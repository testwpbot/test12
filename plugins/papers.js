/**
 * .papers / .paper — download past papers from the bot owner's Google Drive.
 *
 * Professional UI: interactive single-select cards with tappable folders,
 * files and navigation. Every row id is a ready-made text command, so the
 * whole plugin also works 100% by typing:
 *
 *   .papers                     → open the papers hub (button card)
 *   .papers <words>             → search, e.g. `.papers chemistry 2021`
 *   .papers next | prev | more  → paging
 *   .papers back | home         → folder navigation
 *   .paper <number>             → open folder n / download file n
 *   .paper <words>              → download by name
 *   .papers refresh             → owner: force a re-index
 *   .papersetup                 → owner-only setup guide
 */

const { cmd } = require('../command');
const config = require('../config');
const gdrive = require('../lib/gdrive');
const smart = require('../lib/papersearch');
const kb = require('../lib/intent');
const { isTapResponse } = require('../lib/msg');
const { sendButtons } = require('../lib/buttons');
const { parsePaperQuery, matchPaper, SUBJECTS, MEDIUMS, CATEGORIES, TYPE_WORDS, classifyFileName, subjectFromTokens, classifyAll } = require('../lib/papersearch');

/* ── tunables ────────────────────────────────────────────────────────── */
const LIST_TTL = 15 * 60 * 1000;         // how long ".paper N" stays valid
const PAGE_SIZE = 30;                    // entries per text list message
const BUTTON_ROWS = 10;                  // rows per list SECTION (WhatsApp cap)
const MAX_CARD_ROWS = 50;                // absolute row cap (5 sections × 10)
const HIDDEN_YEARS = new Set([2013, 2026]);   // stray year folders — never offered (client has 2015-2025)
const MAX_ACTIVE_DOWNLOADS = 2;          // parallel uploads to WhatsApp
const DEFAULT_MAX_MB = 95;
const DEFAULT_COOLDOWN = 30;             // seconds between downloads per user
const DEFAULT_CACHE_MIN = 10;            // drive index cache

/* ── state ───────────────────────────────────────────────────────────── */
let cache = { at: 0, building: null, index: null };
// Per-STUDENT state (key "chat:senderJid") — never shared between students,
// so one person browsing Agriculture cannot leak their view into someone
// else's "papers". The Drive index cache above is global on purpose: it is
// the same library for everyone and keeps API quota usage tiny.
const browse = {};      // studentKey -> { pathIds:[], pathNames:[], at }
const interviews = {};  // studentKey -> [ { id, at, subject, year, medium, type, cat } ] — SHORT-TERM MEMORY of pending paper requests (several can be open at once)
const MAX_PENDING = 3;                        // max concurrent pending requests per student (oldest dropped)
const INTERVIEW_TTL = 24 * 60 * 60 * 1000;    // memory cleaned after 24 hours
const FIELD_WORDS = new Set(['year', 'subject', 'medium', 'type', 'cat', 'cancel']);
function ivNewId(list) {
  let id = '';
  do { id = Math.random().toString(36).slice(2, 6); }
  while (FIELD_WORDS.has(id) || list.some((s) => s.id === id));
  return id;
}
/** Drop pending requests older than 24 h. */
function pruneInterviews() {
  const cutoff = Date.now() - INTERVIEW_TTL;
  for (const k of Object.keys(interviews)) {
    const list = (interviews[k] || []).filter((s) => s && s.at && s.at >= cutoff);
    if (list.length) interviews[k] = list; else delete interviews[k];
  }
}
function ivList(sk) { return interviews[sk] || []; }
function ivNewest(sk) { const l = ivList(sk); return l.length ? l[l.length - 1] : null; }
function ivRemove(sk, id) {
  const l = ivList(sk).filter((s) => s.id !== id);
  if (l.length) interviews[sk] = l; else delete interviews[sk];
}
const lastList = {};    // studentKey -> { view, title, items, page, pages, at }
const cooldowns = {};   // "chat:sender" -> last download ts

/** Per-student state key. */
function skey(ctx) {
  return `${ctx.from}:${ctx.sender || ctx.senderNumber || 'anon'}`;
}
/** Drop stale navigation/list state so old views never leak back in. */
function pruneState() {
  pruneInterviews();
  const cutoff = Date.now() - (30 * 60 * 1000);
  for (const map of [browse, lastList]) {
    for (const k of Object.keys(map)) {
      if (!map[k] || !map[k].at || map[k].at < cutoff) delete map[k];
    }
  }
}
function setBrowse(key, val) {
  pruneState();
  browse[key] = { ...val, at: Date.now() };
}
let active = 0;
const queue = [];

function maxBytes() {
  const mb = parseInt(String(config.PAPERS_MAX_SIZE_MB || '').trim(), 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024;
}
function cooldownMs() {
  const s = parseInt(String(config.PAPERS_COOLDOWN_SEC || '').trim(), 10);
  return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_COOLDOWN) * 1000;
}
function cacheTtlMs() {
  const m = parseInt(String(config.PAPERS_CACHE_MIN || '').trim(), 10);
  return (Number.isFinite(m) && m >= 1 && m <= 720 ? m : DEFAULT_CACHE_MIN) * 60 * 1000;
}

/* ── download queue (protects the bot number from mass-sending) ─────── */
function enqueue(task) {
  queue.push(task);
  pump();
}
function pump() {
  while (active < MAX_ACTIVE_DOWNLOADS && queue.length > 0) {
    active++;
    const task = queue.shift();
    task().catch((e) => console.error('papers: download task failed:', e))
      .finally(() => { active--; pump(); });
  }
}

/* ── drive index (cached in memory + on disk, single-flight) ─────────── */
const fs = require('fs');
const path = require('path');
const DISK_CACHE = path.join(__dirname, '..', 'temp', 'papers-index.json');

function readDiskCache() {
  try {
    if (fs.existsSync(DISK_CACHE)) {
      const parsed = JSON.parse(fs.readFileSync(DISK_CACHE, 'utf8'));
      if (parsed && parsed.index && parsed.index.root && Array.isArray(parsed.index.files)) {
        return parsed;
      }
    }
  } catch (e) { /* corrupt cache — ignore */ }
  return null;
}
function writeDiskCache(index) {
  try {
    fs.mkdirSync(path.dirname(DISK_CACHE), { recursive: true });
    fs.writeFileSync(DISK_CACHE, JSON.stringify({ at: Date.now(), index }));
  } catch (e) {
    console.error('papers: disk cache write failed:', e.message);
  }
}

function rootId() {
  return gdrive.extractId(config.GDRIVE_FOLDER_ID);
}

/**
 * Returns { index, degraded, at } — `degraded` means Google Drive could not
 * be reached right now and a previously saved list is being served instead,
 * so students keep working during quota/network hiccups or restarts.
 */
async function getIndex({ allowStale = true } = {}) {
  const rid = rootId();
  if (!rid) {
    const e = new Error('Past papers are not configured yet.');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  if (cache.index && Date.now() - cache.at < cacheTtlMs()) {
    return { index: cache.index, degraded: false, at: cache.at };
  }
  if (cache.building) return cache.building;
  cache.building = (async () => {
    try {
      const index = await gdrive.buildIndex(rid);
      cache = { at: Date.now(), building: null, index };
      writeDiskCache(index);
      return { index, degraded: false, at: cache.at };
    } catch (e) {
      cache.building = null;
      if (allowStale) {
        if (cache.index) return { index: cache.index, degraded: true, at: cache.at };
        const disk = readDiskCache();
        if (disk) return { index: disk.index, degraded: true, at: disk.at };
      }
      throw e;
    }
  })();
  return cache.building;
}

/* ── formatting helpers ──────────────────────────────────────────────── */
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function cleanName(name) {
  return String(name || 'file').replace(/[/\\]/g, '_').slice(0, 120);
}
function isGoogleDoc(entry) {
  return !!(entry.mimeType && entry.mimeType.startsWith('application/vnd.google-apps'));
}
function mimeFor(entry) {
  if (isGoogleDoc(entry)) return 'application/pdf';
  if (entry.mimeType) return entry.mimeType;
  const ext = (entry.name.match(/\.([a-z0-9]+)$/i) || [])[1];
  const map = {
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', txt: 'text/plain',
    zip: 'application/zip', rar: 'application/vnd.rar'
  };
  return (ext && map[ext.toLowerCase()]) || 'application/octet-stream';
}
function fileNameFor(entry) {
  let name = cleanName(entry.name);
  if (isGoogleDoc(entry) && !/\.pdf$/i.test(name)) name += '.pdf';
  return name;
}
function pathLabel(pathNames) {
  return (pathNames || []).join(' / ');
}

/**
 * Display name for the papers library in menus/breadcrumbs. Defaults to the
 * real Drive folder name when PAPERS_ROOT_NAME is empty.
 */
function displayName(index) {
  const custom = String(config.PAPERS_ROOT_NAME || '').trim();
  return custom || index.root.name;
}
function countDirectChildren(index, folderPath) {
  const folders = index.folders.filter((f) =>
    f.path.length === folderPath.length + 1 && folderPath.every((n, i) => f.path[i] === n)).length;
  const files = index.files.filter((f) =>
    f.path.length === folderPath.length && folderPath.every((n, i) => f.path[i] === n)).length;
  return { folders, files };
}

/* ── view resolution ─────────────────────────────────────────────────── */
/** Command prefix for student-facing tips: hidden when no-prefix mode is on. */
function pfx() {
  return config.isEnabled('PAPERS_NO_PREFIX') ? '' : config.PREFIX;
}

function helpLines() {
  return (
    `📥 Download: \`${pfx()}paper <number>\`\n` +
    `🔍 Search: \`${pfx()}papers <words>\`  |  📄 More: \`${pfx()}papers next\``
  );
}

/**
 * Resolve a view descriptor into a numbered item list.
 * view = { kind: 'search', query }  or  { kind: 'folder', pathNames: [...] }
 * Index paths always start with the root folder name.
 */
async function resolveView(view) {
  const { index, degraded } = await getIndex();

  if (view.kind === 'search') {
    const res = smart.searchIndex(index, view.query);
    const items = res.items.slice(0, 150);
    const tags = [];
    if (view.ai) tags.push('✨ AI');
    if (res.relaxed) tags.push('loose match');
    return {
      title: `🔍 *" ${view.original || view.query}"* — ${items.length} found${tags.length ? ` · ${tags.join(' · ')}` : ''}`,
      items, isSearch: true, degraded
    };
  }

  const names = (view.pathNames && view.pathNames.length)
    ? view.pathNames
    : [index.root.name];
  const label = [displayName(index), ...names.slice(1)];

  const isDirectChildFolder = (f) =>
    f.path.length === names.length + 1 && names.every((n, i) => f.path[i] === n);
  const isDirectFile = (f) =>
    f.path.length === names.length && names.every((n, i) => f.path[i] === n);

  const items = [
    ...index.folders.filter(isDirectChildFolder).map((f) => {
      const c = countDirectChildren(index, f.path);
      return { ...f, _folder: true, _childCount: c.folders + c.files };
    }),
    ...index.files.filter(isDirectFile).map((f) => ({ ...f, _folder: false }))
  ];
  return { title: `🗂️ *${pathLabel(label)}*`, items, isSearch: false, degraded };
}

/* ── text rendering (fallback + full list) ───────────────────────────── */
function renderText(resolved, page) {
  const pages = Math.max(1, Math.ceil(resolved.items.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page || 1), pages);
  const start = (p - 1) * PAGE_SIZE;
  const slice = resolved.items.slice(start, start + PAGE_SIZE);

  let text = `╭━━━〔 📚 *PAST PAPERS* 〕━━━┈\n┃ ${resolved.title}  (page ${p}/${pages})\n┃\n`;
  if (slice.length === 0) text += '┃ _No files found here._\n';
  slice.forEach((it, i) => {
    const n = start + i + 1;
    if (it._folder) {
      const c = it._childCount ? ` (${it._childCount})` : '';
      text += `┃ ${n}. 📁 *${cleanName(it.name)}*${c}\n`;
    } else {
      const size = it.size ? ` (${fmtSize(it.size)})` : '';
      const where = resolved.isSearch && it.path.length > 1
        ? `\n┃     ↳ _${pathLabel(it.path.slice(1))}_`
        : '';
      text += `┃ ${n}. 📄 ${cleanName(it.name)}${size}${where}\n`;
    }
  });
  text += `╰━━━━━━━━━━━━━━━━━━━┈\n\n${helpLines()}`;
  if (resolved.degraded) {
    text += '\n\n⚠️ _Showing a saved copy — Google Drive is unreachable right now, so very new files may be missing._';
  }
  return { text, page: p, pages };
}

/* ── interactive card rows (buttons UI) ──────────────────────────────── */
function buildRows(resolved, page, offset, view) {
  const pages = Math.max(1, Math.ceil(resolved.items.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page || 1), pages);
  const pageStart = (p - 1) * PAGE_SIZE;
  const windowStart = pageStart + Math.max(0, offset || 0);
  const slice = resolved.items.slice(windowStart, windowStart + BUTTON_ROWS);

  // WhatsApp visually clamps very long row titles, so the FULL file name is
  // also carried in the description whenever the title may be clamped.
  const clampDesc = (s) => (s.length <= 72 ? s : `${s.slice(0, 71)}…`);
  const itemRows = slice.map((it, i) => {
    const n = windowStart + i + 1;
    const name = cleanName(it.name);
    if (it._folder) {
      const c = it._childCount ? ` · ${it._childCount} items` : '';
      return {
        id: `${config.PREFIX}paper ${n}`,
        title: `📁 ${name}`,
        description: clampDesc(`Folder${c} — tap to open`)
      };
    }
    const size = it.size ? ` · ${fmtSize(it.size)}` : '';
    const kind = isGoogleDoc(it) ? 'Docs → PDF' : 'File';
    const desc = name.length > 24
      ? `${name}${size} — download`
      : `${kind}${size} — download`;
    return {
      id: `${config.PREFIX}paper ${n}`,
      title: `${n}. ${name}`,
      description: clampDesc(desc)
    };
  });

  // list only — no navigation / pagination buttons
  return { itemRows, page: p, pages };
}

/** Contextual label for the list button, matching what the rows offer. */
function listTitleFor(resolved) {
  if (resolved.isSearch) return '🔍 Pick a result…';
  const hasFolders = resolved.items.some((it) => it._folder);
  const hasFiles = resolved.items.some((it) => !it._folder);
  if (hasFolders && !hasFiles) return '📂 Open a folder…';
  if (!hasFolders && hasFiles) return '📥 Download…';
  return '📚 Browse papers…';
}

function cardTitle(resolved) {
  const t = resolved.title.replace(/\*/g, '');
  return t.length > 55 ? `📚 ${t.slice(0, 52)}…` : `📚 ${t}`;
}

async function showView(sock, mek, m, ctx, view, page, offset = 0, opts = {}) {
  // pre-resolved direct result lists (structured multi-match) page as-is
  const resolved = view.kind === 'direct' ? view.resolved : await resolveView(view);

  // empty result → simple text message (no interactive card), and keep any
  // previous numbered list valid so ".paper N" still works for the student.
  if (resolved.items.length === 0) {
    if (view.kind === 'search') {
      const q = view.original || view.query;
      return ctx.reply(
        `🔍 *No papers found for "${q}"* 🤔\n\n` +
        `💡 Try fewer or shorter words — e.g. \`${pfx()}papers chem 2021\`\n` +
        `💡 Abbreviations & typos are OK — \`phy\`, \`bio\`, \`maths\`\n` +
        `💡 Or browse everything: \`${pfx()}papers\``
      );
    }
    if (view.pathNames && view.pathNames.length > 1) {
      return ctx.reply(
        `📁 *No papers in this folder yet.*\n\n` +
        `⬆️ Back: \`${pfx()}papers back\`  |  🏠 Home: \`${pfx()}papers\``
      );
    }
    return ctx.reply('📚 The papers library is empty right now — check back soon!');
  }

  const { text, page: p, pages } = renderText(resolved, page);
  const custom = (opts && opts.customText) ? String(opts.customText) : '';
  const bodyText = custom || text;
  pruneState();
  lastList[skey(ctx)] = {
    view,
    title: resolved.title,
    items: resolved.items,
    page: p,
    pages,
    at: Date.now()
  };

  // Interactive card when the bot core supports it, text fallback otherwise.
  if (m && typeof m.sendButtonMenu === 'function') {
    try {
      const { itemRows } = buildRows(resolved, p, offset, view);
      const sections = [];
      if (itemRows.length) sections.push({ title: '📂 Items — tap to open/download', rows: itemRows });
      if (!sections.length) {
        return ctx.reply(bodyText);
      }
      const hidden = resolved.items.length - itemRows.length;
      const moreHint = hidden > 0
        ? `\n📄 …and ${hidden} more — type \`${pfx()}papers next\``
        : '';
      const counts = resolved.isSearch ? '' :
        ` · ${resolved.items.length} item${resolved.items.length === 1 ? '' : 's'}`;
      // logo only on the MAIN menu (root folder, first page) — not on every card
      const isMainMenu = !resolved.isSearch && view.kind === 'folder' &&
        (!view.pathNames || view.pathNames.length === 0) && p === 1 && !offset;
      await m.sendButtonMenu({
        // title only on the MAIN menu card — sub-level cards would duplicate
        // it (their body's first line already carries the breadcrumb)
        title: isMainMenu ? cardTitle(resolved) : '',
        ...(isMainMenu ? { image: config.ALIVE_IMG } : {}),
        text: custom ||
          `${resolved.title}${counts}  (page ${p}/${pages})\n\n` +
          `💡 Tap a row below, or type \`${pfx()}paper <number>\`\n` +
          `🔍 Search everything: \`${pfx()}papers <words>\`${moreHint}` +
          (resolved.degraded ? '\n\n⚠️ _Saved copy — Drive unreachable right now._' : ''),
        footer: `${config.BOT_NAME} • 🎓 Educational Assistant`,
        listTitle: listTitleFor(resolved),
        sections
      });
      console.log(`📋 papers card relayed (${sections.length} section${sections.length === 1 ? '' : 's'}) to ${ctx.from}`);
      return;
    } catch (e) {
      console.error('papers: button card failed, falling back to text:', e.message || e);
    }
  }
  // guaranteed final fallback: plain text, sent directly through the socket
  try {
    return await ctx.reply(bodyText);
  } catch (e) {
    console.error('papers: ctx.reply failed, sending raw:', e.message || e);
    return sock.sendMessage(ctx.from, { text: bodyText });
  }
}

/**
 * Send the papers hub card, optionally with custom body text (used by the
 * welcome flow so the greeting and the menu arrive as ONE message).
 * Returns false when papers are not configured (caller can fall back).
 */
async function sendHubCard(sock, mek, m, ctx, opts = {}) {
  try {
    if (!rootId()) return false;
    await showView(sock, mek, m, ctx, { kind: 'folder', pathIds: [], pathNames: [] }, 1, 0, opts);
    return true;
  } catch (e) {
    console.error('papers: hub card failed:', e.message || e);
    return false;
  }
}

/* ── download ────────────────────────────────────────────────────────── */
async function downloadEntry(sock, mek, ctx, entry) {
  const { from, sender, senderNumber, pushname, isGroup, reply } = ctx;

  const ck = `${from}:${senderNumber}`;
  const cd = cooldownMs();
  if (cd > 0 && cooldowns[ck] && Date.now() - cooldowns[ck] < cd) {
    const left = Math.ceil((cd - (Date.now() - cooldowns[ck])) / 1000);
    return reply(`⏳ *${pushname}*, please wait ${left}s before requesting another paper.`);
  }

  const cap = maxBytes();
  if (entry.size && entry.size > cap) {
    return reply(
      `📦 *${cleanName(entry.name)}* is ${fmtSize(entry.size)} — too big to send here (limit ${fmtSize(cap)}).\n` +
      `🌐 Open it in your browser instead:\nhttps://drive.google.com/file/d/${entry.id}/view`
    );
  }

  cooldowns[ck] = Date.now();
  const fname = fileNameFor(entry);
  const sizeTxt = entry.size ? ` (${fmtSize(entry.size)})` : '';
  await sock.sendMessage(from, { react: { text: '⏳', key: mek.key } });
  await reply(`📥 *Downloading* ${fname}${sizeTxt}…\n⏳ Your paper will arrive in this chat shortly.`);

  enqueue(async () => {
    try {
      const buf = await gdrive.downloadFile(entry);
      const caption =
        `╭━━━〔 📚 *PAST PAPER* 〕━━━┈\n` +
        `┃ 📄 *${fname}*\n` +
        (isGroup ? `┃ 👤 Requested by @${senderNumber}\n` : '') +
        `╰━━━━━━━━━━━━━━━━━━━┈\n` +
        `🌐 ${config.BRAND_SITE}\n` +
        `💬 ${config.BRAND_CONTACT}\n` +
        `_🤖 ${config.BOT_NAME} • ask me for more anytime!_`;
      await sock.sendMessage(from, {
        document: buf,
        fileName: fname,
        mimetype: mimeFor(entry),
        caption,
        ...(isGroup ? { mentions: [sender] } : {})
      }, isTapResponse(mek) ? {} : { quoted: mek });   // taps are never quoted (unsupported for others)
      await sock.sendMessage(from, { react: { text: '✅', key: mek.key } });
      console.log(`📚 Sent paper "${fname}" to ${from}`);
    } catch (e) {
      console.error('❌ paper download failed:', e.message || e);
      await sock.sendMessage(from, { react: { text: '❌', key: mek.key } });
      await reply(`❌ Download failed — please try again in a moment.\n${gdrive.friendlyError(e)}`);
    }
  });
}

/* ── paper interviews — ASK for missing details, never dump lists ────── */
const CAT_WORD_TO_KEY = {};
for (const [k, v] of Object.entries(CATEGORIES)) for (const w of v.words) CAT_WORD_TO_KEY[w] = k;

const TYPE_LABELS = { marking: '🏷️ Marking scheme', mcq: '🏷️ MCQ paper', essay: '🏷️ Essay / structured', paper: '🏷️ Question paper' };


function yearsFor(index, subject, medium, cat) {
  const years = new Set();
  for (const c of classifyAll(index).values()) {
    if (subject && c.subject !== subject) continue;
    if (medium && c.medium !== medium) continue;
    if (cat && c.cat !== cat) continue;
    if (c.year) years.add(c.year);
  }
  return [...years].filter((y) => !HIDDEN_YEARS.has(y)).sort();
}
function subjectsForYear(index, year) {
  const subs = new Set();
  for (const c of classifyAll(index).values()) {
    if (c.subject && (!year || c.year === year)) subs.add(c.subject);
  }
  return [...subs].sort();
}
function mediumsFor(index, year, subject, cat) {
  const meds = new Set();
  for (const c of classifyAll(index).values()) {
    if (c.year === year && (!subject || c.subject === subject) && (!cat || c.cat === cat) && c.medium) meds.add(c.medium);
  }
  return [...meds].sort();
}
function isMarkingFile(cls, f) {
  const c = cls.get(f) || {};
  return c.typeKind === 'marking' || (c.extra || []).some((w) => TYPE_WORDS.marking.includes(w));
}
/**
 * STRICT type filter: when the student explicitly asked for a marking
 * scheme / mcq / essay / question paper, we NEVER silently serve another
 * kind — empty means "not found" and the bot tells what exists instead.
 */
function filterByType(index, files, type) {
  if (!type) return files;
  const cls = classifyAll(index);
  return files.filter((f) => {
    if (type === 'marking') return isMarkingFile(cls, f);
    const c = cls.get(f) || {};
    if (type === 'paper') {
      const isMarking = isMarkingFile(cls, f);
      const isMcq = (c.extra || []).includes('mcq');
      return !isMarking && !isMcq;
    }
    return (c.extra || []).some((w) => TYPE_WORDS[type].includes(w));
  });
}

/** The "not found" reply with available-subjects hint (shared). */
async function paperNotFound(sock, mek, ctx, index, q, degraded, kindHint) {
  // LIVE library facts — never hardcoded lists
  const cls = index && index.files && index.files.length ? [...classifyAll(index).values()] : [];
  const years = [...new Set(cls.map((c) => c.year).filter(Number.isFinite))].filter((y) => !HIDDEN_YEARS.has(y)).sort((a, b) => a - b);
  const meds = [...new Set(cls.map((c) => c.medium).filter(Boolean))];
  const nSubs = smart.subjectsInIndex(index).length;   // live: files + folders + unknown-subject folders

  let msg = `❌ *Paper/Scheme Not Found*\n\nWe couldn't find this paper in our database.`;
  if (cls.length) {
    msg += `\n\nAvailable:\n` +
      `📅 ${years[0]} - ${years[years.length - 1]} Papers\n` +
      `🌐 ${meds.map((m) => MEDIUMS[m].label).join(' | ')}\n` +
      `📚 ${nSubs} A/L Subjects\n\n` +
      `> To view available subject names: Click Button below\n"Available Subjects"`;
  }
  if (kindHint) msg += `\n\n${kindHint}`;
  msg += '\n\nPlease check your:\n* Year\n* Language Medium\n* Subject\n\nand try again. ➡️';
  if (years.length) msg += `\n\n📌${years[years.length - 1] + 1} Papers are currently being prepared....`;
  if (degraded) msg += '\n⚠️ _Saved copy shown — Drive unreachable right now._';
  try {
    await sendButtons(sock, ctx.from, {
      text: msg,
      footer: `${config.BOT_NAME} • 🎓 Educational Assistant`,
      buttons: [{ id: `${config.PREFIX}subjects`, text: '📋 Available Subjects' }]
    }, { quoted: mek });
  } catch (e) {
    await ctx.reply(`${msg}\n\n📋 Available subjects: send *subjects*`);
  }
}

/** Live "Available Subjects" message — built from the Drive index. */
function subjectsListMessage(index) {
  const codes = smart.subjectsInIndex(index);   // real-time: names + folders + paths
  const cls = index && index.files && index.files.length ? [...classifyAll(index).values()] : [];
  const years = [...new Set(cls.map((c) => c.year).filter(Number.isFinite))].filter((y) => !HIDDEN_YEARS.has(y)).sort((a, b) => a - b);
  const meds = [...new Set(cls.map((c) => c.medium).filter(Boolean))];
  const L = [];
  L.push('📚 *Available A/L Subjects*', '');
  L.push(`Our database currently supports *${codes.length}* subjects:`, '');
  codes.forEach((c, i) => L.push(`${String(i + 1).padStart(2, '0')} – ${c.label}`));
  if (meds.length) L.push('', '🌐 Available Mediums:', meds.map((m) => MEDIUMS[m].label).join(' | '));
  if (years.length) L.push('', '📅 Available Years:', `${years[0]} - ${years[years.length - 1]}`);
  // a REAL example: an actual (year, medium, subject) combo from the library
  const ex = cls.find((c) => c.year === years[years.length - 1] && c.medium && c.subject) ||
             cls.find((c) => c.year && c.medium && c.subject) || null;
  if (ex) {
    L.push('', 'Send your request format:', 'Year-Medium-Subject', '',
      'Example:', `*${ex.year}-${MEDIUMS[ex.medium].label}-${SUBJECTS[ex.subject].label}*`, '', '👇🏻');
  }
  return L.join('\n');
}

/** Ask ONE question (with tap buttons) for the next missing detail. */
async function askMissing(sock, mek, m, ctx, st, index) {
  const ctxLine = [
    st.cat && st.cat !== 'past' && `📦 ${CATEGORIES[st.cat].label}`,
    st.year && `📅 ${st.year}`,
    st.subject && `📘 ${SUBJECTS[st.subject].label}`,
    st.medium && `🌐 ${MEDIUMS[st.medium].label}`
  ].filter(Boolean).join(' · ');

  let rows = [], question = '', listTitle = '', more = '';
  if (!st.subject) {
    const subs = subjectsForYear(index, st.year);
    const shown = subs.slice(0, MAX_CARD_ROWS);
    rows = shown.map((s) => ({ id: `${config.PREFIX}ppick ${st.id} subject ${s}`, title: `📘 ${SUBJECTS[s].label}`, description: `${st.year ? st.year + ' papers' : 'Papers'}` }));
    if (subs.length > shown.length) more = `\n📄 …and ${subs.length - shown.length} more — type the subject name`;
    question = '📘 *Which subject do you need?*';
    listTitle = '📘 Pick a subject…';
  } else if (!st.year) {
    const years = yearsFor(index, st.subject, st.medium, st.cat);
    const shown = years.slice(0, MAX_CARD_ROWS);
    rows = shown.map((y) => ({ id: `${config.PREFIX}ppick ${st.id} year ${y}`, title: `📅 ${y}`, description: `${st.subject ? SUBJECTS[st.subject].label : 'Papers'} ${y}` }));
    if (years.length > shown.length) more = `\n📄 …and ${years.length - shown.length} more years — type the year`;
    question = '📅 *What year do you need?*';
    listTitle = '🗓️ Pick a year…';
  } else {
    const meds = mediumsFor(index, st.year, st.subject);
    rows = meds.map((mk) => ({ id: `${config.PREFIX}ppick ${st.id} medium ${mk}`, title: `🌐 ${MEDIUMS[mk].label}`, description: `${st.year} ${SUBJECTS[st.subject].label} — ${MEDIUMS[mk].label}` }));
    question = '🌐 *Which medium do you want?*';
    listTitle = '🌐 Pick a medium…';
  }
  if (!rows.length) {
    return ctx.reply(`🤔 I need a bit more detail to find your paper.\n${ctxLine}\n\n💡 Try the short style: *2019 chem sinhala*`);
  }
  const body =
    `${ctxLine ? ctxLine + '\n\n' : ''}${question}${more}\n` +
    `💬 Or just type your answer` +
    (st.type ? `\n${TYPE_LABELS[st.type] || ''}` : '');
  if (m && typeof m.sendButtonMenu === 'function') {
    // WhatsApp allows multiple sections of 10 rows — chunk so EVERY
    // option is tappable (28 subjects = 3 sections, nothing hidden)
    const sections = [];
    if (rows.length <= 10) {
      sections.push({ title: '🧭 Tap your answer', rows });
    } else {
      for (let i = 0; i < rows.length; i += 10) {
        sections.push({ title: `🧭 Options ${i + 1}–${Math.min(i + 10, rows.length)}`, rows: rows.slice(i, i + 10) });
      }
    }
    try {
      await m.sendButtonMenu({
        title: '',
        text: body,
        footer: `${config.BOT_NAME} • 🎓 Educational Assistant`,
        listTitle,
        sections
      });
      return;
    } catch (e) { console.error('papers: question card failed:', e.message || e); }
  }
  // no card support → list the options as text
  const opts = rows.map((r) => `• ${r.title}`).join('\n');
  return ctx.reply(`${body}\n${opts}`);
}

/** Merge request details into the student's interview; ask or resolve. */
async function startOrContinuePaperRequest(sock, mek, m, ctx, q) {
  const sk = skey(ctx);
  pruneState();
  // FRESH state every time — a new request must never merge into an older
  // pending interview (newest wins). Interview answers go through .ppick,
  // which applies them to the existing state explicitly.
  const st = {
    id: q.id || null,   // set = continuation of a KNOWN pending request (card tap)
    subject: q.subject || null,
    year: Number.isFinite(q.year) && q.year ? q.year : null,
    medium: q.medium || null,
    type: q.type || null,
    cat: q.cat || null,
    at: Date.now()
  };
  if (st.year && st.subject && st.medium) {
    if (st.id) ivRemove(sk, st.id);   // THIS request is resolved; others stay
    return directPaperRequest(sock, mek, m, ctx, st);
  }
  const { index, degraded } = await getIndex();
  if (st.year && st.subject && !mediumsFor(index, st.year, st.subject, st.cat).length) {
    // files may exist WITHOUT medium tags — show them instead of asking a
    // question the library cannot answer
    if (!matchPaper(index, { year: st.year, subject: st.subject, cat: st.cat }).length) {
      if (st.id) ivRemove(sk, st.id);
      return paperNotFound(sock, mek, ctx, index, st, degraded);
    }
    if (st.medium) {   // a medium WAS requested but nothing matches it
      if (st.id) ivRemove(sk, st.id);
      return paperNotFound(sock, mek, ctx, index, st, degraded);
    }
    if (st.id) ivRemove(sk, st.id);
    return directPaperRequest(sock, mek, m, ctx, st);
  }
  if (!st.subject && st.year && !subjectsForYear(index, st.year).length) {
    if (st.id) ivRemove(sk, st.id);
    return paperNotFound(sock, mek, ctx, index, st, degraded);
  }
  // remember it: a tap continues ITS request in place; a new ask joins the
  // student's short-term memory as its own entry (oldest dropped past cap)
  const list = ivList(sk);
  if (st.id) {
    const i = list.findIndex((s) => s.id === st.id);
    if (i >= 0) list[i] = st; else list.push(st);
  } else {
    st.id = ivNewId(list);
    list.push(st);
    while (list.length > MAX_PENDING) list.shift();
  }
  interviews[sk] = list;
  return askMissing(sock, mek, m, ctx, st, index);
}

/** Extract request dimensions from any text WITHOUT AI (local brain). */
function dimsFromText(text) {
  const toks = String(text || '').toLowerCase().replace(/\u200D/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s/]+/gu, ' ').split(/\s+/).filter(Boolean);
  const out = { year: null, subject: null, medium: null, type: null, cat: null };
  for (const t of toks) {
    if (/^(19|20)\d{2}$/.test(t)) out.year = parseInt(t, 10);
    for (const [k, v] of Object.entries(MEDIUMS)) {
      if (v.tokens.includes(t)) { out.medium = k; break; }
    }
  }
  out.subject = subjectFromTokens(toks);
  for (const [k, ws] of Object.entries(TYPE_WORDS)) {
    if (toks.some((t) => ws.includes(t))) { out.type = k; break; }
  }
  for (let i = toks.length - 1; i >= 0; i--) {
    if (CAT_WORD_TO_KEY[toks[i]]) { out.cat = CAT_WORD_TO_KEY[toks[i]]; break; }
  }
  return out;
}

/** Parse a chat answer for the pending question ("2020", "sinhala", …). */
function parseInterviewAnswer(body) {
  const toks = String(body || '').toLowerCase().replace(/\u200D/g, '')
    .split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  if (!toks.length) return null;
  if (toks.some((t) => ['cancel', 'stop', 'exit', 'epa', 'nathi'].includes(t))) return { cancel: true };
  const yr = toks.find((t) => /^(19|20)\d{2}$/.test(t));
  if (yr) return { field: 'year', value: yr };
  for (let i = toks.length - 1; i >= 0; i--) {
    for (const [k, v] of Object.entries(MEDIUMS)) {
      if (v.tokens.includes(toks[i])) return { field: 'medium', value: k };
    }
  }
  for (let i = toks.length - 1; i >= 0; i--) {
    if (CAT_WORD_TO_KEY[toks[i]]) return { field: 'cat', value: CAT_WORD_TO_KEY[toks[i]] };
  }
  for (const [k, ws] of Object.entries(TYPE_WORDS)) {
    if (toks.some((t) => ws.includes(t))) return { field: 'type', value: k };
  }
  const sub = subjectFromTokens(toks);
  if (sub) return { field: 'subject', value: sub };
  return null;
}

/* ── structured requests — "2016 chemistry sinhala medium" ───────────── */
/** The reusable "how to ask" guide text (greetings + usage + fallbacks). */
function buildGuide() {
  return (
    `📖 *Getting your paper is easy!*\n\n` +
    `Just type it in this order:\n\n` +
    `📅 Year  📘 Subject  🌐 Medium\n\n` +
    `For example: *2016 chemistry sinhala medium*\n\n` +
    `almate.edu.lk`
  );
}
function usageGuide(ctx) {
  // generic asks ("i want papers" / "i want a past paper") are NEVER
  // remembered — every send gets the full exact how-to-ask guide again
  return ctx.reply(buildGuide());
}

/**
 * Button-based picker: every found paper becomes a TAP row (filename +
 * size), no number-typing needed. Seeds the per-student list so the row
 * ids (.paper N) download directly, and keeps a numbered TEXT fallback
 * for clients where the card truly cannot render.
 */
async function sendPickCard(sock, mek, m, ctx, resolved, listTitle) {
  const sk = skey(ctx);
  pruneState();
  lastList[sk] = { view: { kind: 'direct', resolved }, title: resolved.title, items: resolved.items, page: 1, pages: 1, at: Date.now() };

  const rows = resolved.items.slice(0, BUTTON_ROWS).map((it, i) => ({
    id: `${config.PREFIX}paper ${i + 1}`,
    title: cleanName(it.name).slice(0, 72),
    description: `${it.size ? `${fmtSize(it.size)} — ` : ''}tap to download`.slice(0, 72)
  }));
  const sections = [{ title: '📥 Papers — tap to download', rows }];
  const hidden = resolved.items.length - rows.length;
  const more = hidden > 0 ? `\n📄 …and ${hidden} more — type \`${pfx()}paper ${rows.length + 1}\`` : '';
  const body =
    `${resolved.title}\n\n` +
    `📥 *Tap a paper below to download*${more}` +
    (resolved.degraded ? '\n\n⚠️ _Saved copy — Drive unreachable right now._' : '');

  if (m && typeof m.sendButtonMenu === 'function') {
    try {
      await m.sendButtonMenu({
        title: '',
        text: body,
        footer: `${config.BOT_NAME} • 🎓 Educational Assistant`,
        listTitle,
        sections
      });
      console.log(`📋 papers pick card relayed (${resolved.items.length} paper${resolved.items.length === 1 ? '' : 's'}) to ${ctx.from}`);
      return;
    } catch (e) {
      console.error('papers: pick card failed, text fallback:', e.message || e);
    }
  }
  // carding unavailable — numbered text (last resort only)
  let text = `${resolved.title}\n\n`;
  resolved.items.slice(0, BUTTON_ROWS).forEach((it, i) => {
    text += `${i + 1}. 📄 ${cleanName(it.name)}${it.size ? ` _(${fmtSize(it.size)})_` : ''}\n`;
  });
  text += `\n📥 Reply ${pfx()}paper 1 – ${Math.min(resolved.items.length, BUTTON_ROWS)} to download`;
  return ctx.reply(text);
}

async function directPaperRequest(sock, mek, m, ctx, q) {
  const { index, degraded } = await getIndex();
  const subLabel = SUBJECTS[q.subject] ? SUBJECTS[q.subject].label : q.subjectRaw;
  const medLabel = MEDIUMS[q.medium] ? MEDIUMS[q.medium].label : null;
  const catLabel = CATEGORIES[q.cat] && q.cat !== 'past' ? CATEGORIES[q.cat].label : null;
  const label = `${catLabel ? `${catLabel} ` : ''}${q.year}${subLabel ? ` ${subLabel}` : ''}` +
    `${medLabel ? ` — ${medLabel} medium` : ''}`;

  let matches = filterByType(index, matchPaper(index, q), q.type);
  if (!matches.length && (!q.subject || !q.medium)) {
    // partial ask (e.g. no medium) — retry fuzzy WITHIN the year
    // (searchIndex pins the year itself, so results stay inside it)
    const kw = [q.year, subLabel, medLabel].filter(Boolean).join(' ');
    matches = smart.searchIndex(index, kw).items.filter((it) => !it._folder && !it.isFolder).slice(0, 30);
  }

  if (matches.length >= 1) {
    // one or many — always a BUTTON card with the paper filename(s);
    // tapping a row downloads instantly (no number-typing)
    const resolved = {
      title: `📚 *${label}* — ${matches.length} paper${matches.length === 1 ? '' : 's'} found`,
      items: matches, isSearch: true, degraded
    };
    return sendPickCard(sock, mek, m, ctx, resolved,
      matches.length === 1 ? '📥 Download…' : '📥 Pick a paper…');
  }

  // the requested KIND is missing (marking asked, question paper exists…)
  // → the SAME standard not-found card, plus what DOES exist for the combo
  // (never silently serve another kind)
  if (q.type) {
    const all = matchPaper(index, q);
    const cls = classifyAll(index);
    const hasMarking = all.some((f) => isMarkingFile(cls, f));
    const hasMcq = all.some((f) => (cls.get(f) || {}).extra?.includes('mcq'));
    const hasPaper = all.some((f) => !isMarkingFile(cls, f) && !(cls.get(f) || {}).extra?.includes('mcq'));
    const avail = [
      hasPaper && 'question paper',
      hasMcq && 'MCQ',
      hasMarking && 'marking scheme'
    ].filter(Boolean);
    const kindHint = avail.length ? `📚 For *${label}* we have: ${avail.join(', ')}` : null;
    return paperNotFound(sock, mek, ctx, index, q, degraded, kindHint);
  }
  return paperNotFound(sock, mek, ctx, index, q, degraded);
}

/* ── papers welcome — image card + 2 buttons (Past Papers / Marking) ─── */
async function sendPapersWelcome(sock, mek, m, ctx) {
  const name = String(ctx.pushname || mek.pushName || '').split(/\s+/)[0];
  const hello = name ? `👋 Hello *${name}*!` : '👋 Hello!';
  const card =
    `${hello}\n\n` +
    `🎓 Welcome to *Almate.edu.lk*\n` +
    `Your Smart A/L Learning AI Assistant 🇱🇰\n\n` +
    `What do you need? 👇`;
  try {
    await sendButtons(sock, ctx.from, {
      image: config.ALIVE_IMG,
      text: card,
      footer: 'Almate.edu.lk 🇱🇰',
      buttons: [
        { id: `${config.PREFIX}pp`, text: '📚 Past Papers' },
        { id: `${config.PREFIX}ms`, text: '📖 Marking Schemes' }
      ]
    }, { quoted: mek });
  } catch (e) {
    await ctx.reply(`${card}\n\n📚 *Past Papers* → send *pp*\n📖 *Marking Schemes* → send *ms*`);
  }
}

/* ── .papers — browse / search ───────────────────────────────────────── */
const papersCommand = cmd({
  pattern: 'papers',
  alias: ['pastpapers', 'paperlist'],
  react: '📚',
  desc: 'Browse & search past papers from Google Drive',
  category: 'main',
  filename: __filename
}, async (sock, mek, m, ctx) => {
  const { from, args, isOwner, isMe, reply } = ctx;
  const isBoss = isOwner || isMe;
  try {
    if (!rootId()) {
      return reply(isBoss
        ? `📚 Google Drive papers are not configured.\nSend \`${config.PREFIX}papersetup\` for the 2-minute setup guide.`
        : '📚 Past papers are not set up yet — the admin is on it! 🛠️');
    }

    const arg0 = (args[0] || '').toLowerCase();

    const sk = skey(ctx);
    if (arg0 === 'home') {
      delete browse[sk];
      return showView(sock, mek, m, ctx, { kind: 'folder', pathIds: [], pathNames: [] }, 1);
    }
    if (arg0 === 'back') {
      const b = browse[sk];
      if (!b || b.pathIds.length === 0) {
        return reply(`ℹ️ Already at the top level. Send \`${pfx()}papers home\` to refresh.`);
      }
      b.pathIds.pop();
      b.pathNames.pop();
      return showView(sock, mek, m, ctx, { kind: 'folder', pathIds: [...b.pathIds], pathNames: [...b.pathNames] }, 1);
    }
    if (arg0 === 'prev') {
      const last = lastList[sk];
      if (!last || last.page <= 1) return reply(`ℹ️ Already on the first page.`);
      return showView(sock, mek, m, ctx, last.view, last.page - 1);
    }
    if (arg0 === 'next') {
      const last = lastList[sk];
      if (!last) return reply(`ℹ️ Nothing to page — send \`${pfx()}papers\` first.`);
      return showView(sock, mek, m, ctx, last.view, last.page + 1);
    }
    if (arg0 === 'more') {
      const last = lastList[sk];
      const off = parseInt(args[1] || '0', 10);
      if (!last || !Number.isFinite(off)) return reply(`ℹ️ Nothing to extend — send \`${pfx()}papers\` first.`);
      return showView(sock, mek, m, ctx, last.view, last.page, off);
    }
    if (arg0 === 'refresh') {
      if (!isBoss) return reply('⛔ Owner only.');
      cache = { at: 0, building: null, index: null };
      const res = await getIndex({ allowStale: false });
      return reply(`🔄 Papers list refreshed — *${res.index.files.length}* files in *${res.index.folders.length}* folders.`);
    }

    const query = args.join(' ').trim();
    if (arg0 === 'menu') {
      // the clean student flow: 📅 year → 📘 subject → 🌐 medium → paper
      // (modern tap cards — the raw folder list is NOT the student UI)
      return startOrContinuePaperRequest(sock, mek, m, ctx, { cat: 'past' });
    }
    if (arg0 === 'browse') {
      // legacy folder browser for power users — always fresh at the root
      delete browse[sk];
      return showView(sock, mek, m, ctx, { kind: 'folder', pathIds: [], pathNames: [] }, 1);
    }
    if (!query) {
      // Bare "papers" = short welcome card (alive image + 2 buttons);
      // the full menu is one tap away (📚 Past Papers → .papers menu)
      return sendPapersWelcome(sock, mek, m, ctx);
    }

    // structured request first: ".papers 2016 chemistry sinhala medium"
    // (missing details start a short interview instead of a loose list)
    const structured = parsePaperQuery(query);
    if (structured && structured.year && (structured.subject || structured.medium)) {
      return startOrContinuePaperRequest(sock, mek, m, ctx, structured);
    }
    // incomplete subject ask ("papers chemistry") → interview as well —
    // students must never get a loose multi-page dump for a subject query
    const dimsQ = dimsFromText(query);
    if (dimsQ.subject && !(dimsQ.year && dimsQ.medium)) {
      return startOrContinuePaperRequest(sock, mek, m, ctx, dimsQ);
    }
    // explicit type without full details ("papers marking scheme") → interview
    if (dimsQ.cat && !dimsQ.year) {
      return startOrContinuePaperRequest(sock, mek, m, ctx, dimsQ);
    }

    // a folder name (top-level or inside the current folder) always wins —
    // papers are usually sorted in folders like "2021", which look like page
    // numbers. Only fall back to page-jumping when no folder matches.
    const index = (await getIndex()).index;
    const last = lastList[sk];
    const cur = browse[sk] || { pathNames: [] };
    const curNames = cur.pathNames.length ? cur.pathNames : [index.root.name];
    const isChildFolder = (f) => f.path.length === curNames.length + 1 &&
      curNames.every((n, i) => f.path[i] === n);
    // Non-Latin scripts (Sinhala/Tamil/…) can't match folder names — send
    // those straight to AI/search instead of letting the tokenizer reduce
    // the query to just its digits.
    const isNonLatin = /[^a-zA-Z0-9\s]/.test(query);
    let hit = null;
    if (!isNonLatin) {
      hit = index.folders.find((f) => (f.path.length === 2 || isChildFolder(f)) &&
        f.path[f.path.length - 1].toLowerCase() === query.toLowerCase());
      if (!hit) hit = smart.matchFolder(index, query, curNames);
    }
    if (hit) {
      const inside = hit.path.length === 2
        ? { pathIds: [hit.id], pathNames: [...hit.path] }
        : (() => {
          const ids = [...(browse[sk]?.pathIds || [])];
          if (ids[ids.length - 1] !== hit.id) ids.push(hit.id);
          return { pathIds: ids, pathNames: [...hit.path] };
        })();
      setBrowse(sk, inside);
      return showView(sock, mek, m, ctx, { kind: 'folder', pathIds: [...inside.pathIds], pathNames: [...inside.pathNames] }, 1);
    }
    if (!isNonLatin && /^\d+$/.test(query) && last && parseInt(query, 10) <= last.pages) {
      return showView(sock, mek, m, ctx, last.view, parseInt(query, 10));
    }

    // Non-Latin (Sinhala/Tamil) queries: the local tokenizer would strip the
    // words and leave a bare year, so go STRAIGHT to AI normalisation.
    const isNonLatinQuery = /[^a-zA-Z0-9\s]/.test(query);
    // Latin queries: LOCAL search first — AI quota is only spent on dead ends
    if (!isNonLatinQuery) {
      const local = smart.searchIndex(index, query);
      if (local.items.length > 0) {
        return showView(sock, mek, m, ctx, { kind: 'search', query, original: query }, 1);
      }
    }
    // AI rescue (Gemini): translate/normalise, then the local engine still
    // picks the files. Silently skipped when no key/quota is available.
    if (query.length <= 80) {
      const expanded = await smart.aiExpand(query);
      if (expanded) {
        const pq = parsePaperQuery(expanded);
        if (pq && pq.year && (pq.subject || pq.medium)) {
          return startOrContinuePaperRequest(sock, mek, m, ctx, pq);
        }
        const res = smart.searchIndex(index, expanded);
        if (res.items.length > 0) {
          return showView(sock, mek, m, ctx, { kind: 'search', query: expanded, original: query, ai: true }, 1);
        }
      }
    }
    if (isNonLatinQuery) {
      return showView(sock, mek, m, ctx, { kind: 'search', query, original: query, ai: false }, 1);
    }
    return showView(sock, mek, m, ctx, { kind: 'search', query, original: query }, 1);
  } catch (e) {
    console.error('papers list error:', e.message || e);
    if (e && e.code === 'NOT_CONFIGURED') {
      return reply(isBoss ? `📚 Not configured — send \`${config.PREFIX}papersetup\`.` : '📚 Past papers are not set up yet.');
    }
    return reply(`❌ ${gdrive.friendlyError(e)}`);
  }
});

/* ── .paper — open folder / download by number or name ───────────────── */
const paperCommand = cmd({
  pattern: 'paper',
  alias: ['getpaper', 'pastpaper'],
  react: '📥',
  desc: 'Download a past paper: .paper <number from .papers>',
  category: 'main',
  filename: __filename
}, async (sock, mek, m, ctx) => {
  const { from, args, isOwner, isMe, reply } = ctx;
  const isBoss = isOwner || isMe;
  try {
    if (!rootId()) {
      return reply(isBoss
        ? `📚 Not configured — send \`${config.PREFIX}papersetup\`.`
        : '📚 Past papers are not set up yet.');
    }

    const arg = args.join(' ').trim();
    if (!arg) {
      return showView(sock, mek, m, ctx, { kind: 'folder', pathIds: [], pathNames: [] }, 1);
    }

    const sk = skey(ctx);
    const last = lastList[sk];
    if (/^\d+$/.test(arg)) {
      if (!last || Date.now() - last.at > LIST_TTL) {
        return reply(`🕒 That list expired — send \`${pfx()}papers\` first, then pick a number.`);
      }
      const n = parseInt(arg, 10);
      const entry = last.items[n - 1];
      if (!entry) {
        return reply(`❓ No item ${n} — this list has ${last.items.length} item(s). Send \`${pfx()}papers\` to see it.`);
      }
      if (entry._folder || entry.isFolder) {
        const cur = browse[sk] || { pathIds: [], pathNames: [] };
        setBrowse(sk, {
          pathIds: [...cur.pathIds, entry.id],
          pathNames: [...(entry.path || [...cur.pathNames, entry.name])]
        });
        return showView(sock, mek, m, ctx, {
          kind: 'folder',
          pathIds: [...browse[sk].pathIds],
          pathNames: [...browse[sk].pathNames]
        }, 1);
      }
      return downloadEntry(sock, mek, ctx, entry);
    }

    // structured request: ".paper 2016 chem sinhala"
    const structured = parsePaperQuery(arg);
    if (structured && structured.year && (structured.subject || structured.medium)) {
      return startOrContinuePaperRequest(sock, mek, m, ctx, structured);
    }

    // by name — prefer the current list, then search everything
    let entry = null;
    if (last && Date.now() - last.at <= LIST_TTL) {
      const matches = last.items.filter((it) => !it._folder && !it.isFolder &&
        it.name.toLowerCase().includes(arg.toLowerCase()));
      if (matches.length === 1) entry = matches[0];
    }
    if (!entry) {
      const index = (await getIndex()).index;
      let res = smart.searchIndex(index, arg);
      if (res.items.length === 0 && arg.length <= 80) {
        // AI rescue — translate/normalise, then retry the local matcher
        const expanded = await smart.aiExpand(arg);
        if (expanded) {
          const pq = parsePaperQuery(expanded);
          if (pq && pq.subject) return directPaperRequest(sock, mek, m, ctx, pq);
          res = smart.searchIndex(index, expanded);
        }
      }
      if (res.items.length === 0) {
        return reply(
          `🔍 *Nothing matched "${arg}"* 🤔\n\n` +
          `💡 Try a shorter word — e.g. \`${pfx()}paper chem\`\n` +
          `💡 Or browse everything: \`${pfx()}papers\``
        );
      }
      if (res.items.length > 1) {
        // button card — tap the filename to download, no number-typing
        const resolved = {
          title: `🔍 *" ${arg}"* — ${res.items.length} matched`,
          items: res.items.slice(0, 150), isSearch: true, degraded: false
        };
        return sendPickCard(sock, mek, m, ctx, resolved, '🔍 Pick a result…');
      }
      entry = res.items[0];
    }
    return downloadEntry(sock, mek, ctx, entry);
  } catch (e) {
    console.error('paper download error:', e.message || e);
    if (e && e.code === 'NOT_CONFIGURED') {
      return reply(isBoss ? `📚 Not configured — send \`${config.PREFIX}papersetup\`.` : '📚 Past papers are not set up yet.');
    }
    return reply(`❌ ${gdrive.friendlyError(e)}`);
  }
});

/* ── .subjects — live A/L subject list from the Drive library ─────────── */
cmd({
  pattern: 'subjects',
  alias: ['subjectlist'],
  react: '📋',
  desc: 'Show every subject/medium/year in the library',
  category: 'main',
  filename: __filename
}, async (sock, mek, m, ctx) => {
  try {
    const { index } = await getIndex();
    if ((ctx.args || [])[0] === 'check') {
      // owner-only audit: exactly WHAT was counted and WHERE from
      if (!(ctx.isOwner || ctx.isMe)) return ctx.reply('⛔ Owner only.');
      const inv = smart.subjectsInIndex(index);
      const by = (s) => inv.filter((e) => e.src === s).map((e) => e.label);
      const names = by('name'), files = by('files'), folders = by('folder');
      return ctx.reply(
        `📋 *Subject inventory check* — ${inv.length} total\n\n` +
        `🔎 From names/aliases (${names.length}):\n${names.join(', ')}\n\n` +
        (files.length ? `🌐 Language subjects from files (${files.length}):\n${files.join(', ')}\n\n` : '') +
        `📁 Unknown subject folders (${folders.length}):\n${folders.length ? folders.join(', ') : 'none'}\n\n` +
        `📊 Scanned ${index.files.length} files · ${index.folders.length} folders`
      );
    }
    return ctx.reply(subjectsListMessage(index));
  } catch (e) {
    return ctx.reply('📚 The papers library is being set up — please try again shortly. 🛠️');
  }
});

/* ── .pp — PAST PAPERS interview (welcome-card button) ────────────────── */
cmd({
  pattern: 'pp',
  react: '📚',
  desc: 'Find past papers (year → subject → medium)',
  category: 'main',
  filename: __filename
}, async (sock, mek, m, ctx) => {
  return startOrContinuePaperRequest(sock, mek, m, ctx, { cat: 'past' });
});

/* ── .ms — start a MARKING SCHEME request (welcome-card button) ───────── */
cmd({
  pattern: 'ms',
  react: '📖',
  desc: 'Ask for a marking scheme / answer sheet',
  category: 'main',
  filename: __filename
}, async (sock, mek, m, ctx) => {
  return startOrContinuePaperRequest(sock, mek, m, ctx, { type: 'marking', cat: 'past' });
});

/* ── .ppick — tap answers for paper questions (year/medium/subject) ──── */
const ppickCommand = cmd({
  pattern: 'ppick',
  react: '🧭',
  desc: 'Answer a papers question (used by the tap buttons)',
  category: 'main',
  filename: __filename
}, async (sock, mek, m, ctx) => {
  const { args, reply } = ctx;
  const sk = skey(ctx);
  pruneInterviews();
  let field = String(args[0] || '').toLowerCase();
  let value = args.slice(1).join(' ').trim().toLowerCase();
  let st = null;
  if (!FIELD_WORDS.has(field)) {
    // tapped from a specific card: ".ppick <reqId> year 2016" — the tap must
    // answer ITS OWN request, never whichever one is newest
    const byId = ivList(sk).find((s) => s.id === field);
    if (byId) {
      st = byId;
      field = String(args[1] || '').toLowerCase();
      value = args.slice(2).join(' ').trim().toLowerCase();
    }
  }

  if (field === 'cancel') {
    delete interviews[sk];   // cancel clears ALL pending requests
    return reply('👌 Cancelled — send *papers* whenever you need 📚');
  }
  if (!st) st = ivNewest(sk) || { id: null, subject: null, year: null, medium: null, type: null, cat: null };
  if (field === 'year' && /^\d{4}$/.test(value)) {
    st.year = parseInt(value, 10);
  } else if (field === 'medium') {
    const mk = Object.keys(MEDIUMS).find((k) => k === value || MEDIUMS[k].tokens.includes(value));
    if (!mk) return reply('🤔 Which medium — *sinhala*, *english* or *tamil*?');
    st.medium = mk;
  } else if (field === 'subject') {
    const sv = subjectFromTokens(value.split(/\s+/)) || (SUBJECTS[value] ? value : null);
    if (!sv) {
      // unknown subject → show what the library ACTUALLY has (live)
      try {
        const { index } = await getIndex();
        return reply(subjectsListMessage(index));
      } catch (e) {
        return reply("🤔 I didn't catch the subject — e.g. *chem*, *phy*, *bio*.");
      }
    }
    st.subject = sv;
  } else if (field === 'type') {
    st.type = ['marking', 'mcq', 'essay', 'paper'].includes(value) ? value : null;
  } else if (field === 'cat') {
    st.cat = CATEGORIES[value] ? value : null;
  } else {
    return reply('🤔 That option expired — send *papers* to start again 📚');
  }
  st.at = Date.now();
  return startOrContinuePaperRequest(sock, mek, m, ctx, st);
});

/* ── no-prefix triggers — students just type "papers" / "chemistry past papers" ── */
let settingsPlugin = null;
try { settingsPlugin = require('./settings'); } catch (e) { /* optional */ }

// Words that mark a message as a papers request.
const TRIGGER_WORDS = new Set(['papers', 'paper', 'pastpapers', 'pastpaper', 'past', 'pp']);
// Subjects/vocab a bare message must contain to count as a trigger (KB-driven).
const isKnownWord = (t) => !!smart.SYNONYMS[t] ||
  Object.values(smart.SYNONYMS).some((vars) => vars.includes(t));

cmd({
  // no pattern + filter → registered as a reply handler (runs on every text)
  noPrefixTriggers: true,
  filter: (text, extra) => {
    try {
      if (!config.isEnabled('PAPERS_NO_PREFIX')) return false;

      // students only — never react to the bot's own messages (loop guard)
      const mek = extra && extra.message;
      if (!mek || mek.key?.fromMe) return false;
      const jid = String(mek.key?.remoteJid || '');
      if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return false;

      const body = String(text || '').trim();
      if (!body || body.length > 60 || /\n|https?:\/\//i.test(body)) return false;
      if (body.startsWith(config.PREFIX)) return false;      // normal pipeline handles these
      if (settingsPlugin && settingsPlugin.isPending &&
          settingsPlugin.isPending(extra.sender)) return false;  // don't steal setting values

      const norm = body.toLowerCase().replace(/\u200D/g, '')
        .replace(/[^\p{L}\p{M}\p{N}\s/]+/gu, ' ')
        .replace(/\s+/g, ' ').trim();
      const tokens = norm.split(' ').filter(Boolean);

      // compound one-word forms: "pastpapers", "alpapers", …
      const squashed = norm.replace(/\s+/g, '');
      if (['papers', 'pastpapers', 'pastpaper', 'alpastpapers', 'alpapers'].includes(squashed)) return true;

      // STRUCTURED request: "2016 chemistry sinhala medium" (short terms &
      // typos welcome). Triggers even when the subject is unknown, so the
      // student gets the usage guide instead of silence.
      const sq = smart.parsePaperQuery(norm);
      if (sq && (sq.subject || sq.hasMediumNoun)) return true;

      // pending paper interview — only a BARE ANSWER ("2020", "sinhala",
      // "marking", "physics") is taken as the reply; greetings and other
      // chat fall through to their own flows (greeting guide / silence)
      const ivKey = `${extra.message?.key?.remoteJid}:${extra.sender}`;
      if (ivList(ivKey).length > 0 && tokens.length <= 2) {
        const d2 = dimsFromText(norm);
        const dimCount = ['subject', 'medium', 'cat', 'type'].filter((k) => d2[k]).length +
          (/^(19|20)\d{2}$/.test(tokens[0]) ? 1 : 0);
        if (dimCount >= 1) return true;
        if (['cancel', 'stop', 'exit', 'epa', 'nathi'].includes(tokens[0])) return true;
      }

      // conversational knowledge base: "you have it?", "do you have
      // papers?", "need paper", "paper thiyenawada?" — real asks get real
      // answers, never silence (only when nothing is pending)
      if (ivList(ivKey).length === 0 && kb.detect(norm)) return true;

      // FREE-FORM: any short message mentioning papers ("i want 2020 A/L
      // chemistry past paper") or a year + subject ("2019 chemistry") goes
      // to the AI brain — it decides if it's a real request.
      if (tokens.length <= 12 && tokens.some((t) => TRIGGER_WORDS.has(t))) return true;
      if (tokens.length <= 8 && tokens.some((t) => /^\d{4}$/.test(t)) &&
          tokens.some((t) => isKnownWord(t.replace(/\//g, '')))) return true;
      // any language: Sinhala/Tamil short messages reach the AI brain too —
      // it translates and decides (students write in their own words)
      if (tokens.length <= 8 && /[^\x00-\x7F]/.test(norm)) return true;

      // "papers …" — next/prev/home/back/numbers/queries
      if (tokens[0] === 'papers') {
        const rest = tokens.slice(1);
        return rest.length <= 3 && rest.every((t) => t.length >= 1 && t.length <= 24);
      }
      // "paper 2" (download item) or "paper chemistry" (search by name)
      if (tokens[0] === 'paper') {
        const rest = tokens.slice(1);
        if (rest.length === 1 && /^\d{1,3}$/.test(rest[0])) return true;
        return rest.length >= 1 && rest.length <= 3 && rest.every(isKnownWord);
      }
      // "<subject> past papers / papers / pp" → <subject> must be real
      // subject words ("chemistry past papers" ✓, "this paper is hard" ✗)
      if (tokens.some((t) => TRIGGER_WORDS.has(t))) {
        const rest = tokens
          .filter((t) => !TRIGGER_WORDS.has(t) && !smart.STOPWORDS.has(t))
          .map((t) => t.replace(/\//g, ''));
        if (rest.length === 0) return true;                      // bare "papers"
        if (rest.length <= 4 && rest.every(isKnownWord)) return true;
        return false;
      }

      // bare subject phrase ("chemistry", "phy", "business studies") → search
      if (tokens.length >= 1 && tokens.length <= 3 &&
          tokens.every((t) => t.length >= 2 && isKnownWord(t))) return true;

      return false;
    } catch (e) {
      console.error('papers no-prefix filter error:', e.message || e);
      return false;
    }
  }
}, async (sock, mek, m, ctx) => {
  try {
    if (!rootId()) {
      return ctx.reply('📚 Past papers are not set up yet — the admin is on it! 🛠️');
    }
    // acknowledge the student's message — but stay FULLY silent for repeat
    // guide-asks inside the anti-spam window (no react, no guide)
    const earlyBody = String(ctx.body || '');
    const earlyDims = dimsFromText(earlyBody);
    const earlyParsed = parsePaperQuery(earlyBody);
    // 📚 react = "seen" ack — ALWAYS, groups + inbox. The filter only admits
    // messages the bot will answer, so every handler run reacts.
    try { await sock.sendMessage(ctx.from, { react: { text: '📚', key: mek.key } }); } catch (e) { /* optional */ }

    const body = String(ctx.body || '').toLowerCase().replace(/\u200D/g, '')
      .replace(/[^\p{L}\p{M}\p{N}\s/]+/gu, ' ')
      .replace(/\s+/g, ' ').trim();
    const tokens = body.split(' ').filter(Boolean);
    const pass = (o) => Object.assign({}, ctx, o);

    // compound one-word forms → main menu
    const squashed = body.replace(/\s+/g, '');
    if (['papers', 'pastpapers', 'pastpaper', 'alpastpapers', 'alpapers'].includes(squashed)) {
      return papersCommand.function(sock, mek, m, pass({ args: [] }));
    }
    // "papers next" / "papers 2021" / "papers chemistry" → .papers behaviour
    // (conversational asks like "paper venum" / "papers oni" skip this —
    // the knowledge base answers them below)
    if (tokens[0] === 'papers' && !kb.detect(body)) {
      return papersCommand.function(sock, mek, m, pass({ args: tokens.slice(1) }));
    }
    // "paper 2" / "paper chemistry" → .paper behaviour
    if (tokens[0] === 'paper' && !kb.detect(body)) {
      return paperCommand.function(sock, mek, m, pass({ args: tokens.slice(1) }));
    }
    // "paper <words>" — numbers open the list item; structured queries
    // ("paper 2016 chem sinhala") go through the .paper command
    if (tokens[0] === 'paper' && !kb.detect(body)) {
      const rest = tokens.slice(1);
      const sp = smart.parsePaperQuery(rest.join(' '));
      if (sp && sp.subject) {
        return paperCommand.function(sock, mek, m, pass({ args: rest }));
      }
      return usageGuide(ctx);
    }

    // pending requests in short-term memory — decide: ANSWER the newest
    // question, or REMEMBER a new request alongside it? (never merged)
    const skIv = skey(ctx);
    pruneInterviews();
    const pending = ivList(skIv);
    if (pending.length) {
      const iv = pending[pending.length - 1];   // typed text answers the NEWEST card
      const ans = parseInterviewAnswer(body);
      const nowParsed = parsePaperQuery(body);
      const nowDims = dimsFromText(body);
      const nowTokens = body.split(/\s+/).filter(Boolean);

      // complete new request → NEWEST WINS (deliver it now; older pendings
      // stay in memory and stay answerable from their own cards)
      const completeNew = (nowParsed && nowParsed.year && (nowParsed.subject || nowParsed.medium)) ||
        (nowDims.subject && nowDims.year);
      if (completeNew) {
        return startOrContinuePaperRequest(sock, mek, m, ctx, nowParsed || nowDims);
      }
      if (ans && ans.cancel) {
        delete interviews[skIv];   // cancel clears ALL pending requests
        return ctx.reply('👌 Cancelled — send *papers* whenever you need 📚');
      }
      // which field is the pending question actually asking for?
      const expectedField = !iv.subject ? 'subject' : (!iv.year ? 'year' : 'medium');
      const dimsPresent = ['subject', 'year', 'medium', 'type', 'cat'].filter((k) => nowDims[k]);
      const bare = nowTokens.length <= 2 && dimsPresent.length >= 1 && dimsPresent.length <= 2;
      const answersPending = bare && (dimsPresent.includes(expectedField) ||
        dimsPresent.every((d) => d === 'type' || d === 'cat'));
      if (answersPending) {
        // ambiguous words ('sinhala' = subject AND medium) resolve to the
        // field the pending question is actually asking about
        const field = dimsPresent.includes(expectedField) ? expectedField
          : dimsPresent.find((d) => d === 'type' || d === 'cat');
        return ppickCommand.function(sock, mek, m, pass({ args: [field, String(nowDims[field])] }));
      }
      // a NEW partial paper ask ("i want physics papers now") → remembered as
      // its OWN request; the older ones stay alive and answerable via their
      // cards. Pronouns are stripped first so "you have it?" (it ≠ ICT here)
      // never hijacks the pending request.
      const supDims = dimsFromText(kb.stripPronouns(body));
      if (supDims.subject || supDims.year) {
        return startOrContinuePaperRequest(sock, mek, m, ctx, supDims);
      }
      // anything else while a request is pending: fall through SILENTLY —
      // no react, no AI, no guide. Memory lives for 24 hours.
      return;
    }

    // STRUCTURED request → "2016 chemistry sinhala medium" (missing details
    // start a short interview instead of dumping a loose list)
    const parsed = smart.parsePaperQuery(body);
    if (parsed && parsed.year && (parsed.subject || parsed.medium)) {
      return startOrContinuePaperRequest(sock, mek, m, ctx, parsed);
    }

    // AI-FIRST: the Gemini brain interprets ANY free-form message using the
    // real library structure (years + subjects from the Drive index), then
    // the bot does the actual lookup — AI can never invent files.
    let index = null;
    try { index = (await getIndex()).index; } catch (e) { /* fall back below */ }
    if (index) {
      const interp = await smart.aiInterpret(ctx.body, index);
      if (interp && interp.action === 'find') {
        // strict match; missing year/medium/subject → ASK, never a dump
        return startOrContinuePaperRequest(sock, mek, m, ctx, interp);
      }
      if (interp && interp.action === 'search') {
        const res = smart.searchIndex(index, interp.keywords);
        if (res.items.length > 0) {
          return showView(sock, mek, m, ctx, { kind: 'search', query: interp.keywords, original: ctx.body, ai: true }, 1);
        }
        return ctx.reply(
          `🔍 *No papers found* 🤔\n` +
          `💡 Try the short style: *2019 chem sinhala*\n` +
          `💡 Or send *papers* to browse 📂`
        );
      }
      // action 'none' / unusable → local fallback decides below
    }

    // conversational knowledge base (local, always on) — availability
    // answers ("you have it?") and the guide for generic asks
    // ("i need papers?"). Runs after the AI brain (AI-first) and only when
    // the student has NO pending request and the message has no details.
    const skKb = skey(ctx);
    if (ivList(skKb).length === 0) {
      const ki = kb.detect(body);
      if (ki) {
        const kbDims = dimsFromText(kb.stripPronouns(body));
        if (!kbDims.subject && !kbDims.year && !kbDims.medium) {
          if (ki === 'availability') {
            return ctx.reply('Yes! 📚 I have A/L *past papers* & *marking schemes* for every subject.\nJust type like *2016 chemistry sinhala* — or send *papers* to browse 📖');
          }
          return usageGuide(ctx);
        }
      }
    }

    // LOCAL FALLBACK (keys exhausted, AI down, or AI unsure): the local
    // brain extracts year/subject/medium and ASKS for what's missing —
    // never a loose multi-page dump.
    const dims = dimsFromText(body);
    if (dims.subject || dims.year) {
      return startOrContinuePaperRequest(sock, mek, m, ctx, dims);
    }
    // nothing usable at all → teach the format
    return usageGuide(ctx);
  } catch (e) {
      console.error('papers no-prefix handler error:', e.message || e);
    try {
      return await ctx.reply(`❌ ${gdrive.friendlyError(e)}`);
    } catch (e2) {
      console.error('papers: even the error reply failed:', e2.message || e2);
      return sock.sendMessage(ctx.from, { text: `❌ ${gdrive.friendlyError(e)}` });
    }
  }
});

/* ── .papersetup — owner-only guide ──────────────────────────────────── */
cmd({
  pattern: 'papersetup',
  alias: ['drivesetup'],
  react: '🛠️',
  desc: 'Setup guide for the Google Drive papers plugin (owner only)',
  category: 'owner',
  filename: __filename
}, async (sock, mek, m, ctx) => {
  const { isOwner, isMe, reply } = ctx;
  if (!isOwner && !isMe) return reply('⛔ Owner only.');
  return reply(
    `🛠️ *PAPERS SETUP* (current auth: ${gdrive.authMode()})\n\n` +
    `*1.* console.cloud.google.com → create/select a project\n` +
    `*2.* APIs & Services → Library → enable *Google Drive API*\n` +
    `*3.* Credentials → *Create credentials → API key*\n` +
    `*4.* In Google Drive: right-click your papers folder → Share → *Anyone with the link → Viewer*\n` +
    `*5.* Copy the folder ID from its URL: drive.google.com/drive/folders/` +
    '`<THIS_PART>`\n' +
    `*6.* Send these two commands:\n` +
    `\`${config.PREFIX}settings set GDRIVE_API_KEY AIza…\`\n` +
    `\`${config.PREFIX}settings set GDRIVE_FOLDER_ID <folder id or URL>\`\n` +
    `*7.* Test with \`${config.PREFIX}papers\` 🎉\n\n` +
    `_Want the folder private instead? Use a Google Cloud *service account*: save its JSON as gdrive-service-account.json in the bot folder (or the GOOGLE_SERVICE_ACCOUNT_JSON secret on GitHub Actions) and share the papers folder with the service account's e-mail as Viewer — no API key needed. See README.md._`
  );
});

module.exports = {
  resolveView, renderText, renderRows: buildRows, getIndex, downloadEntry, enqueue,
    sendHubCard,
  buildGuide, usageGuide, fmtSize, cleanName, mimeFor, fileNameFor,
  __interviews: interviews,
  subjectsListMessage,
  __askMissing: askMissing,
  searchFiles: (index, query) => smart.searchIndex(index, query).items
};

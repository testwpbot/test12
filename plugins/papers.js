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
const { isTapResponse } = require('../lib/msg');
const { parsePaperQuery, matchPaper, SUBJECTS, MEDIUMS, CATEGORIES, TYPE_WORDS, classifyFileName, subjectFromTokens, classifyAll } = require('../lib/papersearch');

/* ── tunables ────────────────────────────────────────────────────────── */
const LIST_TTL = 15 * 60 * 1000;         // how long ".paper N" stays valid
const PAGE_SIZE = 30;                    // entries per text list message
const BUTTON_ROWS = 10;                  // entries per dropdown (WhatsApp row cap)
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
const interviews = {};  // studentKey -> { subject, year, medium, type, at } — missing-detail questions
const lastList = {};    // studentKey -> { view, title, items, page, pages, at }
const cooldowns = {};   // "chat:sender" -> last download ts

/** Per-student state key. */
function skey(ctx) {
  return `${ctx.from}:${ctx.sender || ctx.senderNumber || 'anon'}`;
}
/** Drop stale navigation/list state so old views never leak back in. */
function pruneState() {
  const cutoff = Date.now() - (30 * 60 * 1000);
  for (const map of [browse, lastList, interviews]) {
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
  return [...years].sort();
}
function subjectsForYear(index, year) {
  const subs = new Set();
  for (const c of classifyAll(index).values()) {
    if (c.year === year && c.subject) subs.add(c.subject);
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
function filterByType(index, files, type) {
  if (!type) return files;
  const cls = classifyAll(index);
  if (type === 'paper') {
    const exact = files.filter((f) => {
      const c = cls.get(f) || {};
      const isMarking = c.typeKind === 'marking' || (c.extra || []).some((w) => TYPE_WORDS.marking.includes(w));
      const isMcq = (c.extra || []).includes('mcq');
      return !isMarking && !isMcq;
    });
    return exact.length ? exact : files;
  }
  const hit = files.filter((f) => {
    const c = cls.get(f) || {};
    if (type === 'marking') return c.typeKind === 'marking' || (c.extra || []).some((w) => TYPE_WORDS.marking.includes(w));
    return (c.extra || []).some((w) => TYPE_WORDS[type].includes(w));
  });
  return hit.length ? hit : files;
}

/** The "not found" reply with available-subjects hint (shared). */
async function paperNotFound(ctx, index, q, degraded) {
  const subLabel = SUBJECTS[q.subject] ? SUBJECTS[q.subject].label : (q.subjectRaw || '');
  const medLabel = MEDIUMS[q.medium] ? MEDIUMS[q.medium].label : null;
  const catLabel = CATEGORIES[q.cat] && q.cat !== 'past' ? CATEGORIES[q.cat].label : null;
  const label = `${catLabel ? catLabel + ' ' : ''}${q.year || ''}${subLabel ? ` ${subLabel}` : ''}${medLabel ? ` — ${medLabel} medium` : ''}`.trim();
  const yearFolder = index.folders.find((f) => (f.path || []).some((n) => String(n).includes(String(q.year || ''))));
  let hint = '';
  if (yearFolder) {
    const depth = yearFolder.path.length;
    const subs = [...new Set(index.folders
      .filter((f) => f.path.length === depth + 1 && f.path[depth - 1] === yearFolder.path[depth - 1])
      .map((f) => f.path[depth]))].slice(0, 8);
    if (subs.length) hint = `\n📚 In *${q.year}* we have: ${subs.join(', ')}`;
  }
  return ctx.reply(
    `❌ *Paper not found:* ${label}\n` +
    `That combination isn't in the library yet.${hint}\n\n` +
    `💡 Try another medium, or send *papers* to browse 📂` +
    (degraded ? '\n⚠️ _Saved copy shown — Drive unreachable right now._' : '')
  );
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
  if (!st.year) {
    const years = yearsFor(index, st.subject, st.medium, st.cat);
    const shown = years.slice(0, BUTTON_ROWS);
    rows = shown.map((y) => ({ id: `${config.PREFIX}ppick year ${y}`, title: `📅 ${y}`, description: `${st.subject ? SUBJECTS[st.subject].label : 'Papers'} ${y}` }));
    if (years.length > shown.length) more = `\n📄 …and ${years.length - shown.length} more years — type the year`;
    question = '📅 *What year do you need?*';
    listTitle = '🗓️ Pick a year…';
  } else if (!st.subject) {
    const subs = subjectsForYear(index, st.year);
    const shown = subs.slice(0, BUTTON_ROWS);
    rows = shown.map((s) => ({ id: `${config.PREFIX}ppick subject ${s}`, title: `📘 ${SUBJECTS[s].label}`, description: `${st.year} papers` }));
    if (subs.length > shown.length) more = `\n📄 …and ${subs.length - shown.length} more — type the subject name`;
    question = '📘 *Which subject do you need?*';
    listTitle = '📘 Pick a subject…';
  } else {
    const meds = mediumsFor(index, st.year, st.subject);
    rows = meds.map((mk) => ({ id: `${config.PREFIX}ppick medium ${mk}`, title: `🌐 ${MEDIUMS[mk].label}`, description: `${st.year} ${SUBJECTS[st.subject].label} — ${MEDIUMS[mk].label}` }));
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
    try {
      await m.sendButtonMenu({
        title: '',
        text: body,
        footer: `${config.BOT_NAME} • 🎓 Educational Assistant`,
        listTitle,
        sections: [{ title: '🧭 Tap your answer', rows }]
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
  const prev = interviews[sk] || {};
  const st = {
    subject: q.subject || prev.subject || null,
    year: Number.isFinite(q.year) && q.year ? q.year : (prev.year || null),
    medium: q.medium || prev.medium || null,
    type: q.type || prev.type || null,
    cat: q.cat || prev.cat || null,
    at: Date.now()
  };
  if (st.year && st.subject && st.medium) {
    delete interviews[sk];
    return directPaperRequest(sock, mek, m, ctx, st);
  }
  const { index, degraded } = await getIndex();
  if (st.year && st.subject && !mediumsFor(index, st.year, st.subject, st.cat).length) {
    // files may exist WITHOUT medium tags — show them instead of asking a
    // question the library cannot answer
    if (!matchPaper(index, { year: st.year, subject: st.subject, cat: st.cat }).length) {
      delete interviews[sk];
      return paperNotFound(ctx, index, st, degraded);
    }
    if (st.medium) {   // a medium WAS requested but nothing matches it
      delete interviews[sk];
      return paperNotFound(ctx, index, st, degraded);
    }
    delete interviews[sk];
    return directPaperRequest(sock, mek, m, ctx, st);
  }
  if (!st.subject && st.year && !subjectsForYear(index, st.year).length) {
    delete interviews[sk];
    return paperNotFound(ctx, index, st, degraded);
  }
  interviews[sk] = st;
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
function usageGuide(ctx) {
  const words = Object.values(SUBJECTS).map((s) => s.label);
  const shorts = 'chem • phy • bio • com maths • agri • econ • bs • acc • ict • et • sft • bst • stat';
  return ctx.reply(
    `📖 *How to ask for a paper*\n\n` +
    `Type: *Year + Subject + Medium*\n` +
    `Example: *2016 chemistry sinhala medium*\n\n` +
    `🔤 Short terms: ${shorts}\n` +
    `🌐 Mediums: sinhala • english • tamil\n\n` +
    `📚 Or send *papers* to browse the full menu (${words.length} subjects)`
  );
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

  return paperNotFound(ctx, index, q, degraded);
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
    if (!query) {
      // Bare "papers" = the main menu, ALWAYS fresh — never resume an old
      // sub-folder position. (back/next still work within an active browse.)
      delete browse[sk];
      return showView(sock, mek, m, ctx, { kind: 'folder', pathIds: [], pathNames: [] }, 1);
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
    // explicit collection without full details ("papers fwc") → interview
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
  const field = String(args[0] || '').toLowerCase();
  const value = args.slice(1).join(' ').trim().toLowerCase();

  if (field === 'cancel') {
    delete interviews[sk];
    return reply('👌 Cancelled — send *papers* whenever you need 📚');
  }
  const st = interviews[sk] || { subject: null, year: null, medium: null, type: null, cat: null };
  if (field === 'year' && /^\d{4}$/.test(value)) {
    st.year = parseInt(value, 10);
  } else if (field === 'medium') {
    const mk = Object.keys(MEDIUMS).find((k) => k === value || MEDIUMS[k].tokens.includes(value));
    if (!mk) return reply('🤔 Which medium — *sinhala*, *english* or *tamil*?');
    st.medium = mk;
  } else if (field === 'subject') {
    const sv = subjectFromTokens(value.split(/\s+/)) || (SUBJECTS[value] ? value : null);
    if (!sv) return reply("🤔 I didn't catch the subject — e.g. *chem*, *phy*, *bio*.");
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

      // pending paper interview — the student is answering our question
      const ivKey = `${extra.message?.key?.remoteJid}:${extra.sender}`;
      if (interviews[ivKey] && tokens.length <= 6) return true;

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
    // acknowledge the student's message
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
    if (tokens[0] === 'papers') {
      return papersCommand.function(sock, mek, m, pass({ args: tokens.slice(1) }));
    }
    // "paper 2" / "paper chemistry" → .paper behaviour
    if (tokens[0] === 'paper') {
      return paperCommand.function(sock, mek, m, pass({ args: tokens.slice(1) }));
    }
    // "paper <words>" — numbers open the list item; structured queries
    // ("paper 2016 chem sinhala") go through the .paper command
    if (tokens[0] === 'paper') {
      const rest = tokens.slice(1);
      const sp = smart.parsePaperQuery(rest.join(' '));
      if (sp && sp.subject) {
        return paperCommand.function(sock, mek, m, pass({ args: rest }));
      }
      return usageGuide(ctx);
    }

    // pending interview — the message is (probably) an ANSWER to our question
    const skIv = skey(ctx);
    if (interviews[skIv]) {
      const ans = parseInterviewAnswer(body);
      if (ans && ans.cancel) {
        delete interviews[skIv];
        return ctx.reply('👌 Cancelled — send *papers* whenever you need 📚');
      }
      if (ans && ans.field) {
        return ppickCommand.function(sock, mek, m, pass({ args: [ans.field, String(ans.value)] }));
      }
      // not an answer — keep the interview and continue below
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
  fmtSize, cleanName, mimeFor, fileNameFor,
  searchFiles: (index, query) => smart.searchIndex(index, query).items
};

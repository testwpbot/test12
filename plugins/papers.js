/**
 * .papers / .paper — download past papers from the bot owner's Google Drive.
 *
 * Students in the group can browse and download papers without any admin:
 *   .papers                     → browse the papers folder (numbered list)
 *   .papers <words>             → search, e.g. `.papers chemistry 2021`
 *   .papers next | 2            → more pages
 *   .papers back | home         → folder navigation
 *   .paper <number>             → open folder n / download file n
 *   .paper <words>              → download by name
 *   .papersetup                 → owner-only setup guide
 *
 * Setup (owner): .papersetup — needs GDRIVE_API_KEY + GDRIVE_FOLDER_ID in
 * .settings, or a service-account JSON for a private folder (see README).
 */

const { cmd } = require('../command');
const config = require('../config');
const gdrive = require('../lib/gdrive');

/* ── tunables ────────────────────────────────────────────────────────── */
const LIST_TTL = 15 * 60 * 1000;         // how long ".paper N" stays valid
const PAGE_SIZE = 30;                    // entries per list message
const MAX_ACTIVE_DOWNLOADS = 2;          // parallel uploads to WhatsApp
const DEFAULT_MAX_MB = 95;
const DEFAULT_COOLDOWN = 30;             // seconds between downloads per user
const DEFAULT_CACHE_MIN = 10;            // drive index cache

/* ── state ───────────────────────────────────────────────────────────── */
let cache = { at: 0, building: null, index: null };
const browse = {};      // chat -> { pathIds:[], pathNames:[] }  (root = empty)
const lastList = {};    // chat -> { view, title, items, page, pages, at }
const cooldowns = {};   // "chat:sender" -> last download ts
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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
function matchText(entry) {
  return `${entry.name} ${pathLabel(entry.path)}`.toLowerCase();
}
function searchFiles(index, query) {
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return index.files.filter((f) => tokens.every((t) => matchText(f).includes(t)));
}

/* ── view resolution + rendering ─────────────────────────────────────── */
function helpLines() {
  return (
    `📥 Download: \`${config.PREFIX}paper <number>\`\n` +
    `🔍 Search: \`${config.PREFIX}papers <words>\`  |  📄 More: \`${config.PREFIX}papers next\``
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
    const items = searchFiles(index, view.query).slice(0, 150);
    return { title: `🔍 *"${view.query}"* — ${items.length} found`, items, isSearch: true, degraded };
  }

  const names = (view.pathNames && view.pathNames.length)
    ? view.pathNames
    : [index.root.name];

  const isDirectChildFolder = (f) =>
    f.path.length === names.length + 1 && names.every((n, i) => f.path[i] === n);
  const isDirectFile = (f) =>
    f.path.length === names.length && names.every((n, i) => f.path[i] === n);

  const items = [
    ...index.folders.filter(isDirectChildFolder).map((f) => ({ ...f, _folder: true })),
    ...index.files.filter(isDirectFile).map((f) => ({ ...f, _folder: false }))
  ];
  return { title: `🗂️ *${pathLabel(names)}*`, items, isSearch: false, degraded };
}

/** Render a resolved view into the list message text. */
function renderText(resolved, page) {
  const pages = Math.max(1, Math.ceil(resolved.items.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page || 1), pages);
  const start = (p - 1) * PAGE_SIZE;
  const slice = resolved.items.slice(start, start + PAGE_SIZE);

  let text = `📚 *PAST PAPERS*\n${resolved.title}  (page ${p}/${pages})\n\n`;
  if (slice.length === 0) text += '_No files found here._\n';
  slice.forEach((it, i) => {
    const n = start + i + 1;
    if (it._folder) {
      text += `${n}. 📁 *${cleanName(it.name)}*\n`;
    } else {
      const size = it.size ? ` (${fmtSize(it.size)})` : '';
      const where = resolved.isSearch && it.path.length > 1
        ? `\n     ↳ _${pathLabel(it.path.slice(1))}_`
        : '';
      text += `${n}. 📄 ${cleanName(it.name)}${size}${where}\n`;
    }
  });
  text += `\n${helpLines()}`;
  if (pages > 1 && p < pages) text += `\n➡️ Next page: \`${config.PREFIX}papers next\``;
  if (resolved.degraded) {
    text += `\n\n⚠️ _Showing a saved copy — Google Drive is unreachable right now, so very new files may be missing._`;
  }
  return { text, page: p, pages };
}

async function showView(sock, mek, { from, reply }, view, page) {
  const resolved = await resolveView(view);
  const { text, page: p, pages } = renderText(resolved, page);
  lastList[from] = {
    view,
    title: resolved.title,
    items: resolved.items,
    page: p,
    pages,
    at: Date.now()
  };
  return reply(text);
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
  await reply(`📥 Fetching *${fname}*${sizeTxt} — one moment…`);

  enqueue(async () => {
    try {
      const buf = await gdrive.downloadFile(entry);
      const caption = `📚 *${fname}*\n${isGroup ? `👤 @${senderNumber}\n` : ''}_Shared via ${config.BOT_NAME} 🎓_`;
      await sock.sendMessage(from, {
        document: buf,
        fileName: fname,
        mimetype: mimeFor(entry),
        caption,
        ...(isGroup ? { mentions: [sender] } : {})
      }, { quoted: mek });
      await sock.sendMessage(from, { react: { text: '✅', key: mek.key } });
      console.log(`📚 Sent paper "${fname}" to ${from}`);
    } catch (e) {
      console.error('❌ paper download failed:', e.message || e);
      await sock.sendMessage(from, { react: { text: '❌', key: mek.key } });
      await reply(`❌ Couldn't fetch that paper.\n${gdrive.friendlyError(e)}`);
    }
  });
}

/* ── .papers — browse / search ───────────────────────────────────────── */
cmd({
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

    if (arg0 === 'home') {
      delete browse[from];
      return showView(sock, mek, ctx, { kind: 'folder', pathIds: [], pathNames: [] }, 1);
    }
    if (arg0 === 'back') {
      const b = browse[from];
      if (!b || b.pathIds.length === 0) {
        return reply(`ℹ️ Already at the top level. Send \`${config.PREFIX}papers home\` to refresh.`);
      }
      b.pathIds.pop();
      b.pathNames.pop();
      return showView(sock, mek, ctx, { kind: 'folder', pathIds: [...b.pathIds], pathNames: [...b.pathNames] }, 1);
    }

    if (arg0 === 'next') {
      const last = lastList[from];
      if (!last) return reply(`ℹ️ Nothing to page — send \`${config.PREFIX}papers\` first.`);
      return showView(sock, mek, ctx, last.view, last.page + 1);
    }

    const query = args.join(' ').trim();
    if (!query) {
      const b = browse[from] || { pathIds: [], pathNames: [] };
      return showView(sock, mek, ctx, { kind: 'folder', pathIds: [...b.pathIds], pathNames: [...b.pathNames] }, 1);
    }
    if (query === 'refresh') {
      if (!isBoss) return reply('⛔ Owner only.');
      cache = { at: 0, building: null, index: null };
      const res = await getIndex({ allowStale: false });
      return reply(`🔄 Papers list refreshed — *${res.index.files.length}* files in *${res.index.folders.length}* folders.`);
    }

    // a folder name (top-level or inside the current folder) always wins —
    // papers are usually sorted in folders like "2021", which look like page
    // numbers. Only fall back to page-jumping when no folder matches.
    const index = (await getIndex()).index;
    const last = lastList[from];
    const cur = browse[from] || { pathNames: [] };
    const curNames = cur.pathNames.length ? cur.pathNames : [index.root.name];
    const isChildFolder = (f) => f.path.length === curNames.length + 1 &&
      curNames.every((n, i) => f.path[i] === n);
    const hit = index.folders.find((f) => (f.path.length === 2 || isChildFolder(f)) &&
      f.path[f.path.length - 1].toLowerCase() === query.toLowerCase());
    if (hit) {
      const inside = hit.path.length === 2
        ? { pathIds: [hit.id], pathNames: [...hit.path] }
        : (() => {
            const ids = [...(browse[from]?.pathIds || [])];
            if (ids[ids.length - 1] !== hit.id) ids.push(hit.id);
            return { pathIds: ids, pathNames: [...hit.path] };
          })();
      browse[from] = inside;
      return showView(sock, mek, ctx, { kind: 'folder', pathIds: [...inside.pathIds], pathNames: [...inside.pathNames] }, 1);
    }
    if (/^\d+$/.test(query) && last && parseInt(query, 10) <= last.pages) {
      return showView(sock, mek, ctx, last.view, parseInt(query, 10));
    }
    return showView(sock, mek, ctx, { kind: 'search', query }, 1);
  } catch (e) {
    console.error('papers list error:', e.message || e);
    if (e && e.code === 'NOT_CONFIGURED') {
      return reply(isBoss ? `📚 Not configured — send \`${config.PREFIX}papersetup\`.` : '📚 Past papers are not set up yet.');
    }
    return reply(`❌ ${gdrive.friendlyError(e)}`);
  }
});

/* ── .paper — open folder / download by number or name ───────────────── */
cmd({
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
      return reply(`❓ Usage:\n\`${config.PREFIX}papers\` — see the list\n\`${config.PREFIX}paper 3\` — download item 3`);
    }

    const last = lastList[from];
    if (/^\d+$/.test(arg)) {
      if (!last || Date.now() - last.at > LIST_TTL) {
        return reply(`🕒 That list expired — send \`${config.PREFIX}papers\` first, then pick a number.`);
      }
      const n = parseInt(arg, 10);
      const entry = last.items[n - 1];
      if (!entry) {
        return reply(`❓ No item ${n} — this list has ${last.items.length} item(s). Send \`${config.PREFIX}papers\` to see it.`);
      }
      if (entry._folder || entry.isFolder) {
        const cur = browse[from] || { pathIds: [], pathNames: [] };
        browse[from] = {
          pathIds: [...cur.pathIds, entry.id],
          pathNames: [...(entry.path || [...cur.pathNames, entry.name])]
        };
        return showView(sock, mek, ctx, {
          kind: 'folder',
          pathIds: [...browse[from].pathIds],
          pathNames: [...browse[from].pathNames]
        }, 1);
      }
      return downloadEntry(sock, mek, ctx, entry);
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
      const matches = searchFiles(index, arg);
      if (matches.length === 0) {
        return reply(`🔍 Nothing matched *"${arg}"*. Try \`${config.PREFIX}papers ${arg}\`.`);
      }
      if (matches.length > 1) {
        let text = `🔍 *${matches.length}* papers matched — be more specific:\n\n`;
        matches.slice(0, 15).forEach((it, i) => {
          text += `${i + 1}. 📄 ${cleanName(it.name)} _(${pathLabel(it.path.slice(1))})_\n`;
        });
        return reply(text);
      }
      entry = matches[0];
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
    "`<THIS_PART>`\n" +
    `*6.* Send these two commands:\n` +
    `\`${config.PREFIX}settings set GDRIVE_API_KEY AIza…\`\n` +
    `\`${config.PREFIX}settings set GDRIVE_FOLDER_ID <folder id or URL>\`\n` +
    `*7.* Test with \`${config.PREFIX}papers\` 🎉\n\n` +
    `_Want the folder private instead? Use a Google Cloud *service account*: save its JSON as gdrive-service-account.json in the bot folder and share the papers folder with the service account's e-mail as Viewer — no API key needed. See README.md._`
  );
});

module.exports = {
  resolveView, renderText, getIndex, downloadEntry, enqueue,
  fmtSize, cleanName, mimeFor, fileNameFor, searchFiles
};

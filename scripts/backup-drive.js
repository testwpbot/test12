#!/usr/bin/env node
/**
 * backup-drive.js — download the ENTIRE Drive papers folder as a local backup.
 *
 * Uses the SAME service-account credentials as the papers plugin:
 *   ./gdrive-service-account.json  (or GOOGLE_SERVICE_ACCOUNT_JSON env)
 * The folder must be shared with the service-account e-mail as Viewer.
 *
 * Usage (from the bot folder on the VPS):
 *   node scripts/backup-drive.js                       # uses GDRIVE_FOLDER_ID from config
 *   node scripts/backup-drive.js <folderId>            # override the folder
 *   node scripts/backup-drive.js <folderId> ./mybackup # override destination too
 *
 * Read-only (drive.readonly scope) — it can never modify your Drive.
 * Files already downloaded with the same size are skipped, so you can
 * re-run it to top up an existing backup.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';

const folderIdArg = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : '';
const destArg = process.argv[3] || '';
let folderId = folderIdArg;
if (!folderId) {
  try {
    folderId = String(require('../config').GDRIVE_FOLDER_ID || '').replace(/^.*\/folders\//, '').replace(/[^A-Za-z0-9_-]/g, '');
  } catch (e) { /* no config — argv required */ }
}
if (!folderId) {
  console.error('Usage: node scripts/backup-drive.js <folderId> [destinationDir]');
  console.error('       (or set GDRIVE_FOLDER_ID in config.js and run without args)');
  process.exit(1);
}
const DEST = path.resolve(destArg || `drive-backup-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);

/* ── service account (same conventions as lib/gdrive.js) ─────────────── */
function loadServiceAccount() {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  const candidates = [];
  if (raw.startsWith('{')) return JSON.parse(raw);
  if (raw) candidates.push(raw);
  candidates.push(path.join(__dirname, '..', 'gdrive-service-account.json'));
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  console.error('❌ No service-account JSON found. Place gdrive-service-account.json next to index.js,');
  console.error('   or set GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON or file path).');
  process.exit(1);
}
const SA = loadServiceAccount();
if (!SA.client_email || !SA.private_key) {
  console.error('❌ That JSON is not a service-account key (client_email / private_key missing).');
  process.exit(1);
}

let token = null;
function b64url(s) { return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function getToken() {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    if (token && token.exp - 60 > now) return resolve(token.value);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ iss: SA.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
    let sig;
    try {
      sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(SA.private_key));
    } catch (e) { return reject(new Error(`Bad private_key: ${e.message}`)); }
    const postData = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(head + '.' + body + '.' + sig)}`;
    const req = https.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (!j.access_token) return reject(new Error(`OAuth failed: ${data.slice(0, 200)}`));
          token = { value: j.access_token, exp: now + Number(j.expires_in || 3600) };
          resolve(token.value);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/* ── Drive API (readonly) ────────────────────────────────────────────── */
async function driveJson(urlPath, params, tries = 4) {
  const qs = new URLSearchParams(params || {}).toString();
  for (let i = 1; i <= tries; i++) {
    try {
      const tk = await getToken();
      const url = `${API}${urlPath}${qs ? '?' + qs : ''}`;
      const j = await new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { Authorization: `Bearer ${tk}` } }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            } else reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`), { code: res.statusCode }));
          });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
      });
      return j;
    } catch (e) {
      const retriable = e.code === 429 || e.code === 500 || e.code === 503;
      if (i === tries || !retriable) throw e;
      const wait = i * 5000;
      console.log(`   ⚠️ ${e.code || ''} — retrying in ${wait / 1000}s (${i}/${tries - 1})…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Stream binary content to a file. Returns bytes written. */
function driveDownload(urlPath, params, destFile) {
  return new Promise(async (resolve, reject) => {
    try {
      const tk = await getToken();
      const qs = new URLSearchParams(params || {}).toString();
      const url = `${API}${urlPath}${qs ? '?' + qs : ''}`;
      const file = fs.createWriteStream(destFile);
      let bytes = 0;
      const req = https.get(url, { headers: { Authorization: `Bearer ${tk}` } }, (res) => {
        if (res.statusCode !== 200) {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => { file.close(); fs.existsSync(destFile) && fs.unlinkSync(destFile); reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 160)}`)); });
          return;
        }
        res.on('data', (c) => { bytes += c.length; });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(bytes)));
        file.on('error', reject);
      });
      req.on('error', (e) => { file.close(); try { fs.unlinkSync(destFile); } catch (_) {} reject(e); });
      req.setTimeout(300000, () => { req.destroy(new Error('download timeout')); });
    } catch (e) { reject(e); }
  });
}

/* ── walk & download ─────────────────────────────────────────────────── */
const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.google-apps.drawing': 'application/pdf'
};

let nFiles = 0, nSkipped = 0, nFailed = 0, totalBytes = 0;
const failures = [];

function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180) || 'file';
}

async function listChildren(id) {
  const out = [];
  let pageToken = '';
  do {
    const j = await driveJson('/files', {
      q: `'${id}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {})
    });
    out.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function walk(folderId, relPath) {
  const kids = await listChildren(folderId);
  for (const k of kids) {
    if (k.mimeType === 'application/vnd.google-apps.folder') {
      const sub = path.join(relPath, safeName(k.name));
      fs.mkdirSync(path.join(DEST, sub), { recursive: true });
      console.log(`📁 ${sub}/`);
      await walk(k.id, sub);
    }
  }
  for (const k of kids.filter((x) => x.mimeType !== 'application/vnd.google-apps.folder')) {
    const dest = path.join(DEST, relPath, safeName(k.name));
    try {
      const size = Number(k.size || 0);
      if (size > 0 && fs.existsSync(dest) && fs.statSync(dest).size === size) {
        nSkipped++; totalBytes += size;
        continue;
      }
      if (GOOGLE_EXPORT[k.mimeType]) {
        const bytes = await driveDownload(`/files/${encodeURIComponent(k.id)}`, {
          supportsAllDrives: 'true', alt: 'media', mimeType: GOOGLE_EXPORT[k.mimeType]
        }, dest + '.pdf');
        nFiles++; totalBytes += bytes;
        console.log(`📄 ${path.join(relPath, safeName(k.name))}.pdf  (${(bytes / 1048576).toFixed(1)} MB)`);
      } else {
        const bytes = await driveDownload(`/files/${encodeURIComponent(k.id)}`, {
          supportsAllDrives: 'true', alt: 'media'
        }, dest);
        nFiles++; totalBytes += bytes;
        console.log(`📄 ${path.join(relPath, safeName(k.name))}  (${(bytes / 1048576).toFixed(1)} MB)`);
      }
    } catch (e) {
      nFailed++;
      failures.push(`${path.join(relPath, safeName(k.name))} — ${e.message}`);
      console.log(`   ❌ ${safeName(k.name)}: ${e.message.slice(0, 120)}`);
    }
  }
}

(async () => {
  console.log(`📥 Backing up Drive folder ${folderId}`);
  console.log(`   to ${DEST}\n`);
  fs.mkdirSync(DEST, { recursive: true });
  const t0 = Date.now();
  try {
    await walk(folderId, '');
  } catch (e) {
    console.error(`\n❌ Walk failed: ${e.message}`);
    console.error('   Is the folder shared with the service-account e-mail as Viewer?');
    process.exit(1);
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n✅ Done in ${mins} min — ${nFiles} downloaded, ${nSkipped} already present, ${nFailed} failed`);
  console.log(`   Total: ${(totalBytes / 1048576).toFixed(1)} MB → ${DEST}`);
  if (failures.length) {
    console.log('\n⚠️ Failed items:');
    for (const f of failures) console.log('   • ' + f);
  }
})();

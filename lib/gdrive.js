/**
 * Minimal Google Drive REST client for DANUWA-MD (no extra npm deps).
 *
 * Auth — first available wins:
 *   1. Service account : env GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON or a file
 *                        path) or ./gdrive-service-account.json
 *                        → works with PRIVATE folders (share the folder with
 *                        the service-account e-mail as Viewer).
 *   2. API key         : config.GDRIVE_API_KEY
 *                        → folder must be shared "Anyone with the link".
 *
 * Access tokens are cached in memory and refreshed automatically.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');

const API_BASE = 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

let saCreds = null;   // parsed service-account JSON | false (checked, missing)
let saToken = null;   // { value, exp }

/* ── service account helpers ─────────────────────────────────────────── */

function loadServiceAccount() {
  if (saCreds !== null) return saCreds;
  try {
    const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
    if (raw.startsWith('{')) {
      saCreds = JSON.parse(raw);
      return saCreds;
    }
    const candidates = [raw, path.join(__dirname, '..', 'gdrive-service-account.json')]
      .filter((p) => p && p.length > 0);
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        saCreds = JSON.parse(fs.readFileSync(p, 'utf8'));
        return saCreds;
      }
    }
  } catch (e) {
    console.error('⚠️ gdrive: could not load service account JSON:', e.message);
  }
  saCreds = false;
  return saCreds;
}

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function serviceAccountToken() {
  const creds = loadServiceAccount();
  if (!creds) return null;
  const now = Math.floor(Date.now() / 1000);
  if (saToken && saToken.exp - 60 > now) return saToken.value;

  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  let sig;
  try {
    sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(creds.private_key));
  } catch (e) {
    throw new Error(`Bad service account private_key: ${e.message}`);
  }
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${head}.${body}.${sig}`
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  if (!data.access_token) throw new Error('Google OAuth did not return an access token');
  saToken = { value: data.access_token, exp: now + Number(data.expires_in || 3600) };
  return saToken.value;
}

/* ── auth resolution ─────────────────────────────────────────────────── */

function authMode() {
  if (loadServiceAccount()) return 'service-account';
  if (String(config.GDRIVE_API_KEY || '').trim()) return 'api-key';
  return 'none';
}

async function authHeadersAndParams() {
  if (authMode() === 'service-account') {
    try {
      const token = await serviceAccountToken();
      return { headers: { Authorization: `Bearer ${token}` }, params: {} };
    } catch (e) {
      console.error('⚠️ gdrive: service account auth failed, trying API key:', e.message);
    }
  }
  const key = String(config.GDRIVE_API_KEY || '').trim();
  if (key) return { headers: {}, params: { key } };
  const err = new Error('Google Drive is not configured yet. Ask the bot owner to send .papersetup');
  err.code = 'GDRIVE_NO_AUTH';
  throw err;
}

/* ── core calls ──────────────────────────────────────────────────────── */

async function driveGet(url, params, responseType) {
  const auth = await authHeadersAndParams();
  const { data } = await axios.get(url, {
    params: { ...(params || {}), ...(auth.params || {}) },
    headers: auth.headers,
    responseType: responseType || 'json',
    timeout: responseType === 'arraybuffer' ? 180000 : 20000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  return data;
}

/** Accepts a bare folder ID or a pasted Drive folder/file URL. */
function extractId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const inUrl = s.match(/\/folders\/([A-Za-z0-9_-]{15,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{15,})/);
  if (inUrl) return inUrl[1];
  const bare = s.match(/^([A-Za-z0-9_-]{15,})$/);
  return bare ? bare[1] : '';
}

/** Files + subfolders directly inside `folderId` (folders first). */
async function listFolder(folderId) {
  const data = await driveGet(`${API_BASE}/files`, {
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'nextPageToken, files(id,name,mimeType,size)',
    pageSize: 200,
    orderBy: 'folder,name_natural'
  });
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType || '',
    isFolder: f.mimeType === FOLDER_MIME,
    size: f.size ? Number(f.size) : null
  }));
}

async function getMeta(id) {
  return driveGet(`${API_BASE}/${id}`, { fields: 'id,name,mimeType,size' });
}

/**
 * Flat recursive index of the papers drive (BFS).
 * Returns { root: {id,name}, folders: [{id,name,path[],depth}], files: [{id,name,mimeType,size,isFolder,path[]}] }
 */
async function buildIndex(rootFolderId, { maxDepth = 5, maxEntries = 1500 } = {}) {
  const rootMeta = await getMeta(rootFolderId);
  const root = { id: rootMeta.id, name: rootMeta.name || 'Papers' };
  const files = [];
  const folders = [];

  let frontier = [{ id: rootFolderId, path: [root.name], depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      let items;
      try {
        items = await listFolder(node.id);
      } catch (e) {
        console.error(`⚠️ gdrive: cannot list folder ${node.path.join('/')}:`, e.message);
        continue;
      }
      for (const it of items) {
        if (it.isFolder) {
          const f = { ...it, path: [...node.path, it.name], depth: node.depth + 1 };
          folders.push(f);
          if (node.depth + 1 < maxDepth) next.push(f);
        } else if (files.length < maxEntries) {
          files.push({ ...it, isFolder: false, path: [...node.path] });
        }
      }
    }
    frontier = next;
  }
  return { root, folders, files };
}

/** Download a file's content as a Buffer. Google Docs/Sheets export as PDF. */
async function downloadFile(file) {
  if (file.mimeType && file.mimeType.startsWith('application/vnd.google-apps')) {
    const buf = await driveGet(`${API_BASE}/files/${file.id}/export`, { mimeType: 'application/pdf' }, 'arraybuffer');
    return Buffer.from(buf);
  }
  const buf = await driveGet(`${API_BASE}/files/${file.id}`, { alt: 'media' }, 'arraybuffer');
  return Buffer.from(buf);
}

/** Readable error text for Drive API failures. */
function friendlyError(e) {
  const api = e && e.response && e.response.data && e.response.data.error ? e.response.data.error : null;
  const status = api ? api.code : (e && e.response ? e.response.status : null);
  if (e && e.code === 'GDRIVE_NO_AUTH') return e.message;
  if (status === 403) {
    return 'Google Drive said *403 Forbidden* — check that the folder is shared as "Anyone with the link → Viewer" (or shared with the service-account e-mail) and that the Drive API is enabled for your key.';
  }
  if (status === 404) return 'Google Drive said *404 Not Found* — the GDRIVE_FOLDER_ID looks wrong. Send .papersetup for help.';
  if (api && api.message) return `Google Drive: ${api.message}`;
  return e && e.message ? e.message : 'Unknown Google Drive error.';
}

module.exports = {
  FOLDER_MIME,
  authMode,
  extractId,
  listFolder,
  getMeta,
  buildIndex,
  downloadFile,
  friendlyError
};

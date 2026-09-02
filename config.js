

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = __filename;
const ENV_FILE = path.join(__dirname, 'config.env');

if (fs.existsSync(ENV_FILE)) {
  try {
    require('dotenv').config({ path: ENV_FILE });
  } catch (e) {
    console.warn('⚠️  config.env found but "dotenv" is not installed — skipping env overrides.');
  }
}

const SETTINGS = {
  PREFIX: ".",
  BOT_NAME: "DANUWA-MD",
  BOT_OWNER: "94776121326",
  LOG_NUMBER: "94776121326",
  ALIVE_MSG: "*Hello👋 DANUWA-MD Is Alive Now😍*",
  ALIVE_IMG: "https://github.com/DANUWA-MD/DANUWA-MD/blob/main/images/DANUWA-MD.png?raw=true",
  AUTO_STATUS_SEEN: "true",
  AUTO_STATUS_REACT: "true",
  BLOCK_CALLS: "true",
  BLOCK_CALLS_MSG: "📵 Sorry, calls are not allowed on this number. Please send a text message instead.",
  GDRIVE_API_KEY: "",
  GDRIVE_FOLDER_ID: "",
  PAPERS_MAX_SIZE_MB: "95",
  PAPERS_COOLDOWN_SEC: "30"
};

/**
 * Read-only values. These are shown in the settings panel but can NOT be
 * changed from WhatsApp — editing them there would break the bot.
 */
const READ_ONLY = {
  SESSION_ID: process.env.SESSION_ID || "XTJQBD6S#M46-4bBlW03pWgCTj2T56xw-9q6_aZ-BUO84qHRNunM",
  PORT: Number(process.env.PORT || 8000)
};

/**
 * Describes every editable setting: what it is, how to validate a new value
 * and how to show it in the panel.
 */
const SETTINGS_META = {
  PREFIX: {
    label: 'Command prefix',
    desc: 'Character(s) every command starts with',
    type: 'text',
    validate: (v) => {
      if (!v.length) return 'Prefix cannot be empty.';
      if (v.length > 5) return 'Prefix must be 5 characters or less.';
      if (/\s/.test(v)) return 'Prefix cannot contain spaces.';
      return true;
    }
  },
  BOT_NAME: {
    label: 'Bot name',
    desc: 'Name shown in menus and startup logs',
    type: 'text',
    validate: (v) => (v.length > 0 && v.length <= 30 ? true : 'Bot name must be 1–30 characters.')
  },
  BOT_OWNER: {
    label: 'Owner number',
    desc: 'Your number — the only one allowed to use .settings',
    type: 'owner',
    validate: (v) => (/^\d{7,15}$/.test(v.replace(/[^\d]/g, '')) ? true : 'Use digits only, e.g. 94774915917.')
  },
  LOG_NUMBER: {
    label: 'Log number',
    desc: 'Receives startup ping + forwarded statuses (also an owner)',
    type: 'owner',
    validate: (v) => (/^\d{7,15}$/.test(v.replace(/[^\d]/g, '')) ? true : 'Use digits only, e.g. 94776121326.')
  },
  ALIVE_MSG: {
    label: 'Alive message',
    desc: 'Reply text sent by the .alive command',
    type: 'text',
    validate: (v) => (v.length > 0 ? true : 'Alive message cannot be empty.')
  },
  ALIVE_IMG: {
    label: 'Alive image',
    desc: 'Image URL used by .alive and the startup ping',
    type: 'url',
    validate: (v) => (/^https?:\/\/.+/i.test(v) ? true : 'Must start with http:// or https://')
  },
  AUTO_STATUS_SEEN: {
    label: 'Auto status seen',
    desc: 'Auto-mark contacts’ statuses as seen',
    type: 'boolean'
  },
  AUTO_STATUS_REACT: {
    label: 'Auto status react',
    desc: 'Auto-react with a random emoji to statuses',
    type: 'boolean'
  },
  BLOCK_CALLS: {
    label: 'Block calls',
    desc: 'Auto-reject calls from non-owner users',
    type: 'boolean'
  },
  BLOCK_CALLS_MSG: {
    label: 'Blocked call message',
    desc: 'Auto-reply to blocked callers (empty = silent)',
    type: 'text',
    validate: (v) => (v.length <= 200 ? true : 'Keep the message under 200 characters.')
  },
  GDRIVE_API_KEY: {
    label: 'Google Drive API key',
    desc: 'Drive API key for the papers plugin (.papersetup)',
    type: 'text',
    validate: (v) => (!v.trim() || v.trim().length >= 20 ? true : 'That API key looks too short.')
  },
  GDRIVE_FOLDER_ID: {
    label: 'Papers folder ID',
    desc: 'Drive folder ID (or paste the folder URL)',
    type: 'text',
    validate: (v) => (!v.trim() || /[A-Za-z0-9_-]{15,}/.test(v) ? true : 'Paste the folder ID or the folder URL.')
  },
  PAPERS_MAX_SIZE_MB: {
    label: 'Max paper size (MB)',
    desc: 'Bigger files send a browser link instead',
    type: 'text',
    validate: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1900
      ? true : 'Use a number of megabytes, e.g. 95.')
  },
  PAPERS_COOLDOWN_SEC: {
    label: 'Download cooldown (sec)',
    desc: 'Wait required between downloads per student',
    type: 'text',
    validate: (v) => (/^\d+$/.test(v) && Number(v) <= 600
      ? true : 'Use a number of seconds, e.g. 30.')
  }
};

// ── runtime store: env var wins over the value written in this file ──
const store = {};
for (const key of Object.keys(SETTINGS)) {
  store[key] = process.env[key] !== undefined ? process.env[key] : SETTINGS[key];
}

const TRUTHY = ['true', '1', 'yes', 'on', 'y'];
const FALSY = ['false', '0', 'no', 'off', 'n'];

/** Read a setting (editable or read-only). */
function get(key) {
  return Object.prototype.hasOwnProperty.call(READ_ONLY, key) ? READ_ONLY[key] : store[key];
}

/** True when a boolean setting is switched on. */
function isEnabled(key) {
  return TRUTHY.includes(String(store[key]).toLowerCase());
}

/** Is this setting editable from WhatsApp? */
function isEditable(key) {
  return Object.prototype.hasOwnProperty.call(store, key);
}

/** Clean up a raw user-typed value (strip whitespace / formatting on numbers). */
function normalizeValue(key, raw) {
  let value = String(raw).trim();
  const type = SETTINGS_META[key] ? SETTINGS_META[key].type : 'text';

  if (type === 'boolean') {
    const v = value.toLowerCase();
    if (TRUTHY.includes(v)) return 'true';
    if (FALSY.includes(v)) return 'false';
    throw new Error('Use one of: true / false (or on / off).');
  }

  if (type === 'owner') value = value.replace(/[^\d]/g, '');

  return value;
}

/** Rewrite `KEY: "value",` inside the SETTINGS block of this file. */
function patchConfigFile(key, value) {
  const src = fs.readFileSync(CONFIG_FILE, 'utf8');
  const marker = 'const SETTINGS = {';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('SETTINGS block not found in config.js');

  const end = src.indexOf('\n};', start);
  if (end === -1) throw new Error('SETTINGS block is not closed in config.js');

  const block = src.slice(start, end).split('\n');
  let found = false;

  const updated = block.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*:\s*/);
    if (m && m[1] === key) {
      found = true;
      return `  ${key}: ${JSON.stringify(String(value))},`;
    }
    return line;
  });

  if (!found) throw new Error(`"${key}" is not declared in the SETTINGS block of config.js`);

  fs.writeFileSync(CONFIG_FILE, src.slice(0, start) + updated.join('\n') + src.slice(end), 'utf8');
}

/**
 * Validate + store a new value.
 * Updates the running process, writes config.js and keeps process.env in sync
 * so an env override can not shadow the new value.
 *
 * @returns {{key: string, previous: string, value: string}}
 */
function set(key, rawValue) {
  key = String(key || '').toUpperCase();

  if (!isEditable(key)) {
    throw new Error(Object.prototype.hasOwnProperty.call(READ_ONLY, key)
      ? `\`${key}\` is read-only — edit it in config.js or in your host env vars.`
      : `Unknown setting \`${key}\`.`);
  }

  const value = normalizeValue(key, rawValue);
  const meta = SETTINGS_META[key];
  if (meta && typeof meta.validate === 'function') {
    const result = meta.validate(value);
    if (result !== true) throw new Error(result || `Invalid value for ${key}.`);
  }

  const previous = store[key];
  if (previous === value) throw new Error(`${key} is already set to \`${value}\`.`);

  patchConfigFile(key, value);
  store[key] = value;
  process.env[key] = value;

  return { key, previous, value };
}

/** Restore one setting (or all of them) to the value shipped in this file. */
function reset(key) {
  key = String(key || '').toUpperCase();

  if (key === 'ALL') {
    const changed = [];
    for (const k of Object.keys(SETTINGS)) {
      if (store[k] !== SETTINGS[k]) {
        const previous = store[k];
        patchConfigFile(k, SETTINGS[k]);
        store[k] = SETTINGS[k];
        process.env[k] = SETTINGS[k];
        changed.push({ key: k, previous, value: SETTINGS[k] });
      }
    }
    return changed;
  }

  if (!isEditable(key)) throw new Error(`Unknown setting \`${key}\`.`);
  const previous = store[key];
  patchConfigFile(key, SETTINGS[key]);
  store[key] = SETTINGS[key];
  process.env[key] = SETTINGS[key];
  return [{ key, previous, value: SETTINGS[key] }];
}

/** Every number that must be treated as the bot owner (digits only, no @). */
function ownerNumbers() {
  const numbers = [get('BOT_OWNER'), get('LOG_NUMBER')]
    .filter(Boolean)
    .map((n) => String(n).replace(/[^\d]/g, ''));
  return [...new Set(numbers)];
}

/** Owner numbers as WhatsApp JIDs. */
function ownerJids() {
  return ownerNumbers().map((n) => `${n}@s.whatsapp.net`);
}

/** Where startup pings and forwarded statuses are delivered. */
function logJid() {
  const number = String(get('LOG_NUMBER') || get('BOT_OWNER')).replace(/[^\d]/g, '');
  return `${number}@s.whatsapp.net`;
}

/** Is `number` (digits, or a full JID) one of the owners? */
function isOwner(number) {
  const raw = String(number || '').replace(/[^\d]/g, '');
  // An empty / digit-less value must NEVER match (owner.endsWith('') is true).
  if (!raw) return false;
  // Also try without a leading zero (local format, e.g. 0774… → 94774…).
  const candidates = [...new Set([raw, raw.replace(/^0+/, '')])].filter(Boolean);
  return ownerNumbers().some((owner) =>
    candidates.some((n) => {
      if (owner === n) return true;
      // Allow matching without country code — but never on tiny fragments.
      return Math.min(owner.length, n.length) >= 7 &&
        (owner.endsWith(n) || n.endsWith(owner));
    })
  );
}

/** Hide most of a secret value before showing it in WhatsApp. */
function mask(value) {
  const v = String(value == null ? '' : value);
  if (!v) return '(not set)';
  return v.length <= 8 ? '••••••' : `${v.slice(0, 6)}••••••${v.slice(-2)}`;
}

/** Snapshot used to render the settings panel. */
function describe() {
  const editable = Object.keys(store).map((key) => ({
    key,
    value: store[key],
    type: (SETTINGS_META[key] && SETTINGS_META[key].type) || 'text',
    label: (SETTINGS_META[key] && SETTINGS_META[key].label) || key,
    desc: (SETTINGS_META[key] && SETTINGS_META[key].desc) || '',
    editable: true
  }));

  const readOnly = Object.keys(READ_ONLY).map((key) => ({
    key,
    value: mask(READ_ONLY[key]),
    rawValue: READ_ONLY[key],
    type: 'readonly',
    label: key === 'SESSION_ID' ? 'Session id' : 'Server port',
    desc: key === 'SESSION_ID' ? 'MEGA session id (read-only)' : 'Express port (read-only)',
    editable: false
  }));

  return { editable, readOnly };
}

/** Re-read this file from disk (used after a manual edit). */
function reload() {
  delete require.cache[require.resolve('./config')];
  return require('./config');
}

const exported = {
  // ── read-only ──
  SESSION_ID: READ_ONLY.SESSION_ID,
  PORT: READ_ONLY.PORT,
  // ── api ──
  SETTINGS_META,
  SETTINGS_DEFAULTS: SETTINGS,
  get,
  set,
  reset,
  reload,
  isEnabled,
  isEditable,
  isOwner,
  ownerNumbers,
  ownerJids,
  logJid,
  mask,
  describe
};

// Live getters so `config.PREFIX` etc. always reflect the latest `.settings`
// change instead of the value captured at require-time.
for (const key of Object.keys(SETTINGS)) {
  Object.defineProperty(exported, key, {
    enumerable: true,
    get: () => store[key]
  });
}

module.exports = exported;

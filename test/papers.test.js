/**
 * Self-contained simulation tests for the .papers plugin + lib/gdrive.
 *
 * Intercepts require('axios') in-process, so no network and no node_modules
 * stubbing is needed. Run:  node test/papers.test.js
 */

/* ── axios interceptor ───────────────────────────────────────────────── */
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const f = (id, name, size) => ({ id, name, mimeType: 'application/pdf', size, isFolder: false });
const d = (id, name) => ({ id, name, mimeType: FOLDER_MIME, isFolder: true });

const C1 = f('FILECHEM1aaaaaaaaaaaaaa', 'Chemistry_PP1.pdf', 2 * 1024 * 1024);
const C2 = f('FILECHEM2aaaaaaaaaaaaaa', 'Chemistry_PP2.pdf', 3 * 1024 * 1024);
const H1 = f('FILEHUGEaaaaaaaaaaaaaaa', 'Huge_Collection.pdf', 200 * 1024 * 1024);
const P1 = f('FILEPHY1aaaaaaaaaaaaaaa', 'Physics_PP1.pdf', 1.5 * 1024 * 1024);
const M1 = f('FILEMATH1aaaaaaaaaaaaaa', 'Maths.pdf', 900 * 1024);
const DOC = { id: 'FILEDOCSaaaaaaaaaaaaaaa', name: 'Syllabus Notes', mimeType: 'application/vnd.google-apps.document' };
const DP = f('FILEDEEPaaaaaaaaaaaaaaa', 'DEEP_Paper.pdf', 1024 * 1024);
const LONG = f('FILELONGaaaaaaaaaaaaaaa', 'Business_Studies_Structured_Essay_Paper_2021_GCE_AL_New_Syllabus.pdf', 4 * 1024 * 1024);

const A16MCQ = f('FILE16AG1aaaaaaaaaaaaaa', '2016_Agriculture_MCQ_Sinhala_Medium.pdf', 1024 * 1024);
const A16ESS = f('FILE16AG2aaaaaaaaaaaaaa', '2016_Agriculture_Essay_Sinhala.pdf', 1024 * 1024);
const A16ENG = f('FILE16AG3aaaaaaaaaaaaaa', '2016_Agriculture_English_Medium.pdf', 2 * 1024 * 1024);
const A16SIN = f('FILE16AG4aaaaaaaaaaaaaa', '2016_Agriculture_Sinhala.pdf', 1024 * 1024);
const B16MCQ = f('FILE16BI1aaaaaaaaaaaaaa', '2016_Biology_MCQ_Sinhala.pdf', 1024 * 1024);
const B16ESS = f('FILE16BI2aaaaaaaaaaaaaa', '2016_Biology_Structured_Sinhala.pdf', 1024 * 1024);

const CHEM20 = f('FILE20CH1aaaaaaaaaaaaaa', '2020_Chemistry_Sinhala_Medium.pdf', 1024 * 1024);

const TREE = {
  ROOT_FOLDER_ID_123456: [d('FOLDER2020aaaaaaaaaaaaaa', '2020'), d('FOLDER2021aaaaaaaaaaaaaa', '2021'), d('FOLDER2016aaaaaaaaaaaaaa', '2016'), d('FOLDEREMPTYaaaaaaaaaaaaa', 'Empty')],
  FOLDER2021aaaaaaaaaaaaaa: [d('FOLDERPHYaaaaaaaaaaaaaaa', 'Physics'), C1, C2, DOC, H1, LONG],
  FOLDERPHYaaaaaaaaaaaaaaa: [P1],
  FOLDER2020aaaaaaaaaaaaaa: [M1, CHEM20],
  FOLDER2016aaaaaaaaaaaaaa: [d('FOLDERAG16aaaaaaaaaaaaaaa', 'Agriculture'), d('FOLDERBI16aaaaaaaaaaaaaaa', 'Biology')],
  FOLDERAG16aaaaaaaaaaaaaaa: [A16MCQ, A16ESS, A16ENG, A16SIN],
  FOLDERBI16aaaaaaaaaaaaaaa: [B16MCQ, B16ESS],
  FOLDERPHYaaaaaaaaaaaaaaa_: [DP] // unreachable decoy (id not referenced)
};
// deep chain: 2021/Physics already above; extend Physics with a subfolder
TREE.FOLDERPHYaaaaaaaaaaaaaaa = [P1, d('SUBDEEPaaaaaaaaaaaaaaa0', 'VeryDeep')];
TREE.SUBDEEPaaaaaaaaaaaaaaa0 = [DP];

const META = { ROOT_FOLDER_ID_123456: 'School Papers' };

let OUTAGE = false;
global.TRANSIENT_FAILS = 0;   // make the next N metadata calls fail once with ECONNRESET
const axiosStub = {
  get: async (url, opts = {}) => {
    if (OUTAGE) {
      const e = new Error('simulated outage');
      e.response = { status: 403, data: { error: { code: 403, message: 'quota exceeded', status: 'PERMISSION_DENIED' } } };
      throw e;
    }
    const q = (opts.params && opts.params.q) || '';
    if (url.endsWith('/drive/v3/files') && q) {
      for (const k of Object.keys(TREE)) {
        if (q.includes(k)) return { data: { files: TREE[k].map((x) => ({ id: x.id, name: x.name, mimeType: x.mimeType, size: x.size })) } };
      }
      return { data: { files: [] } };
    }
    const mE = url.match(/\/files\/([^/]+)\/export/);
    if (mE) return { data: Buffer.from('EXPORTED_PDF_' + mE[1]) };
    const mM = url.match(/\/files\/([^/?]+)$/);
    if (mM && opts.params && opts.params.alt === 'media') return { data: Buffer.from('CONTENT_' + mM[1]) };
    const mM2 = url.match(/\/drive\/v3\/files\/([^/?]+)$/);
    if (mM2 && !(opts.params && opts.params.alt)) {
      if (global.TRANSIENT_FAILS > 0) {
        global.TRANSIENT_FAILS--;
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }
      return { data: { id: mM2[1], name: META[mM2[1]] || mM2[1], mimeType: FOLDER_MIME } };
    }
    // anything else: behave like the real API — reject with a 404
    const e = new Error('Request failed with status code 404');
    e.response = { status: 404, data: { error: { code: 404, message: 'Not Found' } } };
    throw e;
  },
  post: async (url) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      const keyM = url.match(/key=([^&]+)/);
      const tail = keyM ? decodeURIComponent(keyM[1]).slice(-6) : '?';
      global.AI_KEY_CALLS = global.AI_KEY_CALLS || {};
      global.AI_KEY_CALLS[tail] = (global.AI_KEY_CALLS[tail] || 0) + 1;
      global.AI_CALLS = (global.AI_CALLS || 0) + 1;
      if (global.AI_DOWN) { const e = new Error('ai down'); e.response = { status: 503 }; throw e; }
      if (global.AI_429_TAILS && global.AI_429_TAILS.includes(tail)) {
        const e = new Error('Quota exceeded');
        e.response = { status: 429, data: { error: { code: 429, message: 'RESOURCE_EXHAUSTED: quota exceeded' } } };
        throw e;
      }
      const body = global.AI_INTERPRET != null ? global.AI_INTERPRET : (global.AI_EXPANSION || 'chemistry 2021');
      return { data: { candidates: [{ content: { parts: [{ text: body }] } }] } };
    }
    throw new Error('stub: no OAuth in tests');
  }
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') return axiosStub;
  if (request === '@whiskeysockets/baileys') {
    return {
      proto: { Message: { create: (x) => x }, WebMessageInfo: { fromObject: (x) => x } },
      downloadContentFromMessage: async function* () {},
      getContentType: (m) => (m && typeof m === 'object' ? Object.keys(m)[0] : undefined),
      jidNormalizedUser: (j) => j,
      generateWAMessageFromContent: (jid, message, opts) => ({
        key: { id: 'STUBMSG', remoteJid: jid, fromMe: true },
        message
      })
    };
  }
  if (request === 'gifted-btns') {
    return { sendButtons: async () => {}, sendInteractiveMessage: async () => {} };
  }
  if (request === 'form-data') {
    return class FormData {};
  }
  return origLoad.apply(this, arguments);
};

/* ── env + modules under test ────────────────────────────────────────── */
process.env.GDRIVE_FOLDER_ID = 'https://drive.google.com/drive/folders/ROOT_FOLDER_ID_123456';
process.env.GDRIVE_API_KEY = 'AIzaTESTKEY1234567890';
process.env.PAPERS_COOLDOWN_SEC = '60';
process.env.PAPERS_ROOT_NAME = 'AI Mate Papers';
process.env.PAPERS_MAX_SIZE_MB = '95';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { commands } = require('../command');
require('../plugins/papers.js');
const config = require('../config');
const gdrive = require('../lib/gdrive');

const papersCmd = commands.find((c) => c.pattern === 'papers');
const paperCmd = commands.find((c) => c.pattern === 'paper');
const setupCmd = commands.find((c) => c.pattern === 'papersetup');

let sent = [];
const sock = { sendMessage: async (jid, content, opts) => { sent.push({ jid, content, opts }); } };
const mek = { key: { id: 'MSGXYZ', remoteJid: 'GROUP@g.us' } };
const replies = () => sent.filter((s) => s.reply !== undefined).map((s) => s.reply);
const lastReply = () => replies()[replies().length - 1] || '';
const docs = () => sent.filter((s) => s.content && s.content.document);
const reacts = () => sent.filter((s) => s.content && s.content.react).map((s) => s.content.react.text);
const ctx = (over = {}, mekOverride) => Object.assign({
  from: 'GROUP@g.us', args: [], isOwner: true, isMe: false,
  sender: '94777000001@s.whatsapp.net', senderNumber: '94777000001',
  pushname: 'Student', isGroup: true,
  reply: async (t) => { sent.push({ reply: t }); }
}, over);
// harness passes the GLOBAL mek by default; tests can call paperCmd with a custom mek directly
const drain = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '\n      got: ' + String(extra).slice(0, 300) : '')); }
};

(async () => {
  /* 1. root listing */
  await papersCmd.function(sock, mek, {}, ctx());
  let r = lastReply();
  ok(r.includes('AI Mate Papers'), 'root listing shows root name');
  ok(/1\. 📁 \*2020\*/.test(r) && /2\. 📁 \*2021\*/.test(r), 'folders listed first, numbered', r);

  /* 2. folder by name (number-looking names must beat page-jumping) */
  await papersCmd.function(sock, mek, {}, ctx({ args: ['2021'] }));
  r = lastReply();
  ok(r.includes('AI Mate Papers / 2021'), '.papers 2021 opens folder', r);
  ok(/1\. 📁 \*Physics\*/.test(r) && /2\. 📄 Chemistry_PP1\.pdf \(2\.0 MB\)/.test(r), 'subfolder + files with sizes', r);

  /* 3. page jump when no folder matches */
  await papersCmd.function(sock, mek, {}, ctx({ args: ['1'] }));
  ok(lastReply().includes('AI Mate Papers / 2021') && /\(page 1\/1\)/.test(lastReply()), 'page jump works when no folder matches');

  /* 4. download .paper 2 (Chemistry_PP1) */
  sent = [];
  await paperCmd.function(sock, mek, {}, ctx({ args: ['2'] }));
  await drain();
  ok(lastReply().includes('*Downloading* Chemistry_PP1.pdf'), 'ack says Downloading with filename', lastReply());
  ok(lastReply().includes('arrive in this chat'), 'friendly waiting line');
  ok(reacts().includes('⏳') && reacts().includes('✅'), 'react ⏳ → ✅');
  const doc = docs().find((x) => x.opts && x.opts.quoted);
  ok(doc && doc.content.fileName === 'Chemistry_PP1.pdf' && doc.content.mimetype === 'application/pdf', 'document sent with name+mime');
  ok(doc && doc.content.document.toString().startsWith('CONTENT_FILECHEM1'), 'buffer came from Drive');
  ok(doc && doc.content.caption.includes('@94777000001'), 'caption mentions requester');
  ok(doc && doc.content.caption.includes('almate.edu.lk') && doc.content.caption.includes('wa.me/94722002009?text=Start'),
     'caption carries website + contact links', doc && doc.content.caption.split('\n').slice(-4).join(' | '));

  /* 5. google-doc export (fresh chat → fresh cooldown window) */
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'GD@g.us', args: ['2021'], sender: '94777000001@s.whatsapp.net' }));
  await paperCmd.function(sock, mek, {}, ctx({ from: 'GD@g.us', args: ['4'], senderNumber: '94777000001', sender: '94777000001@s.whatsapp.net' }));
  await drain();
  const doc2 = docs().find((x) => x.opts && x.opts.quoted);
  ok(doc2 && doc2.content.fileName === 'Syllabus Notes.pdf' && doc2.content.document.toString().startsWith('EXPORTED_PDF_'), 'google-doc exported as PDF');

  /* 6. oversize → browser link, no upload (fresh chat) */
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'OS@g.us', args: ['2021'], sender: '94777000001@s.whatsapp.net' }));
  await paperCmd.function(sock, mek, {}, ctx({ from: 'OS@g.us', args: ['5'], senderNumber: '94777000001', sender: '94777000001@s.whatsapp.net' }));
  ok(lastReply().includes('too big') && lastReply().includes('drive.google.com/file/d/FILEHUGE'), 'oversize gets browser link');
  ok(docs().length === 0, 'oversize NOT uploaded');

  /* 7. search + deep paths */
  await papersCmd.function(sock, mek, {}, ctx({ args: ['chemistry'] }));
  r = lastReply();
  ok(r.includes('What year do you need') && r.includes('2020') && r.includes('2021'),
     "subject ask '.papers chemistry' → year interview (no dump)", r);
  await papersCmd.function(sock, mek, {}, ctx({ args: ['verydeep'] }));
  r = lastReply();
  ok(r.includes('DEEP_Paper.pdf') && r.includes('↳ _2021 / Physics / VeryDeep_'), 'keyword search still reaches 3 levels deep', r);

  /* 8. deep navigation + back/home */
  await papersCmd.function(sock, mek, {}, ctx({ args: ['2021'] }));
  await paperCmd.function(sock, mek, {}, ctx({ args: ['1'], senderNumber: '94777000001', sender: '94777000001@s.whatsapp.net' })); // Physics
  ok(lastReply().includes('AI Mate Papers / 2021 / Physics'), 'subfolder breadcrumb', lastReply());
  await papersCmd.function(sock, mek, {}, ctx({ args: ['back'], senderNumber: '94777000001', sender: '94777000001@s.whatsapp.net' }));
  ok(/AI Mate Papers \/ 2021\*\s+\(page 1\//.test(lastReply()), 'back goes up one level');
  await papersCmd.function(sock, mek, {}, ctx({ args: ['home'] }));
  ok(/\(page 1\/1\)/.test(lastReply()) && lastReply().includes('AI Mate Papers'), 'home returns to root');

  /* 9. invalid item */
  await paperCmd.function(sock, mek, {}, ctx({ args: ['99'], senderNumber: '94777000001', sender: '94777000001@s.whatsapp.net' }));
  ok(lastReply().includes('No item 99'), 'invalid item handled');

  /* 10. download by name */
  sent = [];
  await paperCmd.function(sock, mek, {}, ctx({ args: ['Maths'], senderNumber: '94777000007', sender: '94777000007@s.whatsapp.net' }));
  await drain();
  const doc4 = docs().find((x) => x.opts && x.opts.quoted);
  ok(doc4 && doc4.content.fileName === 'Maths.pdf', '.paper <name> downloads');

  /* 11. setup gating */
  await setupCmd.function(sock, mek, {}, ctx({ isOwner: true, isMe: true }));
  ok(lastReply().includes('PAPERS SETUP'), 'setup guide for owner');
  await setupCmd.function(sock, mek, {}, ctx({ isOwner: false, isMe: false }));
  ok(lastReply() === '⛔ Owner only.', 'setup denied for strangers');

  /* 12. owner refresh */
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ args: ['refresh'], isOwner: true }));
  ok(/refreshed — \*\d+\* files in \*\d+\* folders/.test(lastReply()), 'owner .papers refresh', lastReply());
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ args: ['refresh'], isOwner: false }));
  ok(lastReply() === '⛔ Owner only.', 'student cannot force refresh');

  /* 13. cooldown (60s from env; every other download used a unique key) */
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'CD@g.us', args: ['2020'], sender: '94711111111@s.whatsapp.net' }));
  await paperCmd.function(sock, mek, {}, ctx({ from: 'CD@g.us', args: ['1'], senderNumber: '94711111111', sender: '94711111111@s.whatsapp.net' })); // open 2020
  sent = [];
  await paperCmd.function(sock, mek, {}, ctx({ from: 'CD@g.us', args: ['1'], senderNumber: '94711111111', sender: '94711111111@s.whatsapp.net' })); // download Maths
  await drain();
  ok(docs().length > 0, 'cooldown: first download passes');
  sent = [];
  await paperCmd.function(sock, mek, {}, ctx({ from: 'CD@g.us', args: ['1'], senderNumber: '94711111111', sender: '94711111111@s.whatsapp.net' }));
  ok(!docs().length && /wait \d+s/.test(lastReply()), 'cooldown: second blocked', lastReply());
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'CD@g.us', args: ['2020'], sender: '94722222222@s.whatsapp.net' })); // own list first
  await paperCmd.function(sock, mek, {}, ctx({ from: 'CD@g.us', args: ['1'], senderNumber: '94722222222', sender: '94722222222@s.whatsapp.net' }));
  await drain();
  ok(docs().length > 0, 'cooldown: other student unaffected (own list, no cooldown)');

  /* 14. outage: degraded browse from disk cache (fresh state via disk file) */
  const diskCache = path.join(__dirname, '..', 'temp', 'papers-index.json');
  assert.ok(fs.existsSync(diskCache), 'disk cache exists from earlier builds');
  OUTAGE = true;
  // force cache expiry by wiping in-memory cache through a fresh plugin module
  delete require.cache[require.resolve('../plugins/papers.js')];
  delete require.cache[require.resolve('../lib/gdrive')];
  require('../plugins/papers.js');
  const papersCmd2 = commands.slice().reverse().find((c) => c.pattern === 'papers' && c !== papersCmd) || commands.find((c) => c.pattern === 'papers');
  const freshPapers = commands.filter((c) => c.pattern === 'papers').pop();
  const freshPaper = commands.filter((c) => c.pattern === 'paper').pop();
  sent = [];
  await freshPapers.function(sock, mek, {}, ctx());
  r = lastReply();
  ok(r.includes('AI Mate Papers') && r.includes('2021'), 'outage: listing served from disk cache', r);
  ok(r.includes('saved copy'), 'outage: degraded notice shown');
  sent = [];
  await freshPaper.function(sock, mek, {}, ctx({ args: ['Chemistry_PP1'] }));
  await drain();
  ok(sent.some((s) => s.reply && s.reply.includes('Download failed') && s.reply.includes('403')), 'outage: download fails friendly');
  sent = [];
  await freshPapers.function(sock, mek, {}, ctx({ args: ['refresh'] }));
  ok(lastReply().includes('403'), 'outage: refresh reports real error');

  /* 15. unconfigured states */
  OUTAGE = false;
  const gdrive2 = require('../lib/gdrive');   // fresh instance the reloaded plugin uses
  const realExtract = gdrive2.extractId;
  gdrive2.extractId = () => '';
  const unPapers = commands.filter((c) => c.pattern === 'papers').pop();
  sent = [];
  await unPapers.function(sock, mek, {}, ctx({ isOwner: false }));
  ok(lastReply().includes('not set up yet'), 'unconfigured: student note');
  sent = [];
  await unPapers.function(sock, mek, {}, ctx({ isOwner: true }));
  ok(lastReply().includes('papersetup'), 'unconfigured: owner hint');
  gdrive2.extractId = realExtract;

  /* 15b. interactive button card (professional UI) */
  let card = null;
  const mWithButtons = {
    sendButtonMenu: async (payload) => { card = payload; }
  };
  // with buttons available: pass m through — handlers receive m as 3rd arg
  sent = [];
  await papersCmd.function(sock, mek, mWithButtons, ctx({ from: 'BT@g.us' }));
  ok(card && card.title && card.title.includes('📚'), 'button card sent with title', JSON.stringify(card && card.title));
  ok(card && card.text.includes('Tap a row'), 'card invites tapping');
  ok(card && card.footer.includes('AI Mate Assistant'), 'card footer shows new bot name', card && card.footer);
  const rows = card && card.sections && card.sections[0] && card.sections[0].rows;
  ok(rows && rows[0] && rows[0].id === '.paper 1' && /📁/.test(rows[0].title), 'folder row taps .paper 1', JSON.stringify(rows && rows[0]));
  ok(rows && rows[0] && typeof rows[0].description === 'string' && rows[0].description.includes('Folder'), 'folder row describes itself');
  // root card: items only (root IS home) — nav section appears in subfolders
  ok(card && card.sections && card.sections.length >= 1, 'root card has an items section');

  // tap flow: open folder 2020 via its row id command
  card = null;
  await papersCmd.function(sock, mek, mWithButtons, ctx({ from: 'BT@g.us', args: ['2020'] }));
  ok(card && card.title === '' && card.text.includes('AI Mate Papers / 2020'),
     'second-level card: no header title, breadcrumb only in body', JSON.stringify({ t: card && card.title, x: card && card.text.slice(0, 80) }));
  const fRows = card && card.sections && card.sections[0].rows;
  ok(fRows && fRows[0] && fRows[0].id === '.paper 1' && /Maths\.pdf/.test(fRows[0].title), 'file row taps .paper 1', JSON.stringify(fRows && fRows[0]));
  ok(card && card.sections && card.sections.length === 1,
     'subfolder card is LIST-ONLY (no navigation section)', JSON.stringify(card && card.sections.map((s) => s.title)));
  const fRows2 = card && card.sections && card.sections[0].rows;
  ok(fRows2 && fRows2.length === 2 && fRows2.every((rw) => /^\.paper \d+$/.test(rw.id)),
     'all rows are item rows only', JSON.stringify(fRows2));
  ok(fRows && fRows[0] && fRows[0].description.includes('download'), 'file row offers download');

  // prev / more subcommands
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'BT2@g.us', args: ['prev'] }));
  ok(lastReply().includes('Already on the first page'), '.papers prev at page 1', lastReply());
  card = null;
  await papersCmd.function(sock, mek, mWithButtons, ctx({ from: 'BT@g.us', args: ['more', '0'] }));
  ok(card && card.sections, '.papers more renders a card');

  /* 15c. bot rename */
  ok(config.BOT_NAME === 'AI Mate Assistant', 'BOT_NAME is AI Mate Assistant', config.BOT_NAME);
  ok(String(config.ALIVE_MSG).includes('AI Mate Assistant'), 'ALIVE_MSG renamed');

  /* 15d. smart search engine + empty states */
  // empty search → simple text, no card, previous list preserved
  let cardSent = false;
  const mFlag = { sendButtonMenu: async () => { cardSent = true; } };
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS@g.us', args: ['2020'] }));  // browse 2020 (1 file)
  sent = [];
  await papersCmd.function(sock, mek, mFlag, ctx({ from: 'SS@g.us', args: ['zzzqqq', 'xyz'] }));
  r = lastReply();
  ok(r.includes('No papers found') && r.includes('zzzqqq'), 'empty search → simple text', r);
  ok(!cardSent, 'empty search → no button card');
  sent = [];
  await paperCmd.function(sock, mek, {}, ctx({ from: 'SS@g.us', args: ['1'], senderNumber: '94777000001', sender: '94777000001@s.whatsapp.net' }));
  await drain();
  ok(docs().length > 0, 'previous numbered list still usable after empty search');

  // empty folder
  sent = [];
  await papersCmd.function(sock, mek, mFlag, ctx({ from: 'SS2@g.us', args: ['empty'] }));
  r = lastReply();
  ok(r.includes('No papers in this folder'), 'empty folder → simple text', r);
  ok(!cardSent, 'empty folder → no button card');

  // synonyms / prefixes / typos / stopwords
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS3@g.us', args: ['chem'] }));
  ok(lastReply().includes('What year do you need'), "synonym: 'chem' → chemistry interview", lastReply());
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS3@g.us', args: ['phy', 'pp1'] }));
  ok(lastReply().includes('What year do you need'), "prefix: 'phy pp1' → physics interview", lastReply());
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS3@g.us', args: ['phisics'] }));
  ok(lastReply().includes('What year do you need'), "typo: 'phisics' → physics interview (KB catches typos)", lastReply());
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS3@g.us', args: ['past', 'papers', 'chemistry'] }));
  ok(lastReply().includes('What year do you need'), 'stopwords ignored — chemistry interview', lastReply());
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS3@g.us', args: ['physsics', 'zzzqq'] }));
  r = lastReply();
  ok(r.includes('loose match') && r.includes('Physics_PP1.pdf'), 'loose-match fallback flags + finds', r);

  // smart folder match: 'phy' opens Physics inside 2021
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS4@g.us', args: ['2021'] }));
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS4@g.us', args: ['zzzfolder'] }));
  ok(lastReply().includes('zzzfolder') || lastReply().includes('Nothing matched') || lastReply().includes('No papers found'),
     'unknown folder word → search fallback (no crash)', lastReply());

  // AI expansion (Gemini mock): Sinhala phrase the local KB can't parse
  process.env.GEMINI_API_KEY = 'AIzaFAKEGEMINIKEY1234567890';
  global.AI_CALLS = 0;
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS5@g.us', args: ['මට', 'ඕනෙ', 'පත්රයක්'] }));
  r = lastReply();
  ok(global.AI_CALLS >= 1, 'AI expansion endpoint called (non-KB Sinhala phrase)');
  ok(r.includes('2021 Chemistry') && r.includes('Chemistry_PP1.pdf'),
     "AI-expanded 'chemistry 2021' → the papers directly (no medium tags in library)", r);
  // AI down → silent fallback to local search
  global.AI_DOWN = true;
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'SS6@g.us', args: ['රසායන'] }));
  ok(!lastReply().includes('✨ AI'), 'AI down → falls back silently');
  delete process.env.GEMINI_API_KEY;
  global.AI_DOWN = false;

  /* 15t. AI key pool — auto fallback when a key is exhausted */
  const smart = require('../lib/papersearch');
  smart.geminiReset();
  process.env.GEMINI_API_KEY = 'AIzaPOOLAAAA111111111111111';
  process.env.GEMINI_API_KEYS = 'AIzaPOOLBBBB222222222222222, AIzaPOOLCCCC333333333333333';
  global.AI_429_TAILS = ['111111'];
  global.AI_KEY_CALLS = {};
  await papersCmd.function(sock, mek, {}, ctx({ from: 'AIP1@g.us', args: ['මට', 'පත්රයක්', 'ඕනෙ'] }));
  ok(global.AI_KEY_CALLS['111111'] === 1, 'key 1 tried first', JSON.stringify(global.AI_KEY_CALLS));
  ok(global.AI_KEY_CALLS['222222'] === 1, 'key 2 took over after the 429', JSON.stringify(global.AI_KEY_CALLS));
  ok(!global.AI_KEY_CALLS['333333'], 'key 3 not wasted on that call');
  ok(lastReply().includes('2021 Chemistry') && lastReply().includes('Chemistry_PP1.pdf'),
     'fallback still delivered AI results (pick card)', lastReply());
  // exhausted key stays benched on later calls (rotation moves on by itself)
  await papersCmd.function(sock, mek, {}, ctx({ from: 'AIP2@g.us', args: ['ඕනෙ', 'පත්ර'] }));
  await papersCmd.function(sock, mek, {}, ctx({ from: 'AIP3@g.us', args: ['පත්රය', 'ඕනෙ'] }));
  ok(global.AI_KEY_CALLS['111111'] === 1, 'exhausted key benched until reset — never retried', JSON.stringify(global.AI_KEY_CALLS));
  delete global.AI_429_TAILS;
  // all keys down → clean local fallback (no crash, empty-search text)
  smart.geminiReset();
  delete process.env.GEMINI_API_KEYS;
  global.AI_DOWN = true;
  await papersCmd.function(sock, mek, {}, ctx({ from: 'AIP4@g.us', args: ['මට', 'ඕනෙ', 'පත්රයක්'] }));
  ok(lastReply().includes('No papers found'), 'all keys down → local empty-search text, no crash', lastReply());
  global.AI_DOWN = false;
  // per-key daily cap
  config.set('AI_DAILY_CAP', '1');
  smart.geminiReset();
  global.AI_CALLS = 0;
  await papersCmd.function(sock, mek, {}, ctx({ from: 'AIP5@g.us', args: ['මට', 'ඕනෙ', 'පත්රයක්'] }));
  await papersCmd.function(sock, mek, {}, ctx({ from: 'AIP6@g.us', args: ['ඕනෙ', 'පත්ර', 'ඕනෙ'] }));
  ok(global.AI_CALLS === 1, 'daily cap stops the second AI call', String(global.AI_CALLS));
  config.set('AI_DAILY_CAP', '500');
  // AI normalises into a STRUCTURED query → direct paper flow
  smart.geminiReset();
  global.AI_EXPANSION = '2019 chemistry sinhala medium';
  await papersCmd.function(sock, mek, {}, ctx({ from: 'AIP7@g.us', args: ['මට', 'ඕනෙ', 'පත්රයක්'] }));
  ok(lastReply().includes('Paper not found') && lastReply().includes('2019 Chemistry — Sinhala medium'),
     'AI-normalised query flows into the structured engine', lastReply());
  delete process.env.GEMINI_API_KEY;
  delete global.AI_EXPANSION;
  smart.geminiReset();

  /* 15u. local-first: AI is NOT spent when local search already matches */
  process.env.GEMINI_API_KEY = 'AIzaLOCAL4444444444444444';
  smart.geminiReset();
  global.AI_CALLS = 0;
  await papersCmd.function(sock, mek, {}, ctx({ from: 'AIP8@g.us', args: ['chem'] }));
  ok(global.AI_CALLS === 0 && lastReply().includes('What year do you need'), 'local hit → interview with zero AI calls', String(global.AI_CALLS));
  delete process.env.GEMINI_API_KEY;
  smart.geminiReset();

  /* 15v. AI-FIRST free-form brain — "i want 2020 A/L chemistry past paper" */
  process.env.GEMINI_API_KEY = 'AIzaFREEFORM99999999999999';
  smart.geminiReset();
  const npFF = require('../command').replyHandlers.find((h) => h.noPrefixTriggers === true);
  const fFF = (t) => npFF.filter(t, { sender: '9477@s.whatsapp.net', message: { key: { fromMe: false, remoteJid: 'G@g.us' } } });
  ok(fFF('i want 2020 A/L chemistry past paper') === true, 'trigger: free-form request admitted');
  ok(fFF('give me a chemistry paper') === true, 'trigger: casual paper ask admitted');
  let ffCard = null;
  const ffM = { sendButtonMenu: async (payload) => { ffCard = payload; } };
  const ppickCmd = commands.find((c) => c.pattern === 'ppick');
  ok(!!ppickCmd, 'ppick command registered for interview taps');

  // ── FF1a: free-form ask, medium missing → the bot ASKS (buttons), then resolves
  sent = [];
  ffCard = null;
  await npFF.function(sock, mek, ffM, { from: 'FF1@g.us', body: 'i want 2020 A/L chemistry past paper', sender: '94778111111@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  ok(ffCard && ffCard.listTitle === '🌐 Pick a medium…' && ffCard.sections[0].rows.length === 1 &&
     ffCard.sections[0].rows[0].title.includes('Sinhala'),
     "missing medium → 'Which medium do you want?' question card (sinhala available)", JSON.stringify(ffCard && ffCard.text));
  // student taps the medium → exact paper pick card
  sent = [];
  ffCard = null;
  await ppickCmd.function(sock, mek, ffM, ctx({ from: 'FF1@g.us', args: ['medium', 'sinhala'], sender: '94778111111@s.whatsapp.net' }));
  ok(ffCard && ffCard.sections[0].rows.length === 1 &&
     ffCard.sections[0].rows[0].title.includes('2020_Chemistry_Sinhala_Medium.pdf'),
     'answering the medium → exact 2020 chemistry card', JSON.stringify(ffCard && ffCard.sections));
  sent = [];
  await paperCmd.function(sock, mek, {}, ctx({ from: 'FF1@g.us', args: ['1'], sender: '94778111111@s.whatsapp.net' }));
  await drain();
  ok(docs().some((d) => d.content.fileName && d.content.fileName.includes('2020_Chemistry_Sinhala')),
     'tapping the found paper downloads it', JSON.stringify(docs().map((d) => d.content.fileName)));

  // ── FF1b: AI find with FULL details (Sinhala query → AI needed) → straight to the paper
  global.AI_INTERPRET = '{"action":"find","year":2020,"subject":"chemistry","medium":"sinhala"}';
  sent = [];
  ffCard = null;
  await npFF.function(sock, mek, ffM, { from: 'FF1b@g.us', body: 'ඕනෙ පත්රම ඕනෙ', sender: '94778111112@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  ok(ffCard && ffCard.sections[0].rows.length === 1 &&
     ffCard.sections[0].rows[0].title.includes('2020_Chemistry_Sinhala_Medium.pdf'),
     'AI find (full details) → exact paper card, no questions', JSON.stringify(ffCard && ffCard.sections));

  // ── FF-year: year missing → 'What year do you need?' with available years
  global.AI_INTERPRET = '{"action":"find","year":null,"subject":"biology","medium":"sinhala"}';
  sent = [];
  ffCard = null;
  await npFF.function(sock, mek, ffM, { from: 'FFY@g.us', body: 'ජීව විද්යාව sinhala', sender: '94778111113@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  ok(ffCard && ffCard.listTitle === '🗓️ Pick a year…' && ffCard.sections[0].rows.some((r) => r.title === '📅 2016'),
     "missing year → 'What year do you need?' with years that HAVE the subject", JSON.stringify(ffCard && ffCard.sections));
  // tap the year → variants card (both 2016 biology sinhala siblings)
  sent = [];
  ffCard = null;
  await ppickCmd.function(sock, mek, ffM, ctx({ from: 'FFY@g.us', args: ['year', '2016'], sender: '94778111113@s.whatsapp.net' }));
  ok(ffCard && ffCard.sections[0].rows.length === 2,
     'answering the year → the paper(s) as tap rows', JSON.stringify(ffCard && ffCard.sections));

  // ── FF-text: student TYPES the answer instead of tapping
  global.AI_INTERPRET = '{"action":"find","year":2020,"subject":"chemistry","medium":null}';
  sent = [];
  ffCard = null;
  await npFF.function(sock, mek, ffM, { from: 'FFT@g.us', body: 'රසායන 2020', sender: '94778111114@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  ok(ffCard && ffCard.listTitle === '🌐 Pick a medium…', 'interview opened (medium question)', ffCard && ffCard.listTitle);
  ok(fFF('sinhala') === true, 'pending interview admits a plain answer');
  sent = [];
  ffCard = null;
  await npFF.function(sock, mek, ffM, { from: 'FFT@g.us', body: 'sinhala', sender: '94778111114@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  ok(ffCard && ffCard.sections[0].rows.length === 1 &&
     ffCard.sections[0].rows[0].title.includes('2020_Chemistry_Sinhala_Medium.pdf'),
     "typed answer 'sinhala' completes the paper lookup", JSON.stringify(ffCard && ffCard.sections));

  // ── FF-type: marking schemes & variants — ask for the TYPE via AI
  global.AI_INTERPRET = '{"action":"find","year":2016,"subject":"biology","medium":"sinhala","type":"mcq"}';
  sent = [];
  ffCard = null;
  await npFF.function(sock, mek, ffM, { from: 'FFT2@g.us', body: 'ජීව විද්‍යාව 2016 sinhala mcq', sender: '94778111115@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  ok(ffCard && ffCard.sections[0].rows.length === 1 &&
     ffCard.sections[0].rows[0].title.includes('MCQ'),
     "type 'mcq' → only the MCQ sibling", JSON.stringify(ffCard && ffCard.sections));

  // ── FF-cancel: a pending interview can be cancelled by text
  global.AI_INTERPRET = '{"action":"find","year":2020,"subject":"chemistry","medium":null}';
  await npFF.function(sock, mek, ffM, { from: 'FFC@g.us', body: 'රසායන 2020', sender: '94778111116@s.whatsapp.net', reply: async () => {} });
  ok(npFF.filter('cancel', { sender: '94778111116@s.whatsapp.net', message: { key: { fromMe: false, remoteJid: 'FFC@g.us' } } }) === true,
     'pending interview admits cancel');
  sent = [];
  await npFF.function(sock, mek, ffM, { from: 'FFC@g.us', body: 'cancel', sender: '94778111116@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  ok(sent.map((s) => s.reply).join('').includes('Cancelled'), "'cancel' clears the interview");

  // interpretation normalizer: type dimension + rejections
  const NI = smart.normalizeInterpretation;
  ok(NI({ action: 'find', year: 2019, subject: 'chemistry', medium: 'sinhala', type: 'marking' }).type === 'marking' &&
     NI({ action: 'find', year: 2019, subject: 'chemistry', medium: 'sinhala', type: 'marking' }).subject === 'chemistry',
     'normalizer: canonical subject kept with type');
  ok(NI({ action: 'find', year: 2019, subject: 'zzz' }) === null, 'normalizer: unknown subject rejected');
  const sillyYear = NI({ action: 'find', year: 1899, subject: 'biology' });
  ok(sillyYear && sillyYear.year === null, 'normalizer: silly year dropped');

  // 'Biology 2020 past paper' — no 2020 biology in the library
  // → NOT-FOUND (never 64 loose results from other years)
  global.AI_INTERPRET = '{"action":"find","year":2020,"subject":"biology","medium":null}';
  sent = [];
  ffCard = null;
  await npFF.function(sock, mek, ffM, { from: 'FF6@g.us', body: 'Biology 2020 past paper', sender: '94778111117@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  const nfBio = sent.map((s) => s.reply).join('\n');
  ok(!ffCard && nfBio.includes('Paper not found') && nfBio.includes('2020 Biology'),
     "'Biology 2020 past paper' with no 2020 biology → clean not-found", nfBio.slice(0, 120));

  // YEAR PIN in the search engine: 'biology 2020' can never return 2016 biology
  const scopeIdx = (await (async () => {
    await papersCmd.function(sock, mek, {}, ctx({ from: 'YP@g.us', args: ['2021'] }));
    return null;
  })());
  const siRes = require('../lib/papersearch').searchIndex(
    { root: { name: 'School Papers' }, folders: [
      { id: 'f1', name: '2020', path: ['School Papers', '2020'], depth: 1 },
      { id: 'f2', name: 'Biology', path: ['School Papers', '2016', 'Biology'], depth: 2 }
    ], files: [
      { id: 'a', name: '2016_Biology_MCQ_Sinhala.pdf', isFolder: false, path: ['School Papers', '2016', 'Biology'] },
      { id: 'b', name: '2020_Physics_English.pdf', isFolder: false, path: ['School Papers', '2020'] },
      { id: 'c', name: '2020_Chemistry_Sinhala_Medium.pdf', isFolder: false, path: ['School Papers', '2020'] }
    ] }, 'biology 2020');
  ok(siRes.items.length === 0, "YEAR PIN: 'biology 2020' never returns 2016 biology", JSON.stringify(siRes.items.map((x) => x.name)));
  const siRes2 = require('../lib/papersearch').searchIndex(
    { root: { name: 'School Papers' }, folders: [], files: [
      { id: 'a', name: '2016_Biology_MCQ_Sinhala.pdf', isFolder: false, path: ['School Papers', '2016', 'Biology'] },
      { id: 'b', name: '2020_Biology_English_Medium.pdf', isFolder: false, path: ['School Papers', '2020'] }
    ] }, 'biology 2020');
  ok(siRes2.items.length === 1 && siRes2.items[0].name.includes('2020_Biology'),
     "YEAR PIN: 'biology 2020' returns exactly the 2020 biology", JSON.stringify(siRes2.items.map((x) => x.name)));

  /* 15w. collections — past / FWC / provincial — any language */
  const PS = require('../lib/papersearch');
  const catIdx = { root: { name: 'X' }, folders: [], files: [
    { name: '2019_Biology_Sinhala.pdf', isFolder: false, path: ['X', '2019'] },
    { name: '2019 Biology FWC Sinhala.pdf', isFolder: false, path: ['X', 'FWC'] },
    { name: '2019_Biology_Provincial_Sinhala.pdf', isFolder: false, path: ['X', 'Provincial'] }
  ] };
  ok(PS.matchPaper(catIdx, { year: 2019, subject: 'biology', medium: 'sinhala' }).length === 3,
     'no category asked → all collections offered');
  ok(PS.matchPaper(catIdx, { year: 2019, subject: 'biology', medium: 'sinhala', cat: 'fwc' }).length === 1 &&
     PS.matchPaper(catIdx, { year: 2019, subject: 'biology', medium: 'sinhala', cat: 'fwc' })[0].name.includes('FWC'),
     "cat 'fwc' → only the FWC file");
  ok(PS.matchPaper(catIdx, { year: 2019, subject: 'biology', medium: 'sinhala', cat: 'provincial' })[0].name.includes('Provincial'),
     "cat 'provincial' → only the provincial file");
  ok(PS.matchPaper(catIdx, { year: 2019, subject: 'biology', medium: 'sinhala', cat: 'past' })[0].name === '2019_Biology_Sinhala.pdf',
     "cat 'past' → the plain paper (unmarked = past)");
  const pqFwc = PS.parsePaperQuery('fwc 2019 bio sinhala');
  ok(pqFwc && pqFwc.cat === 'fwc' && pqFwc.subject === 'biology', 'parse: fwc category extracted');
  const pqPalath = PS.parsePaperQuery('2019 පළාත් ජීව විද්‍යාව sinhala');
  ok(pqPalath && pqPalath.cat === 'provincial' && pqPalath.subject === 'biology',
     'parse: පළාත් → provincial (Sinhala)');
  const sinFile = PS.classifyFileName('2019 රසායන විද්‍යාව සිංහල.pdf');
  ok(sinFile.subject === 'chemistry' && sinFile.medium === 'sinhala',
     'classifier: Sinhala-named file fully understood');

  // classifier: real-world drive names like '2015-Bio-Resource-Technology-English.pdf'
  const cf2 = require('../lib/papersearch').classifyFileName;
  ok(cf2('2015-Bio-Resource-Technology-English.pdf').subject === 'bst',
     'classifier: Bio Resource Technology → bst', JSON.stringify(cf2('2015-Bio-Resource-Technology-English.pdf')));
  // search action
  global.AI_INTERPRET = '{"action":"search","keywords":"chemistry"}';
  sent = [];
  ffCard = null;
  await npFF.function(sock, mek, ffM, { from: 'FF3@g.us', body: 'give me a chemistry paper', reply: async (t) => { sent.push({ reply: t }); } });
  ok(ffCard && ffCard.text.includes('3 found'), "AI search action → results card", ffCard && ffCard.text.slice(0, 80));
  // none → usage guide (chat, not a request)
  global.AI_INTERPRET = '{"action":"none"}';
  sent = [];
  await npFF.function(sock, mek, ffM, { from: 'FF4@g.us', body: 'this paper is hard', reply: async (t) => { sent.push({ reply: t }); } });
  ok(sent.map((s) => s.reply).join('').includes('How to ask'), "AI 'none' → usage guide reply", sent.map((s) => s.reply).join('').slice(0, 80));
  // AI down → local keyword fallback still answers
  global.AI_DOWN = true;
  delete global.AI_INTERPRET;
  sent = [];
  ffCard = null;
  await npFF.function(sock, mek, ffM, { from: 'FF5@g.us', body: 'i want 2020 chemistry past paper', reply: async (t) => { sent.push({ reply: t }); } });
  ok(ffCard && ffCard.listTitle === '🌐 Pick a medium…',
     'AI down → structured engine still ASKS the medium (no dump)', ffCard && ffCard.listTitle);
  global.AI_DOWN = false;
  delete process.env.GEMINI_API_KEY;
  smart.geminiReset();

  /* 15e. full file names + contextual picker button */
  sent = [];
  await papersCmd.function(sock, mek, mFlag, ctx({ from: 'FN@g.us' }));   // root → folders only
  ok(cardSent, 'root card sent');
  // NOTE: cardSent flag is stale from earlier — rebind a fresh catcher
  let lastCard = null;
  const mCard = { sendButtonMenu: async (payload) => { lastCard = payload; } };
  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'FN1@g.us' }));
  ok(lastCard && lastCard.listTitle.includes('Open a folder'), 'root: picker says "Open a folder"', lastCard && lastCard.listTitle);

  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'FN2@g.us', args: ['2021'] })); // mixed
  ok(lastCard && lastCard.listTitle.includes('Browse papers'), 'mixed folder: picker says "Browse papers"', lastCard && lastCard.listTitle);
  const longRow = lastCard.sections[0].rows.find((rw) => rw.id === '.paper 6');
  ok(longRow && longRow.title.includes('Business_Studies_Structured_Essay_Paper_2021_GCE_AL_New_Syllabus.pdf'),
     'full file name in row title, no truncation', JSON.stringify(longRow));
  ok(longRow && !longRow.title.includes('…'), 'no ellipsis in titles');
  ok(longRow && longRow.description.includes('Business_Studies_Structured_Essay_Paper_2021_GCE_AL_New_Syllabus.pdf'),
     'full name also in description (survives WhatsApp title clamp)', JSON.stringify(longRow));

  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'FN3@g.us', args: ['2020'] })); // files only
  ok(lastCard && lastCard.listTitle.includes('Download'), 'file-only folder: picker says "Download"', lastCard && lastCard.listTitle);
  const shortRow = lastCard.sections[0].rows[0];
  ok(shortRow && shortRow.title === '1. Maths.pdf' && shortRow.description.includes('download'),
     'short-name row keeps info description', JSON.stringify(shortRow));

  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'FN4@g.us', args: ['chem'] }));
  ok(lastCard && lastCard.listTitle.includes('Pick a year'), 'subject ask: picker says "Pick a year"', lastCard && lastCard.listTitle);

  /* 15f. logo only on the main menu card */
  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'LG1@g.us' }));   // main menu (root)
  ok(lastCard && lastCard.image && String(lastCard.image.url || lastCard.image) === String(config.ALIVE_IMG),
     'main menu card HAS the logo (ALIVE_IMG)', JSON.stringify(lastCard && lastCard.image));
  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'LG2@g.us', args: ['2021'] })); // subfolder
  ok(lastCard && !lastCard.image, 'subfolder card has NO logo');
  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'LG3@g.us', args: ['chem'] })); // search
  ok(lastCard && !lastCard.image, 'search card has NO logo');

  /* 15g. custom library name in menus */
  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'RN1@g.us' }));
  ok(lastCard && lastCard.title.includes('AI Mate Papers'), 'root card shows custom library name', lastCard && lastCard.title);
  ok(lastCard && !lastCard.title.includes('School Papers'), 'Drive folder name hidden on root card', lastCard && lastCard.title);
  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'RN2@g.us', args: ['2021'] }));
  ok(lastCard && lastCard.title === '' && lastCard.text.includes('AI Mate Papers / 2021'),
     'breadcrumb uses custom name (in body, no duplicate header)', lastCard && lastCard.text.slice(0, 100));
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'RN3@g.us', args: ['chem'] }));
  ok(lastReply().includes('AI Mate Papers') === false && lastReply().includes('What year do you need'), 'interview text clean (no menu header)', lastReply());
  // folder matching still works on REAL names
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'RN4@g.us', args: ['2020'] }));
  ok(lastReply().includes('AI Mate Papers / 2020'), 'nav works with custom name', lastReply());

  /* 15h. no-prefix triggers (students only) */
  const { replyHandlers } = require('../command');
  const np = replyHandlers.find((h) => h.noPrefixTriggers === true);
  ok(!!np, 'no-prefix reply handler registered');
  const f = (t, extra = {}) => np.filter(t, { sender: '9477@s.whatsapp.net', message: { key: { fromMe: false, remoteJid: 'G@g.us' } }, ...extra });
  ok(f('papers') === true, "trigger: 'papers'");
  ok(f('Papers!') === true, "trigger: 'Papers!'");
  ok(f('past papers') === true, "trigger: 'past papers'");
  ok(f('A/L past papers') === true, "trigger: 'A/L past papers'");
  ok(f('chemistry past papers') === true, "trigger: 'chemistry past papers'");
  ok(f('chemistry') === true, "trigger: bare subject 'chemistry'");
  ok(f('phy') === true, "trigger: bare subject 'phy'");
  ok(f('hello how are you') === false, "ignores normal chat");
  ok(f('this paper is hard') === true, 'paper-mentioning chatter triggers — the AI brain decides');
  ok(f('.papers') === false, "ignores prefixed commands");
  ok(f('papers', { message: { key: { fromMe: true, remoteJid: 'G@g.us' } } }) === false, 'ignores bot own messages');
  ok(f('papers', { message: { key: { fromMe: false, remoteJid: 'status@broadcast' } } }) === false, 'ignores status broadcast');
  ok(f('https://evil.com papers') === false, 'ignores messages with links');
  ok(f('chemistry, past papers!') === true, 'punctuation tolerated');
  ok(f('paper 2') === true, "trigger: 'paper 2' (download item)");
  ok(f('paper hello') === true, "'paper hello' triggers — AI brain decides");
  ok(f('papers next') === true, "trigger: 'papers next'");
  ok(f('papers 2021') === true, "trigger: 'papers 2021'");
  ok(f('papers foo bar baz qux') === true, "'papers' + junk words → AI decides");
  ok(f('paper is hard') === true, "'paper is hard' triggers — AI brain decides");

  // full flow: 'papers' opens the main menu card
  lastCard = null;
  await np.function(sock, mek, mCard, { from: 'NP@g.us', body: 'papers', reply: async (t) => { sent.push({ reply: t }); } });
  ok(lastCard && lastCard.title.includes('AI Mate Papers'), "typing 'papers' opens main menu card", lastCard && lastCard.title);
  // 'chemistry past papers' (AI not configured) → LOCAL fallback search
  // still answers with results — the old format engine is the fallback now
  sent = [];
  lastCard = null;
  await np.function(sock, mek, mCard, { from: 'NP2@g.us', body: 'chemistry past papers', reply: async (t) => { sent.push({ reply: t }); } });
  ok(lastCard && lastCard.listTitle.includes('Pick a year'),
     "AI-unconfigured 'chemistry past papers' → local interview (year question)", JSON.stringify(lastCard && lastCard.listTitle));

  /* 15r. structured requests — "2016 agriculture sinhala medium" */
  ok(f('2016 chemistry sinhala medium') === true, "trigger: '2016 chemistry sinhala medium'");
  ok(f('2022 physics english') === true, "trigger: '2022 physics english' (medium word optional)");
  ok(f('2021 combined maths sinhala mediam') === true, 'trigger: multi-word subject + typo medium');
  ok(f('2016 xyzabc sinhala medium') === true, 'trigger: year+medium but unknown subject → guide');
  ok(f('2016 xyzabc sinhala') === true, 'year + medium-ish ask triggers — AI decides');
  ok(f('2021 chem') === true, 'year+subject without medium triggers — AI fills the gaps');

  // filename classifier: strict year token, variant detection
  const cf = require('../lib/papersearch').classifyFileName;
  ok(cf('2019_Chemistry_Sinhala_Medium.pdf').extra.length === 0, 'classifier: year+subject+medium = exact', JSON.stringify(cf('2019_Chemistry_Sinhala_Medium.pdf')));
  ok(cf('2019 Chemistry Sinhala MCQ.pdf').extra.join() === 'mcq', 'classifier: MCQ sibling is a variant');
  ok(cf('20190_notes.pdf').year === null, 'classifier: 20190 is NOT a year (no substring years)');

  // direct hit — exact paper found → BUTTON card with the FILENAME row
  sent = [];
  lastCard = null;
  await np.function(sock, mek, mCard, { from: 'SR1@g.us', body: '2016 agriculture english medium', sender: '94778000001@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  ok(lastCard && lastCard.sections.length === 1 && lastCard.sections[0].rows.length === 1,
     'exact hit → one tap row, no numbers asked', JSON.stringify(lastCard && lastCard.sections));
  ok(lastCard && lastCard.sections[0].rows[0].title.includes('2016_Agriculture_English_Medium.pdf'),
     'row carries the paper FILENAME', lastCard && lastCard.sections[0].rows[0].title);
  ok(lastCard && lastCard.sections[0].rows[0].id === '.paper 1', 'row id downloads on tap');
  ok(docs().length === 0, 'no instant download — student taps to get it');
  // tapping the row (paper 1) downloads the paper
  sent = [];
  await paperCmd.function(sock, mek, {}, ctx({ from: 'SR1@g.us', args: ['1'], sender: '94778000001@s.whatsapp.net' }));
  await drain();
  ok(docs().some((d) => d.content.fileName && d.content.fileName.includes('2016_Agriculture_English')),
     'tapping the row downloads the paper', JSON.stringify(docs().map((d) => d.content.fileName)));
  ok(sent.some((s) => s.content && s.content.react && (s.content.react.text === '⏳' || s.content.react.text === '✅')),
     'download reacts ⏳/✅');

  // short terms + typo ("mediam") → EXACT-named file wins: single button row
  sent = [];
  lastCard = null;
  await np.function(sock, mek, mCard, { from: 'SR2@g.us', body: '2016 agri sin mediam', sender: '94778000002@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  ok(lastCard && lastCard.sections[0].rows.length === 1 &&
     lastCard.sections[0].rows[0].title.includes('2016_Agriculture_Sinhala.pdf'),
     'exact name beats MCQ/essay variants — THE paper only (one row)',
     JSON.stringify(lastCard && lastCard.sections));

  // variants-only combo → button card listing both siblings (tap either)
  sent = [];
  lastCard = null;
  await np.function(sock, mek, mCard, { from: 'SR5@g.us', body: '2016 bio sinhala', sender: '94778000004@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  const rowTitles = (lastCard && lastCard.sections[0].rows.map((r) => r.title).join('|')) || '';
  ok(lastCard && lastCard.sections[0].rows.length === 2 &&
     rowTitles.includes('2016_Biology_MCQ_Sinhala.pdf') && rowTitles.includes('2016_Biology_Structured_Sinhala.pdf'),
     'variants-only combo → both siblings as tap rows', rowTitles);
  ok(lastCard && lastCard.text.includes('Tap a paper below to download'),
     'card invites tapping, not typing numbers', lastCard && lastCard.text.slice(0, 120));

  // not found — year exists in library → hint with available subjects
  sent = [];
  await np.function(sock, mek, mCard, { from: 'SR3@g.us', body: '2016 chemistry sinhala medium', reply: async (t) => { sent.push({ reply: t }); } });
  const nf = sent.map((s) => s.reply).join('\n');
  ok(nf.includes('Paper not found') && nf.includes('2016 Chemistry — Sinhala medium'),
     'not-found message names the requested combo', nf.slice(0, 140));
  ok(nf.includes('Agriculture'), 'not-found hints the subjects available that year');

  // prefixed structured query through .papers → same button card
  sent = [];
  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'SR4@g.us', args: ['2016', 'agri', 'eng', 'medium'], sender: '94778000003@s.whatsapp.net' }));
  ok(lastCard && lastCard.sections[0].rows.length === 1 &&
     lastCard.sections[0].rows[0].title.includes('2016_Agriculture_English_Medium.pdf'),
     "'.papers 2016 agri eng medium' → tap card too",
     JSON.stringify(lastCard && lastCard.sections));


  // reaction + delegation: 'papers' reacts to the student's message
  sent = [];
  await np.function(sock, mek, mCard, { from: 'NP3@g.us', body: 'papers', reply: async (t) => { sent.push({ reply: t }); } });
  ok(sent.some((s) => s.content && s.content.react && s.content.react.text === '📚'),
     "trigger reacts 📚 to the student's message", JSON.stringify(sent.filter((s) => s.content && s.content.react)));
  // 'paper 2' flow: seed a list, then download without prefix
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'NP4@g.us', args: ['2020'], sender: '94777000001@s.whatsapp.net' }));
  sent = [];
  await np.function(sock, mek, mCard, { from: 'NP4@g.us', body: 'paper 1', sender: '94777000001@s.whatsapp.net', reply: async (t) => { sent.push({ reply: t }); } });
  await drain();
  ok(docs().length > 0, "'paper 1' downloads without prefix", sent.map((s) => s.reply).join('|').slice(0, 120));
  ok(sent.some((s) => s.content && s.content.react && s.content.react.text === '📚'), "'paper 1' also reacted");

  // tips adapt to prefix mode
  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'TP@g.us' }));
  ok(lastCard && !lastCard.text.includes('.paper'), 'tips have NO prefix when no-prefix mode is on', lastCard && lastCard.text.slice(0, 200));
  config.set('PAPERS_NO_PREFIX', 'false');
  lastCard = null;
  await papersCmd.function(sock, mek, mCard, ctx({ from: 'TP2@g.us' }));
  ok(lastCard && lastCard.text.includes('.paper'), 'tips show prefix when mode is off', lastCard && lastCard.text.slice(0, 200));
  config.set('PAPERS_NO_PREFIX', 'true');

  // toggle off via owner setting (config.set writes config.js; we restore it)
  config.set('PAPERS_NO_PREFIX', 'false');
  ok(f('papers') === false, 'setting off: no-prefix triggers disabled');
  config.set('PAPERS_NO_PREFIX', 'true');
  ok(f('papers') === true, 'setting on: triggers back');

  /* 15i. welcome message template */
  const tpl = 'Hi {name}, welcome to {group} — powered by {bot}!'
    .replaceAll('{name}', 'Kasun')
    .replaceAll('{group}', 'A/L 2026 Class')
    .replaceAll('{bot}', config.BOT_NAME);
  ok(tpl.includes('Hi Kasun, welcome to A/L 2026 Class') && tpl.includes('AI Mate Assistant'),
     'welcome template fills name/group/bot', tpl);
  ok(config.WELCOME_MSG.length <= 160 && /\{name\}/.test(config.WELCOME_MSG) &&
     /\{group\}/.test(config.WELCOME_MSG) && /\{bot\}/.test(config.WELCOME_MSG) &&
     /papers/i.test(config.WELCOME_MSG),
     'default welcome has name+group+bot+papers', config.WELCOME_MSG);

  /* 15j. participantInfo — Baileys rc.9 welcome bug regression */
  const { participantInfo } = require('../lib/functions');
  // rc.9 shape: {id: lid, phoneNumber: pn, lid: pn-lid, admin}
  const rc9 = participantInfo({ id: '9988776655@lid', phoneNumber: '94771234567@s.whatsapp.net', lid: '94771234567.0:11@s.whatsapp.net', admin: null });
  ok(rc9.digits === '94771234567', 'rc.9 object: digits from phoneNumber', JSON.stringify(rc9));
  ok(rc9.jid === '94771234567@s.whatsapp.net', 'rc.9 object: mention jid = phone JID', JSON.stringify(rc9));
  // lid-only object (no phoneNumber attr)
  const lidOnly = participantInfo({ id: '9988776655@lid', admin: null });
  ok(lidOnly.digits === '9988776655' && lidOnly.jid === '9988776655@lid', 'lid-only object falls back to lid', JSON.stringify(lidOnly));
  // old Baileys shape: plain JID string
  const legacy = participantInfo('94771234567@s.whatsapp.net');
  ok(legacy.digits === '94771234567' && legacy.jid === '94771234567@s.whatsapp.net', 'legacy string JID works');
  // stub param JSON string shape
  const stubParam = participantInfo(JSON.parse(JSON.stringify({ id: '9988776655@lid', phoneNumber: '94771234567@s.whatsapp.net' })));
  ok(stubParam.digits === '94771234567', 'stub JSON param resolves');
  // unusable entry
  ok(participantInfo({ admin: null }).digits === '', 'unusable participant -> no digits');

  /* 15l. sendHubCard — welcome + papers menu in ONE message */
  const papersMod = require('../plugins/papers');
  ok(typeof papersMod.sendHubCard === 'function', 'sendHubCard exported');
  lastCard = null;
  const hubCtx = { from: 'HUB@g.us', reply: async (t) => { sent.push({ reply: t }); } };
  const welcomeText = "*👋 Welcome, Kasun! 🎓*\n*You're in A/L Class 📖*\n*🤖 I'm AI Mate Assistant — type papers to grab past papers.*";
  let separateTextSent = false;
  const origSockSend = sock.sendMessage;
  const hubResult = await papersMod.sendHubCard(
    { sendMessage: async () => { separateTextSent = true; } },
    { key: { id: 'HUBMSG', remoteJid: 'HUB@g.us', fromMe: false }, message: { conversation: 'welcome' } },
    { sendButtonMenu: async (payload) => { lastCard = payload; } },
    hubCtx,
    { customText: welcomeText }
  );
  ok(hubResult === true, 'sendHubCard returns true when configured');
  ok(lastCard && lastCard.text.includes('Welcome, Kasun') && lastCard.text.includes("You're in A/L Class"),
     'welcome text IS the card body (same message)', lastCard && lastCard.text);
  ok(!separateTextSent, 'no separate text message sent');
  ok(lastCard && lastCard.image && lastCard.sections && lastCard.sections[0].rows.length,
     'hub card has logo + folder rows');
  ok(lastCard && lastCard.title.includes('AI Mate Papers'), 'hub card title shows library name');
  // unconfigured → false
  const gdriveT = require('../lib/gdrive');
  const realEx2 = gdriveT.extractId;
  gdriveT.extractId = () => '';
  const hubFail = await papersMod.sendHubCard({ sendMessage: async () => {} }, {}, {},
    { from: 'X@g.us', reply: async () => {} }, { customText: 'x' });
  gdriveT.extractId = realEx2;
  ok(hubFail === false, 'sendHubCard returns false when not configured');

  /* 15k. welcome synthetic mek must carry a message (Baileys quoted crash) */
  // Baileys (rc.14 messages.js:568) reads quoted.message when sending
  // interactive cards; an empty synthetic mek crashed gifteds/baileys with
  // "Cannot read properties of undefined (reading 'undefined')".
  const indexSrc = require('fs').readFileSync('/home/user/test12/index.js', 'utf8');
  const fakeBlock = indexSrc.slice(indexSrc.indexOf('const fakeMek'), indexSrc.indexOf('};', indexSrc.indexOf('const fakeMek')));
  ok(/message:\s*\{\s*conversation:/.test(fakeBlock), 'welcome fakeMek carries a minimal .message', fakeBlock);
  ok(/sendHubCard/.test(indexSrc) && !/pattern === 'menu'/.test(indexSrc.slice(indexSrc.indexOf('greetMember'))),
     'welcome flow attaches the papers hub (not the main menu)');
  // only ONE welcome: plain text must be gated behind card failure
  const greetBlock = indexSrc.slice(indexSrc.indexOf('const greetMember'), indexSrc.indexOf("test.ev.on('group-participants.update'"));
  ok(greetBlock.includes('if (cardSent)'), 'plain text welcome only when the card fails');
  const textSendIdx = greetBlock.indexOf('await test.sendMessage(groupJid, { text');
  const cardIdx = greetBlock.indexOf('sendHubCard');
  ok(textSendIdx > cardIdx, 'card attempted BEFORE any plain text send');

  /* 15m. cross-student isolation (the 'agriculture leak' bug) */
  const A = { senderNumber: '94711111111', sender: '94711111111@s.whatsapp.net' };
  const B = { senderNumber: '94722222222', sender: '94722222222@s.whatsapp.net' };
  // A browses deep: root → 2021 → Physics (A's position = Physics folder)
  await papersCmd.function(sock, mek, {}, ctx({ from: 'ISOL@g.us', args: ['2021'], ...A }));
  await paperCmd.function(sock, mek, {}, ctx({ from: 'ISOL@g.us', args: ['1'], ...A }));
  ok(lastReply().includes('AI Mate Papers / 2021 / Physics'), 'A is inside Physics');
  // B types ".papers" in the SAME chat → B must see the ROOT, not A's folder
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'ISOL@g.us', args: [], ...B }));
  r = lastReply();
  ok(r.includes('AI Mate Papers*  (page') && r.includes('2020') && r.includes('2021') && !r.includes('/ Physics'),
     'B gets the ROOT menu, not A\'s folder view', r);
  // B has their OWN numbered list (root folders incl. new 2016) — A's list must not leak
  await paperCmd.function(sock, mek, {}, ctx({ from: 'ISOL@g.us', args: ['99'], ...B }));
  ok(lastReply().includes('this list has 4 item'), "B's list is B's own (root: 4 folders, not A's Physics view)", lastReply());
  // A's position is intact for A
  sent = [];
  await paperCmd.function(sock, mek, {}, ctx({ from: 'ISOL@g.us', args: ['2'], ...A }));  // folders first → P1 is item 2
  await drain();
  ok(docs().some((d) => d.content.fileName === 'Physics_PP1.pdf'), "A can still download from A's own view",
     JSON.stringify({ replies: sent.map((s) => s.reply).filter(Boolean) }));

  /* 15n. transient network errors: retried + friendly */
  const gdriveF = require('../lib/gdrive');
  const fe = gdriveF.friendlyError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  ok(fe.includes('unreachable') && fe.includes('try again'), 'network error → friendly message', fe);

  global.TRANSIENT_FAILS = 2;   // fail twice, succeed on 3rd attempt
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'RT@g.us', args: ['refresh'], isOwner: true }));
  ok(global.TRANSIENT_FAILS === 0, 'retry loop consumed both transient failures');
  ok(lastReply().includes('refreshed'), 'rebuild succeeds after transient retries', lastReply());
  global.TRANSIENT_FAILS = 0;

  /* 15o. bare "papers" always = fresh main menu (no stale sub-folder) */
  await papersCmd.function(sock, mek, {}, ctx({ from: 'FR@g.us', args: ['2021'], ...A }));
  await paperCmd.function(sock, mek, {}, ctx({ from: 'FR@g.us', args: ['1'], ...A }));
  ok(lastReply().includes('/ Physics'), 'A is inside Physics again');
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'FR@g.us', args: [], ...A }));   // bare papers
  r = lastReply();
  ok(r.includes('AI Mate Papers*  (page') && r.includes('2020') && !r.includes('/ Physics'),
     'bare papers resets to the main menu, never last state', r);
  // no-prefix 'papers' behaves the same
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'FR@g.us', args: ['2021'], ...A }));
  await paperCmd.function(sock, mek, {}, ctx({ from: 'FR@g.us', args: ['1'], ...A }));
  sent = [];
  await np.function(sock, mek, mCard, { from: 'FR@g.us', body: 'papers', sender: A.sender, reply: async (t) => { sent.push({ reply: t }); } });
  ok(lastCard && lastCard.title.includes('AI Mate Papers') && !lastCard.text.includes('/ Physics'),
     "no-prefix 'papers' also resets to the main menu", lastCard && lastCard.title);

  /* 15p. tap responses are never quoted (fixes "not supported" for others) */
  const { isTapResponse } = require('../lib/msg');
  ok(isTapResponse({ message: { interactiveResponseMessage: {} } }) === true, 'detector: interactiveResponseMessage');
  ok(isTapResponse({ message: { listResponseMessage: {} } }) === true, 'detector: listResponseMessage');
  ok(isTapResponse({ message: { buttonsResponseMessage: {} } }) === true, 'detector: buttonsResponseMessage');
  ok(isTapResponse({ message: { conversation: 'papers' } }) === false, 'detector: normal text not a tap');

  // end-to-end: student downloads via a BUTTON TAP → document arrives UNQUOTED
  sent = [];
  await papersCmd.function(sock, mek, {}, ctx({ from: 'TAP@g.us', args: ['2021'], sender: '94779999999@s.whatsapp.net' }));
  const tapMek = { key: { id: 'TAPMSG', remoteJid: 'TAP@g.us', fromMe: false, participant: '94779999999@s.whatsapp.net' }, message: { interactiveResponseMessage: { nativeFlowResponseMessage: {} } } };
  await paperCmd.function(sock, tapMek, {}, ctx({ from: 'TAP@g.us', args: ['2'], senderNumber: '94779999999', sender: '94779999999@s.whatsapp.net' }));
  await drain();
  const tapDoc = docs().find((d) => d.opts !== undefined);
  ok(!!tapDoc, 'tap download produced a document');
  ok(tapDoc && tapDoc.opts && tapDoc.opts.quoted === undefined,
     'document sent via tap is NOT quoted (no unsupported embed for others)', JSON.stringify(tapDoc && tapDoc.opts));

  /* 15q. legacy list format — tap bubbles render everywhere */
  const { sendButtonMenu, sendLegacyList } = require('../lib/buttons');
  let relayed = null;
  const legacySock = { user: { id: '9477:s.whatsapp.net' }, relayMessage: async (jid, message, o) => { relayed = { jid, message, o }; } };
  const longTitle = 'Very_Long_Combined_Maths_Structured_Essay_Paper_2021_GCE_AL_New_Syllabus_File.pdf';
  await sendButtonMenu(legacySock, 'LG@g.us', {
    title: '📚 AI Mate Papers',
    text: 'body text',
    footer: 'AI Mate Assistant',
    image: 'https://example.com/logo.jpeg',   // must be dropped silently
    listTitle: '📂 Open a folder…',
    sections: [{ title: 'Items', rows: [
      { id: '.paper 1', title: `1. ${longTitle}`, description: 'File · 4.0 MB — download' }
    ] }]
  }, { quoted: { key: { id: 'Q' }, message: { conversation: 'x' } } });
  const lm = relayed && relayed.message && relayed.message.listMessage;
  ok(!!lm, 'dropdowns relay as legacy listMessage', JSON.stringify(relayed && Object.keys(relayed.message)));
  ok(lm && lm.buttonText === '📂 Open a folder…', 'button label = listTitle', lm && lm.buttonText);
  ok(lm && lm.listType === 1, 'SINGLE_SELECT list type');
  ok(lm && lm.description === 'body text' && lm.title === '📚 AI Mate Papers', 'title/body carried');
  ok(lm && lm.sections[0].rows[0].rowId === '.paper 1', 'rowId = command id');
  ok(lm && lm.sections[0].rows[0].title.length <= 72, 'long row titles clamped to protocol limit',
     lm && String(lm.sections[0].rows[0].title.length));
  const bizNode = relayed && relayed.o && relayed.o.additionalNodes && relayed.o.additionalNodes[0];
  ok(bizNode && bizNode.tag === 'biz' && bizNode.content[0].tag === 'list'
     && bizNode.content[0].attrs.type === 'product_list' && bizNode.content[0].attrs.v === '2',
     'relay carries required <biz> list stanza (else WA silently drops)',
     JSON.stringify(bizNode && bizNode.content));
  // tap guard: legacy taps are detected too — so bot replies never quote them
  const tap = { message: { listResponseMessage: { singleSelectReply: { selectedRowId: '.paper 1' } } } };
  ok(isTapResponse(tap) === true, 'legacy tap detected (listResponseMessage) — never quoted');

  /* 16. extractId */
  assert.strictEqual(gdrive.extractId('https://drive.google.com/drive/folders/1AbCdefGHIJKLMnopQRS'), '1AbCdefGHIJKLMnopQRS');
  assert.strictEqual(gdrive.extractId('1AbCdefGHIJKLMnopQRS'), '1AbCdefGHIJKLMnopQRS');
  assert.strictEqual(gdrive.extractId('short'), '');
  ok(true, 'extractId handles URL / bare ID / junk');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });

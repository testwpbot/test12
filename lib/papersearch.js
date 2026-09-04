/**
 * Smart search engine for the papers plugin — a tiny local "knowledge base".
 *
 * Students search in many ways: "chem", "phy pp1", "phisics" (typo),
 * "past papers chemistry 2021", even Sinhala/Tamil. This module bridges all
 * of that onto the Drive index:
 *
 *  - synonym/abbreviation expansion (Sri Lankan A/L vocabulary)
 *  - prefix matching        (chem → chemistry, phy → physics)
 *  - fuzzy matching         (phisics → physics, chemestry → chemistry)
 *  - stopword removal       ("past papers", "exam", …)
 *  - name-over-path scoring, AND pass with a loose-match fallback
 *  - optional Gemini AI query expansion when GEMINI_API_KEY is configured
 *    (translates + normalises the query; failure falls back to local search)
 */

const axios = require('axios');
const config = require('../config');

/* ── knowledge base ──────────────────────────────────────────────────── */
const SYNONYMS = {
  chem: ['chemistry'], chemi: ['chemistry'], chemistry: ['chem'],
  phy: ['physics'], phys: ['physics'], physics: ['phy'],
  bio: ['biology'], biology: ['bio'],
  math: ['maths', 'mathematics'], maths: ['math', 'mathematics'], mathematics: ['maths'],
  eng: ['english'], english: ['eng'],
  sin: ['sinhala'], sinhala: ['sin'],
  tam: ['tamil'], tamil: ['tam'],
  hist: ['history'], history: ['hist'],
  geo: ['geography'], geography: ['geo'],
  civ: ['civics'], civics: ['civ'],
  agri: ['agriculture'], agriculture: ['agri'],
  bs: ['business'], business: ['bs', 'studies'],
  econ: ['economics'], economics: ['econ'],
  ict: ['technology'],
  combined: ['maths'],
  pp: ['paper'], paper: ['pp'],
  mcq: ['mcq'], essay: ['essay', 'structured'],
  answer: ['answers'], answers: ['answer'],
  scheme: ['schemas'], schemas: ['scheme'],
  provincial: ['provinsial', 'province'], provinsial: ['provincial', 'province'], province: ['provincial'],
  fwc: ['fwc'],
  al: ['al'], marking: ['marking']
};

const STOPWORDS = new Set([
  'past', 'papers', 'paper', 'exam', 'exams', 'old', 'new',
  'the', 'and', 'of', 'for', 'with', 'a', 'in', 'to', 'please', 'give', 'send', 'me'
]);

/* ── tokenising (Unicode-aware) ──────────────────────────────────────── */
function tokenize(text) {
  return String(text || '').toLowerCase().replace(/\u200D/g, '')
    .split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

/** Tokens for a name / folder path. "A_L" → ['a', 'l', 'al']. */
function tokensOf(text) {
  const s = String(text || '').toLowerCase();
  const out = tokenize(s);
  if (/[_-]/.test(s)) {
    const joined = s.replace(/[^a-z0-9]+/g, '');
    if (joined) out.push(joined);
  }
  return out;
}

/* ── fuzzy matching (bounded Levenshtein) ────────────────────────────── */
function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How well one file token matches a query group (0..1). */
function tokenScore(fileToken, group) {
  let best = 0;
  for (const v of group.variants) {
    if (fileToken === v) return 1;
    if (v.length >= 2 && fileToken.startsWith(v)) best = Math.max(best, 0.75);
    else if (fileToken.length >= 3 && v.startsWith(fileToken)) best = Math.max(best, 0.7);
    const long = Math.max(fileToken.length, v.length);
    if (long >= 4) {
      const tol = long >= 7 ? 2 : 1;
      if (levenshtein(fileToken, v, tol) <= tol) best = Math.max(best, 0.55);
    }
  }
  return best;
}

/** Score one entry against all query groups. */
function entryScore(entry, groups) {
  const nameT = tokensOf(entry.name);
  const pathT = tokensOf((entry.path || []).join(' '));
  let total = 0;
  let matched = 0;
  for (const g of groups) {
    let best = 0;
    for (const t of nameT) best = Math.max(best, tokenScore(t, g));
    const nameBest = best;
    for (const t of pathT) best = Math.max(best, tokenScore(t, g) * 0.6);
    if (best > 0) matched++;
    total += nameBest > 0 ? best : best * 0.9; // slight bonus when the name itself matches
  }
  return { total, matched };
}

/* ── query → groups ──────────────────────────────────────────────────── */
function buildGroups(query) {
  const raw = tokenize(query).filter((t) => !STOPWORDS.has(t));
  const groups = [];
  for (const t of raw) {
    const variants = new Set([t]);
    for (const syn of SYNONYMS[t] || []) variants.add(syn);
    groups.push({ token: t, variants: [...variants] });
  }
  return groups;
}

/* ── public: full-index search ───────────────────────────────────────── */
function searchIndex(index, query) {
  // YEAR PIN: when the query names a year ("biology 2020"), results may
  // ONLY come from that year — never from other years sharing the subject.
  const ym = String(query || '').match(/(19|20)\d{2}/);
  let idx = index;
  if (ym) {
    const y = ym[0];
    const files = (index.files || []).filter((f) =>
      `${(f.path || []).join(' ')} ${f.name || ''}`.includes(y));
    const folders = (index.folders || []).filter((f) =>
      (f.path || []).some((n) => String(n).includes(y)));
    if (files.length || folders.length) {
      idx = Object.assign({}, index, { files, folders });
    }
  }
  const groups = buildGroups(query);
  if (!groups.length) return { items: [], relaxed: false };
  // Year already enforced by the scope above — the REMAINING words must
  // all match too ('biology 2020' must never degrade to 'everything 2020').
  if (ym) {
    const nonYear = groups.filter((g) => !/^(19|20)\d{2}$/.test(g.token));
    if (nonYear.length) {
      const hits = [];
      for (const f of idx.files) {
        if (entryScore(f, nonYear).matched === nonYear.length) hits.push(f);
      }
      hits.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { items: hits, relaxed: false };
    }
  }
  const and = [];
  const loose = [];
  for (const f of idx.files) {
    const { total, matched } = entryScore(f, groups);
    if (matched === groups.length) and.push({ f, total });
    else if (groups.length >= 2 && matched >= groups.length - 1) loose.push({ f, total, matched });
  }
  const byScore = (a, b) => b.total - a.total || a.f.name.localeCompare(b.f.name);
  if (and.length) {
    and.sort(byScore);
    return { items: and.map((x) => x.f), relaxed: false };
  }
  loose.sort(byScore);
  return { items: loose.map((x) => x.f), relaxed: loose.length > 0 };
}

/** Find a child folder whose name matches a single-token query. */
function matchFolder(index, query, curNames) {
  const groups = buildGroups(query);
  if (groups.length !== 1) return null;
  const names = (curNames && curNames.length) ? curNames : null;
  const candidates = index.folders.filter((f) =>
    f.path.length === 2 ||
    (names && f.path.length === names.length + 1 && names.every((n, i) => f.path[i] === n)));
  for (const f of candidates) {
    const seg = f.path[f.path.length - 1];
    for (const t of tokensOf(seg)) {
      // exact or prefix only — never fuzzy: "2021" must never open "2020"
      if (tokenScore(t, groups[0]) >= 0.7) return f;
    }
  }
  return null;
}

/* ── optional Gemini AI query expansion ──────────────────────────────── */
const aiCache = new Map();       // query -> { at, value }
const AI_TTL = 24 * 60 * 60 * 1000;  // normalised queries repeat — cache a full day

/**
 * Returns an expanded English keyword string, or null when disabled/unusable.
 * KEY POOL: GEMINI_API_KEY first, then any extras in GEMINI_API_KEYS
 * (comma separated — add spares via .settings). If a key is rate-limited
 * or exhausted the next key takes over automatically; an invalid key is
 * benched for a week. Free quota resets at midnight US Pacific, so an
 * exhausted key is benched until ~09:00 UTC (≈2:30 PM in Sri Lanka).
 * A per-key daily cap (AI_DAILY_CAP) keeps the pool healthy on crazy days.
 */
const keyState = new Map();      // key -> { exhaustedUntil, deadUntil, day, count }
const aiCursor = { i: 0 };       // round-robin so all keys wear evenly

function geminiKeys() {
  const raw = [
    process.env.GEMINI_API_KEY || config.GEMINI_API_KEY || '',
    process.env.GEMINI_API_KEYS || config.GEMINI_API_KEYS || ''
  ].join(',');
  const seen = new Set();
  const out = [];
  for (const k of raw.split(/[,;\s]+/)) {
    const t = k.trim();
    if (t.length >= 20 && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

function dailyCap() {
  const n = parseInt(process.env.AI_DAILY_CAP || config.AI_DAILY_CAP || '500', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;   // 0 = unlimited
}

/** Next Gemini free-quota reset: ~midnight US Pacific ≈ 09:00 UTC. */
function nextResetMs() {
  const now = new Date();
  const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0);
  return reset > now.getTime() ? reset : reset + 24 * 3600 * 1000;
}

function slDayStamp() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Test/ops helper — clears AI cache, key state and rotation cursor. */
function geminiReset() {
  aiCache.clear();
  keyState.clear();
  aiCursor.i = 0;
}

/** One Gemini call over the KEY POOL. Returns reply text or null. */
async function geminiChat(body) {
  const keys = geminiKeys();
  if (!keys.length) return null;

  const cap = dailyCap();
  const model = String(process.env.GEMINI_MODEL || config.GEMINI_MODEL || 'gemini-2.5-flash-lite').trim();
  const start = aiCursor.i % keys.length;
  for (let n = 0; n < keys.length; n++) {
    const idx = (start + n) % keys.length;
    const key = keys[idx];
    const now = Date.now();
    const st = keyState.get(key) || {};
    if (st.deadUntil && st.deadUntil > now) continue;           // invalid key
    if (st.exhaustedUntil && st.exhaustedUntil > now) continue; // quota gone today
    if (cap) {
      if (st.day !== slDayStamp()) { st.day = slDayStamp(); st.count = 0; }
      if ((st.count || 0) >= cap) continue;                     // daily cap reached
    }
    const payload = Object.assign({}, body, {
      generationConfig: Object.assign({ thinkingConfig: { thinkingBudget: 0 } }, body.generationConfig || {})
    });
    try {
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        payload,
        { timeout: 8000 }
      );
      if (cap) { st.day = slDayStamp(); st.count = (st.count || 0) + 1; }
      keyState.set(key, st);
      aiCursor.i = idx + 1;
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts || [];
      return parts.map((p) => p && p.text || '').join(' ');
    } catch (e) {
      const status = e.response && e.response.status;
      const msg = String((e.response && e.response.data && e.response.data.error &&
        e.response.data.error.message) || e.message || '');
      if (status === 429 || /quota|resource.?exhausted|rate limit/i.test(msg)) {
        st.exhaustedUntil = nextResetMs();
        console.warn(`⚠️ gemini: key #${idx + 1} quota exceeded — benched until reset, trying next key…`);
      } else if (status === 400 || status === 401 || status === 403 || /api[_ ]?key/i.test(msg)) {
        st.deadUntil = now + 7 * 24 * 3600 * 1000;
        console.warn(`⚠️ gemini: key #${idx + 1} rejected (${status}) — benched 7 days, trying next key…`);
      } else {
        console.warn(`⚠️ gemini: key #${idx + 1} error (${status || e.code || e.message}) — trying next key…`);
      }
      keyState.set(key, st);
    }
  }
  console.warn('⚠️ gemini: no key available right now — local fallback');
  return null;
}

/**
 * AI query expansion — translate/normalise a query into 2-6 English
 * keywords. Used by the .papers/.paper commands as the rescue path.
 */
async function aiExpand(query) {
  const keys = geminiKeys();
  const q = String(query || '').trim();
  if (!keys.length || !q || q.length > 80) return null;

  const cacheKey = q.toLowerCase();
  const hit = aiCache.get(cacheKey);
  if (hit && Date.now() - hit.at < AI_TTL) return hit.value;

  const prompt =
    'You normalise search queries for a Sri Lankan A/L past-paper library on Google Drive. ' +
    'Translate any non-English words to English, fix spelling, and expand abbreviations ' +
    '(e.g. chem -> chemistry, phy -> physics, pp -> past paper). ' +
    'Reply with ONLY 2-6 simple English keywords separated by spaces, no explanation.\n' +
    `Query: ${query}`;
  const text = await geminiChat({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 60 }
  });
  if (text == null) return null;
  const tokens = String(text).toLowerCase().split(/[\n,;]+/)
    .flatMap((s) => s.split(/\s+/))
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9]{1,20}$/.test(s))
    .slice(0, 6);
  const value = tokens.length >= 1 ? tokens.join(' ') : null;
  if (aiCache.size > 500) aiCache.clear();
  aiCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/**
 * AI INTERPRETER — the free-form brain. Given the student's raw message and
 * the REAL library structure (years + subjects straight from the Drive
 * index), decides what the student wants and returns a structured intent:
 *   { action: 'find',   year, subject, medium }  — exact paper request
 *   { action: 'search', keywords }               — loose search
 *   { action: 'none' }                           — not a paper request
 * The BOT still does every Drive lookup, so the AI can never invent files.
 */
async function aiInterpret(query, index) {
  const q = String(query || '').trim();
  if (!q || q.length > 200) return null;

  // real library summary: "2020: Chemistry, Physics; 2021: …"
  let summary = '';
  try {
    const byYear = new Map();
    for (const f of ((index && index.folders) || [])) {
      if (f.path.length === 3) {
        if (!byYear.has(f.path[1])) byYear.set(f.path[1], []);
        byYear.get(f.path[1]).push(f.path[2]);
      }
    }
    const years = [...byYear.keys()];
    summary = years.length
      ? `Years in the library: ${years.join(', ')}.\nSubjects per year: ` +
        years.slice(0, 25).map((y) => `${y}: ${(byYear.get(y) || []).slice(0, 12).join(', ')}`).join('; ')
      : 'The library folder list is still empty.';
  } catch (e) { summary = 'Structure unknown.'; }

  const prompt =
    'You are the search brain of a WhatsApp bot that serves Sri Lankan G.C.E. A/L past papers ' +
    'from Google Drive. Files are named like "2020_Chemistry_Sinhala_Medium.pdf" ' +
    '(year + subject + medium).\n' +
    `${summary}\n` +
    'Subject codes you may use: ' + Object.keys(SUBJECTS).join(', ') + '.\n' +
    'Mediums: sinhala, english, tamil.\n' +
    'Decide what the student wants and reply with ONLY one JSON object, no other text:\n' +
    '{"action":"find","year":<number or null>,"subject":"<subject code or null>","medium":"<sinhala|english|tamil or null>","type":"<marking|mcq|essay|paper or null>","category":"<past|fwc|provincial or null>"}\n' +
    '{"action":"search","keywords":"2-6 simple english keywords"}\n' +
    '{"action":"none"}  // message is not about getting papers\n' +
    '"type" is what the student wants: marking scheme (also "answer sheet", "answer key", "answers") -> "marking", MCQ paper -> "mcq", essay/structured -> "essay", the question paper itself -> "paper" or null.\n' +
    '"category" is the paper collection: plain A/L exam papers -> "past", FWC papers -> "fwc", provincial papers (Sinhala: පළාත්) -> "provincial"; leave null when not mentioned.\n'
    'Rules: translate Sinhala/Tamil words to English, expand short forms ' +
    '(chem=chemistry, phy=physics, bio=biology, com maths=combinedmaths, bs=businessstudies, acc=accounting), ' +
    'fix typos. Only say find when you are sure of the subject.\n' +
    `Student message: ${query}`;
  const text = await geminiChat({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 120, responseMimeType: 'application/json' }
  });
  if (text == null) return null;
  try {
    const raw = String(text).replace(/```json|```/g, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    return normalizeInterpretation(JSON.parse(m ? m[0] : raw));
  } catch (e) {
    console.warn('⚠️ gemini: unparseable interpretation — local fallback');
    return null;
  }
}

/** Validate/clean one AI interpretation object (exported for tests). */
function normalizeInterpretation(obj) {
  const action = obj && obj.action;
  if (action !== 'find' && action !== 'search' && action !== 'none') return null;
  const out = { action, year: null, subject: null, medium: null, type: null, cat: null, keywords: '' };
  if (action === 'find') {
    const y = parseInt(obj.year, 10);
    if (Number.isFinite(y) && y >= 1970 && y <= 2100) out.year = y;
    if (obj.subject && SUBJECTS[obj.subject]) out.subject = obj.subject;
    if (obj.medium && MEDIUMS[obj.medium]) out.medium = obj.medium;
    if (['marking', 'mcq', 'essay', 'paper'].includes(obj.type)) out.type = obj.type;
    if (CATEGORIES[obj.category] && obj.category !== 'past') out.cat = obj.category;
    if (!out.subject) return null;                 // unsure find → treat as unusable
  } else if (action === 'search') {
    out.keywords = String(obj.keywords || '').toLowerCase().slice(0, 80);
    if (!out.keywords) return null;
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════ ══
   STRUCTURED PAPER REQUESTS — "Year + Subject + Medium"
   e.g. "2016 chemistry sinhala medium", "2022 phy eng mediam"
   Students type all kinds of variations, so every subject carries short
   terms and common typos (Sri Lanka G.C.E. A/L subject list).
   ══════════════════════════════════════════════════════════════════════ */
const SUBJECTS = {
  physics:        { label: 'Physics', aliases: ['phy', 'phys', 'phisics', 'phyics', 'pysics', 'භෞතික විද්යාව', 'භෞතික', 'இயற்பியல்'] },
  chemistry:      { label: 'Chemistry', aliases: ['chem', 'chemi', 'chemstry', 'chemestry', 'kemistry', 'රසායන විද්යාව', 'රසායනික', 'රසායන', 'வேதியியல்'] },
  biology:        { label: 'Biology', aliases: ['bio', 'bilogy', 'bioligy', 'ජීව විද්යාව', 'உயிரியல்'] },
  combinedmaths:  { label: 'Combined Mathematics', aliases: ['combined maths', 'combinedmaths', 'commaths', 'commath', 'com maths', 'cm', 'maths', 'math', 'mathematics', 'combined', 'එක්සත් ගණිතය', 'ගණිතය', 'கணிதம்'] },
  agriculture:    { label: 'Agriculture', aliases: ['agri', 'agro', 'agric', 'agricultural', 'agricultural science', 'agri science', 'farming', 'කෘෂිකර්ම', 'කෘෂි'] },
  ict:            { label: 'ICT', aliases: ['ict', 'it', 'information technology', 'information communication technology', 'තොරතුරු තාක්ෂණය', 'තොරතුරු තාක්ෂණ'] },
  sft:            { label: 'Science for Technology', aliases: ['sft', 'science for technology', 'science tech', 'sci tech', 'sci for tech'] },
  et:             { label: 'Engineering Technology', aliases: ['et', 'eng tech', 'engineering tech', 'engineeringtechnology', 'entech'] },
  bst:            { label: 'Bio Systems Technology', aliases: ['bst', 'bt', 'bio systems', 'biosystems', 'bio system technology', 'biosystem', 'bio resource', 'bio resource technology', 'brt', 'bio resources technology'] },
  economics:      { label: 'Economics', aliases: ['econ', 'eco', 'ecomomics', 'econimics', 'ආර්ථික විද්යාව', 'ආර්ථික'] },
  businessstudies:{ label: 'Business Studies', aliases: ['bs', 'business', 'business study', 'bus studies', 'b studies', 'busniess studies', 'ව්යාපාර අධ්යයනය', 'ව්යාපාර'] },
  accounting:     { label: 'Accounting', aliases: ['acc', 'acct', 'accounts', 'account', 'accouting', 'acounting', 'ගිණුම්කරණය', 'ගිණුම්'] },
  businessstats:  { label: 'Business Statistics', aliases: ['bstat', 'bstats', 'business statistics', 'business stat', 'statistics', 'stat'] },
  history:        { label: 'History', aliases: ['hist', 'histry'] },
  geography:      { label: 'Geography', aliases: ['geo', 'geogrphy'] },
  political:      { label: 'Political Science', aliases: ['pol', 'pol sci', 'polsci', 'political', 'politics'] },
  logic:          { label: 'Logic', aliases: ['logic', 'logic and scientific method'] },
  sinhala:        { label: 'Sinhala', aliases: ['sinhala lang', 'sinhala literature'] },
  english:        { label: 'English', aliases: ['general english', 'english lang', 'english literature'] },
  tamil:          { label: 'Tamil', aliases: ['tamil lang', 'tamil literature'] },
  buddhism:       { label: 'Buddhism', aliases: ['budhism', 'buddist'] },
  bc:             { label: 'Buddhist Civilization', aliases: ['bc', 'buddhist civilization', 'buddhist civ'] },
  christianity:   { label: 'Christianity', aliases: ['christ', 'christainity'] },
  art:            { label: 'Art', aliases: ['arts', 'drawing'] },
  dance:          { label: 'Dancing', aliases: ['dance'] },
  drama:          { label: 'Drama & Theatre', aliases: ['drama', 'theatre', 'theater'] },
  music:          { label: 'Music', aliases: ['music', 'oriental music', 'western music'] },
  media:          { label: 'Media Studies', aliases: ['media', 'mass media', 'communication and media studies', 'cms'] },
  homeecon:       { label: 'Home Economics', aliases: ['home econ', 'home economics', 'home science'] },
  hindi:          { label: 'Hindi', aliases: ['hindi'] },
  arabic:         { label: 'Arabic', aliases: ['arabic'] },
  french:         { label: 'French', aliases: ['french'] },
  japanese:       { label: 'Japanese', aliases: ['japanese', 'japan'] },
  sanskrit:       { label: 'Sanskrit', aliases: ['sanskrit', 'sanscrit'] },
  pali:           { label: 'Pali', aliases: ['pali'] },
  islam:          { label: 'Islam', aliases: ['islam'] },
  git:            { label: 'GIT', aliases: ['git', 'general information technology'] },
  englishlit:     { label: 'English Literature', aliases: ['literature'] }
};

const MEDIUMS = {
  sinhala: { label: 'Sinhala', tokens: ['sinhala', 'sin', 'si', 'sinhla', 'සිංහල'] },
  english: { label: 'English', tokens: ['english', 'eng', 'en', 'ඉංග්රීසි', 'ஆங்கிலம்'] },
  tamil:   { label: 'Tamil',   tokens: ['tamil', 'tam', 'ta', 'tmil', 'தமிழ்', 'දෙමළ'] }
};

/* PAPER COLLECTIONS — past / fwc / provincial (a file without a marker
   counts as the regular past paper). Words students actually type,
   Sinhala and Tamil included. */
const CATEGORIES = {
  past:       { label: 'Past paper', words: ['past', 'old', 'pasugiya', 'පසුගිය', 'prashna pathra', 'ප්‍රශ්න පත්‍ර'] },
  fwc:        { label: 'FWC paper', words: ['fwc'] },
  provincial: { label: 'Provincial paper', words: ['provincial', 'provinsial', 'provencial', 'province', 'palath', 'palathe', 'පළාත්', 'மாகாண'] }
};
const CAT_BY_WORD = {};
for (const [k, v] of Object.entries(CATEGORIES)) for (const w of v.words) CAT_BY_WORD[w] = k;

/* TYPE words (marking scheme / mcq / essay) — Sinhala + Tamil included. */
const TYPE_WORDS = {
  marking: ['marking', 'markin', 'markingg', 'scheme', 'schemes', 'sceme', 'schme', 'schem',
    'answer', 'answers', 'answer sheet', 'answersheet', 'answer key', 'answerkey',
    'key', 'uttara', 'uthara', 'utara', 'uttara pathra', 'uthara pathra',
    'උත්තර', 'උත්තර පත්රය', 'விடை', 'விடைத்தாள்'],
  mcq: ['mcq', 'mcqs'],
  essay: ['essay', 'structured']
};
const TYPE_BY_WORD = {};
for (const [k, v] of Object.entries(TYPE_WORDS)) for (const w of v) TYPE_BY_WORD[w] = k;
// the word "medium" itself — with the typos customers actually type
const MEDIUM_NOUNS = new Set(['medium', 'mediam', 'meduim', 'mediums', 'mediaum', 'med']);
const MEDIUM_BY_TOKEN = {};
for (const [k, v] of Object.entries(MEDIUMS)) for (const t of v.tokens) MEDIUM_BY_TOKEN[t] = k;

// NOTE: \p{L}\p{N} keeps Sinhala/Tamil letters; ZWJ (‍) is stripped so
// 'විද්‍යාව' and 'විද්යාව' normalise to the same tokens.
const normText = (s) => String(s || '').toLowerCase().replace(/\u200D/g, '')
  .replace(/[^\p{L}\p{M}\p{N}\s/]+/gu, ' ').replace(/\s+/g, ' ').trim();
const splitTokens = (s) => normText(s).split(' ').filter(Boolean);
const squash = (s) => String(s || '').toLowerCase().replace(/\u200D/g, '').replace(/[^\p{L}\p{M}\p{N}]/gu, '');

// per-subject match tokens: canonical words + every alias word + squashed phrases
const SUBJECT_MATCH = {};
for (const [key, s] of Object.entries(SUBJECTS)) {
  const set = new Set();
  for (const phrase of [key, s.label.toLowerCase(), ...s.aliases]) {
    for (const t of splitTokens(phrase)) set.add(t);
    const sq = squash(phrase);
    if (sq && phrase.includes(' ')) set.add(sq);
  }
  SUBJECT_MATCH[key] = set;
}

/** Locate a subject phrase inside a token list (longest alias wins). */
function subjectPhraseIn(tokens) {
  let best = null; // { key, start, len }
  for (const [key, s] of Object.entries(SUBJECTS)) {
    const phrases = [key, s.label.toLowerCase(), ...s.aliases];
    for (const phrase of phrases) {
      const pt = splitTokens(phrase);
      if (!pt.length || pt.length > tokens.length) continue;
      for (let i = 0; i + pt.length <= tokens.length; i++) {
        if (pt.every((w, j) => tokens[i + j] === w)) {
          if (!best || pt.length > best.len) best = { key, start: i, len: pt.length };
        }
      }
    }
  }
  return best;
}
function subjectFromTokens(tokens) {
  const hit = subjectPhraseIn(tokens);
  return hit ? hit.key : null;
}

/**
 * Parse a structured request: "2016 chemistry sinhala medium".
 * Returns null when the text has no year+medium skeleton at all.
 * Returns { year, medium, subject: null, subjectRaw } when a year and a
 * medium are present but the subject is unknown — caller should show the
 * usage guide.
 */
function parsePaperQuery(text) {
  const norm = normText(text);
  if (!norm || norm.length > 60) return null;
  let tokens = norm.split(' ').filter(Boolean);
  // optional leading command word: ".papers …" / "paper …" / "getpaper …"
  if (/^(papers?|getpaper|pastpaper)$/.test(tokens[0])) tokens = tokens.slice(1);
  if (tokens.length < 2 || tokens.length > 7) return null;
  const yearTok = tokens.find((t) => /^(19|20)\d{2}$/.test(t));
  if (!yearTok) return null;
  const year = parseInt(yearTok, 10);
  tokens = tokens.filter((t) => t !== yearTok);
  const hasMediumNoun = tokens.some((t) => MEDIUM_NOUNS.has(t));
  tokens = tokens.filter((t) => !MEDIUM_NOUNS.has(t));
  // medium = the LAST token that names a medium
  let medium = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (MEDIUM_BY_TOKEN[tokens[i]]) {
      medium = MEDIUM_BY_TOKEN[tokens[i]]; // canonical: sinhala/english/tamil
      tokens.splice(i, 1);
      break;
    }
  }
  // medium is OPTIONAL now — a year with a subject (or medium) is enough to
  // start the interview; the bot asks for whatever is missing.
  // collection: pull the category word out before reading the subject
  let cat = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (CAT_BY_WORD[tokens[i]]) {
      cat = CAT_BY_WORD[tokens[i]];
      tokens.splice(i, 1);
      break;
    }
  }
  // type: marking / mcq / essay ("2016 bio sinhala marking" resolves fully)
  let type = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (TYPE_BY_WORD[tokens[i]]) {
      type = TYPE_BY_WORD[tokens[i]];
      tokens.splice(i, 1);
      break;
    }
  }
  const subjectRaw = tokens.join(' ').trim();
  const subject = subjectRaw ? subjectFromTokens(tokens) : null;
  if (!subject && !medium && !hasMediumNoun && !cat && !type) return null;  // nothing usable
  return { year, medium, subject, subjectRaw, hasMediumNoun, cat, type };
}

/* Words that may trail an exact paper name without making it a variant. */
const FILLER_WORDS = new Set(['paper', 'papers']);

/**
 * Strictly classify a file name in "Year + Subject + Medium" format.
 * Returns { year, subject, medium, cat, extra } where `cat` is the paper
 * collection (past|fwc|provincial — unmarked = past) and `extra` holds
 * leftover words (mcq, essay, marking, 2, …) that make the file a VARIANT.
 */
function classifyFileName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  let tokens = splitTokens(base);
  const yearTok = tokens.find((t) => /^(19|20)\d{2}$/.test(t)) || null;
  if (yearTok) {
    const i = tokens.indexOf(yearTok);
    tokens = [...tokens.slice(0, i), ...tokens.slice(i + 1)];
  }
  tokens = tokens.filter((t) => !MEDIUM_NOUNS.has(t));
  let medium = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (MEDIUM_BY_TOKEN[tokens[i]]) {
      medium = MEDIUM_BY_TOKEN[tokens[i]];
      tokens.splice(i, 1);
      break;
    }
  }
  // collection: pull the category word out of the token stream
  let cat = 'past';
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (CAT_BY_WORD[tokens[i]]) {
      cat = CAT_BY_WORD[tokens[i]];
      tokens.splice(i, 1);
      break;
    }
  }
  const hit = subjectPhraseIn(tokens);
  let subject = null;
  let extra = tokens;
  if (hit) {
    subject = hit.key;
    extra = [...tokens.slice(0, hit.start), ...tokens.slice(hit.start + hit.len)];
  }
  return { year: yearTok ? parseInt(yearTok, 10) : null, subject, medium, cat, extra };
}

const _clsCache = new WeakMap();
/**
 * classifyFileName for a whole index, ENRICHED from folder paths: files
 * named without a year/subject inherit them from their path
 * (Chemistry_PP1.pdf in 2021/Physics = 2021 chemistry), and collections
 * (FWC/Provincial/Marking) are recognised from folder names too.
 */
function classifyAll(index) {
  let m = _clsCache.get(index);
  if (!m) {
    m = new Map();
    for (const f of ((index && index.files) || [])) {
      const c = classifyFileName(f.name);
      if (!c.year) {
        for (const seg of (f.path || [])) {
          if (/^(19|20)\d{2}$/.test(String(seg))) { c.year = parseInt(seg, 10); break; }
        }
      }
      const pathSegs = (f.path || []).slice(1);
      if (!c.subject) c.subject = subjectPhraseIn(splitTokens(pathSegs.join(' ')))?.key || null;
      for (const seg of pathSegs) {
        for (const t of splitTokens(seg)) {
          if (CAT_BY_WORD[t]) c.cat = CAT_BY_WORD[t];
          if (TYPE_WORDS.marking.includes(t)) c.typeKind = 'marking';
        }
      }
      if (!c.typeKind) {
        for (const w of c.extra) if (TYPE_WORDS.marking.includes(w)) { c.typeKind = 'marking'; break; }
      }
      m.set(f, c);
    }
    _clsCache.set(index, m);
  }
  return m;
}

/**
 * All files matching year + subject + medium — EXACT names first.
 * A file whose extra words are only filler ("… Medium Paper.pdf") counts
 * as the exact paper; MCQ/essay/marking siblings are variants and are
 * returned only when no exact-named file exists for the combination.
 */
function matchPaper(index, q) {
  // year is ALWAYS required; subject or medium (or both) narrow it further
  if (!q || !Number.isFinite(q.year) || (!q.subject && !MEDIUMS[q.medium])) return [];
  const wantCat = CATEGORIES[q.cat] ? q.cat : null;
  const exact = [];
  const variants = [];
  const cls = classifyAll(index);   // path-aware: files named without a year
                                    // inherit it from their folder
  for (const f of (index.files || [])) {
    const c = cls.get(f);
    if (c.year !== q.year) continue;
    if (wantCat && c.cat !== wantCat) continue;      // fwc/provincial/past
    if (q.subject && c.subject !== q.subject) continue;
    if (q.medium && c.medium !== q.medium) continue;
    if (c.extra.every((w) => FILLER_WORDS.has(w))) exact.push(f);
    else variants.push({ f, n: c.extra.length });
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  if (exact.length) return exact.sort(byName);
  return variants.sort((a, b) => a.n - b.n || byName(a.f, b.f)).map((v) => v.f);
}

module.exports = {
  SYNONYMS, STOPWORDS, buildGroups, searchIndex, matchFolder,
  aiExpand, tokensOf, tokenScore, levenshtein,
  SUBJECTS, MEDIUMS, MEDIUM_NOUNS, parsePaperQuery, matchPaper, classifyFileName,
  geminiReset, geminiKeys, aiInterpret, normalizeInterpretation, subjectFromTokens,
  CATEGORIES, TYPE_WORDS, classifyAll
};


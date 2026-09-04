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

/* ── tokenising ──────────────────────────────────────────────────────── */
function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
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
  const groups = buildGroups(query);
  if (!groups.length) return { items: [], relaxed: false };
  const and = [];
  const loose = [];
  for (const f of index.files) {
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
const AI_TTL = 60 * 60 * 1000;

/**
 * Returns an expanded English keyword string, or null when disabled/unusable.
 * Enabled by setting GEMINI_API_KEY (env override or .settings).
 */
async function aiExpand(query) {
  const key = String(process.env.GEMINI_API_KEY || config.GEMINI_API_KEY || '').trim();
  if (!key || !query || query.length > 80) return null;

  const cacheKey = query.toLowerCase();
  const hit = aiCache.get(cacheKey);
  if (hit && Date.now() - hit.at < AI_TTL) return hit.value;

  try {
    const prompt =
      'You normalise search queries for a Sri Lankan A/L past-paper library on Google Drive. ' +
      'Translate any non-English words to English, fix spelling, and expand abbreviations ' +
      '(e.g. chem -> chemistry, phy -> physics, pp -> past paper). ' +
      'Reply with ONLY 2-6 simple English keywords separated by spaces, no explanation.\n' +
      `Query: ${query}`;
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 60 }
      },
      { timeout: 8000 }
    );
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0].text || '';
    const tokens = String(text).toLowerCase().split(/[\n,;]+/)
      .flatMap((s) => s.split(/\s+/))
      .map((s) => s.trim())
      .filter((s) => /^[a-z0-9]{1,20}$/.test(s))
      .slice(0, 6);
    const value = tokens.length >= 1 ? tokens.join(' ') : null;
    if (aiCache.size > 200) aiCache.clear();
    aiCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (e) {
    console.error('papers: AI search expansion failed:', e.message || e);
    return null;
  }
}


/* ════════════════════════════════════════════════════════════════════ ══
   STRUCTURED PAPER REQUESTS — "Year + Subject + Medium"
   e.g. "2016 chemistry sinhala medium", "2022 phy eng mediam"
   Students type all kinds of variations, so every subject carries short
   terms and common typos (Sri Lanka G.C.E. A/L subject list).
   ══════════════════════════════════════════════════════════════════════ */
const SUBJECTS = {
  physics:        { label: 'Physics', aliases: ['phy', 'phys', 'phisics', 'phyics', 'pysics'] },
  chemistry:      { label: 'Chemistry', aliases: ['chem', 'chemi', 'chemstry', 'chemestry', 'kemistry'] },
  biology:        { label: 'Biology', aliases: ['bio', 'bilogy', 'bioligy'] },
  combinedmaths:  { label: 'Combined Mathematics', aliases: ['combined maths', 'combinedmaths', 'commaths', 'commath', 'com maths', 'cm', 'maths', 'math', 'mathematics', 'combined'] },
  agriculture:    { label: 'Agriculture', aliases: ['agri', 'agro', 'agric', 'agricultural', 'farming'] },
  ict:            { label: 'ICT', aliases: ['ict', 'it', 'information technology', 'information communication technology'] },
  sft:            { label: 'Science for Technology', aliases: ['sft', 'science for technology', 'science tech', 'sci tech', 'sci for tech'] },
  et:             { label: 'Engineering Technology', aliases: ['et', 'eng tech', 'engineering tech', 'engineeringtechnology', 'entech'] },
  bst:            { label: 'Bio Systems Technology', aliases: ['bst', 'bt', 'bio systems', 'biosystems', 'bio system technology', 'biosystem'] },
  economics:      { label: 'Economics', aliases: ['econ', 'eco', 'ecomomics', 'econimics'] },
  businessstudies:{ label: 'Business Studies', aliases: ['bs', 'business', 'business study', 'bus studies', 'b studies', 'busniess studies'] },
  accounting:     { label: 'Accounting', aliases: ['acc', 'acct', 'accounts', 'account', 'accouting', 'acounting'] },
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
  sinhala: { label: 'Sinhala', tokens: ['sinhala', 'sin', 'si', 'sinhla', 'sinhla'] },
  english: { label: 'English', tokens: ['english', 'eng', 'en'] },
  tamil:   { label: 'Tamil',   tokens: ['tamil', 'tam', 'ta', 'tmil'] }
};
// the word "medium" itself — with the typos customers actually type
const MEDIUM_NOUNS = new Set(['medium', 'mediam', 'meduim', 'mediums', 'mediaum', 'med']);
const MEDIUM_BY_TOKEN = {};
for (const [k, v] of Object.entries(MEDIUMS)) for (const t of v.tokens) MEDIUM_BY_TOKEN[t] = k;

const normText = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s/]+/g, ' ').replace(/\s+/g, ' ').trim();
const splitTokens = (s) => normText(s).split(' ').filter(Boolean);
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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

/** Try to identify the subject from a token list (longest alias wins). */
function subjectFromTokens(tokens) {
  let best = null; // { key, len }
  for (const [key, s] of Object.entries(SUBJECTS)) {
    const phrases = [key, s.label.toLowerCase(), ...s.aliases];
    for (const phrase of phrases) {
      const pt = splitTokens(phrase);
      if (pt.length > tokens.length) continue;
      for (let i = 0; i + pt.length <= tokens.length; i++) {
        if (pt.every((w, j) => tokens[i + j] === w)) {
          if (!best || pt.length > best.len) best = { key, len: pt.length };
        }
      }
    }
  }
  return best ? best.key : null;
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
  if (!medium) return null;
  const subjectRaw = tokens.join(' ').trim();
  const subject = subjectRaw ? subjectFromTokens(tokens) : null;
  return { year, medium, subject, subjectRaw, hasMediumNoun };
}

/** All files in the index matching year + subject + medium, best first. */
function matchPaper(index, q) {
  if (!q || !q.subject || !MEDIUMS[q.medium]) return [];
  const year = String(q.year);
  const subTokens = SUBJECT_MATCH[q.subject];
  const medTokens = new Set([...MEDIUMS[q.medium].tokens, q.medium]);
  const scored = [];
  for (const f of (index.files || [])) {
    const hay = `${(f.path || []).join(' ')} ${f.name}`.toLowerCase();
    if (!hay.includes(year)) continue;
    const toks = new Set(tokensOf(hay));
    let sq = null;
    if (hay.includes('_') || hay.includes('-') || hay.includes(' ')) { sq = squash(hay); toks.add(sq); }
    const hasSub = [...subTokens].some((t) => toks.has(t) || (t.length > 6 && hay.includes(t)));
    if (!hasSub) continue;
    const hasMed = [...medTokens].some((t) => toks.has(t));
    if (!hasMed) continue;
    const pathStr = (f.path || []).join(' ').toLowerCase();
    const nameStr = String(f.name || '').toLowerCase();
    let score = 0;
    if (pathStr.includes(year)) score += 8;                       // year as folder
    if (nameStr.includes(year)) score += 2;                       // year in file name
    if ([...subTokens].some((t) => pathStr.includes(t))) score += 4;  // subject folder
    if (toks.has(q.medium)) score += 2;                           // full medium word in name
    score += Math.min([...subTokens].filter((t) => toks.has(t)).length, 3);
    scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score || a.f.name.localeCompare(b.f.name));
  return scored.map((s) => s.f);
}

module.exports = {
  SYNONYMS, STOPWORDS, buildGroups, searchIndex, matchFolder,
  aiExpand, tokensOf, tokenScore, levenshtein,
  SUBJECTS, MEDIUMS, MEDIUM_NOUNS, parsePaperQuery, matchPaper
};


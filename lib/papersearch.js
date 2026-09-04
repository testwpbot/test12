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

module.exports = {
  SYNONYMS, STOPWORDS, buildGroups, searchIndex, matchFolder,
  aiExpand, tokensOf, tokenScore, levenshtein
};

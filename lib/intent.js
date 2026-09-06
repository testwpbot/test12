/**
 * Local knowledge base — understands conversational paper asks WITHOUT any
 * online AI: "i need papers?", "you have it?", "do you have marking
 * schemes?", "paper thiyenawada?", "ඕන් පත්තරයෙක්", "paper venum" …
 * Returns an INTENT, and the bot replies naturally (nothing in the replies
 * mentions how the bot works — no "AI", no "knowledge base").
 */
const HAVE_WORDS = new Set([
  'have', 'has', 'got',
  'thiyenawada', 'thiyenawa', 'thiyenwada', 'thiyennda', 'thiyeda', 'thibenawada',
  'තියෙනවද', 'තියෙනවා', 'තියෙද', 'තියෙන්න', 'තිබෙනවද', 'තියෙන',
  'irukka', 'iruku', 'irukum', 'iruka',
  'இருக்கிறதா', 'இருக்கு', 'உண்டா'
]);
const WANT_WORDS = new Set([
  'need', 'needs', 'want', 'wants', 'wanna', 'looking', 'get',
  'oni', 'onu', 'one', 'ඕන්', 'ඕනෙ', 'ඕනෑ', 'ඕන්න', 'ඕනෝ',
  'venum', 'வேண்டும்', 'வேணும்',
  'denna', 'දෙන්න', 'send', 'give', 'show', 'find'
]);
const PAPER_WORDS = new Set([
  'paper', 'papers', 'pp', 'pastpaper', 'pastpapers', 'al',
  'mcq', 'essay', 'structured', 'marking', 'scheme', 'answer', 'answers',
  'පත්ර', 'පත්තර', 'පත්රය', 'පත්තරය', 'ප්රශ්න', 'ප්රශ්නය', 'ප්රශ්නපත්ර',
  'prashna', 'pathra', 'patra',
  'வினா', 'வினாத்தாள்', 'தாள்', 'paperகள்'
]);
// pronoun-ish words that must never count as a subject/year ("you have IT?")
const PRONOUNS = new Set([
  'it', 'that', 'this', 'any', 'them', 'they', 'one', 'eka', 'ekak', 'eva',
  'ඒක', 'ඒවා', 'මේක', 'அத', 'அதை',
  'i', 'im', 'me', 'my', 'you', 'your', 'u', 'we', 'us',
  'bro', 'machan', 'aiya', 'sir', 'please', 'pls', 'plz',
  'the', 'a', 'an', 'of', 'for', 'from', 'with', 'and', 'or', 'to'
]);

const norm = (text) => String(text || '').toLowerCase().replace(/\u200D/g, '')
  .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
const toks = (text) => norm(text).split(' ').filter(Boolean);
const first = (set, list) => list.find((t) => set.has(t)) || null;

/** Drop pronoun/filler words so subject/year detection stays clean. */
function stripPronouns(text) {
  return toks(text).filter((t) => !PRONOUNS.has(t)).join(' ');
}

/**
 * Detect a conversational intent.
 *   'availability' — "you have it?" / "do you have papers?" / "thiyenawada?"
 *   'guide'        — "i need papers?" / "need paper" / "ඕන් පත්තරයෙක්"
 *   null           — not a paper conversation
 * Messages WITH details (year/subject/medium) return null — the normal
 * request flow handles those better.
 */
function detect(text) {
  const t = toks(text);
  if (!t.length || t.length > 8) return null;
  const has = first(HAVE_WORDS, t);
  const want = first(WANT_WORDS, t);
  const paper = first(PAPER_WORDS, t) ||
    t.find((w) => /^පත්/.test(w) || /வினா|தாள்/.test(w)) || null;
  const itWord = t.find((w) => PRONOUNS.has(w) &&
    ['it', 'that', 'this', 'any', 'them', 'they', 'eka', 'ekak', 'eva', 'ඒක', 'ඒවා', 'මේක', 'அத', 'அதை'].includes(w));
  // availability: a have-word + (a paper word, OR "it/that" as the object,
  // OR a Sinhala/Tamil have-word which on its own means "do you have?")
  if (has && (paper || itWord || !/^[a-z]+$/.test(has))) return 'availability';
  // generic ask: a want-word + a paper word ("i need papers?") — with no
  // details, so the bot shows the how-to-ask guide
  if (want && paper) return 'guide';
  return null;
}

module.exports = { detect, stripPronouns };

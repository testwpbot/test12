/**
 * Bot identity for mention detection. index.js remembers the logged-in
 * account JID at message time; filters use isBotMention() to tell
 * "@bot ..." apart from tagging other people.
 */
const digits = new Set();

function remember(jid) {
  const raw = String(jid || '');
  const d = raw.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (d) {
    digits.add(d);
    if (raw.includes('@')) digits.add(raw);
  }
}

/** True when this message mentions the bot (contextInfo or "@<number>"). */
function isBotMention(mek) {
  const mm = mek && mek.message;
  if (!mm) return false;
  const cx = (mm.extendedTextMessage && mm.extendedTextMessage.contextInfo) ||
             (mm.imageMessage && mm.imageMessage.contextInfo) ||
             (mm.videoMessage && mm.videoMessage.contextInfo);
  const text = String(mm.conversation || (mm.extendedTextMessage && mm.extendedTextMessage.text) || '');
  for (const d of digits) {
    if (cx && Array.isArray(cx.mentionedJid) &&
        cx.mentionedJid.some((j) => String(j).includes(d))) return true;
    if (d.length > 4 && text.includes('@' + d)) return true;
  }
  return false;
}

function reset() { digits.clear(); }   // test helper

module.exports = { remember, isBotMention, reset };

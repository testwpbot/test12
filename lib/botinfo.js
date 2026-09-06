/**
 * Bot identity for mention detection. index.js remembers the logged-in
 * account JID at message time; filters use isBotMention() to tell
 * "@bot ..." apart from tagging other people.
 */
const digits = new Set();
let announced = false;

function remember(jid) {
  const raw = String(jid || '');
  const d = raw.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (d) {
    digits.add(d);
    if (raw.includes('@')) digits.add(raw);
    if (!announced) {
      announced = true;
      console.log(`[botinfo] mention detection armed (identity: ${d})`);
    }
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
  // @lid mentions: WhatsApp may encode the tag with a LID that never
  // matches our number — accept the bot's DISPLAY NAME after '@' too
  // ("@AI Mate ..." / "@AI Mate Assistant ...")
  const config = require('../config');
  const name = String(config.BOT_NAME || '').trim().replace(/\s+/g, '\\s*');
  if (name.length >= 3 && new RegExp('@' + name, 'i').test(text)) return true;
  return false;
}

function reset() { digits.clear(); }   // test helper

module.exports = { remember, isBotMention, reset };

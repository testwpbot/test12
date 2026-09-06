/* ── greetings & mentions ──────────────────────────────────────────────
 * "hello" / "hi" (any short greeting, Sinhala/Tamil included) gets a warm
 * reply with the how-to-ask-a-paper guide. When a member MENTIONS the bot
 * and greets, it greets back; mention + a paper ask is served by the
 * papers engine (its handler catches the request first).
 * ─────────────────────────────────────────────────────────────────────── */
const { cmd } = require('../command');
const config = require('../config');
const { sendButtons } = require('../lib/buttons');
const guideGate = require('../lib/guidegate');

let settingsPlugin = null;
try { settingsPlugin = require('./settings'); } catch (e) { /* optional */ }

// greeting vocab (EN + Sinhala + Tamil) + the company words that may trail
const GREET_WORDS = new Set([
  'hi', 'hii', 'hiii', 'hello', 'helo', 'halo', 'hlo', 'hey', 'hai',
  'ayubowan', 'aubowan', 'aayubowan', 'ආයුබෝවන්', 'ආයුබෝ', 'හලෝ', 'හෙලෝ', 'හල්ලෝ',
  'vanakkam', 'வணக்கம்',
  'good', 'morning', 'afternoon', 'evening', 'night', 'gm', 'gn',
  'bro', 'machan', 'aiya', 'sir', 'team', 'all'
]);

// Greetings that MEAN the same share one memory family: "hiii" ≈ "hi",
// "හලෝ" ≈ "hello", "gm" ≈ "good morning". Each DISTINCT greeting word
// greets once per window — but its elongations/translations do not
// re-greet (that would feel like spam).
const GREET_FAMILY = {
  'hi': 'hi', 'hii': 'hi', 'hiii': 'hi', 'hai': 'hi',
  'hello': 'hello', 'helo': 'hello', 'halo': 'hello', 'hlo': 'hello',
  'හලෝ': 'hello', 'හෙලෝ': 'hello', 'හල්ලෝ': 'hello',
  'hey': 'hey',
  'ayubowan': 'ayubowan', 'aubowan': 'ayubowan', 'aayubowan': 'ayubowan',
  'ආයුබෝවන්': 'ayubowan', 'ආයුබෝ': 'ayubowan',
  'vanakkam': 'vanakkam', 'வணக்கம்': 'vanakkam',
  'morning': 'morning', 'gm': 'morning',
  'afternoon': 'afternoon', 'evening': 'evening', 'night': 'night', 'gn': 'night',
  'bro': 'bro', 'machan': 'machan', 'aiya': 'aiya', 'sir': 'sir', 'team': 'team', 'all': 'all'
};

/** Canonical greeting family of a message ("hiii bro" → "hi"). */
const greetFamilyOf = (text) => {
  const toks = stripMentionTokens(text).toLowerCase().replace(/\u200D/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  for (const t of toks) {
    if (t === 'good') continue;                        // "good morning" → morning
    if (GREET_FAMILY[t]) return GREET_FAMILY[t];
    if (GREET_WORDS.has(t)) return t;                  // unseen greeting word → itself
  }
  return 'hello';
};

const digitsOf = (j) => String(j || '').split('@')[0].replace(/[^0-9]/g, '');

/** Every number that counts as "the bot itself". */
function botDigits(sock) {
  const set = new Set();
  for (const j of [sock && sock.user && sock.user.id, config.BOT_OWNER, config.LOG_NUMBER]) {
    const d = digitsOf(j);
    if (d) set.add(d);
  }
  return set;
}

/** Is the bot mentioned in this message? (mentionedJid or "@<number>") */
function mentionedBy(mek, sock) {
  const mm = mek && mek.message;
  if (!mm) return false;
  const cx = (mm.extendedTextMessage && mm.extendedTextMessage.contextInfo) ||
             (mm.imageMessage && mm.imageMessage.contextInfo) ||
             (mm.videoMessage && mm.videoMessage.contextInfo);
  const mine = botDigits(sock);
  if (cx && Array.isArray(cx.mentionedJid) &&
      cx.mentionedJid.some((j) => mine.has(digitsOf(j)))) return true;
  const body = String(mm.conversation || (mm.extendedTextMessage && mm.extendedTextMessage.text) || '');
  for (const d of mine) if (d.length > 4 && body.includes('@' + d)) return true;
  return false;
}

const stripMentionTokens = (text) =>
  String(text || '').replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim();

const isPureGreeting = (text) => {
  const toks = stripMentionTokens(text).toLowerCase().replace(/\u200D/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  return toks.length >= 1 && toks.length <= 3 && toks.every((t) => GREET_WORDS.has(t));
};

cmd({
  noPrefixTriggers: true,
  filter: (text, extra) => {
    try {
      const mek = extra && extra.message;
      if (!mek || mek.key?.fromMe) return false;            // never greet ourselves
      const jid = String(mek.key?.remoteJid || '');
      if (!jid || jid.endsWith('@broadcast')) return false;
      if (settingsPlugin && settingsPlugin.isPending &&
          settingsPlugin.isPending(extra.sender)) return false;

      const body = String(text || '').trim();
      if (!body || body.length > 60 || body.includes('\n') || body.includes('http://') || body.includes('https://')) return false;

      // 1) plain short greeting: "hello", "hi bro", "good morning"
      if (isPureGreeting(body)) return true;

      // 2) bot mentioned + greeting/empty remainder: "@AI Mate hi"
      if (mentionedBy(mek)) {
        const nameWords = String(config.BOT_NAME || '').toLowerCase().split(/\s+/).filter(Boolean);
        const restToks = stripMentionTokens(body).toLowerCase().replace(/\u200D/g, '')
          .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ').split(/\s+/)
          .filter((t) => t && !nameWords.includes(t));
        if (!restToks.length) return true;                       // bare mention
        // a real paper ask ("@Bot 2019 chemistry sinhala") → papers engine
        const paperish = restToks.some((t) => /^(19|20)\d{2}$/.test(t)) ||
          restToks.includes('papers') || restToks.includes('paper') || restToks.includes('pp');
        if (paperish) return false;
        if (restToks.length <= 3 && restToks.every((t) => GREET_WORDS.has(t))) return true;
        if (restToks.length <= 6 && restToks.some((t) => GREET_WORDS.has(t))) return true;
        return false;
      }
      return false;
    } catch (e) {
      console.error('greeting filter error:', (e && e.message) || e);
      return false;
    }
  }
}, async (sock, mek, m, ctx) => {
  try {
    // per-WORD anti-spam memory: "hello" greets once, a second "hello" is
    // silent, but a DIFFERENT greeting ("hi", "ayubowan", …) greets again.
    // Each word once per gap (default 6h).
    const fam = greetFamilyOf(String(ctx.body || ''));
    if (guideGate.recent(ctx, fam)) return;
    const name = String(mek.pushName || '').split(/\s+/)[0];
    const hello = name ? `👋 Hello *${name}*!` : '👋 Hello!';
    // options live ONLY on the buttons below — no text list (no duplication)
    const card =
      `${hello}\n\n` +
      `🎓 Welcome to *Almate.edu.lk*\nhttps://almate.edu.lk\n\n` +
      `Your Smart A/L Learning AI Assistant 🇱🇰\n\n` +
      `How can I help you? 👇`;
    try {
      // quick-reply buttons attached to the message (NOT a menu dropdown);
      // taps arrive as buttonsResponseMessage → body → normal command pipeline
      await sendButtons(sock, ctx.from, {
        text: card,
        footer: '🚧 AI Assistant & Stream Group are coming soon!',
        buttons: [
          { id: '.papers', text: '📚 Past Papers' },
          { id: '.ms', text: '📖 Marking Schemes' },
          { id: '.ai', text: '🤖 AI Assistant' },
          { id: '.stream', text: '👥 Stream Group' }
        ]
      }, { quoted: mek });
    } catch (e) {
      // button send failed → plain-text fallback keeps the greeting alive
      await ctx.reply(`${card}\n\n📚 *Past Papers* • 📖 *Marking Schemes*\n🤖 *AI Assistant* & 👥 *Stream Group* — coming soon!`);
    }
    guideGate.mark(ctx, fam);   // this greeting word (per-word memory)
  } catch (e) {
    console.error('greeting reply error:', (e && e.message) || e);
  }
});

/* ── welcome-card placeholders — options 3 & 4 are COMING SOON ────────── */
cmd({
  pattern: 'ai',
  desc: 'Almate AI Assistant (coming soon)',
  category: 'main',
  filename: __filename
}, async (sock, mek, m, ctx) => {
  return ctx.reply('🤖 *Almate AI Assistant* is COMING SOON! 🚧\nI will answer your A/L questions here — stay tuned!');
});

cmd({
  pattern: 'stream',
  desc: 'Join A/L Stream Group (coming soon)',
  category: 'main',
  filename: __filename
}, async (sock, mek, m, ctx) => {
  return ctx.reply('👥 *A/L Stream Group* is COMING SOON! 🚧\nThe invite link will be shared here — stay tuned!');
});

/**
 * Anti-spam memory for greeting / guide messages.
 * Remembers which chat+student already received a greeting or the
 * "how to ask for a paper" guide, and suppresses repeats until the
 * configured gap passes (GUIDE_GAP_HOURS, default 6, 0 = always reply).
 */
const config = require('../config');

const mem = new Map();   // "chat:sender" -> last-sent timestamp

function gapMs() {
  const n = parseInt(process.env.GUIDE_GAP_HOURS || config.GUIDE_GAP_HOURS || '6', 10);
  if (!Number.isFinite(n) || n < 0) return 6 * 3600 * 1000;
  return n * 3600 * 1000;
}

function key(ctx, word) {
  const base = `${ctx.from || ''}:${ctx.sender || ctx.senderNumber || ''}`;
  // a greeting WORD gets its own slot: "hello" once, "hi" greets again
  return word ? `${base}:${word}` : base;
}

/** True when this student already got the message within the gap. */
function recent(ctx, word) {
  const gap = gapMs();
  if (gap === 0) return false;              // memory disabled
  prune();
  const t = mem.get(key(ctx, word));
  return !!(t && Date.now() - t < gap);
}

/** Record that the message was just sent to this student. */
function mark(ctx, word) {
  const gap = gapMs();
  if (gap === 0) return;
  mem.set(key(ctx, word), Date.now());
}

/** Drop stale entries so the map never grows unbounded. */
function prune() {
  const cutoff = Date.now() - Math.max(gapMs(), 3600 * 1000);
  for (const [k, t] of mem) if (t < cutoff) mem.delete(k);
}

/** Test/ops helper — forget everyone. */
function reset() { mem.clear(); }

module.exports = { recent, mark, reset, gapMs, key };

/**
 * Bot working-mode gate.
 *   mode "group" (default): the bot answers in GROUPS and the OWNER's
 *                           inbox only — every other private chat is
 *                           ignored SILENTLY (no react, no reply).
 *   mode "both":            groups AND all private inboxes.
 * Unknown/empty mode falls back to "group" (safe default).
 */
function chatAllowed(mode, { isGroup, isOwner, fromMe } = {}) {
  const m = String(mode || '').trim().toLowerCase() === 'both' ? 'both' : 'group';
  if (m === 'both') return true;
  if (isGroup) return true;
  return !!(isOwner || fromMe);
}

module.exports = { chatAllowed };

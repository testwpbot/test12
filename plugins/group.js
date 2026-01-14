const { cmd } = require("../command");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");

/* ─────────────── HELPERS ─────────────── */

async function getGroupContext(sock, m) {
const metadata = await sock.groupMetadata(m.chat);

const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";

const isBotSender = m.sender === botId;

const isUserAdmin =
  isBotSender ||
  metadata.participants.some(
    p => p.id === m.sender && (p.admin === "admin" || p.admin === "superadmin")
  );

const isBotAdmin =
  metadata.owner === botId ||
  metadata.participants.some(
    p => p.id === botId && (p.admin === "admin" || p.admin === "superadmin")
  );

if (!isUserAdmin)
  return reply("❌ You must be an admin.");

if (!isBotAdmin)
  return reply("❌ I must be an admin to do this.");

function getTargetUser(mek, quoted, args) {
  if (mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length) {
    return mek.message.extendedTextMessage.contextInfo.mentionedJid[0];
  }
  if (quoted?.sender) return quoted.sender;
  if (args[0]?.includes("@"))
    return args[0].replace("@", "") + "@s.whatsapp.net";
  return null;
}

/* ─────────────── KICK ─────────────── */

cmd({
  pattern: "kick",
  react: "👢",
  desc: "Kick user from group",
  category: "group"
}, async (sock, mek, m, { isGroup, reply, quoted, args }) => {

  if (!isGroup) return reply("❌ Group only command.");

  const { isUserAdmin, isBotAdmin, participants } =
    await getGroupContext(sock, m);

  if (!isUserAdmin) return reply("❌ You must be an admin.");
  if (!isBotAdmin) return reply("❌ I must be admin to do this.");

  const target = getTargetUser(mek, quoted, args);
  if (!target) return reply("❌ Mention or reply to a user.");

  const isTargetAdmin = participants.some(
    p => p.id === target && p.admin
  );

  if (isTargetAdmin)
    return reply("❌ I can’t kick another admin.");

  await sock.groupParticipantsUpdate(m.chat, [target], "remove");

  reply(`✅ Kicked: @${target.split("@")[0]}`, { mentions: [target] });
});

/* ─────────────── PROMOTE ─────────────── */

cmd({
  pattern: "promote",
  react: "⬆️",
  desc: "Promote user to admin",
  category: "group"
}, async (sock, mek, m, { isGroup, reply, quoted, args }) => {

  if (!isGroup) return reply("❌ Group only command.");

  const { isUserAdmin, isBotAdmin } =
    await getGroupContext(sock, m);

  if (!isUserAdmin) return reply("❌ You must be an admin.");
  if (!isBotAdmin) return reply("❌ I must be admin.");

  const target = getTargetUser(mek, quoted, args);
  if (!target) return reply("❌ Mention or reply to a user.");

  await sock.groupParticipantsUpdate(m.chat, [target], "promote");

  reply(`✅ Promoted: @${target.split("@")[0]}`, { mentions: [target] });
});

/* ─────────────── DEMOTE ─────────────── */

cmd({
  pattern: "demote",
  react: "⬇️",
  desc: "Demote admin",
  category: "group"
}, async (sock, mek, m, { isGroup, reply, quoted, args }) => {

  if (!isGroup) return reply("❌ Group only command.");

  const { isUserAdmin, isBotAdmin } =
    await getGroupContext(sock, m);

  if (!isUserAdmin) return reply("❌ You must be an admin.");
  if (!isBotAdmin) return reply("❌ I must be admin.");

  const target = getTargetUser(mek, quoted, args);
  if (!target) return reply("❌ Mention or reply to a user.");

  await sock.groupParticipantsUpdate(m.chat, [target], "demote");

  reply(`✅ Demoted: @${target.split("@")[0]}`, { mentions: [target] });
});

/* ─────────────── SET PP ─────────────── */

cmd({
  pattern: "setpp",
  desc: "Set group profile picture",
  category: "group"
}, async (sock, mek, m, { isGroup, reply, quoted }) => {

  if (!isGroup) return reply("❌ Group only command.");

  const { isUserAdmin, isBotAdmin } =
    await getGroupContext(sock, m);

  if (!isUserAdmin) return reply("❌ You must be admin.");
  if (!isBotAdmin) return reply("❌ I must be admin.");

  if (!quoted?.message?.imageMessage)
    return reply("❌ Reply to an image.");

  const media = await downloadMediaMessage(quoted, "buffer");
  await sock.updateProfilePicture(m.chat, media);

  reply("✅ Group profile picture updated.");
});

/* ─────────────── OPEN / CLOSE ─────────────── */

cmd({
  pattern: "open",
  alias: ["unmute"],
  react: "🔓",
  category: "group"
}, async (sock, mek, m, { isGroup, reply }) => {

  if (!isGroup) return reply("❌ Group only.");

  const { isUserAdmin, isBotAdmin } =
    await getGroupContext(sock, m);

  if (!isUserAdmin) return reply("❌ You must be admin.");
  if (!isBotAdmin) return reply("❌ I must be admin.");

  await sock.groupSettingUpdate(m.chat, "not_announcement");
  reply("✅ Group unmuted.");
});

cmd({
  pattern: "close",
  alias: ["mute"],
  react: "🔒",
  category: "group"
}, async (sock, mek, m, { isGroup, reply }) => {

  if (!isGroup) return reply("❌ Group only.");

  const { isUserAdmin, isBotAdmin } =
    await getGroupContext(sock, m);

  if (!isUserAdmin) return reply("❌ You must be admin.");
  if (!isBotAdmin) return reply("❌ I must be admin.");

  await sock.groupSettingUpdate(m.chat, "announcement");
  reply("✅ Group muted.");
});

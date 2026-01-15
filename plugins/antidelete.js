const fs = require('fs');
const path = require('path');

let deletedMessages = {};
let deletedMediaPath = {};

const tempFolder = path.join(__dirname, '../temp');
if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder, { recursive: true });

module.exports = {
  onMessage: async (conn, msg) => {
    const key = msg.key;
    const content = msg.message;
    if (!content || key.fromMe) return;

    // Save message for text & media
    deletedMessages[key.id] = { key, message: content };

    if (msg._mediaBuffer && msg._mediaType) {
      let ext = '.bin';
      if (msg._mediaType === 'imageMessage') ext = '.jpg';
      else if (msg._mediaType === 'videoMessage') ext = '.mp4';
      else if (msg._mediaType === 'audioMessage') ext = '.ogg';
      else if (msg._mediaType === 'stickerMessage') ext = '.webp';
      else if (msg._mediaType === 'documentMessage') {
        ext = msg.message.documentMessage?.fileName
          ? path.extname(msg.message.documentMessage.fileName)
          : '.bin';
      }

      const fileName = `${key.id}${ext}`;
      const filePath = path.join(tempFolder, fileName);
      try {
        await fs.promises.writeFile(filePath, msg._mediaBuffer);
        deletedMediaPath[key.id] = filePath;
      } catch (e) {
        console.log('❌ Media save failed:', e.message);
      }
    }
  },

  onDelete: async (conn, updates) => {
    for (const update of updates) {
      if (!update || !update.key) continue;

      const isDeleteEvent = update.action === 'delete' || update.update?.message === null;
      if (!isDeleteEvent) continue;

      const from = update.key.remoteJid;
      const sender = update.key.participant || from;

      const deleted =
        deletedMessages[update.key.id] ||
        deletedMessages[update.update?.key?.id];

      if (!deleted) {
        continue;
      }


      try {
        let caption = `┏━━ 🚨 *DILSHAN-MD Alert* ━━┓

👤 *Sender:* @${sender.split('@')[0]}
🕒 *Time:* ${new Date().toLocaleString()}

⚠️ Deleted message has been successfully *recovered*.

✅ Service: *DILSHAN-MD WhatsApp Assistant*

┗━━━━━━━━━━━━━━━━━━━━┛`;

        const mediaPath = deletedMediaPath[update.key.id] || deletedMediaPath[update.update?.key?.id];
        if (mediaPath && fs.existsSync(mediaPath)) {
          let messageOptions = { caption, mentions: [sender] };
          if (mediaPath.endsWith('.jpg')) {
            await conn.sendMessage(from, { image: { url: mediaPath }, ...messageOptions });
          } else if (mediaPath.endsWith('.mp4')) {
            await conn.sendMessage(from, { video: { url: mediaPath }, ...messageOptions });
          } else if (mediaPath.endsWith('.webp')) {
            await conn.sendMessage(from, { sticker: { url: mediaPath } });
            await conn.sendMessage(from, { text: caption, mentions: [sender] }); // 👈 Sticker caption
          } else if (mediaPath.endsWith('.ogg')) {
            await conn.sendMessage(from, {
              audio: { url: mediaPath, mimetype: 'audio/ogg; codecs=opus' }
            });
            await conn.sendMessage(from, { text: caption, mentions: [sender] }); // 👈 Audio caption
          } else if (mediaPath.endsWith('.pdf')) {
            await conn.sendMessage(from, { document: { url: mediaPath }, ...messageOptions });
          } else {
            await conn.sendMessage(from, { document: { url: mediaPath }, ...messageOptions });
          }
        } else {
          let textMessage = null;

          if (deleted.message.conversation) {
            textMessage = deleted.message.conversation;
          } else if (deleted.message.extendedTextMessage && deleted.message.extendedTextMessage.text) {
            textMessage = deleted.message.extendedTextMessage.text;
          } else if (deleted.message.imageMessage && deleted.message.imageMessage.caption) {
            textMessage = deleted.message.imageMessage.caption;
          } else if (deleted.message.videoMessage && deleted.message.videoMessage.caption) {
            textMessage = deleted.message.videoMessage.caption;
          } else if (deleted.message.documentMessage && deleted.message.documentMessage.caption) {
            textMessage = deleted.message.documentMessage.caption;
          } else {
            const msgValues = Object.values(deleted.message);
            for (const val of msgValues) {
              if (val?.text) {
                textMessage = val.text;
                break;
              }
            }
          }

          if (textMessage) {
            await conn.sendMessage(from, { text: caption + `\n\n📝 *Message:* ${textMessage}`, mentions: [sender] });
          } else {
            await conn.sendMessage(from, { text: caption, mentions: [sender] });
          }
        }
      } catch (e) {
        console.log('❌ Error resending deleted message:', e);
      }
    }
  }
};

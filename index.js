const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  proto,
  generateWAMessageContent,
  generateWAMessage,
  AnyMessageContent,
  prepareWAMessageMedia,
  areJidsSameUser,
  downloadContentFromMessage,
  MessageRetryMap,
  generateForwardMessageContent,
  generateWAMessageFromContent,
  generateMessageID, makeInMemoryStore,
  jidDecode,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const fs = require('fs');
const P = require('pino');
const express = require('express');
const axios = require('axios');
const path = require('path');
const qrcode = require('qrcode-terminal');

const config = require('./config');
const { sms, downloadMediaMessage } = require('./lib/msg');
const { sendButtons, sendInteractive, sendButtonMenu } = require('./lib/buttons');
const {
  getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson
} = require('./lib/functions');
const { File } = require('megajs');
const { commands, replyHandlers } = require('./command');

const app = express();
// PORT is read from config.js (env var override handled there)

// All owner numbers, prefix, bot name etc. now live in config.js
// (editable at runtime with the .settings command).
const credsPath = path.join(__dirname, '/auth_info_baileys/creds.json');

async function ensureSessionFile() {
  if (!fs.existsSync(credsPath)) {
    if (!config.SESSION_ID) {
      console.error('❌ SESSION_ID env variable is missing. Cannot restore session.');
      process.exit(1);
    }

    console.log("🔄 creds.json not found. Downloading session from MEGA...");

    const sessdata = config.SESSION_ID;
    const filer = File.fromURL(`https://mega.nz/file/${sessdata}`);

    filer.download((err, data) => {
      if (err) {
        console.error("❌ Failed to download session file from MEGA:", err);
        process.exit(1);
      }

      fs.mkdirSync(path.join(__dirname, '/auth_info_baileys/'), { recursive: true });
      fs.writeFileSync(credsPath, data);
      console.log("✅ Session downloaded and saved. Restarting bot...");
      setTimeout(() => {
        connectToWA();
      }, 2000);
    });
  } else {
    setTimeout(() => {
      connectToWA();
    }, 1000);
  }
}


const antiDeletePlugin = require('./plugins/antidelete.js');
global.pluginHooks = global.pluginHooks || [];
global.pluginHooks.push(antiDeletePlugin);


async function connectToWA() {
  console.log(`Connecting ${config.BOT_NAME} 🧬...`);
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '/auth_info_baileys/'));
  const { version } = await fetchLatestBaileysVersion();

  const test = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Firefox"),
    auth: state,
    version,
    syncFullHistory: true,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
  });

  test.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        connectToWA();
      }
    } else if (connection === 'open') {
      console.log(`✅ ${config.BOT_NAME} connected to WhatsApp`);

      const up = `${config.BOT_NAME} connected ✅\n\nPREFIX: ${config.PREFIX}`;
      await test.sendMessage(config.logJid(), {
        image: { url: config.ALIVE_IMG },
        caption: up
      });

      fs.readdirSync("./plugins/").forEach((plugin) => {
        if (path.extname(plugin).toLowerCase() === ".js") {
          require(`./plugins/${plugin}`);
        }
      });
    }
  });

  test.ev.on('creds.update', saveCreds);

  test.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.messageStubType === 68) {
        await test.sendMessageAck(msg.key);
      }
    }

    const mek = messages[0];
    if (!mek || !mek.message) return;
    mek.message = getContentType(mek.message) === 'ephemeralMessage' ? mek.message.ephemeralMessage.message : mek.message;
   

        if (global.pluginHooks) {
      for (const plugin of global.pluginHooks) {
        if (plugin.onMessage) {
          try {
            await plugin.onMessage(test, mek);
          } catch (e) {
            console.log("onMessage error:", e);
          }
        }
      }
    }
 
    
    
if (mek.key?.remoteJid === 'status@broadcast') {
  const senderJid = mek.key.participant || mek.key.remoteJid || "unknown@s.whatsapp.net";
  const mentionJid = senderJid.includes("@s.whatsapp.net") ? senderJid : senderJid + "@s.whatsapp.net";

  if (config.isEnabled("AUTO_STATUS_SEEN")) {
    try {
      await test.readMessages([mek.key]);
      console.log(`[✓] Status seen: ${mek.key.id}`);
    } catch (e) {
      console.error("❌ Failed to mark status as seen:", e);
    }
  }

  if (config.isEnabled("AUTO_STATUS_REACT") && mek.key.participant) {
    try {
      const emojis = ['❤️', '💸', '😇', '🍂', '💥', '💯', '🔥', '💫', '💎', '💗', '🤍', '🖤', '👀', '🙌', '🙆', '🚩', '🥰', '💐', '😎', '🤎', '✅', '🫀', '🧡', '😁', '😄', '🌸', '🕊️', '🌷', '⛅', '🌟', '🗿', '💜', '💙', '🌝', '🖤', '💚'];
      const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

      await test.sendMessage(mek.key.participant, {
        react: {
          text: randomEmoji,
          key: mek.key,
        }
      });

      console.log(`[✓] Reacted to status of ${mek.key.participant} with ${randomEmoji}`);
    } catch (e) {
      console.error("❌ Failed to react to status:", e);
    }
  }

  if (mek.message?.extendedTextMessage && !mek.message.imageMessage && !mek.message.videoMessage) {
    const text = mek.message.extendedTextMessage.text || "";
    if (text.trim().length > 0) {
      try {
        await test.sendMessage(config.logJid(), {
          text: `📝 *Text Status*\n👤 From: @${mentionJid.split("@")[0]}\n\n${text}`,
          mentions: [mentionJid]
        });
        console.log(`✅ Text-only status from ${mentionJid} forwarded.`);
      } catch (e) {
        console.error("❌ Failed to forward text status:", e);
      }
    }
  }

  if (mek.message?.imageMessage || mek.message?.videoMessage) {
    try {
      const msgType = mek.message.imageMessage ? "imageMessage" : "videoMessage";
      const mediaMsg = mek.message[msgType];

      const stream = await downloadContentFromMessage(
        mediaMsg,
        msgType === "imageMessage" ? "image" : "video"
      );

      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      const mimetype = mediaMsg.mimetype || (msgType === "imageMessage" ? "image/jpeg" : "video/mp4");
      const captionText = mediaMsg.caption || "";

      await test.sendMessage(config.logJid(), {
        [msgType === "imageMessage" ? "image" : "video"]: buffer,
        mimetype,
        caption: `📥 *Forwarded Status*\n👤 From: @${mentionJid.split("@")[0]}\n\n${captionText}`,
        mentions: [mentionJid]
      });

      console.log(`✅ Media status from ${mentionJid} forwarded.`);
    } catch (err) {
      console.error("❌ Failed to download or forward media status:", err);
    }
  }
}


const m = sms(test, mek)
const type = getContentType(mek.message)
const content = JSON.stringify(mek.message)
const from = mek.key.remoteJid
const quoted = type == 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo != null ? mek.message.extendedTextMessage.contextInfo.quotedMessage || [] : []
    const body = (m && typeof m.body === 'string' && m.body.length > 0) ? m.body :
      (type === 'conversation') ? mek.message.conversation :
        (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text :
          (type == 'imageMessage' && mek.message.imageMessage.caption) ? mek.message.imageMessage.caption :
            (type == 'videoMessage' && mek.message.videoMessage.caption) ? mek.message.videoMessage.caption : '';
    const isCmd = body.startsWith(prefix);
    const commandName = isCmd ? body.slice(prefix.length).trim().split(" ")[0].toLowerCase() : '';
    const args = body.trim().split(/ +/).slice(1);
    const q = args.join(' ');

    const sender = mek.key.fromMe ? test.user.id : (mek.key.participant || mek.key.remoteJid);
    const senderNumber = sender.split('@')[0];
    const isGroup = from.endsWith('@g.us');
    const botNumber = test.user.id.split(':')[0];
    const pushname = mek.pushName || 'Sin Nombre';
    const isMe = botNumber.includes(senderNumber);
    const isOwner = config.isOwner(senderNumber) || isMe;
    const botNumber2 = await jidNormalizedUser(test.user.id);

    const groupMetadata = isGroup ? await test.groupMetadata(from).catch(() => {}) : '';
    const groupName = isGroup ? groupMetadata.subject : '';
    const participants = isGroup ? groupMetadata.participants : '';
    const groupAdmins = isGroup ? await getGroupAdmins(participants) : '';
    const isBotAdmins = isGroup ? groupAdmins.includes(botNumber2) : false;
    const isAdmins = isGroup ? groupAdmins.includes(sender) : false;

    const reply = (text) => test.sendMessage(from, { text }, { quoted: mek });

    if (isCmd) {
      const cmd = commands.find((c) => c.pattern === commandName || (c.alias && c.alias.includes(commandName)));
      if (cmd) {
        if (cmd.react) test.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
        try {
          cmd.function(test, mek, m, {
            from, quoted: mek, body, isCmd, command: commandName, args, q,
            isGroup, sender, senderNumber, botNumber2, botNumber, pushname,
            isMe, isOwner, groupMetadata, groupName, participants, groupAdmins,
            isBotAdmins, isAdmins, reply,
            sendButtons: (data, opts) => sendButtons(test, from, data, { quoted: mek, ...opts }),
            sendInteractive: (content, opts) => sendInteractive(test, from, content, { quoted: mek, ...opts }),
            sendButtonMenu: (config, opts) => sendButtonMenu(test, from, config, { quoted: mek, ...opts })
          });
        } catch (e) {
          console.error("[PLUGIN ERROR]", e);
        }
      }
    }

    const replyText = body;
    for (const handler of replyHandlers) {
      if (handler.filter(replyText, { sender, message: mek })) {
        try {
          await handler.function(test, mek, m, {
            from, quoted: mek, body: replyText, sender, reply,
          });
          break;
        } catch (e) {
          console.log("Reply handler error:", e);
        }
      }
    }
  });

  
  test.ev.on('messages.update', async (updates) => {
    if (global.pluginHooks) {
      for (const plugin of global.pluginHooks) {
        if (plugin.onDelete) {
          try {
            await plugin.onDelete(test, updates);
          } catch (e) {
            console.log("onDelete error:", e);
          }
        }
      }
    }
  });
}



ensureSessionFile();

app.get("/", (req, res) => {
  res.send(`Hey, ${config.BOT_NAME} started✅`);
});

app.listen(config.PORT, () => console.log(`Server listening on http://localhost:${config.PORT}`));

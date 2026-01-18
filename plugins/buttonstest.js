const { cmd } = require("../command");
const { proto, generateWAMessageFromContent } = require("@whiskeysockets/baileys");

cmd({
  pattern: "bt",
  alias: ["buttontest", "buttons"],
  react: "🧪",
  desc: "Test WhatsApp buttons (official Baileys)",
  category: "test",
  filename: __filename
}, async (danuwa, mek, m, { from }) => {

  const msg = generateWAMessageFromContent(
    from,
    proto.Message.fromObject({
      interactiveMessage: {
        header: {
          title: "🎬 Button Test",
          subtitle: "Official Baileys"
        },
        body: {
          text: "Click a button below 👇"
        },
        footer: {
          text: "test-MD • Button Test"
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "BTN_PING",
                title: "🏓 Ping"
              }
            },
            {
              type: "reply",
              reply: {
                id: "BTN_ALIVE",
                title: "🤖 Alive"
              }
            }
          ]
        }
      }
    }),
    { quoted: mek }
  );

  await danuwa.relayMessage(from, msg.message, {
    messageId: msg.key.id
  });

});

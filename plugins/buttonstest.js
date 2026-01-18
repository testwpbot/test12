const { cmd } = require("../command");
const { proto, generateWAMessageFromContent } = require("@whiskeysockets/baileys");

cmd({
  pattern: "bt",
  alias: ["listtest", "buttons"],
  react: "🧪",
  desc: "Test WhatsApp list messages (safe in 2026)",
  category: "test",
  filename: __filename
}, async (danuwa, mek, m, { from }) => {

  const msg = generateWAMessageFromContent(
    from,
    proto.Message.fromObject({
      listMessage: {
        title: "🎬 List Test",
        description: "Choose an option below 👇",
        buttonText: "OPEN MENU",
        footerText: "test-MD • List Test",
        sections: [
          {
            title: "Test Actions",
            rows: [
              {
                title: "🏓 Ping",
                description: "Check bot response",
                rowId: "LIST_PING"
              },
              {
                title: "🤖 Alive",
                description: "Check bot status",
                rowId: "LIST_ALIVE"
              }
            ]
          }
        ]
      }
    }),
    { quoted: mek }
  );

  await danuwa.relayMessage(from, msg.message, {
    messageId: msg.key.id
  });

});

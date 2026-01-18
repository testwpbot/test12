const { cmd } = require("../command");

cmd({
  pattern: "bt",
  alias: ["listtest", "buttons"],
  react: "🧪",
  desc: "Test WhatsApp list messages (safe in 2026)",
  category: "test",
  filename: __filename
}, async (danuwa, mek, m, { from }) => {

  await danuwa.sendMessage(from, {
    text: "🎬 *List Test*\nChoose an option below 👇",
    footer: "test-MD • List Test",
    title: "Button Alternative",
    buttonText: "OPEN MENU",
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
  }, { quoted: mek });

});

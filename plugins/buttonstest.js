const { cmd } = require("../command");

cmd({
  pattern: "buttontest",
  alias: ["bt", "buttons"],
  react: "🧪",
  desc: "Test WhatsApp buttons (interactiveMessage)",
  category: "test",
  filename: __filename
}, async (danuwa, mek, m, { from, reply }) => {

  await danuwa.sendMessage(from, {
    interactiveMessage: {
      header: {
        title: "🎬 Button Test",
        subtitle: "Official Baileys"
      },
      body: {
        text: "Click a button below to test 👇"
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
  }, { quoted: mek });

});

/**
 * List Menu Test Plugin
 * Clicking a row sends exact command (.ping)
 */

const { cmd } = require("../command");

cmd(
  {
    pattern: "bt",
    alias: ["buttontest", "buttons"],
    react: "🧪",
    desc: "List menu test (command payload)",
    category: "test",
    filename: __filename
  },
  async (danuwa, mek, m, { from, quoted }) => {
    try {
      const listMessage = {
        text: "🎬 Command List Test",
        footer: "test-MD • List Menu",
        title: "Select a command",
        buttonText: "OPEN MENU",
        sections: [
          {
            title: "Test Commands",
            rows: [
              {
                title: "🏓 Ping",
                description: "Check bot latency",
                rowId: ".ping"
              },
              {
                title: "🤖 Alive",
                description: "Bot status",
                rowId: ".alive"
              }
            ]
          }
        ]
      };

      await danuwa.sendMessage(from, listMessage, { quoted });

    } catch (err) {
      console.error("❌ List menu error:", err);
    }
  }
);

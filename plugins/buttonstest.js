

const { cmd } = require("../command");
const { sendButtons } = require("gifted-btns");

cmd(
  {
    pattern: "bt",
    alias: ["buttontest", "buttons"],
    react: "🧪",
    desc: "Button test (command payload buttons)",
    category: "test",
    filename: __filename
  },
  async (danuwa, mek, m, { from, quoted }) => {
    try {
      // Safety check (required for gifted-btns)
      if (!danuwa?.user || !danuwa?.relayMessage) {
        console.log("❌ Invalid Baileys socket");
        return;
      }

      // Button payloads MUST be commands
      const buttons = [
        { id: ".menu", text: "🏓 Menu" },
        { id: ".alive", text: "🤖 Alive" },
                { id: ".menu1", text: "🏓 Menu" },
                { id: ".menu2", text: "🏓 Menu" },
                { id: ".menu3", text: "🏓 Menu" },
                { id: ".menu4", text: "🏓 Menu" },
      ];

      // Send buttons
      await sendButtons(
        danuwa,
        from,
        {
          text: "🎬 Button Command Test",
          footer: "test-MD • Click = Command",
          buttons
        },
        { quoted }
      );

      console.log("✅ Button command test sent");

    } catch (err) {
      console.error("❌ Button plugin error:", err);
    }
  }
);

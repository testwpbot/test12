const { cmd } = require("../command");
const { sendButtons } = require("gifted-btns");

cmd({
  pattern: "bt",
  alias: ["buttontest", "buttons"],
  react: "🧪",
  desc: "Test WhatsApp buttons (gifted-btns)",
  category: "test",
  filename: __filename
}, async (danuwa, mek, m, { from, quoted, body }) => {
  try {
    // 'danuwa' is your main Baileys socket, must have 'user' and 'relayMessage'
    if (!danuwa.user) return console.log("❌ Socket missing 'user' property");

    // Buttons array
    const buttons = [
      { id: "BTN_PING", text: "🏓 Ping" },
      { id: "BTN_ALIVE", text: "🤖 Alive" }
    ];

    // Send buttons
    await sendButtons(danuwa, from, {
      text: "🎬 Button Test",
      footer: "test-MD • Button Test",
      buttons
    }, { quoted });

    console.log("✅ Button test sent successfully");
  } catch (err) {
    console.error("❌ Error sending buttons:", err);
  }
});

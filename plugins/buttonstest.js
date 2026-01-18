const { cmd } = require("../command");

cmd({
  pattern: "bt",
  alias: ["buttontest", "buttons"],
  react: "🧪",
  desc: "Test WhatsApp buttons (Elaina Baileys)",
  category: "test",
  filename: __filename
}, async (danuwa, mek, m, { from, reply }) => {

  // Button array
  const buttons = [
    { buttonId: "BTN_PING", buttonText: { displayText: "🏓 Ping" }, type: 1 },
    { buttonId: "BTN_ALIVE", buttonText: { displayText: "🤖 Alive" }, type: 1 }
  ];

  try {
    await danuwa.sendMessage(from, {
      text: "🎬 Button Test\nClick one of the buttons below 👇",
      footer: "test-MD • Button Test",
      buttons,
      headerType: 1
    }, { quoted: mek });

  } catch (error) {
    console.error("❌ Failed to send buttons:", error);
    reply("*❌ Failed to send buttons*");
  }

});

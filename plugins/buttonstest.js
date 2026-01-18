const { cmd } = require("../command");
const { sendButtons } = require("gifted-btns");

cmd({
  pattern: "bt",
  alias: ["buttontest", "buttons"],
  react: "🧪",
  desc: "Test WhatsApp buttons (official Baileys + gifted-btns)",
  category: "test",
  filename: __filename
}, async (danuwa, mek, { from }) => {

  const buttons = [
    { id: "BTN_PING", text: "🏓 Ping" },
    { id: "BTN_ALIVE", text: "🤖 Alive" }
  ];

  await sendButtons(danuwa, from, {
    text: "🎬 Button Test",
    footer: "test-MD • Button Test",
    buttons
  });
});

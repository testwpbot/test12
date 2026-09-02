const { cmd, commands } = require("../command");
const { sendButtons, sendInteractive } = require("../lib/buttons");
const fs = require("fs");

const pendingMenu = {};
const numberEmojis = ["0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
const categoryEmojis = {
  MAIN: "👑",
  DOWNLOAD: "📥",
  GROUP: "👥",
  LOGO: "🎨",
  SEARCH: "🔍",
  MISC: "⚡",
  TOOLS: "🛠️",
  GAMES: "🎮",
  CONVERT: "🔄"
};

const headerImage = "https://github.com/DANUWA-MD/DANUWA-MD/blob/main/images/DANUWA-MD.png?raw=true";

function getCategoryEmoji(cat) {
  return categoryEmojis[cat.toUpperCase()] || "📌";
}

cmd({
  pattern: "menu",
  alias: ["help", "list", "panel"],
  react: "📋",
  desc: "Show interactive command menu & submenus",
  category: "main",
  filename: __filename
}, async (test, m, msg, { from, sender, q, reply }) => {
  try {
    await test.sendMessage(from, { react: { text: "📋", key: m.key } });

    // 1. Group commands by category
    const commandMap = {};
    let totalCommands = 0;

    for (const command of commands) {
      if (command.dontAddCommandList) continue;
      const category = (command.category || "MISC").toUpperCase();
      if (!commandMap[category]) commandMap[category] = [];
      commandMap[category].push(command);
      totalCommands++;
    }

    const categories = Object.keys(commandMap);
    const selectedCategoryInput = q ? q.trim().toUpperCase() : "";

    // 2. Check if a specific category submenu was requested (e.g. .menu download)
    const matchedCategory = categories.find(
      cat => cat === selectedCategoryInput || cat.toLowerCase() === selectedCategoryInput.toLowerCase()
    );

    if (matchedCategory) {
      // --- RENDER SUB MENU ---
      const cmdsInCategory = commandMap[matchedCategory];
      const catEmoji = getCategoryEmoji(matchedCategory);

      let subMenuText = `╭━━━〔 *${catEmoji} ${matchedCategory} MENU* 〕━━━┈\n┃\n`;

      cmdsInCategory.forEach(c => {
        const patterns = [c.pattern, ...(c.alias || [])].filter(Boolean).map(p => `.${p}`);
        subMenuText += `┃ 🔹 *${patterns.join(", ")}*\n`;
        if (c.desc) subMenuText += `┃    └ ${c.desc}\n`;
      });

      subMenuText += `┃\n╰━━━━━━━━━━━━━━━━━━━┈\n`;
      subMenuText += `📌 *Total Commands:* ${cmdsInCategory.length}\n\n`;
      subMenuText += `💡 *Tip:* Click a button below to navigate submenus.`;

      // Build navigation buttons for other categories & main menu
      const subMenuButtons = [
        { id: ".menu", text: "🏠 Main Menu" }
      ];

      // Add up to 4 other category buttons
      categories
        .filter(cat => cat !== matchedCategory)
        .slice(0, 4)
        .forEach(cat => {
          subMenuButtons.push({
            id: `.menu ${cat.toLowerCase()}`,
            text: `${getCategoryEmoji(cat)} ${cat}`
          });
        });

      // Try sending with interactive buttons
      try {
        await m.sendButtons({
          title: `DANUWA-MD | ${matchedCategory}`,
          text: subMenuText,
          footer: "DANUWA-MD WhatsApp Bot",
          image: headerImage,
          buttons: subMenuButtons
        });
      } catch (err) {
        console.error("Submenu buttons error, falling back to text reply:", err);
        await test.sendMessage(from, {
          image: { url: headerImage },
          caption: subMenuText
        }, { quoted: m });
      }

      delete pendingMenu[sender];
      return;
    }

    // --- RENDER MAIN MENU WITH CATEGORY BUTTONS ---
    let menuText = `╭━━━〔 *DANUWA-MD MAIN MENU* 〕━━━┈\n┃\n`;
    menuText += `┃ 🤖 *Bot Status:* Active ✅\n`;
    menuText += `┃ 📊 *Total Commands:* ${totalCommands}\n`;
    menuText += `┃ 📁 *Categories:* ${categories.length}\n┃\n`;
    menuText += `───────────────────────\n`;

    categories.forEach((cat, i) => {
      const emojiIndex = (i + 1).toString().split("").map(n => numberEmojis[n] || n).join("");
      const catEmoji = getCategoryEmoji(cat);
      menuText += `┃ ${emojiIndex} ${catEmoji} *${cat}* (${commandMap[cat].length} cmds)\n`;
    });

    menuText += `───────────────────────\n`;
    menuText += `💡 *Click a button below or reply with category number to view sub menu!*`;

    // Store pendingMenu for number reply fallback
    pendingMenu[sender] = { step: "category", commandMap, categories };

    // Build buttons for main menu categories
    const mainButtons = categories.slice(0, 5).map(cat => ({
      id: `.menu ${cat.toLowerCase()}`,
      text: `${getCategoryEmoji(cat)} ${cat} Menu`
    }));

    // If more than 5 categories exist, send as a single select list
    if (categories.length > 5) {
      const rows = categories.map((cat, i) => ({
        id: `.menu ${cat.toLowerCase()}`,
        title: `${getCategoryEmoji(cat)} ${cat} MENU`,
        description: `View ${commandMap[cat].length} commands in ${cat}`
      }));

      await m.sendButtonMenu({
        title: "DANUWA-MD BOT MENU",
        text: menuText,
        footer: "Select a command category below",
        image: headerImage,
        listTitle: "📋 Select Category",
        sections: [{
          title: "Available Categories",
          rows
        }]
      });
    } else {
      await m.sendButtons({
        title: "DANUWA-MD BOT MENU",
        text: menuText,
        footer: "Click a category button below",
        image: headerImage,
        buttons: mainButtons
      });
    }

  } catch (e) {
    console.error("Menu plugin error:", e);
    reply(`❌ Error loading menu: ${e.message || e}`);
  }
});

// Reply handler fallback for number selection (1, 2, 3...)
cmd({
  filter: (text, { sender }) => pendingMenu[sender] && pendingMenu[sender].step === "category" && /^[1-9][0-9]*$/.test(text.trim())
}, async (test, m, msg, { from, body, sender, reply }) => {
  try {
    await test.sendMessage(from, { react: { text: "✅", key: m.key } });

    const { commandMap, categories } = pendingMenu[sender];
    const index = parseInt(body.trim()) - 1;
    if (index < 0 || index >= categories.length) return reply("❌ Invalid category selection number.");

    const selectedCategory = categories[index];
    const cmdsInCategory = commandMap[selectedCategory];
    const catEmoji = getCategoryEmoji(selectedCategory);

    let cmdText = `╭━━━〔 *${catEmoji} ${selectedCategory} MENU* 〕━━━┈\n┃\n`;
    cmdsInCategory.forEach(c => {
      const patterns = [c.pattern, ...(c.alias || [])].filter(Boolean).map(p => `.${p}`);
      cmdText += `┃ 🔹 *${patterns.join(", ")}*\n`;
      if (c.desc) cmdText += `┃    └ ${c.desc}\n`;
    });
    cmdText += `┃\n╰━━━━━━━━━━━━━━━━━━━┈\n`;
    cmdText += `📌 *Total Commands:* ${cmdsInCategory.length}\n`;

    const subMenuButtons = [
      { id: ".menu", text: "🏠 Main Menu" }
    ];

    categories
      .filter(cat => cat !== selectedCategory)
      .slice(0, 4)
      .forEach(cat => {
        subMenuButtons.push({
          id: `.menu ${cat.toLowerCase()}`,
          text: `${getCategoryEmoji(cat)} ${cat}`
        });
      });

    await m.sendButtons({
      title: `DANUWA-MD | ${selectedCategory}`,
      text: cmdText,
      footer: "DANUWA-MD WhatsApp Bot",
      image: headerImage,
      buttons: subMenuButtons
    });

    delete pendingMenu[sender];
  } catch (e) {
    console.error("Menu reply handler error:", e);
    delete pendingMenu[sender];
  }
});

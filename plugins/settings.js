const { cmd } = require("../command");
const config = require("../config");

/**
 * .settings — view & change the bot configuration (owner only)
 *
 * Every change is validated, written back into config.js and applied to the
 * running process immediately (no restart needed).
 *
 *   .settings                     → interactive panel (single-select list)
 *   .settings set KEY value       → change a value directly
 *   .settings set KEY             → bot asks for the new value (5 min)
 *   .settings toggle KEY          → switch a true/false setting
 *   .settings reset KEY | all     → restore the defaults
 */

const pending = {};                 // sender JID -> { key, at }
const PENDING_TTL = 5 * 60 * 1000;  // pending prompts expire after 5 minutes

const TYPE_ICON = {
  boolean: "🔘",
  owner: "📱",
  url: "🔗",
  text: "📝",
  readonly: "🔒"
};

const usage = () =>
  `💡 *How to use*\n` +
  `• \`${config.PREFIX}settings\` — open the panel\n` +
  `• \`${config.PREFIX}settings set KEY new value\`\n` +
  `• \`${config.PREFIX}settings toggle KEY\`\n` +
  `• \`${config.PREFIX}settings reset KEY\` / \`reset all\``;

/** Short, single-line rendering of a value (WhatsApp limits row text). */
function displayValue(key, value, type, limit = 40) {
  if (type === "boolean") return config.isEnabled(key) ? "ON" : "OFF";
  const v = String(value == null || value === "" ? "(empty)" : value);
  return v.length > limit ? `${v.slice(0, limit - 1)}…` : v;
}

/** The full "current configuration" text block. */
function buildPanelText() {
  const { editable, readOnly } = config.describe();

  let text = `╭━━━〔 *⚙️ ${config.BOT_NAME} SETTINGS* 〕━━━┈\n┃\n`;

  for (const s of editable) {
    const icon = TYPE_ICON[s.type] || "📝";
    text += `┃ ${icon} *${s.label}*\n`;
    text += `┃    \`${s.key}\` = ${displayValue(s.key, s.value, s.type)}\n`;
  }

  text += `┃\n┃ ── 🔒 Read only ──\n`;
  for (const s of readOnly) {
    text += `┃ 🔒 *${s.label}* = ${s.value}\n`;
  }

  text += `┃\n╰━━━━━━━━━━━━━━━━━━━┈\n\n`;
  text += usage();
  return text;
}

/** Build the single-select rows shown under the panel. */
function buildSections() {
  const { editable } = config.describe();
  const toggles = [];
  const values = [];

  for (const s of editable) {
    const isBool = s.type === "boolean";
    const current = displayValue(s.key, s.value, s.type, 30);
    const row = {
      id: `${config.PREFIX}settings ${isBool ? "toggle" : "set"} ${s.key}`,
      title: `${TYPE_ICON[s.type] || "📝"} ${s.key}`,
      description: isBool ? `Now: ${current} — tap to switch` : `Now: ${current} — tap to change`
    };
    (isBool ? toggles : values).push(row);
  }

  const sections = [];
  if (toggles.length) sections.push({ title: "🔘 On / Off", rows: toggles });
  if (values.length) sections.push({ title: "📝 Values", rows: values });
  sections.push({
    title: "♻️ Reset",
    rows: [{ id: `${config.PREFIX}settings reset all`, title: "♻️ Reset all", description: "Restore every setting to default" }]
  });

  return sections;
}

/** Send the interactive panel (falls back to plain text if buttons fail). */
async function sendPanel(m) {
  const text = buildPanelText();

  try {
    await m.sendButtonMenu({
      title: `${config.BOT_NAME} SETTINGS`,
      text,
      footer: "Owner only • saved straight to config.js",
      image: config.ALIVE_IMG,
      listTitle: "⚙️ Choose a setting",
      sections: buildSections()
    });
  } catch (e) {
    console.error("⚠️ Settings panel interactive failed, falling back to text:", e && e.message ? e.message : e);
    await m.reply(text);
  }
}

/** Apply + persist a value, then re-render the panel. */
async function applyChange(m, key, rawValue) {
  let result;
  try {
    result = config.set(key, rawValue);
  } catch (e) {
    return m.reply(`❌ ${e.message || e}`);
  }

  let note = "";
  if (result.key === "PREFIX") note = `\n\nℹ️ Commands now start with \`${result.value}\`.`;
  if (result.key === "BOT_OWNER") note = `\n\n⚠️ Owner number changed — \`.settings\` now answers to \`${result.value}\`.`;
  if (result.key === "LOG_NUMBER") note = `\n\nℹ️ Startup pings and status forwards now go to \`${result.value}\`.`;
  if (result.key === "AUTO_STATUS_SEEN") note = `\n\nℹ️ Auto status seen is now *${config.isEnabled("AUTO_STATUS_SEEN") ? "ON" : "OFF"}*.`;
  if (result.key === "AUTO_STATUS_REACT") note = `\n\nℹ️ Auto status react is now *${config.isEnabled("AUTO_STATUS_REACT") ? "ON" : "OFF"}*.`;

  await m.reply(`✅ *${result.key}* updated\n┃ Old: \`${displayValue(result.key, result.previous, "text", 60)}\`\n┃ New: \`${displayValue(result.key, result.value, "text", 60)}\`${note}`);
  return sendPanel(m);
}

/** Restore defaults for one key or for everything. */
async function resetSetting(m, key) {
  let changed;
  try {
    changed = config.reset(key);
  } catch (e) {
    return m.reply(`❌ ${e.message || e}`);
  }

  if (!changed.length) {
    return m.reply(`ℹ️ Nothing to reset — ${key === "ALL" ? "every setting is" : `\`${key}\` is`} already at its default.`);
  }

  await m.reply(`♻️ Reset ${changed.length} setting(s)\n\n${changed.map((c) => `• *${c.key}* → \`${c.value}\``).join("\n")}`);
  return sendPanel(m);
}

/** Ask the owner to type the new value for `key`. */
async function askForValue(m, sender, key) {
  if (!config.isEditable(key)) {
    return m.reply(`🔒 \`${key}\` is read-only — change it in config.js or your host env vars.`);
  }

  pending[sender] = { key, at: Date.now() };
  return m.reply(
    `✏️ Send the new value for *${key}*\n\n` +
    `Current: \`${displayValue(key, config.get(key), "text", 60)}\`\n\n` +
    `Type \`cancel\` to abort (expires in 5 minutes).`
  );
}

cmd(
  {
    pattern: "settings",
    alias: ["setting", "set", "config"],
    react: "⚙️",
    desc: "View & change bot configuration (owner only)",
    category: "main",
    filename: __filename
  },
    async (sock, mek, m, { sender, senderNumber, args, isOwner, isMe, reply }) => {
      try {
        if (!isOwner && !isMe) {
          return reply("⛔ Owner only — you are not allowed to change the bot configuration.");
        }

      const action = (args[0] || "").toLowerCase();
      const key = (args[1] || "").toUpperCase();
      const value = args.slice(2).join(" ").trim();

      // No arguments → show the panel
      if (!action) return sendPanel(m);

      switch (action) {
        case "view":
        case "list":
        case "panel":
          return sendPanel(m);

        case "cancel":
          delete pending[sender];
          return reply("❌ Cancelled — nothing was changed.");

        case "toggle": {
          if (!key) return reply(`❓ Which setting?\n\n${usage()}`);
          return applyChange(m, key, config.isEnabled(key) ? "false" : "true");
        }

        case "set": {
          if (!key) return reply(`❓ Which setting?\n\n${usage()}`);
          if (!value) return askForValue(m, sender, key);
          return applyChange(m, key, value);
        }

        case "reset":
          return resetSetting(m, key || "ALL");

        default: {
          // Shorthand: `.settings PREFIX !` / `.settings PREFIX`
          const shorthandKey = action.toUpperCase();
          if (config.isEditable(shorthandKey)) {
            const shorthandValue = args.slice(1).join(" ").trim();
            if (!shorthandValue) return askForValue(m, sender, shorthandKey);
            return applyChange(m, shorthandKey, shorthandValue);
          }
          return reply(`❓ Unknown option \`${action}\`.\n\n${usage()}`);
        }
      }
    } catch (e) {
      console.error("Settings plugin error:", e);
      return reply(`❌ ${e.message || e}`);
    }
  }
);

// Captures the free-text value the owner types after `.settings set KEY`
cmd(
  {
    filter: (text, { sender }) => {
      const p = pending[sender];
      if (!p) return false;
      if (Date.now() - p.at > PENDING_TTL) {
        delete pending[sender];
        return false;
      }
      return true;
    }
  },
  async (sock, mek, m, { sender, body, reply }) => {
    const p = pending[sender];
    delete pending[sender];

    const text = String(body || "").trim();

    if (["cancel", "c", `${config.PREFIX}cancel`].includes(text.toLowerCase())) {
      return reply("❌ Cancelled — nothing was changed.");
    }

    // Let commands through untouched (the command handler deals with them)
    if (text.startsWith(config.PREFIX)) return;

    return applyChange(m, p.key, text);
  }
);

// Expose pending-prompt state so other plugins (papers no-prefix triggers)
// can step aside while the owner is typing a setting value.
module.exports = { isPending: (sender) => !!pending[sender] };

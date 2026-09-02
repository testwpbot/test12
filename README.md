# DANUWA-MD

WhatsApp bot built with [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys).

## Quick start

```bash
npm install
npm start          # runs: pm2 start index.js --name DANUWA-MD
```

Scan the QR code (or set `SESSION_ID` to restore a session from MEGA).

## Configuration

**All configuration lives in [`config.js`](./config.js)** — no numbers or
constants are hardcoded in `index.js` anymore. Every editable value can be
overridden with an environment variable of the same name.

| Setting | Default | What it does |
| --- | --- | --- |
| `PREFIX` | `.` | Character every command starts with |
| `BOT_NAME` | `DANUWA-MD` | Name used in menus and logs |
| `BOT_OWNER` | `94774915917` | **Your** number — the only one allowed to use `.settings` |
| `LOG_NUMBER` | `94776121326` | Receives the startup ping and forwarded statuses (also an owner) |
| `ALIVE_MSG` | `Hello👋 DANUWA-MD Is Alive Now😍` | Reply text for `.alive` |
| `ALIVE_IMG` | image URL | Image used by `.alive` and the startup ping |
| `AUTO_STATUS_SEEN` | `true` | Auto-mark contacts' statuses as seen |
| `AUTO_STATUS_REACT` | `true` | Auto-react with a random emoji to statuses |

`SESSION_ID` and `PORT` are read-only inside the bot (shown masked in the
settings panel) — set them in `config.js` or as env vars.

## ⚙️ `.settings` command (owner only)

Change any setting from WhatsApp, without a restart. Every change is validated
and written back into `config.js`, so it survives a reboot.

```
.settings                      → interactive panel (single-select list)
.settings set KEY new value    → change a value directly
.settings set KEY              → bot asks for the new value (expires in 5 min)
.settings toggle KEY           → switch a true/false setting
.settings reset KEY | all      → restore defaults
```

Aliases: `.setting`, `.set`, `.config`.

Tapping a row in the panel sends the matching command for you — toggles flip
on/off, value rows ask you to type the new value. `cancel` aborts a prompt.
Anyone who is not an owner gets `⛔ Owner only`.

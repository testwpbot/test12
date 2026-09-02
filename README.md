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
| `BLOCK_CALLS` | `true` | Auto-reject calls from non-owner users |
| `BLOCK_CALLS_MSG` | 📵 Sorry, calls… | Auto-reply sent to blocked callers (empty = silent) |
| `GDRIVE_API_KEY` | — | Google Drive API key for the papers plugin |
| `GDRIVE_FOLDER_ID` | — | Drive folder (ID or URL) that holds the past papers |
| `PAPERS_MAX_SIZE_MB` | `95` | Files bigger than this send a browser link instead |
| `PAPERS_COOLDOWN_SEC` | `30` | Wait required between downloads per student |

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

## 📚 Past papers from Google Drive (`.papers`)

Students in your group can download past papers straight from **your own
Google Drive** — no admin approval needed:

```
.papers                    → browse the papers folder (numbered list)
.papers chemistry          → search across all subfolders
.papers next               → next page · .papers back / home → navigate
.paper 3                   → download item 3 (opens folders, sends files)
.paper 3                   → on a 📁 folder number → open that folder
.papersetup                → owner-only setup guide
```

### One-time setup (~3 minutes)

1. Open [console.cloud.google.com](https://console.cloud.google.com) → create (or pick) a project.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key** → copy it.
4. In Google Drive, right-click the folder that holds your papers →
   **Share → General access → Anyone with the link → Viewer**.
5. Copy the folder ID from its URL — `drive.google.com/drive/folders/`**`THIS_PART`**.
6. In WhatsApp (as owner):
   ```
   .settings set GDRIVE_API_KEY AIzaSy…your-key…
   .settings set GDRIVE_FOLDER_ID THIS_PART      (or paste the whole folder URL)
   ```
7. Send `.papers` in your group — done 🎉

The index refreshes every 10 minutes, so new files you add to Drive appear
automatically. Google Docs/Sheets are sent as PDF exports. Files larger than
`PAPERS_MAX_SIZE_MB` get a browser link instead of an upload.

### Keeping the folder private (optional)

Don't want "anyone with link"? Use a **service account** instead of an API key:

1. Google Cloud Console → **IAM & Admin → Service Accounts → Create service account**
2. Open it → **Keys → Add key → JSON** → save the file as
   `gdrive-service-account.json` in the bot folder (already git-ignored).
3. In Drive, share the papers folder with the service account's e-mail
   (`…@…iam.gserviceaccount.com`) as **Viewer**.
4. Restart the bot. The plugin detects the key file automatically — no API
   key or public sharing needed.

### Safety limits built in

- Max **2 downloads at once** and one queued after another — protects your bot
  number when many students request papers at the same time.
- Per-student cooldown (default 30 s, configurable) against spam.
- Everything is searchable, so students can find a paper in one message.

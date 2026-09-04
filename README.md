# AI Mate Assistant 🎓

> Educational WhatsApp assistant — browse and download past papers, right from
> your study group. Built on the DANUWA-MD core ([Baileys](https://github.com/WhiskeySockets/Baileys)).

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
| `BOT_NAME` | `AI Mate Assistant` | Name used in menus and logs |
| `BOT_OWNER` | `94774915917` | **Your** number — the only one allowed to use `.settings` |
| `LOG_NUMBER` | `94776121326` | Receives the startup ping and forwarded statuses (also an owner) |
| `ALIVE_MSG` | `👋 AI Mate Assistant is online…` | Reply text for `.alive` |
| `ALIVE_IMG` | image URL | Image used by `.alive` and the startup ping |
| `AUTO_STATUS_SEEN` | `true` | Auto-mark contacts' statuses as seen |
| `AUTO_STATUS_REACT` | `true` | Auto-react with a random emoji to statuses |
| `BLOCK_CALLS` | `true` | Auto-reject calls from non-owner users |
| `BLOCK_CALLS_MSG` | 📵 Sorry, calls… | Auto-reply sent to blocked callers (empty = silent) |
| `GDRIVE_API_KEY` | — | Google Drive API key for the papers plugin |
| `GDRIVE_FOLDER_ID` | — | Drive folder (ID or URL) that holds the past papers |
| `PAPERS_MAX_SIZE_MB` | `95` | Files bigger than this send a browser link instead |
| `PAPERS_COOLDOWN_SEC` | `30` | Wait required between downloads per student |
| `PAPERS_CACHE_MIN` | `10` | How long the saved Drive index stays fresh |
| `GEMINI_API_KEY` | — | Optional: AI-powered query expansion for `.papers` search |

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

The index refreshes every 10 minutes (`PAPERS_CACHE_MIN`), so new files you
add to Drive appear automatically. Admins can force an immediate refresh with
`.papers refresh`. Google Docs/Sheets are sent as PDF exports. Files larger
than `PAPERS_MAX_SIZE_MB` get a browser link instead of an upload.

**Google Drive API limits — will a 100+ group hit them?** No. The Drive API
allows 1,000,000 quota units/min per project (a folder listing costs 100
units, a download 200). One full index of ~30 subfolders ≈ 3,000 units and is
cached, so even a busy class uses a fraction of a percent of quota. The bot
also keeps a copy of the index on disk (`temp/papers-index.json`): if Google
Drive is ever unreachable or throttled, students still get the saved list
(with a small notice) instead of an error, and `.papers refresh` picks up new
files once the API is back.

### Keeping the folder private (optional)

An API key can only read folders shared "anyone with the link" — keys carry
no identity, so Google will always 404 a Restricted folder. To keep the
folder **fully Restricted**, use a **service account** instead (the bot
prefers it automatically when present):

1. Google Cloud Console → **Credentials → Create credentials → Service account**
2. Open it → **Keys → Add key → JSON** → download the file.
3. In Drive, share the papers folder with the service account's e-mail
   (`…@…iam.gserviceaccount.com`, the `client_email` inside the JSON) as
   **Viewer** — the folder stays Restricted.
4. Give the bot the key:
   - **VPS / own machine:** save it as `gdrive-service-account.json` next to
     `config.js` (git-ignored). **Never commit it.**
   - **GitHub Actions:** repo → Settings → Secrets and variables → Actions →
     New repository secret `GOOGLE_SERVICE_ACCOUNT_JSON` = the whole JSON
     content, then pass it to the start step in the workflow:
     ```yaml
     - run: npm run start
       env:
         GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}
     ```
5. Restart the bot (or re-run the workflow).

### 🔎 Smart search (how students find papers)

Students don't need exact file names — the built-in knowledge base handles
how students actually search:

| Student types | Finds |
| --- | --- |
| `.papers chem 2021` | `chem` → **chemistry** (abbreviation) |
| `.papers phy pp1` | `phy` → **physics**, `pp` → paper |
| `.papers phisics` | typo auto-corrected to **physics** |
| `.papers past papers chemistry` | filler words ignored |

Results are ranked (name matches above folder-path matches), and if nothing
matches all words, a **loose match** pass relaxes the least-important word.

**Optional AI boost:** set a free Gemini key
([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) with
`.settings set GEMINI_API_KEY …` and searches in **Sinhala/Tamil** or with
unusual spelling are first expanded by AI ("රසායන 2021" → "chemistry 2021"),
then matched locally. Without the key everything still works — the AI layer
is pure enhancement, and failures fall back silently.

### Safety limits built in

- Max **2 downloads at once** and one queued after another — protects your bot
  number when many students request papers at the same time.
- Per-student cooldown (default 30 s, configurable) against spam.
- Everything is searchable, so students can find a paper in one message.

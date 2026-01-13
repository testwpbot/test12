const { cmd } = require("../command");
const { exec } = require("child_process");
const yts = require("yt-search");
const fs = require("fs");
const path = require("path");

// Use this function to search or return the URL directly
async function getYoutubeUrl(query) {
  const isUrl = /(youtube\.com|youtu\.be)/i.test(query);
  if (isUrl) return query;

  const search = await yts(query);
  if (!search.videos.length) return null;
  return search.videos[0].url;
}

// Path to your cookies file (upload this to bot root)
const COOKIES_FILE = path.join(__dirname, "../cookies.txt");

// Realistic User-Agent to avoid bot detection
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

cmd(
  {
    pattern: "ytmp3",
    alias: ["yta", "song"],
    desc: "Download YouTube MP3 using yt-dlp with cookies",
    category: "download",
    filename: __filename,
  },
  async (bot, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("🎵 *Send song name or YouTube link!*");

      reply("🔎 Searching...");
      const url = await getYoutubeUrl(q);
      if (!url) return reply("❌ No results found!");

      reply("⬇️ Downloading MP3... (yt-dlp + cookies)");

      const cmdStr = `yt-dlp --cookies "${COOKIES_FILE}" --user-agent "${USER_AGENT}" -x --audio-format mp3 -o "%(title)s.%(ext)s" "${url}"`;

      exec(cmdStr, async (err, stdout, stderr) => {
        if (err) {
          console.error(stderr);
          return reply("❌ Error while downloading audio!");
        }

        // yt-dlp outputs: Destination: <filename>
        const match = stdout.match(/Destination: (.+\.mp3)/);
        if (!match) return reply("❌ Failed to find output file!");

        const filePath = match[1];

        await bot.sendMessage(
          from,
          {
            audio: fs.readFileSync(filePath),
            mimetype: "audio/mpeg",
          },
          { quoted: mek }
        );

        fs.unlinkSync(filePath);
        reply("✅ Sent successfully!");
      });
    } catch (e) {
      console.log("Error:", e);
      reply("❌ Something went wrong!");
    }
  }
);

cmd(
  {
    pattern: "ytmp4",
    alias: ["ytv", "video"],
    desc: "Download YouTube MP4 360p using yt-dlp with cookies",
    category: "download",
    filename: __filename,
  },
  async (bot, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("🎬 *Send video name or YouTube link!*");

      reply("🔎 Searching...");
      const url = await getYoutubeUrl(q);
      if (!url) return reply("❌ No results found!");

      reply("⬇️ Downloading MP4 360p... (yt-dlp + cookies)");

      const cmdStr = `yt-dlp --cookies "${COOKIES_FILE}" --user-agent "${USER_AGENT}" -f 18 -o "%(title)s_360p.%(ext)s" "${url}"`;

      exec(cmdStr, async (err, stdout, stderr) => {
        if (err) {
          console.error(stderr);
          return reply("❌ Error while downloading video!");
        }

        const match = stdout.match(/Destination: (.+_360p\.mp4)/);
        if (!match) return reply("❌ Failed to find MP4 file!");

        const filePath = match[1];

        await bot.sendMessage(
          from,
          {
            video: fs.readFileSync(filePath),
            caption: "🎬 Here is your video!",
          },
          { quoted: mek }
        );

        fs.unlinkSync(filePath);
        reply("✅ Video sent!");
      });
    } catch (e) {
      console.log("Error:", e);
      reply("❌ Something went wrong!");
    }
  }
);

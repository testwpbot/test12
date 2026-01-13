const { cmd } = require("../command");
const { exec } = require("child_process");
const yts = require("yt-search");
const fs = require("fs");

async function getYoutubeUrl(query) {
  const isUrl = /(youtube\.com|youtu\.be)/i.test(query);
  if (isUrl) return query;

  const search = await yts(query);
  if (!search.videos.length) return null;
  return search.videos[0].url;
}

cmd(
  {
    pattern: "ytmp3",
    alias: ["yta", "song"],
    desc: "Download YouTube MP3 using yt-dlp",
    category: "download",
    filename: __filename,
  },
  async (bot, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("🎵 *Send song name or YouTube link!*");

      reply("🔎 Searching...");
      const url = await getYoutubeUrl(q);
      if (!url) return reply("❌ No results found!");

      reply("⬇️ Downloading MP3... (yt-dlp)");

      const cmd = `yt-dlp -x --audio-format mp3 -o "%(title)s.%(ext)s" "${url}"`;

      exec(cmd, async (err, stdout, stderr) => {
        if (err) {
          console.error(stderr);
          return reply("❌ Error while downloading audio!");
        }

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
    desc: "Download YouTube MP4 using yt-dlp",
    category: "download",
    filename: __filename,
  },
  async (bot, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("🎬 *Send video name or YouTube link!*");

      reply("🔎 Searching...");
      const url = await getYoutubeUrl(q);
      if (!url) return reply("❌ No results found!");

      reply("⬇️ Downloading MP4 360p... (yt-dlp)");
      const cmd = `yt-dlp -f 18 -o "%(title)s_360p.%(ext)s" "${url}"`;

      exec(cmd, async (err, stdout, stderr) => {
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

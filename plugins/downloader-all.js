const { cmd } = require("../command");
const { ytmp3, ytmp4, tiktok } = require("sadaslk-dlcore");

/**
 * =========================
 * YOUTUBE MP3
 * =========================
 */
cmd(
  {
    pattern: "ytmp3",
    alias: ["yta", "song"],
    desc: "Download YouTube MP3",
    category: "download",
    filename: __filename,
  },
  async (bot, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("🎵 Send YouTube link!");

      reply("⬇️ Downloading MP3...");

      const data = await ytmp3(q);
      if (!data?.url) return reply("❌ Failed to get MP3");

      await bot.sendMessage(
        from,
        {
          audio: { url: data.url },
          mimetype: "audio/mpeg",
        },
        { quoted: mek }
      );
    } catch (e) {
      console.log("YTMP3 ERROR:", e);
      reply("❌ Error downloading MP3");
    }
  }
);

/**
 * =========================
 * YOUTUBE MP4
 * =========================
 */
cmd(
  {
    pattern: "ytmp4",
    alias: ["ytv", "video"],
    desc: "Download YouTube MP4",
    category: "download",
    filename: __filename,
  },
  async (bot, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("🎬 Send YouTube link!");

      reply("⬇️ Downloading video...");

      const data = await ytmp4(q, {
        format: "mp4",
        videoQuality: "720",
      });

      if (!data?.url) return reply("❌ Failed to get video");

      await bot.sendMessage(
        from,
        {
          video: { url: data.url },
          caption: `🎬 ${data.filename || "Here is your video"}`,
        },
        { quoted: mek }
      );
    } catch (e) {
      console.log("YTMP4 ERROR:", e);
      reply("❌ Error downloading video");
    }
  }
);

/**
 * =========================
 * TIKTOK
 * =========================
 */
cmd(
  {
    pattern: "tiktok",
    alias: ["tt"],
    desc: "Download TikTok video",
    category: "download",
    filename: __filename,
  },
  async (bot, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("📱 Send TikTok link!");

      reply("⬇️ Downloading TikTok video...");

      const data = await tiktok(q);
      if (!data?.no_watermark)
        return reply("❌ Failed to get TikTok video");

      await bot.sendMessage(
        from,
        {
          video: { url: data.no_watermark },
          caption: `🎵 ${data.title || "TikTok video"}`,
        },
        { quoted: mek }
      );
    } catch (e) {
      console.log("TIKTOK ERROR:", e);
      reply("❌ Error downloading TikTok video");
    }
  }
);

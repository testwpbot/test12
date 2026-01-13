
const { cmd } = require("../command");
const yt = require("@vreden/youtube_scraper");
const he = require("he");
const yts = require("yt-search");

async function findFirstVideo(query) {
  const searchResult = await yts(query);
  if (!searchResult?.videos?.length) return null;

  const first = searchResult.videos[0];
  return {
    title: he.decode(first.title || "Unknown Title"),
    url: first.url,
  };
}

cmd(
  {
    pattern: "ytmp3",
    alias: ["yta", "song"],
    react: "🎧",
    desc: "Download YouTube Audio (by name or link)",
    category: "download",
    filename: __filename,
  },
  async (danuwa, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("*🎵 Give song name or the link*");

      let videoUrl = q.trim();
      const ytRegex = /(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;

      if (!ytRegex.test(videoUrl)) {
        reply("🔎 *searching youtube*");
        const first = await findFirstVideo(videoUrl);
        if (!first) return reply("❌ *No results found on YouTube!*");
        videoUrl = first.url;
        console.log("🎵 Found:", first.title);
      }

      reply("🎶 *found*");

      const result = await yt.ytmp3(videoUrl, 128);
      if (!result?.download?.url)
        return reply("❌ *Failed to get MP3 link. Try again later!*");

      const { metadata, download } = result;
      const title = he.decode(metadata?.title || "Unknown Title");
      const thumb = metadata?.thumbnail || metadata?.image || null;
      const fileUrl = download.url;
      const quality = download.quality || "128kbps";
      const fileName = download.filename || `${title}.mp3`;

      const desc = `
🎵 *AUDIO DOWNLOADER*
🎧 *Title:* ${title}
📊 *Quality:* ${quality}
🔗 *URL:* ${metadata?.url || videoUrl}
`;

      if (thumb) {
        await danuwa.sendMessage(
          from,
          { image: { url: thumb }, caption: desc },
          { quoted: mek }
        );
      }

      await danuwa.sendMessage(
        from,
        {
          audio: { url: fileUrl },
          mimetype: "audio/mpeg",
          fileName,
        },
        { quoted: mek }
      );

      return reply("✅ *send successfully*");
    } catch (e) {
      console.error("❌ Error in YTMP3 Plugin:", e);
      return reply("❌ *Error while processing your audio request.*");
    }
  }
);


cmd(
  {
    pattern: "ytmp4",
    alias: ["ytv", "video"],
    react: "🎬",
    desc: "Download YouTube Video (by name or link)",
    category: "download",
    filename: __filename,
  },
  async (danuwa, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("*🎥 Send video name or link*");

      let videoUrl = q.trim();
      const ytRegex = /(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;

      if (!ytRegex.test(videoUrl)) {
        reply("🔎 *seaching youtube*");
        const first = await findFirstVideo(videoUrl);
        if (!first) return reply("❌ *No results found on YouTube!*");
        videoUrl = first.url;
        console.log("🎬 Found:", first.title);
      }

      reply("🎬 *found*");

      const result = await yt.ytmp4(videoUrl, 360);
      if (!result?.download?.url)
        return reply("❌ *Failed to get MP4 link. Try again later!*");

      const { metadata, download } = result;
      const title = he.decode(metadata?.title || "Unknown Title");
      const thumb = metadata?.thumbnail || metadata?.image || null;
      const fileUrl = download.url;
      const quality = download.quality || "360p";

      const desc = `
🎬 *VIDEO DOWNLOADER*
🎬 *Title:* ${title}
📊 *Quality:* ${quality}
🔗 *URL:* ${metadata?.url || videoUrl}
`;

      if (thumb) {
        await danuwa.sendMessage(
          from,
          { image: { url: thumb }, caption: desc },
          { quoted: mek }
        );
      }

      await danuwa.sendMessage(
        from,
        {
          video: { url: fileUrl },
          caption: `🎬 *${title}* (${quality})`,
        },
        { quoted: mek }
      );

      return reply("✅ *Send successfully*");
    } catch (e) {
      console.error("❌ Error in YTMP4 Plugin:", e);
      return reply("❌ *Error while processing your video request.*");
    }
  }
);

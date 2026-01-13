const { cmd } = require("../command");
const {
  youtube,
  ttdl,
  igdl,
  fbdown,
  twitter,
  mediafire,
  capcut,
  gdrive,
  pinterest,
} = require("ab-downloader");

// Detect platform by URL
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return "youtube";
  if (/tiktok\.com/.test(url)) return "tiktok";
  if (/instagram\.com/.test(url)) return "instagram";
  if (/facebook\.com|fb\.watch/.test(url)) return "facebook";
  if (/twitter\.com|x\.com/.test(url)) return "twitter";
  if (/mediafire\.com/.test(url)) return "mediafire";
  if (/capcut\.com/.test(url)) return "capcut";
  if (/drive\.google\.com/.test(url)) return "gdrive";
  if (/pin\.it|pinterest\.com/.test(url)) return "pinterest";
  return null;
}

// Extract usable media URL from any structure
function extractUrl(media) {
  return (
    media?.url ||
    media?.download ||
    media?.download_link ||
    media?.link ||
    media?.urls?.[0] ||
    null
  );
}

cmd(
  {
    pattern: "dl",
    alias: ["all", "download"],
    react: "📥",
    desc: "All-in-one media downloader",
    category: "download",
    filename: __filename,
  },
  async (danuwa, mek, m, { from, q, reply }) => {
    try {
      if (!q) return reply("*📥 Send any media link to download!*");

      const url = q.trim();
      const platform = detectPlatform(url);

      if (!platform)
        return reply(
          "*❌ Unsupported link!*\nSend: YouTube, TikTok, FB, IG, Twitter, CapCut, GDrive, Pinterest, MediaFire links."
        );

      reply(`🔍 *Platform detected:* ${platform}`);

      let result;
      switch (platform) {
        case "youtube":
          result = await youtube(url);
          break;
        case "tiktok":
          result = await ttdl(url);
          break;
        case "instagram":
          result = await igdl(url);
          break;
        case "facebook":
          result = await fbdown(url);
          break;
        case "twitter":
          result = await twitter(url);
          break;
        case "mediafire":
          result = await mediafire(url);
          break;
        case "capcut":
          result = await capcut(url);
          break;
        case "gdrive":
          result = await gdrive(url);
          break;
        case "pinterest":
          result = await pinterest(url);
          break;
      }

      if (!result) return reply("❌ *Nothing found*");

      // Always treat result as array
      const list = Array.isArray(result) ? result : [result];

      for (let media of list) {
        const dl = extractUrl(media);
        const thumb = media?.thumbnail || media?.thumb || null;
        const title = media?.title || platform.toUpperCase();

        if (!dl) {
          await reply("⚠️ *Skipping one file: No download link found.*");
          continue;
        }

        // Thumbnail
        if (thumb) {
          await danuwa.sendMessage(
            from,
            { image: { url: thumb }, caption: `📥 *${title}*` },
            { quoted: mek }
          );
        }

        // Determine type safely
        const isImage = media?.type === "image" || /\.(jpg|png|jpeg|gif)$/i.test(dl);
        const isVideo = media?.type === "video" || /\.(mp4|mov|webm)$/i.test(dl);

        // Image
        if (isImage) {
          await danuwa.sendMessage(
            from,
            { image: { url: dl }, caption: title },
            { quoted: mek }
          );
          continue;
        }

        // Video
        if (isVideo) {
          await danuwa.sendMessage(
            from,
            { video: { url: dl }, caption: title },
            { quoted: mek }
          );
          continue;
        }

        // Otherwise send as file
        await danuwa.sendMessage(
          from,
          {
            document: { url: dl },
            fileName: `${title}.file`,
            mimetype: "application/octet-stream",
          },
          { quoted: mek }
        );
      }

      return reply("✅ *Download complete!*");
    } catch (e) {
      console.log("❌ AIO Downloader Error:", e);
      return reply("❌ *Failed to download media. Invalid link or server error.*");
    }
  }
);

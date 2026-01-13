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

      reply(`🔍 *Detecting platform:* ${platform}...`);

      let result;

      // 🔶 SMART PLATFORM HANDLER
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

      if (!result) return reply("❌ *Failed to download.*");

      // 🔶 Instagram, TikTok, Twitter, FB → arrays
      const mediaList = Array.isArray(result) ? result : [result];

      for (let media of mediaList) {
        const { url: dl, thumbnail, title } = media;

        if (thumbnail) {
          await danuwa.sendMessage(
            from,
            { image: { url: thumbnail }, caption: `📥 *${title || platform}*` },
            { quoted: mek }
          );
        }

        // 📌 Auto-detect type: image / video / file
        if (media.type === "image" || dl.endsWith(".jpg") || dl.endsWith(".png")) {
          await danuwa.sendMessage(
            from,
            { image: { url: dl }, caption: title || "Downloaded" },
            { quoted: mek }
          );
        } else if (media.type === "video" || dl.endsWith(".mp4")) {
          await danuwa.sendMessage(
            from,
            { video: { url: dl }, caption: title || "Downloaded" },
            { quoted: mek }
          );
        } else {
          await danuwa.sendMessage(
            from,
            {
              document: { url: dl },
              fileName: title || "file",
              mimetype: "application/octet-stream",
            },
            { quoted: mek }
          );
        }
      }

      return reply("✅ *Downloaded & sent successfully!*");
    } catch (e) {
      console.log("❌ AIO Downloader Error:", e);
      return reply("❌ *Failed to download media. Maybe link is invalid or file too large.*");
    }
  }
);

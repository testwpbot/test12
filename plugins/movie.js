const { cmd } = require("../command");
const axios = require("axios");
const cheerio = require("cheerio");

const pendingMovies = {};
const pendingQuality = {};

const channelJid = '120363420746032294@newsletter'; 
const channelName = 'ミ★【﻿𝘿𝙄𝙇𝙎𝙃𝘼𝙉 - 𝙈𝘿 °•° 𝙒𝙝𝙖𝙨𝙩𝙖𝙥𝙥 𝘽𝙤𝙩 】★彡';

cmd({
  pattern: "movie",
  alias: ["film"],
  react: "🎬",
  desc: "Download Sinhala Subtitled Movies",
  category: "download",
  filename: __filename
}, async (dilshan, mek, m, { from, q, sender, reply }) => {
  if (!q) return reply("❌ Please provide a movie name.");
  try {
    const url = `https://sinhalasub.lk/?s=${encodeURIComponent(q)}&search_type=all`;
    const res = await axios.get(url);
    const $ = cheerio.load(res.data);

    const movies = [];
    $(".result-item article").each((i, el) => {
      const title = $(el).find(".title a").text().trim();
      const link = $(el).find(".title a").attr("href");
      const thumb = $(el).find("img").attr("src"); // movie thumbnail
      movies.push({ title, link, thumb });
    });

    if (!movies.length) return reply("❌ No movies found.");

    const numberEmojis = ["0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];

    let desc = `╭━━━❰ 🎬 *MOVIE RESULTS* ❱━━━╮\n`;
    desc += `┃🔰 *WELCOME TO DILSHAN-MD* 🔰\n`;
    desc += `┃───────────────────────\n`;

    movies.forEach((mov, i) => {
      const emojiIndex = (i + 1).toString().split("").map(n => numberEmojis[n]).join("");
      desc += `┃ ${emojiIndex} *${mov.title}*\n\n`;
    });

    desc += `┃───────────────────────\n`;
    desc += `┃ ❤️ *REPLY YOUR MOVIE NUMBER*\n`;
    desc += `╰━━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;
          await dilshan.sendMessage(from, {
      image: { url: "https://github.com/dilshan62/DILSHAN-MD/blob/main/images/DILSHAN-MD-MOVIE.png?raw=true" },
      caption: desc,
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: channelJid,
          newsletterName: channelName,
          serverMessageId: -1
        }
      }
    });

    pendingMovies[sender] = { movies };
  } catch (e) {
    console.error("Movie search error:", e);
    await reply("❌ Sorry, something went wrong while fetching movies.");
  }
});

cmd({
  filter: (text, { sender }) => pendingMovies[sender] && /^[1-9][0-9]*$/.test(text.trim())
}, async (dilshan, mek, m, { from, body, sender, reply }) => {
  await dilshan.sendMessage(from, { react: { text: "✅", key: m.key } });
  const { movies } = pendingMovies[sender];
  const index = parseInt(body.trim()) - 1;

  if (index < 0 || index >= movies.length) return reply("❌ Invalid selection.");
  const movie = movies[index];
  delete pendingMovies[sender];

  try {
    const res = await axios.get(movie.link);
    const $ = cheerio.load(res.data);

    const imdb = $("#repimdb strong").first().text().trim() || "N/A";
    const yearText = $(".custom_fields2").find("b:contains('Year')").next("span").text().trim();
    const year = yearText ? yearText.replace(/\D/g, '') : "Unknown";
    const description = $("div[itemprop='description'] p span").first().text().trim() || "No description available.";

    const qualities = [];
    $(".sbox .download-link").each((i, el) => {
      const server = $(el).find(".download-btn").text().trim();
      if (server.toLowerCase() === "telegram") return;
      const quality = $(el).find(".link-quality").text().trim();
      const size = $(el).find(".link-meta span").last().text().trim();
      const linkPage = $(el).find(".download-btn").attr("href");
      qualities.push({ server, quality, size, linkPage });
    });

    if (!qualities.length) return reply("❌ No download links found.");

    const numberEmojis = ["0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];

    let qualityMsg = `╭━[ 🎬 *${movie.title}* ]━⬣\n`;
    qualityMsg += `┃ ⭐ IMDb: *${imdb || "N/A"}*\n`;
    qualityMsg += `┃ 📝 Description:\n┃ ${description.replace(/\n/g, "\n┃ ")}\n`;
    qualityMsg += `┏━━━━━━━━━━━━━━━━━━━━━━┓\n`;
    qualityMsg += `┃ 📍 *CHOOSE MOVIE QUALITY...!*\n`;
    qualityMsg += `┗━━━━━━━━━━━━━━━━━━━━━━┛\n\n`;

    qualities.forEach((q, i) => {
      const emojiIndex = (i + 1).toString().split("").map(n => numberEmojis[n]).join("");
      qualityMsg += `${emojiIndex} *${q.quality}* - ${q.size} (${q.server})\n`;
    });

    qualityMsg += `\n─────────────────────────\n`;
    await reply(`📣 *ඉක්මනට download කරගන්න ඕනිනම් Pixeldrain Link Use කරන්ඩෝ...!* `);

    await dilshan.sendMessage(from, {
      image: { url: movie.thumb },
      caption: qualityMsg,
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: channelJid,
          newsletterName: channelName,
          serverMessageId: -1
        }
      }
    });

    pendingQuality[sender] = { movie, qualities, imdb, year };

  } catch (e) {
    console.error("Movie selection error:", e.message);
    reply("❌ Failed to fetch movie details or qualities.");
  }
});

cmd({
  filter: (text, { sender }) => pendingQuality[sender] && /^[1-9][0-9]*$/.test(text.trim())
}, async (dilshan, mek, m, { from, body, sender, reply }) => {
  await dilshan.sendMessage(from, { react: { text: "✅", key: m.key } });
  const { movie, qualities, imdb, year } = pendingQuality[sender];
  const index = parseInt(body.trim()) - 1;
  if (index < 0 || index >= qualities.length) return reply("❌ Invalid selection.");
  const selected = qualities[index];
  delete pendingQuality[sender];

  await reply(`*පොඩ්ඩක් ඉන්න ඉක්මනට Download කරලා දෙන්නම්...👀❤️*`);

  try {
    const res = await axios.get(selected.linkPage);
    const $ = cheerio.load(res.data);

    let downloadHref = $("#download-link").attr("href");
    if (!downloadHref) return reply("❌ Failed to get download link.");

    if (downloadHref.includes("pixeldrain.com/u/")) {
      const fileID = downloadHref.split("/u/")[1];
      downloadHref = `https://pixeldrain.com/api/file/${fileID}?download`;
    }

    const caption = `╭━[ ✅ MOVIE DOWNLOAD ]━⬣
┃ 🎬 Title: *${movie.title}*
┃ ⭐ IMDb: ${imdb}
┃ 💾 Quality: ${selected.quality}
┃ 📦 Size: ${selected.size}
┃ 🔗 Server: ${selected.server}
╰─🔥 *DILSHAN - MD* 🔥─╯`;

    await dilshan.sendMessage(from, {
      document: { url: downloadHref },
      mimetype: "video/mp4",
      fileName: `${movie.title}-${selected.quality}.mp4`,
      caption,
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: channelJid,
          newsletterName: channelName,
          serverMessageId: -1
        }
      }
    }, { quoted: mek });

  } catch (e) {
    console.error("Download error:", e.message);
    reply("❌ Failed to fetch or send movie.");
  }
});

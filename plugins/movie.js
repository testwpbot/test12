const { cmd } = require("../command");
const puppeteer = require("puppeteer");
const { sendButtons } = require("gifted-btns");

const pendingSearch = {};
const pendingQuality = {};

function normalizeQuality(text) {
  if (!text) return null;
  text = text.toUpperCase();
  if (/1080|FHD/.test(text)) return "1080p";
  if (/720|HD/.test(text)) return "720p";
  if (/480|SD/.test(text)) return "480p";
  return text;
}

function getDirectPixeldrainUrl(url) {
  const match = url.match(/pixeldrain\.com\/u\/(\w+)/);
  if (!match) return null;
  return `https://pixeldrain.com/api/file/${match[1]}?download`;
}

// ... keep your searchMovies, getMovieMetadata, getPixeldrainLinks functions as is ...

/**
 * ======= Movie Search Command =======
 */
cmd({
  pattern: "movie",
  alias: ["sinhalasub","films","cinema"],
  react: "🎬",
  desc: "Search and send movies from Sinhalasub.lk",
  category: "download",
  filename: __filename
}, async (danuwa, mek, m, { from, q, sender, reply }) => {
  if (!q) return reply(`*🎬 Movie Search Plugin*\nUsage: movie_name\nExample: movie avengers`);

  reply("*🔍 Searching for movies...*");
  const searchResults = await searchMovies(q);
  if (!searchResults.length) return reply("*❌ No movies found!*");

  pendingSearch[sender] = { results: searchResults, timestamp: Date.now() };

  // Build buttons for top 10 results
  const buttons = searchResults.slice(0, 10).map((movie, i) => ({
    id: `MOVIE_${i}`, 
    text: `${i+1}. ${movie.title}`
  }));

  await sendButtons(danuwa, from, {
    text: "*🎬 Search Results:*\nClick a movie below to select:",
    footer: "test-MD • Movie Plugin",
    buttons
  }, { quoted: mek });
});

/**
 * ======= Movie Selection Handler =======
 */
cmd({
  filter: (text, { sender }) => pendingSearch[sender] && text.startsWith("MOVIE_")
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  await danuwa.sendMessage(from, { react: { text: "✅", key: m.key } });

  const index = parseInt(body.split("_")[1]);
  const selected = pendingSearch[sender].results[index];
  delete pendingSearch[sender];

  const metadata = await getMovieMetadata(selected.movieUrl);

  let msg = `*🎬 ${metadata.title}*\n*📝 Language:* ${metadata.language}\n*⏱️ Duration:* ${metadata.duration}\n*⭐ IMDb:* ${metadata.imdb}\n`;
  msg += `*🎭 Genres:* ${metadata.genres.join(", ")}\n*🎥 Directors:* ${metadata.directors.join(", ")}\n*🌟 Stars:* ${metadata.stars.slice(0,5).join(", ")}${metadata.stars.length>5?"...":""}\n\n*🔗 Fetching download links, please wait...*`;

  if (metadata.thumbnail) {
    await danuwa.sendMessage(from, { image: { url: metadata.thumbnail }, caption: msg }, { quoted: mek });
  } else {
    await danuwa.sendMessage(from, { text: msg }, { quoted: mek });
  }

  const downloadLinks = await getPixeldrainLinks(selected.movieUrl);
  if (!downloadLinks.length) return reply("*❌ No download links found (<2GB)!*");

  pendingQuality[sender] = { movie: { metadata, downloadLinks }, timestamp: Date.now() };

  // Build buttons for quality selection
  const qualityButtons = downloadLinks.slice(0, 10).map((d,i) => ({
    id: `QUALITY_${i}`, 
    text: `${d.quality} - ${d.size}`
  }));

  await sendButtons(danuwa, from, {
    text: "*📥 Available Qualities (Max 2GB):*\nClick a quality to receive the movie:",
    footer: "test-MD • Movie Plugin",
    buttons: qualityButtons
  }, { quoted: mek });
});

/**
 * ======= Quality Selection Handler =======
 */
cmd({
  filter: (text, { sender }) => pendingQuality[sender] && text.startsWith("QUALITY_")
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  await danuwa.sendMessage(from, { react: { text: "✅", key: m.key } });

  const index = parseInt(body.split("_")[1]);
  const { movie } = pendingQuality[sender];
  delete pendingQuality[sender];

  const selectedLink = movie.downloadLinks[index];

  reply(`*⬇️ Sending ${selectedLink.quality} movie as document...*\nPlease wait.`);

  try {
    const directUrl = getDirectPixeldrainUrl(selectedLink.link);
    await danuwa.sendMessage(from, {
      document: { url: directUrl },
      mimetype: "video/mp4",
      fileName: `${movie.metadata.title.substring(0,50)} - ${selectedLink.quality}.mp4`.replace(/[^\w\s.-]/gi,''),
      caption: `*🎬 ${movie.metadata.title}*\n*📊 Quality:* ${selectedLink.quality}\n*💾 Size:* ${selectedLink.size}\n\n*Enjoy your movie! 🍿*`
    }, { quoted: mek });
  } catch (error) {
    console.error("Send document error:", error);
    reply(`*❌ Failed to send movie:* ${error.message || "Unknown error"}`);
  }
});

// Cleanup old pending searches/qualities
setInterval(() => {
  const now = Date.now();
  const timeout = 10*60*1000;
  for (const s in pendingSearch) if (now - pendingSearch[s].timestamp > timeout) delete pendingSearch[s];
  for (const s in pendingQuality) if (now - pendingQuality[s].timestamp > timeout) delete pendingQuality[s];
}, 5*60*1000);

module.exports = { pendingSearch, pendingQuality };

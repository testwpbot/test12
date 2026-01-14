const { cmd } = require("../command");
const puppeteer = require("puppeteer");

// --- User sessions ---
const pendingSearch = {};
const pendingQuality = {};

// --- Quality utilities ---
const QUALITY_ORDER = ["1080p", "720p", "480p"];
function normalizeQuality(text) {
  if (!text) return null;
  text = text.toUpperCase();
  if (/1080|FHD/.test(text)) return "1080p";
  if (/720|HD/.test(text)) return "720p";
  if (/480|SD/.test(text)) return "480p";
  return null;
}
function getQualityOrder(q) {
  return QUALITY_ORDER.indexOf(q);
}

// --- Convert Pixeldrain URL to direct API link ---
function getDirectPixeldrainUrl(url) {
  const match = url.match(/pixeldrain\.com\/u\/(\w+)/);
  if (!match) return null;
  return `https://pixeldrain.com/api/file/${match[1]}?download`;
}

// --- Filter and deduplicate links ---
function filterLinks(links) {
  const normalized = links.map(l => ({ link: l.link, quality: normalizeQuality(l.quality) || "1080p" }));
  const seen = new Set();
  const unique = [];
  for (const l of normalized) {
    if (!seen.has(l.quality)) {
      seen.add(l.quality);
      unique.push(l);
    }
  }
  return unique.sort((a, b) => getQualityOrder(a.quality) - getQualityOrder(b.quality));
}

// --- Search movies ---
async function searchMovies(query) {
  const searchUrl = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}&post_type=movies`;
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });

  const results = await page.$$eval(".display-item .item-box", boxes =>
    boxes.slice(0, 10).map((box, index) => {
      const a = box.querySelector("a");
      const img = box.querySelector(".thumb");
      const lang = box.querySelector(".item-desc-giha .language")?.textContent || "";
      const quality = box.querySelector(".item-desc-giha .quality")?.textContent || "";
      const qty = box.querySelector(".item-desc-giha .qty")?.textContent || "";
      return {
        id: index + 1,
        title: a?.title?.trim() || "",
        movieUrl: a?.href || "",
        thumb: img?.src || "",
        language: lang.trim(),
        quality: quality.trim(),
        qty: qty.trim(),
      };
    }).filter(m => m.title && m.movieUrl)
  );

  await browser.close();
  return results;
}

// --- Fetch movie metadata ---
async function getMovieMetadata(url) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const metadata = await page.evaluate(() => {
    const getText = el => el?.textContent.trim() || "";
    const getList = selector => Array.from(document.querySelectorAll(selector)).map(el => el.textContent.trim());

    const title = getText(document.querySelector(".info-details .details-title h3"));

    let language = "", directors = [], stars = [];
    document.querySelectorAll(".info-col p").forEach(p => {
      const strong = p.querySelector("strong");
      if (!strong) return;
      const txt = strong.textContent.trim();
      if (txt.includes("Language:")) language = strong.nextSibling?.textContent?.trim() || "";
      if (txt.includes("Director:")) directors = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
      if (txt.includes("Stars:")) stars = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
    });

    const duration = getText(document.querySelector(".info-details .data-views[itemprop='duration']"));
    const imdb = getText(document.querySelector(".info-details .data-imdb"))?.replace("IMDb:", "").trim();
    const genres = getList(".details-genre a");
    const thumbnail = document.querySelector(".splash-bg img")?.src || "";

    return { title, language, duration, imdb, genres, directors, stars, thumbnail };
  });

  await browser.close();
  return metadata;
}

// --- Fetch Pixeldrain links and assign default qualities 1080/720/480 ---
async function getPixeldrainLinks(movieUrl) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(movieUrl, { waitUntil: "networkidle2", timeout: 30000 });

  const pixeldrainPages = await page.$$eval("table tr a", links =>
    links.filter(a => a.textContent.toLowerCase().includes("pixeldrain")).map(a => a.href)
  );

  const directLinks = [];
  let qualityIndex = 0;
  for (const link of pixeldrainPages) {
    if (qualityIndex >= 3) break; // only 1080,720,480
    try {
      const subPage = await browser.newPage();
      await subPage.goto(link, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 12000)); // wait for countdown

      const finalUrl = await subPage.$eval(".wait-done a[href^='https://pixeldrain.com/']", el => el.href)
        .catch(() => null);

      if (finalUrl) {
        directLinks.push({ link: finalUrl, quality: QUALITY_ORDER[qualityIndex] });
        qualityIndex++;
      }
      await subPage.close();
    } catch (e) { continue; }
  }

  await browser.close();
  return directLinks;
}

// --- Command: Search Movies ---
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

  let text = "*🎬 Search Results:*\n";
  searchResults.forEach((m, i) => {
    text += `*${i+1}.* ${m.title}\n   📝 Language: ${m.language}\n   📊 Quality: ${m.quality}\n   🎞️ Format: ${m.qty}\n`;
  });
  text += `\n*Reply with movie number (1-${searchResults.length})*`;
  reply(text);
});

// --- Handle Movie Selection ---
cmd({
  filter: (text, { sender }) => pendingSearch[sender] && !isNaN(text) &&
    parseInt(text) > 0 && parseInt(text) <= pendingSearch[sender].results.length
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  const index = parseInt(body.trim()) - 1;
  const selected = pendingSearch[sender].results[index];
  delete pendingSearch[sender];

  reply("*📥 Fetching movie metadata and download links...*");

  const metadata = await getMovieMetadata(selected.movieUrl);
  const downloadLinks = await getPixeldrainLinks(selected.movieUrl);
  if (!downloadLinks.length) return reply("*❌ No download links found!*");

  console.log(`=== DEBUG: Available download links for ${metadata.title} ===`);
  downloadLinks.forEach((d,i) => console.log(`${i+1}: [${d.quality}] ${d.link}`));
  console.log("=== END DEBUG ===");

  pendingQuality[sender] = { movie: { metadata, downloadLinks }, timestamp: Date.now() };

  let msg = `*🎬 ${metadata.title}*\n`;
  msg += `*📝 Language:* ${metadata.language}\n*⏱️ Duration:* ${metadata.duration}\n*⭐ IMDb:* ${metadata.imdb}\n`;
  msg += `*🎭 Genres:* ${metadata.genres.join(", ")}\n*🎥 Directors:* ${metadata.directors.join(", ")}\n*🌟 Stars:* ${metadata.stars.slice(0,5).join(", ")}${metadata.stars.length>5?"...":""}\n\n`;
  msg += "*📥 Available Qualities:*\n";
  downloadLinks.forEach((d,i) => msg += `*${i+1}.* ${d.quality}\n`);
  msg += `\n*Reply with quality number to receive the movie as a document.*`;

  if (metadata.thumbnail) {
    await danuwa.sendMessage(from, { image: { url: metadata.thumbnail }, caption: msg }, { quoted: mek });
  } else {
    await danuwa.sendMessage(from, { text: msg }, { quoted: mek });
  }
});

// --- Handle Quality Selection & Send Movie ---
cmd({
  filter: (text, { sender }) => pendingQuality[sender] && !isNaN(text) &&
    parseInt(text) > 0 && parseInt(text) <= pendingQuality[sender].movie.downloadLinks.length
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  const index = parseInt(body.trim()) - 1;
  const { movie } = pendingQuality[sender];
  delete pendingQuality[sender];

  const selectedLink = movie.downloadLinks[index];
  const directUrl = getDirectPixeldrainUrl(selectedLink.link);

  if (!directUrl) return reply("*❌ Failed to get direct movie link!*");
  reply(`*⬇️ Sending ${selectedLink.quality} movie as document...* Please wait.`);

  try {
    await danuwa.sendMessage(from, {
      document: { url: directUrl },
      mimetype: "video/mp4",
      fileName: `${movie.metadata.title.substring(0,50)} - ${selectedLink.quality}.mp4`.replace(/[^\w\s.-]/gi,''),
      caption: `*🎬 ${movie.metadata.title}*\n*📊 Quality:* ${selectedLink.quality}\n*💾 Size:* Streaming directly from Pixeldrain\n\n*Enjoy your movie! 🍿*`
    }, { quoted: mek });
  } catch (error) {
    console.error("Send document error:", error);
    reply(`*❌ Failed to send movie:* ${error.message || "Unknown error"}`);
  }
});

// --- Cleanup old sessions ---
setInterval(() => {
  const now = Date.now();
  const timeout = 10*60*1000;
  for (const s in pendingSearch) if (now - pendingSearch[s].timestamp > timeout) delete pendingSearch[s];
  for (const s in pendingQuality) if (now - pendingQuality[s].timestamp > timeout) delete pendingQuality[s];
}, 5*60*1000);

module.exports = { pendingSearch, pendingQuality };

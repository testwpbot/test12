const { cmd } = require("../command");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// Pending user sessions
const pendingSearch = {};
const pendingQuality = {};

// Utility functions
function normalizeQuality(text) {
  if (!text) return "Unknown";
  text = text.toUpperCase();
  if (/1080|FHD/.test(text)) return "1080p";
  if (/720|HD/.test(text)) return "720p";
  if (/480|SD/.test(text)) return "480p";
  if (/4K|UHD/.test(text)) return "4K";
  return text;
}
function getQualityOrder(q) {
  if (q === "4K") return 0;
  if (q === "1080p") return 1;
  if (q === "720p") return 2;
  if (q === "480p") return 3;
  return 4;
}

// --- Search Movies ---
async function searchMovies(query) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const searchUrl = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}&post_type=movies`;

  try {
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
    return results;
  } catch (e) {
    console.error("Search error:", e);
    return [];
  } finally {
    await browser.close();
  }
}

// --- Movie Metadata ---
async function getMovieMetadata(url) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    const metadata = await page.evaluate(() => {
      const getText = (el) => el?.textContent?.trim() || "";
      const getList = (sel) => Array.from(document.querySelectorAll(sel)).map(e => e.textContent.trim());

      const title = getText(document.querySelector(".info-details .details-title h3")) || "Unknown";

      let language = "";
      let directors = [];
      let stars = [];
      document.querySelectorAll(".info-col p").forEach(p => {
        const strong = p.querySelector("strong");
        if (!strong) return;
        if (strong.textContent.includes("Language:")) language = strong.nextSibling?.textContent?.trim() || "Unknown";
        if (strong.textContent.includes("Director:")) directors = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
        if (strong.textContent.includes("Stars:")) stars = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
      });

      const duration = getText(document.querySelector(".info-details .data-views[itemprop='duration']")) || "Unknown";
      const imdb = getText(document.querySelector(".info-details .data-imdb"))?.replace("IMDb:", "").trim() || "N/A";
      const genres = getList(".details-genre a") || ["Unknown"];
      const thumbnail = document.querySelector(".splash-bg img")?.src || "";

      return { title, language, duration, imdb, genres, directors, stars, thumbnail };
    });
    return metadata;
  } catch (e) {
    console.error("Metadata error:", e);
    return null;
  } finally {
    await browser.close();
  }
}

// --- Pixeldrain Links ---
async function getPixeldrainLinks(movieUrl) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  try {
    await page.goto(movieUrl, { waitUntil: "networkidle2", timeout: 30000 });
    const pixPages = await page.$$eval("table tr a", links =>
      links.filter(a => a.textContent.toLowerCase() === "pixeldrain").map(a => a.href)
    );

    const directLinks = [];
    for (const link of pixPages) {
      const subPage = await browser.newPage();
      await subPage.goto(link, { waitUntil: "networkidle2", timeout: 30000 });
      try {
        await subPage.waitForSelector(".wait-done a[href^='https://pixeldrain.com/']", { timeout: 20000 });
        const result = await subPage.$eval(".wait-done a[href^='https://pixeldrain.com/']", el => {
          const text = el.textContent || "";
          let q = "Unknown";
          if (/1080|FHD/i.test(text)) q = "1080p";
          else if (/720|HD/i.test(text)) q = "720p";
          else if (/480|SD/i.test(text)) q = "480p";
          return { link: el.href, quality: q };
        });
        directLinks.push({ ...result, quality: normalizeQuality(result.quality) });
      } catch (err) {
        console.warn("Pixeldrain link not ready:", link);
      }
      await subPage.close();
    }

    return directLinks.sort((a, b) => getQualityOrder(a.quality) - getQualityOrder(b.quality));
  } catch (e) {
    console.error("Pixeldrain fetch error:", e);
    return [];
  } finally {
    await browser.close();
  }
}

// --- Download File ---
async function downloadFile(url, sender) {
  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const timestamp = Date.now();
  const filename = `movie_${sender}_${timestamp}.mp4`;
  const filepath = path.join(tempDir, filename);

  const response = await axios({ method: "GET", url, responseType: "stream", timeout: 600000 });
  const writer = fs.createWriteStream(filepath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => resolve({ filepath, filename }));
    writer.on("error", reject);
  });
}

// --- Command ---
cmd({
  pattern: "movie",
  alias: ["sinhalasub", "films", "cinema"],
  react: "🎬",
  desc: "Search and download movies from Sinhalasub.lk",
  category: "download",
  filename: __filename,
}, async (danuwa, mek, m, { from, q, sender, reply }) => {
  if (!q) return reply(`*Usage:* movie <movie_name>`);

  await danuwa.sendMessage(from, { react: { text: "🔍", key: m.key } });
  reply("*Searching movies...*");

  const results = await searchMovies(q);
  if (!results.length) return reply("*No movies found!*");

  pendingSearch[sender] = { results, timestamp: Date.now() };

  let text = "*Search Results:*\n\n";
  results.forEach((r, i) => text += `*${i + 1}.* ${r.title}\n   📝 ${r.language}\n   📊 ${r.quality}\n   🎞️ ${r.qty}\n\n`);
  text += `*Reply with the movie number (1-${results.length})*`;
  reply(text);
});

// --- Movie selection ---
cmd({
  filter: (text, { sender }) => pendingSearch[sender] && !isNaN(parseInt(text)) && parseInt(text) > 0 && parseInt(text) <= pendingSearch[sender].results.length
}, async (danuwa, mek, m, { from, body, sender, reply }) => {
  const index = parseInt(body) - 1;
  const movie = pendingSearch[sender].results[index];
  if (!movie) return reply("❌ Invalid selection");

  reply("*Fetching metadata...*");
  const metadata = await getMovieMetadata(movie.movieUrl);
  if (!metadata) return reply("*Failed to fetch metadata!*");

  reply("*Fetching download links...*");
  const links = await getPixeldrainLinks(movie.movieUrl);
  if (!links.length) return reply("*No download links found!*");

  pendingQuality[sender] = { movie: { metadata, links }, timestamp: Date.now() };

  let msg = `*🎬 ${metadata.title}*\n📝 ${metadata.language}\n⏱️ ${metadata.duration}\n⭐ IMDb: ${metadata.imdb}\n🎭 ${metadata.genres.join(", ")}\n\n*Download Options:*\n`;
  links.forEach((l, i) => msg += `*${i + 1}.* ${l.quality}\n`);
  msg += `\n*Reply with quality number (1-${links.length})*`;

  if (metadata.thumbnail) {
    await danuwa.sendMessage(from, { image: { url: metadata.thumbnail }, caption: msg }, { quoted: mek });
  } else {
    await danuwa.sendMessage(from, { text: msg }, { quoted: mek });
  }

  delete pendingSearch[sender];
});

// --- Quality selection ---
cmd({
  filter: (text, { sender }) => pendingQuality[sender] && !isNaN(parseInt(text)) && parseInt(text) > 0 && parseInt(text) <= pendingQuality[sender].movie.links.length
}, async (danuwa, mek, m, { from, body, sender, reply }) => {
  const index = parseInt(body) - 1;
  const { movie } = pendingQuality[sender];
  const selectedLink = movie.links[index];
  if (!selectedLink) return reply("❌ Invalid selection");

  reply(`*Downloading ${selectedLink.quality}...*`);
  try {
    const { filepath } = await downloadFile(selectedLink.link, sender);
    if (!fs.existsSync(filepath)) return reply("❌ File download failed");

    const stats = fs.statSync(filepath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    const filename = `${movie.metadata.title.substring(0, 50)} - ${selectedLink.quality}.mp4`.replace(/[^\w\s.-]/gi, '').trim();

    await danuwa.sendMessage(from, { 
      document: { url: `file://${filepath}` },
      mimetype: "video/mp4",
      fileName: filename,
      caption: `*🎬 ${movie.metadata.title}*\n📊 Quality: ${selectedLink.quality}\n💾 Size: ${sizeMB} MB`
    }, { quoted: mek });

    fs.unlinkSync(filepath);
    delete pendingQuality[sender];
  } catch (err) {
    console.error(err);
    delete pendingQuality[sender];
    reply("*❌ Download failed*");
  }
});

// --- Cleanup old sessions ---
setInterval(() => {
  const now = Date.now();
  for (const s of Object.keys(pendingSearch)) if (now - pendingSearch[s].timestamp > 10*60*1000) delete pendingSearch[s];
  for (const s of Object.keys(pendingQuality)) if (now - pendingQuality[s].timestamp > 10*60*1000) delete pendingQuality[s];
}, 5*60*1000);

module.exports = { pendingSearch, pendingQuality };

const { cmd } = require("../command");
const puppeteer = require("puppeteer");

// Pending user sessions
const pendingSearch = {};
const pendingQuality = {};

// Normalize quality
function normalizeQuality(text) {
  text = (text || "").toUpperCase();
  if (/1080|FHD/.test(text)) return "1080p";
  if (/720|HD/.test(text)) return "720p";
  if (/480|SD/.test(text)) return "480p";
  return "Unknown";
}

// Sort order
function getQualityOrder(q) {
  if (q === "1080p") return 1;
  if (q === "720p") return 2;
  if (q === "480p") return 3;
  return 4;
}

// --- Search Movies ---
async function searchMovies(query) {
  const url = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}&post_type=movies`;
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2" });

  const results = await page.$$eval(".display-item .item-box", boxes =>
    boxes.slice(0, 10).map(box => {
      const a = box.querySelector("a");
      const img = box.querySelector(".thumb");
      const lang = box.querySelector(".item-desc-giha .language")?.textContent || "";
      const quality = box.querySelector(".item-desc-giha .quality")?.textContent || "";
      const qty = box.querySelector(".item-desc-giha .qty")?.textContent || "";
      return {
        title: a?.title?.trim() || "Unknown",
        movieUrl: a?.href || "",
        thumb: img?.src || "",
        language: lang.trim() || "Unknown",
        quality: quality.trim() || "Unknown",
        qty: qty.trim() || "Unknown"
      };
    }).filter(m => m.movieUrl)
  );

  await browser.close();
  return results;
}

// --- Get Movie Metadata ---
async function getMovieMetadata(url) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2" });

  const metadata = await page.evaluate(() => {
    const getText = el => el?.textContent.trim() || "";
    const getList = sel => Array.from(document.querySelectorAll(sel)).map(e => e.textContent.trim());

    let language = "Unknown";
    document.querySelectorAll(".info-col p").forEach(p => {
      const s = p.querySelector("strong");
      if (s?.textContent.includes("Language:")) language = s.nextSibling?.textContent?.trim() || "Unknown";
    });

    let directors = [];
    document.querySelectorAll(".info-col p").forEach(p => {
      const s = p.querySelector("strong");
      if (s?.textContent.includes("Director:")) directors = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
    });

    let stars = [];
    document.querySelectorAll(".info-col p").forEach(p => {
      const s = p.querySelector("strong");
      if (s?.textContent.includes("Stars:")) stars = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
    });

    const title = getText(document.querySelector(".info-details .details-title h3")) || "Unknown";
    const duration = getText(document.querySelector(".info-details .data-views[itemprop='duration']")) || "Unknown";
    const imdb = getText(document.querySelector(".info-details .data-imdb"))?.replace("IMDb:", "").trim() || "N/A";
    const genres = getList(".details-genre a") || ["Unknown"];
    const thumbnail = document.querySelector(".splash-bg img")?.src || "";

    return { title, language, duration, imdb, genres, directors, stars, thumbnail };
  });

  await browser.close();
  return metadata;
}

// --- Get Pixeldrain Direct Links ---
async function getPixeldrainLinks(movieUrl) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(movieUrl, { waitUntil: "networkidle2" });

  const pixeldrainPages = await page.$$eval("table tr a", links =>
    links.filter(a => a.textContent.toLowerCase() === "pixeldrain").map(a => a.href)
  );

  const directLinks = [];
  for (const link of pixeldrainPages) {
    const subPage = await browser.newPage();
    await subPage.goto(link, { waitUntil: "networkidle2" });
    await new Promise(r => setTimeout(r, 12000));

    const result = await subPage.$eval(".wait-done a[href^='https://pixeldrain.com/']", el => {
      const text = el.textContent || "";
      let quality = "Unknown";
      if (/1080|FHD/i.test(text)) quality = "1080p";
      else if (/720|HD/i.test(text)) quality = "720p";
      else if (/480|SD/i.test(text)) quality = "480p";
      return { link: el.href, quality };
    }).catch(() => null);

    if (result) directLinks.push({ ...result });
    await subPage.close();
  }

  await browser.close();
  return directLinks.sort((a, b) => getQualityOrder(a.quality) - getQualityOrder(b.quality));
}

// --- Main Command ---
cmd({
  pattern: "movie",
  alias: ["sinhalasub", "films"],
  react: "🎬",
  desc: "Search and download movies from SinhalaSub.lk",
  category: "download",
  filename: __filename,
}, async (danuwa, mek, m, { from, body, sender, command, q, reply }) => {
  if (!q) return reply(`Usage: ${command} movie_name\nExample: ${command} avengers`);

  reply("*🔍 Searching movies...*");
  const searchResults = await searchMovies(q);
  if (!searchResults.length) return reply("*❌ No movies found!*");

  pendingSearch[sender] = { results: searchResults, timestamp: Date.now() };

  let text = "*🎬 Search Results:*\n\n";
  searchResults.forEach((movie, i) => {
    text += `*${i + 1}.* ${movie.title}\n   📝 Language: ${movie.language}\n   📊 Quality: ${movie.quality}\n   🎞️ Format: ${movie.qty}\n\n`;
  });
  text += `Reply with movie number (1-${searchResults.length}) to select.`;

  await danuwa.sendMessage(from, { text }, { quoted: mek });
});

// --- Reply: Movie selection ---
cmd({
  filter: (text, { sender }) => pendingSearch[sender] && !isNaN(parseInt(text)) && parseInt(text) > 0 && parseInt(text) <= pendingSearch[sender].results.length
}, async (danuwa, mek, m, { body, sender, from, reply }) => {
  const index = parseInt(body) - 1;
  const movie = pendingSearch[sender].results[index];
  reply("*📥 Fetching metadata...*");

  const metadata = await getMovieMetadata(movie.movieUrl);
  const links = await getPixeldrainLinks(movie.movieUrl);

  // --- Debug log for available links ---
  console.log("=== DEBUG: Available download links for", metadata.title, "===");
  links.forEach((l, i) => console.log(`${i + 1}: [${l.quality}] ${l.link}`));
  console.log("=== END DEBUG ===");

  if (!links.length) return reply("*❌ No download links found!*");

  pendingQuality[sender] = { movie, metadata, links, timestamp: Date.now() };

  let text = `*🎬 ${metadata.title}*\n📝 Language: ${metadata.language}\n⏱️ Duration: ${metadata.duration}\n⭐ IMDb: ${metadata.imdb}\n\n*📥 Available Downloads:*\n`;
  links.forEach((l, i) => text += `*${i + 1}.* ${l.quality}\n`);
  text += `\nReply with quality number (1-${links.length}) to receive the movie (direct link).`;

  if (metadata.thumbnail) {
    await danuwa.sendMessage(from, { image: { url: metadata.thumbnail }, caption: text }, { quoted: mek });
  } else {
    await danuwa.sendMessage(from, { text }, { quoted: mek });
  }

  delete pendingSearch[sender];
});

// --- Reply: Quality selection ---
cmd({
  filter: (text, { sender }) => pendingQuality[sender] && !isNaN(parseInt(text)) && parseInt(text) > 0 && parseInt(text) <= pendingQuality[sender].links.length
}, async (danuwa, mek, m, { body, sender, from, reply }) => {
  const index = parseInt(body) - 1;
  const { metadata, links } = pendingQuality[sender];
  const selected = links[index];

  try {
    await danuwa.sendMessage(from, {
      document: { url: selected.link },
      mimetype: "video/mp4",
      fileName: `${metadata.title} - ${selected.quality}.mp4`,
      caption: `🎬 ${metadata.title}\n📊 Quality: ${selected.quality}\n💾 Direct download`
    }, { quoted: mek });
  } catch (err) {
    console.error("Send failed:", err);
    reply("*❌ Failed to send movie. It may exceed WhatsApp file size limits.*");
  }

  delete pendingQuality[sender];
});

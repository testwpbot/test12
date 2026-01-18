const { cmd } = require("../command");
const { sendButtons } = require("gifted-btns");
const puppeteer = require("puppeteer");

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

async function getPixeldrainLinks(movieUrl) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(movieUrl, { waitUntil: "networkidle2", timeout: 30000 });
  const linksData = await page.$$eval(".link-pixeldrain tbody tr", rows =>
    rows.map(row => {
      const a = row.querySelector(".link-opt a");
      const quality = row.querySelector(".quality")?.textContent.trim() || "";
      const size = row.querySelector("td:nth-child(3) span")?.textContent.trim() || "";
      return { pageLink: a?.href || "", quality, size };
    })
  );
  const directLinks = [];
  for (const l of linksData) {
    try {
      const subPage = await browser.newPage();
      await subPage.goto(l.pageLink, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 12000));
      const finalUrl = await subPage.$eval(".wait-done a[href^='https://pixeldrain.com/']", el => el.href).catch(() => null);
      if (finalUrl) {
        let sizeMB = 0;
        const sizeText = l.size.toUpperCase();
        if (sizeText.includes("GB")) sizeMB = parseFloat(sizeText) * 1024;
        else if (sizeText.includes("MB")) sizeMB = parseFloat(sizeText);
        if (sizeMB <= 2048) {
          directLinks.push({ 
            link: finalUrl, 
            quality: normalizeQuality(l.quality), 
            size: l.size,
            rawQuality: l.quality // Keep original quality text
          });
        }
      }
      await subPage.close();
    } catch (e) { continue; }
  }
  await browser.close();
  return directLinks;
}

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

cmd({
  filter: (text, { sender }) => pendingSearch[sender] && !isNaN(text) && parseInt(text) > 0 && parseInt(text) <= pendingSearch[sender].results.length
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  await danuwa.sendMessage(from, { react: { text: "✅", key: m.key } });
  const index = parseInt(body.trim()) - 1;
  const selected = pendingSearch[sender].results[index];
  delete pendingSearch[sender];
  const metadata = await getMovieMetadata(selected.movieUrl);
  let msg = `*🎬 ${metadata.title}*\n`;
  msg += `*📝 Language:* ${metadata.language}\n*⏱️ Duration:* ${metadata.duration}\n*⭐ IMDb:* ${metadata.imdb}\n`;
  msg += `*🎭 Genres:* ${metadata.genres.join(", ")}\n*🎥 Directors:* ${metadata.directors.join(", ")}\n*🌟 Stars:* ${metadata.stars.slice(0,5).join(", ")}${metadata.stars.length>5?"...":""}\n\n`;
  msg += "*🔗 Fetching download links, please wait...*";
  
  if (metadata.thumbnail) {
    await danuwa.sendMessage(from, { image: { url: metadata.thumbnail }, caption: msg }, { quoted: mek });
  } else {
    await danuwa.sendMessage(from, { text: msg }, { quoted: mek });
  }
  
  const downloadLinks = await getPixeldrainLinks(selected.movieUrl);
  if (!downloadLinks.length) return reply("*❌ No download links found (<2GB)!*");
  
  // Store quality links with unique IDs
  pendingQuality[sender] = { 
    movie: { 
      metadata, 
      downloadLinks,
      movieUrl: selected.movieUrl
    }, 
    timestamp: Date.now(),
    qualityIds: {} // Map button IDs to quality indices
  };
  
  // Create buttons for quality selection
  const buttons = [];
  pendingQuality[sender].qualityIds = {}; // Reset mapping
  
  downloadLinks.forEach((d, i) => {
    const buttonId = `QUALITY_${sender}_${Date.now()}_${i}`;
    pendingQuality[sender].qualityIds[buttonId] = i; // Map button ID to quality index
    
    buttons.push({
      id: buttonId,
      text: `${d.quality} - ${d.size}`,
      emoji: "🎬"
    });
  });
  
  // Add a cancel button
  buttons.push({
    id: `CANCEL_${sender}_${Date.now()}`,
    text: "❌ Cancel",
    emoji: "❌"
  });
  
  // Send quality selection buttons
  await sendButtons(danuwa, from, {
    text: `*📥 Available Qualities (Max 2GB)*\n*🎬 Movie:* ${metadata.title.substring(0, 50)}${metadata.title.length > 50 ? '...' : ''}`,
    footer: "Click a button to download | Sinhalasub.lk",
    buttons
  }, { quoted: mek });
});

// Handle button clicks for quality selection
cmd({
  filter: (text, { sender }) => {
    if (!pendingQuality[sender]) return false;
    return text.startsWith(`QUALITY_${sender}_`) || text.startsWith(`CANCEL_${sender}_`);
  }
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  // React to acknowledge button click
  await danuwa.sendMessage(from, { react: { text: "⏳", key: m.key } });
  
  // Handle cancel button
  if (body.startsWith(`CANCEL_${sender}_`)) {
    delete pendingQuality[sender];
    await danuwa.sendMessage(from, { 
      text: "*❌ Download cancelled*",
      edit: m.key 
    });
    return;
  }
  
  // Get quality index from button ID
  const buttonId = body;
  const qualityIndex = pendingQuality[sender].qualityIds[buttonId];
  
  if (qualityIndex === undefined) {
    await danuwa.sendMessage(from, { 
      text: "*❌ Invalid selection. Please try again.*",
      edit: m.key 
    });
    return;
  }
  
  const { movie } = pendingQuality[sender];
  const selectedLink = movie.downloadLinks[qualityIndex];
  
  // Update button message to show "Processing..."
  await danuwa.sendMessage(from, { 
    text: `*⬇️ Preparing ${selectedLink.quality} quality...*\nPlease wait while we fetch your movie.`,
    edit: m.key 
  });
  
  try {
    const directUrl = getDirectPixeldrainUrl(selectedLink.link);
    if (!directUrl) {
      throw new Error("Could not get direct download URL");
    }
    
    // Sanitize filename
    const sanitizeFilename = (title, quality) => {
      return `${title.substring(0, 50)} - ${quality}.mp4`
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };
    
    const fileName = sanitizeFilename(movie.metadata.title, selectedLink.quality);
    
    // Send movie as document
    await danuwa.sendMessage(from, {
      document: { url: directUrl },
      mimetype: "video/mp4",
      fileName: fileName,
      caption: `*🎬 ${movie.metadata.title}*\n*📊 Quality:* ${selectedLink.quality}\n*💾 Size:* ${selectedLink.size}\n\n*Enjoy your movie! 🍿*`
    }, { quoted: mek });
    
    // Clean up
    delete pendingQuality[sender];
    
  } catch (error) {
    console.error("Download error:", error);
    
    // Send error message
    await danuwa.sendMessage(from, { 
      text: `*❌ Download failed*\nError: ${error.message || "Unknown error"}\n\nPlease try again or select another quality.`,
      edit: m.key 
    });
    
    // Optionally, resend quality buttons
    const buttons = [];
    movie.downloadLinks.forEach((d, i) => {
      if (i !== qualityIndex) { // Skip the failed one
        const buttonId = `QUALITY_${sender}_${Date.now()}_${i}`;
        pendingQuality[sender].qualityIds[buttonId] = i;
        buttons.push({
          id: buttonId,
          text: `${d.quality} - ${d.size}`,
          emoji: "🎬"
        });
      }
    });
    
    if (buttons.length > 0) {
      buttons.push({
        id: `CANCEL_${sender}_${Date.now()}`,
        text: "❌ Cancel",
        emoji: "❌"
      });
      
      await sendButtons(danuwa, from, {
        text: `*⚠️ Retry Available Qualities*\n*🎬 Movie:* ${movie.metadata.title.substring(0, 50)}${movie.metadata.title.length > 50 ? '...' : ''}`,
        footer: "Click a button to download | Failed quality: " + selectedLink.quality,
        buttons
      }, { quoted: mek });
    }
  }
});

// Keep the session cleanup
setInterval(() => {
  const now = Date.now();
  const timeout = 10*60*1000;
  for (const s in pendingSearch) if (now - pendingSearch[s].timestamp > timeout) delete pendingSearch[s];
  for (const s in pendingQuality) if (now - pendingQuality[s].timestamp > timeout) delete pendingQuality[s];
}, 5*60*1000);

module.exports = { pendingSearch, pendingQuality };

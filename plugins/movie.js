const { cmd } = require("../command");
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
            buttonText: `${normalizeQuality(l.quality)} - ${l.size}` // Store button text format
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
  
  // Store with button text mapping
  pendingQuality[sender] = { 
    movie: { metadata, downloadLinks }, 
    timestamp: Date.now(),
    // Create a map of all possible button texts to their index
    buttonTextMap: {}
  };
  
  // Build button text map for matching
  downloadLinks.forEach((d, i) => {
    const buttonText = d.buttonText || `${d.quality} - ${d.size}`;
    // Store multiple variations for flexible matching
    pendingQuality[sender].buttonTextMap[buttonText.toLowerCase()] = i; // "720p - 1.78 gb" → 0
    pendingQuality[sender].buttonTextMap[buttonText.toUpperCase()] = i; // "720P - 1.78 GB" → 0
    pendingQuality[sender].buttonTextMap[buttonText] = i; // "720p - 1.78 GB" → 0
    
    // Also store without spaces for safety
    const noSpaceText = buttonText.replace(/\s+/g, '');
    pendingQuality[sender].buttonTextMap[noSpaceText.toLowerCase()] = i;
  });
  
  let qualityMsg = "*📥 Available Qualities (Max 2GB):*\n";
  downloadLinks.forEach((d, i) => {
    const buttonText = d.buttonText || `${d.quality} - ${d.size}`;
    qualityMsg += `*${i+1}.* ${buttonText}\n`;
  });
  qualityMsg += `\n*Reply with quality text (e.g., "720p - 1.78 GB") to receive the movie.*`;
  await danuwa.sendMessage(from, { text: qualityMsg }, { quoted: mek });
});

// CHANGED: This filter now accepts button text instead of numbers
cmd({
  filter: (text, { sender }) => {
    if (!pendingQuality[sender]) return false;
    
    const session = pendingQuality[sender];
    const normalizedText = text.trim().toLowerCase();
    
    // Check if text matches any button text
    if (session.buttonTextMap && session.buttonTextMap[normalizedText] !== undefined) {
      return true;
    }
    
    // Also check original text (case sensitive)
    if (session.buttonTextMap && session.buttonTextMap[text] !== undefined) {
      return true;
    }
    
    // Check without spaces
    const noSpaceText = text.replace(/\s+/g, '').toLowerCase();
    if (session.buttonTextMap && session.buttonTextMap[noSpaceText] !== undefined) {
      return true;
    }
    
    // BACKWARD COMPATIBILITY: Also accept numbers (1, 2, 3...)
    const num = parseInt(text);
    if (!isNaN(num) && num > 0 && num <= session.movie.downloadLinks.length) {
      return true;
    }
    
    // Check for cancel
    if (text.toLowerCase() === "cancel" || text === "❌ Cancel") {
      return true;
    }
    
    return false;
  }
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  await danuwa.sendMessage(from, { react: { text: "✅", key: m.key } });
  
  const session = pendingQuality[sender];
  if (!session) {
    reply("*❌ Session expired. Please start over.*");
    return;
  }
  
  // Handle cancel
  if (body.toLowerCase() === "cancel" || body === "❌ Cancel") {
    delete pendingQuality[sender];
    reply("*❌ Download cancelled*");
    return;
  }
  
  let index = -1;
  
  // Try to match by button text first
  const normalizedText = body.trim().toLowerCase();
  
  // Method 1: Exact match (case insensitive)
  if (session.buttonTextMap && session.buttonTextMap[normalizedText] !== undefined) {
    index = session.buttonTextMap[normalizedText];
    console.log("🎬 Button text matched (case insensitive):", { body, index });
  }
  // Method 2: Exact match (case sensitive)
  else if (session.buttonTextMap && session.buttonTextMap[body] !== undefined) {
    index = session.buttonTextMap[body];
    console.log("🎬 Button text matched (case sensitive):", { body, index });
  }
  // Method 3: Match without spaces
  else {
    const noSpaceText = body.replace(/\s+/g, '').toLowerCase();
    if (session.buttonTextMap && session.buttonTextMap[noSpaceText] !== undefined) {
      index = session.buttonTextMap[noSpaceText];
      console.log("🎬 Button text matched (no spaces):", { body, index });
    }
  }
  
  // Method 4: BACKWARD COMPATIBILITY - Number match
  if (index === -1) {
    const num = parseInt(body);
    if (!isNaN(num) && num > 0 && num <= session.movie.downloadLinks.length) {
      index = num - 1;
      console.log("🎬 Number matched:", { body, index });
    }
  }
  
  if (index === -1) {
    // Try partial matching as last resort
    for (let i = 0; i < session.movie.downloadLinks.length; i++) {
      const link = session.movie.downloadLinks[i];
      const buttonText = link.buttonText || `${link.quality} - ${link.size}`;
      
      // Check if body contains quality or size
      if (body.toLowerCase().includes(link.quality.toLowerCase()) || 
          body.toLowerCase().includes(link.size.toLowerCase())) {
        index = i;
        console.log("🎬 Partial match found:", { body, quality: link.quality, index });
        break;
      }
    }
  }
  
  if (index === -1 || index < 0 || index >= session.movie.downloadLinks.length) {
    let errorMsg = "*❌ Invalid selection.*\n\n";
    errorMsg += "*Please reply with one of these:*\n";
    session.movie.downloadLinks.forEach((d, i) => {
      const buttonText = d.buttonText || `${d.quality} - ${d.size}`;
      errorMsg += `• "${buttonText}"\n`;
    });
    errorMsg += `\n*Or type "cancel" to cancel.*`;
    reply(errorMsg);
    return;
  }
  
  const { movie } = session;
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

// Add a helper command to show accepted formats
cmd({
  pattern: "moviehelp",
  desc: "Show movie plugin help",
  category: "download"
}, async (danuwa, mek, m, { sender, reply }) => {
  let helpMsg = "*🎬 Movie Download Plugin Help*\n\n";
  helpMsg += "*Usage:*\n";
  helpMsg += "`.movie <movie_name>` - Search for movies\n";
  helpMsg += "`.moviehelp` - Show this help\n\n";
  helpMsg += "*Quality Selection:*\n";
  helpMsg += "After selecting a movie, you'll see quality options.\n";
  helpMsg += "Reply with the QUALITY TEXT (e.g., \"720p - 1.78 GB\")\n";
  helpMsg += "OR reply with the NUMBER (1, 2, 3...)\n\n";
  helpMsg += "*Examples:*\n";
  helpMsg += "• \"720p - 1.78 GB\"\n";
  helpMsg += "• \"480p - 940 MB\"\n";
  helpMsg += "• \"2\" (for second option)\n";
  helpMsg += "• \"cancel\" (to cancel)\n";
  
  await reply(helpMsg);
});

setInterval(() => {
  const now = Date.now();
  const timeout = 10*60*1000;
  for (const s in pendingSearch) if (now - pendingSearch[s].timestamp > timeout) delete pendingSearch[s];
  for (const s in pendingQuality) if (now - pendingQuality[s].timestamp > timeout) delete pendingQuality[s];
}, 5*60*1000);

module.exports = { pendingSearch, pendingQuality };

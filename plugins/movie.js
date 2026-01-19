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
          directLinks.push({ link: finalUrl, quality: normalizeQuality(l.quality), size: l.size });
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
  
  // Store with button text to number mapping
  pendingQuality[sender] = { 
    movie: { metadata, downloadLinks }, 
    timestamp: Date.now(),
    buttonMap: {} // Will store "1. 720p - 1.78 GB" → 1
  };
  
  // Create buttons with NUMBER PREFIX
  const buttons = [];
  
  downloadLinks.forEach((d, i) => {
    const buttonNumber = i + 1;
    const buttonText = `${buttonNumber}. ${d.quality} - ${d.size}`; // "1. 720p - 1.78 GB"
    
    // Store mapping
    pendingQuality[sender].buttonMap[buttonText] = buttonNumber;
    
    buttons.push({
      id: buttonNumber.toString(),
      text: buttonText
    });
  });
  
  // Add cancel button
  buttons.push({
    id: "cancel",
    text: "❌ Cancel"
  });
  
  try {
    await sendButtons(danuwa, from, {
      text: `*📥 Available Qualities (Max 2GB)*\n*🎬 Movie:* ${metadata.title.substring(0, 50)}${metadata.title.length > 50 ? '...' : ''}`,
      footer: "Click a button to select quality | Sinhalasub.lk",
      buttons
    }, { quoted: mek });
  } catch (error) {
    console.error("Error sending buttons:", error);
    // Fallback to text
    let qualityMsg = "*📥 Available Qualities (Max 2GB):*\n";
    downloadLinks.forEach((d,i) => qualityMsg += `*${i+1}.* ${d.quality} - ${d.size}\n`);
    qualityMsg += `\n*Reply with quality number to receive the movie as a document.*`;
    await danuwa.sendMessage(from, { text: qualityMsg }, { quoted: mek });
  }
});

// Enhanced filter to extract numbers from button text
cmd({
  filter: (text, { sender }) => {
    if (!pendingQuality[sender]) return false;
    
    const session = pendingQuality[sender];
    
    // 1. Check if it's a plain number (1, 2, 3...)
    const plainNum = parseInt(text);
    if (!isNaN(plainNum) && plainNum > 0 && plainNum <= session.movie.downloadLinks.length) {
      return true;
    }
    
    // 2. Check if it's button text with number prefix (like "1. 720p - 1.78 GB")
    // Extract number from beginning of text
    const match = text.match(/^(\d+)\./);
    if (match) {
      const extractedNum = parseInt(match[1]);
      if (!isNaN(extractedNum) && extractedNum > 0 && extractedNum <= session.movie.downloadLinks.length) {
        return true;
      }
    }
    
    // 3. Check if text matches any button text exactly (for backward compatibility)
    if (session.buttonMap && session.buttonMap[text]) {
      return true;
    }
    
    // 4. Check for cancel
    if (text === "cancel" || text === "❌ Cancel") {
      return true;
    }
    
    return false;
  }
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  console.log("🎬 Quality selection received:", { sender, body });
  
  await danuwa.sendMessage(from, { react: { text: "✅", key: m.key } });
  
  const session = pendingQuality[sender];
  if (!session) {
    reply("*❌ Session expired. Please start over.*");
    return;
  }
  
  // Handle cancel
  if (body === "cancel" || body === "❌ Cancel") {
    delete pendingQuality[sender];
    reply("*❌ Download cancelled*");
    return;
  }
  
  let selectedNumber = null;
  
  // Method 1: Try to extract number from button text (e.g., "1. 720p - 1.78 GB")
  const match = body.match(/^(\d+)\./);
  if (match) {
    selectedNumber = parseInt(match[1]);
    console.log("🎬 Extracted number from button text:", { body, extractedNumber: selectedNumber });
  }
  // Method 2: Check if it's a plain number
  else if (!isNaN(parseInt(body))) {
    selectedNumber = parseInt(body);
    console.log("🎬 Plain number received:", selectedNumber);
  }
  // Method 3: Check button map (exact match)
  else if (session.buttonMap && session.buttonMap[body]) {
    selectedNumber = session.buttonMap[body];
    console.log("🎬 Button map match:", { body, number: selectedNumber });
  }
  
  if (!selectedNumber || selectedNumber < 1 || selectedNumber > session.movie.downloadLinks.length) {
    reply(`*❌ Invalid selection. Please choose a number between 1-${session.movie.downloadLinks.length}*`);
    return;
  }
  
  const index = selectedNumber - 1;
  const { movie } = session;
  delete pendingQuality[sender];
  
  const selectedLink = movie.downloadLinks[index];
  
  // Debug log
  console.log("🎬 Processing download:", {
    quality: selectedLink.quality,
    size: selectedLink.size,
    link: selectedLink.link,
    movie: movie.metadata.title
  });
  
  reply(`*⬇️ Sending ${selectedLink.quality} movie as document...*\nPlease wait.`);
  
  try {
    const directUrl = getDirectPixeldrainUrl(selectedLink.link);
    if (!directUrl) {
      throw new Error("Could not generate direct download URL");
    }
    
    // Sanitize filename
    const fileName = `${movie.metadata.title.substring(0,50)} - ${selectedLink.quality}.mp4`
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    await danuwa.sendMessage(from, {
      document: { url: directUrl },
      mimetype: "video/mp4",
      fileName: fileName,
      caption: `*🎬 ${movie.metadata.title}*\n*📊 Quality:* ${selectedLink.quality}\n*💾 Size:* ${selectedLink.size}\n\n*Enjoy your movie! 🍿*`
    }, { quoted: mek });
    
  } catch (error) {
    console.error("🎬 Send document error:", error);
    reply(`*❌ Failed to send movie:* ${error.message || "Unknown error"}`);
  }
});

// Add a debug command to see what's happening
cmd({
  pattern: "moviedebug",
  desc: "Debug movie plugin state",
  category: "debug"
}, async (danuwa, mek, m, { sender, reply }) => {
  let debugMsg = "*🎬 Movie Plugin Debug Info*\n\n";
  
  if (pendingSearch[sender]) {
    debugMsg += `*Pending Search:* Yes\n`;
    debugMsg += `*Results:* ${pendingSearch[sender].results.length}\n`;
  }
  
  if (pendingQuality[sender]) {
    const session = pendingQuality[sender];
    debugMsg += `\n*Pending Quality:* Yes\n`;
    debugMsg += `*Movie:* ${session.movie.metadata.title}\n`;
    debugMsg += `*Qualities:* ${session.movie.downloadLinks.length}\n`;
    debugMsg += `*Button Map:* ${JSON.stringify(session.buttonMap || {})}\n`;
  }
  
  await reply(debugMsg);
});

setInterval(() => {
  const now = Date.now();
  const timeout = 10*60*1000;
  for (const s in pendingSearch) if (now - pendingSearch[s].timestamp > timeout) delete pendingSearch[s];
  for (const s in pendingQuality) if (now - pendingQuality[s].timestamp > timeout) delete pendingQuality[s];
}, 5*60*1000);

module.exports = { pendingSearch, pendingQuality };

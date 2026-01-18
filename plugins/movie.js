const { cmd } = require("../command");
const { sendButtons, sendInteractiveMessage } = require("gifted-btns");
const puppeteer = require("puppeteer");

const pendingSearch = {};
const pendingQuality = {};

// Debug function
function debugLog(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] DEBUG: ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

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
      const size = row.querySelector("td:nth-child(3) span")?.textcontent.trim() || "";
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
            rawQuality: l.quality
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
  debugLog("Movie command received", { sender, query: q });
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
  filter: (text, { sender }) => {
    if (!pendingSearch[sender]) return false;
    const num = parseInt(text);
    return !isNaN(num) && num > 0 && num <= pendingSearch[sender].results.length;
  }
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  debugLog("Movie selection received", { sender, selection: body });
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
  debugLog("Download links fetched", { 
    sender, 
    movie: metadata.title, 
    linksCount: downloadLinks.length,
    links: downloadLinks.map(l => ({ quality: l.quality, size: l.size, link: l.link }))
  });
  
  if (!downloadLinks.length) return reply("*❌ No download links found (<2GB)!*");
  
  // Store with button text mapping
  pendingQuality[sender] = { 
    movie: { 
      metadata, 
      downloadLinks
    }, 
    timestamp: Date.now(),
    buttonMap: {} // Map button text to quality index
  };
  
  // METHOD 1: Using sendInteractiveMessage with proper quick_reply format
  try {
    const interactiveButtons = [];
    
    downloadLinks.forEach((d, i) => {
      const buttonText = `${d.quality} - ${d.size}`;
      const buttonId = `quality_${i}`;
      
      // Map button text to quality index
      pendingQuality[sender].buttonMap[buttonText] = i;
      
      interactiveButtons.push({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: buttonText,
          id: buttonId
        })
      });
    });
    
    // Add cancel button
    interactiveButtons.push({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: "❌ Cancel",
        id: "cancel"
      })
    });
    
    debugLog("Sending interactive buttons", { 
      sender, 
      buttonCount: interactiveButtons.length,
      buttonTexts: interactiveButtons.map(b => JSON.parse(b.buttonParamsJson).display_text)
    });
    
    await sendInteractiveMessage(danuwa, from, {
      text: `*📥 Available Qualities (Max 2GB)*\n*🎬 Movie:* ${metadata.title.substring(0, 50)}${metadata.title.length > 50 ? '...' : ''}`,
      footer: "Click a button to download | Sinhalasub.lk",
      interactiveButtons
    }, { quoted: mek });
    
  } catch (error) {
    console.error("Error sending interactive buttons:", error);
    
    // METHOD 2: Fallback to simple buttons
    try {
      const buttons = downloadLinks.map((d, i) => ({
        id: `quality_${i}`,
        text: `${d.quality} - ${d.size}`
      }));
      
      buttons.push({
        id: "cancel",
        text: "❌ Cancel"
      });
      
      await sendButtons(danuwa, from, {
        text: `*📥 Available Qualities (Max 2GB)*\n*🎬 Movie:* ${metadata.title}`,
        footer: "Click a button to download | Sinhalasub.lk",
        buttons
      }, { quoted: mek });
      
    } catch (error2) {
      console.error("Error sending fallback buttons:", error2);
      
      // METHOD 3: Fallback to text-based selection
      let qualityMsg = "*📥 Available Qualities:*\n";
      downloadLinks.forEach((d,i) => qualityMsg += `*${i+1}.* ${d.quality} - ${d.size}\n`);
      qualityMsg += `\n*Reply with number (1-${downloadLinks.length})*`;
      await danuwa.sendMessage(from, { text: qualityMsg }, { quoted: mek });
    }
  }
});

// Handle ALL messages to catch button responses
cmd({
  on: "message"
}, async (danuwa, mek, m, { body, sender, from, reply }) => {
  // Only process if user has pending quality selection
  if (!pendingQuality[sender]) return;
  
  const messageText = (body || "").trim();
  debugLog("Message received from user with pending quality", {
    sender,
    messageText,
    hasPendingQuality: true,
    buttonMapKeys: Object.keys(pendingQuality[sender].buttonMap || {})
  });
  
  // Check if this is a button text from our buttonMap
  const session = pendingQuality[sender];
  let qualityIndex = null;
  let isCancel = false;
  
  // Check for cancel
  if (messageText === "❌ Cancel" || messageText === "cancel") {
    isCancel = true;
  }
  
  // Check if message matches any button text
  if (session.buttonMap && session.buttonMap[messageText] !== undefined) {
    qualityIndex = session.buttonMap[messageText];
  }
  
  // Also check for numeric fallback (if user types number)
  if (qualityIndex === null && !isNaN(parseInt(messageText))) {
    const num = parseInt(messageText);
    if (num >= 1 && num <= session.movie.downloadLinks.length) {
      qualityIndex = num - 1;
    }
  }
  
  debugLog("Button response analysis", {
    sender,
    messageText,
    isCancel,
    qualityIndex,
    matchedButtonText: qualityIndex !== null
  });
  
  // Handle cancel
  if (isCancel) {
    debugLog("Cancel request detected", { sender });
    delete pendingQuality[sender];
    await danuwa.sendMessage(from, { 
      text: "*❌ Download cancelled*"
    }, { quoted: m });
    await danuwa.sendMessage(from, { react: { text: "❌", key: m.key } });
    return;
  }
  
  // Handle quality selection
  if (qualityIndex !== null) {
    debugLog("Quality selection detected", {
      sender,
      qualityIndex,
      totalQualities: session.movie.downloadLinks.length
    });
    
    const selectedLink = session.movie.downloadLinks[qualityIndex];
    const metadata = session.movie.metadata;
    
    debugLog("Selected quality details", {
      sender,
      quality: selectedLink.quality,
      size: selectedLink.size,
      pixeldrainLink: selectedLink.link,
      movie: metadata.title
    });
    
    // React to acknowledge
    await danuwa.sendMessage(from, { react: { text: "✅", key: m.key } });
    
    // Send processing message
    await danuwa.sendMessage(from, { 
      text: `*⬇️ Preparing ${selectedLink.quality} quality...*\nPlease wait while we fetch your movie...\n\n*Pixeldrain Link for debugging:*\n\`${selectedLink.link}\``
    }, { quoted: m });
    
    try {
      const directUrl = getDirectPixeldrainUrl(selectedLink.link);
      if (!directUrl) {
        throw new Error("Could not get direct download URL");
      }
      
      debugLog("Direct download URL obtained", {
        original: selectedLink.link,
        direct: directUrl
      });
      
      // Sanitize filename
      const sanitizeFilename = (title, quality) => {
        return `${title.substring(0, 50)} - ${quality}.mp4`
          .replace(/[<>:"/\\|?*]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      };
      
      const fileName = sanitizeFilename(metadata.title, selectedLink.quality);
      
      debugLog("Sending document to user", {
        fileName,
        fileSize: selectedLink.size,
        quality: selectedLink.quality
      });
      
      // Send movie as document
      await danuwa.sendMessage(from, {
        document: { url: directUrl },
        mimetype: "video/mp4",
        fileName: fileName,
        caption: `*🎬 ${metadata.title}*\n*📊 Quality:* ${selectedLink.quality}\n*💾 Size:* ${selectedLink.size}\n\n*Enjoy your movie! 🍿*`
      }, { quoted: m });
      
      // Clean up
      delete pendingQuality[sender];
      debugLog("Download completed successfully", { sender, movie: metadata.title });
      
    } catch (error) {
      console.error("Download error:", error);
      debugLog("Download failed", {
        sender,
        error: error.message
      });
      
      // Send error message
      await danuwa.sendMessage(from, { 
        text: `*❌ Download failed*\nError: ${error.message || "Unknown error"}\n\nPlease try again.`
      }, { quoted: m });
    }
    
    return; // Important: return after handling
  }
  
  // If we get here, it's not a button response we recognize
  // But we still have pending quality, so maybe remind user
  if (session.movie && session.movie.downloadLinks) {
    debugLog("Unknown message from user with pending quality", {
      sender,
      messageText,
      expectedResponses: Object.keys(session.buttonMap || {})
    });
    
    // Send reminder
    let reminder = "*⚠️ Please select a quality by clicking one of the buttons above*\n\n";
    reminder += "*Available Qualities:*\n";
    session.movie.downloadLinks.forEach((d, i) => {
      reminder += `• ${d.quality} - ${d.size}\n`;
    });
    reminder += "\n*Or type 'cancel' to cancel*";
    
    await danuwa.sendMessage(from, { text: reminder }, { quoted: m });
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

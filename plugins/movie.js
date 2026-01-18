const { cmd } = require("../command");
const { sendButtons, sendInteractiveMessage } = require("gifted-btns");
const puppeteer = require("puppeteer");

const pendingSearch = {};
const pendingQuality = {};

// Enhanced debug function
function debugLog(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] 🎬 MOVIE PLUGIN: ${message}`);
  if (data) {
    console.log(`[${timestamp}] 🎬 DATA:`, JSON.stringify(data, null, 2));
  }
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
            rawQuality: l.quality
          });
        }
      }
      await subPage.close();
    } catch (e) { 
      console.error("Error processing link:", e);
      continue; 
    }
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
  
  // Create button text to index mapping
  downloadLinks.forEach((d, i) => {
    const buttonText = `${d.quality} - ${d.size}`;
    pendingQuality[sender].buttonMap[buttonText] = i;
    debugLog(`Button mapping created: "${buttonText}" → ${i}`);
  });
  
  // Store the exact button texts for reference
  const buttonTexts = downloadLinks.map(d => `${d.quality} - ${d.size}`);
  pendingQuality[sender].buttonTexts = buttonTexts;
  
  // Send buttons
  try {
    const interactiveButtons = [];
    
    downloadLinks.forEach((d, i) => {
      const buttonText = `${d.quality} - ${d.size}`;
      
      interactiveButtons.push({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: buttonText,
          id: `quality_${i}`
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
    console.error("Error with sendInteractiveMessage:", error);
    
    // Fallback to text-based selection
    debugLog("Falling back to text selection", { sender });
    let qualityMsg = "*📥 Available Qualities:*\n";
    downloadLinks.forEach((d,i) => qualityMsg += `*${i+1}.* ${d.quality} - ${d.size}\n`);
    qualityMsg += `\n*Reply with number (1-${downloadLinks.length})*`;
    await danuwa.sendMessage(from, { text: qualityMsg }, { quoted: mek });
  }
});

// CRITICAL: Add a global message listener to catch ALL messages
// This will help us debug what's being sent when buttons are clicked
const originalMessageHandler = danuwa.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0];
  if (!msg.message || msg.key.fromMe) return; // Skip bot's own messages
  
  const sender = msg.key.remoteJid;
  const messageText = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.buttonsResponseMessage?.selectedButtonId ||
                     msg.message.listResponseMessage?.title ||
                     '';
  
  // Check if this user has pending quality selection
  if (pendingQuality[sender]) {
    debugLog("GLOBAL HANDLER: Message from user with pending quality", {
      sender,
      messageText,
      messageType: Object.keys(msg.message).filter(k => k !== 'messageContextInfo' && msg.message[k]),
      fullMessage: JSON.stringify(msg.message, null, 2).substring(0, 500) // First 500 chars
    });
    
    // Check for buttonsResponseMessage (this is how button clicks come)
    if (msg.message.buttonsResponseMessage) {
      const buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
      const selectedDisplayText = msg.message.buttonsResponseMessage.selectedDisplayText;
      
      debugLog("GLOBAL HANDLER: BUTTON CLICK DETECTED!", {
        sender,
        buttonId,
        selectedDisplayText,
        buttonTexts: pendingQuality[sender].buttonTexts
      });
      
      // Process the button click
      processButtonClick(danuwa, sender, selectedDisplayText || buttonId, msg);
    }
    
    // Check for interactive response
    if (msg.message.interactiveResponseMessage) {
      debugLog("GLOBAL HANDLER: Interactive response detected", {
        sender,
        interactiveType: msg.message.interactiveResponseMessage?.type,
        content: JSON.stringify(msg.message.interactiveResponseMessage, null, 2).substring(0, 300)
      });
    }
  }
});

// Function to process button clicks
async function processButtonClick(danuwa, sender, buttonText, originalMessage) {
  debugLog("Processing button click", { sender, buttonText });
  
  const session = pendingQuality[sender];
  if (!session) {
    debugLog("No session found for sender", { sender });
    return;
  }
  
  // Handle cancel
  if (buttonText === "❌ Cancel" || buttonText === "cancel" || buttonText.includes("Cancel")) {
    debugLog("Processing cancel request", { sender, buttonText });
    delete pendingQuality[sender];
    
    await danuwa.sendMessage(sender, { 
      text: "*❌ Download cancelled*"
    }, { quoted: originalMessage });
    
    await danuwa.sendMessage(sender, { 
      react: { text: "❌", key: originalMessage.key } 
    });
    
    return;
  }
  
  // Try to match button text
  let qualityIndex = null;
  
  // Try exact match first
  if (session.buttonMap && session.buttonMap[buttonText] !== undefined) {
    qualityIndex = session.buttonMap[buttonText];
    debugLog("Exact button text match found", { buttonText, qualityIndex });
  }
  
  // Try partial match if exact didn't work
  if (qualityIndex === null && session.buttonTexts) {
    for (let i = 0; i < session.buttonTexts.length; i++) {
      const expectedText = session.buttonTexts[i];
      
      // Check if buttonText contains quality and size
      if (buttonText.includes(session.movie.downloadLinks[i].quality) && 
          buttonText.includes(session.movie.downloadLinks[i].size.replace(' GB', '').replace(' MB', ''))) {
        qualityIndex = i;
        debugLog("Partial match found", { 
          buttonText, 
          expectedText, 
          qualityIndex 
        });
        break;
      }
    }
  }
  
  // Try numeric match
  if (qualityIndex === null && !isNaN(parseInt(buttonText))) {
    const num = parseInt(buttonText);
    if (num >= 1 && num <= session.movie.downloadLinks.length) {
      qualityIndex = num - 1;
      debugLog("Numeric match found", { buttonText, qualityIndex });
    }
  }
  
  if (qualityIndex === null) {
    debugLog("Could not match button text", { 
      buttonText, 
      availableTexts: session.buttonTexts,
      buttonMap: session.buttonMap 
    });
    
    // Send help message
    let helpMsg = "*⚠️ Could not understand your selection*\n\n";
    helpMsg += "*Available options:*\n";
    session.movie.downloadLinks.forEach((d, i) => {
      helpMsg += `• ${d.quality} - ${d.size}\n`;
    });
    helpMsg += "\n*Please click one of the buttons above or type 'cancel'*";
    
    await danuwa.sendMessage(sender, { text: helpMsg }, { quoted: originalMessage });
    return;
  }
  
  // Process the download
  await handleQualitySelection(danuwa, sender, qualityIndex, originalMessage);
}

// Handle quality selection and download
async function handleQualitySelection(danuwa, sender, qualityIndex, originalMessage) {
  const session = pendingQuality[sender];
  if (!session || !session.movie) {
    debugLog("Invalid session", { sender });
    return;
  }
  
  const selectedLink = session.movie.downloadLinks[qualityIndex];
  const metadata = session.movie.metadata;
  
  debugLog("Processing quality selection for download", {
    sender,
    qualityIndex,
    quality: selectedLink.quality,
    size: selectedLink.size,
    pixeldrainLink: selectedLink.link,
    movie: metadata.title
  });
  
  // React to acknowledge
  await danuwa.sendMessage(sender, { 
    react: { text: "✅", key: originalMessage.key } 
  });
  
  // Send processing message
  const processingMsg = `*⬇️ Preparing ${selectedLink.quality} quality...*\nPlease wait while we fetch your movie...\n\n*Debug Info:*\n• Quality: ${selectedLink.quality}\n• Size: ${selectedLink.size}\n• Pixeldrain Link: ${selectedLink.link}`;
  
  await danuwa.sendMessage(sender, { 
    text: processingMsg 
  }, { quoted: originalMessage });
  
  try {
    const directUrl = getDirectPixeldrainUrl(selectedLink.link);
    if (!directUrl) {
      throw new Error("Could not get direct download URL");
    }
    
    debugLog("Got direct download URL", {
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
      directUrl,
      size: selectedLink.size
    });
    
    // Send movie as document
    await danuwa.sendMessage(sender, {
      document: { url: directUrl },
      mimetype: "video/mp4",
      fileName: fileName,
      caption: `*🎬 ${metadata.title}*\n*📊 Quality:* ${selectedLink.quality}\n*💾 Size:* ${selectedLink.size}\n\n*Enjoy your movie! 🍿*`
    }, { quoted: originalMessage });
    
    // Clean up
    delete pendingQuality[sender];
    debugLog("Download completed successfully", { 
      sender, 
      movie: metadata.title,
      quality: selectedLink.quality 
    });
    
  } catch (error) {
    console.error("Download error:", error);
    debugLog("Download failed", {
      sender,
      error: error.message,
      stack: error.stack
    });
    
    // Send error message
    await danuwa.sendMessage(sender, { 
      text: `*❌ Download failed*\nError: ${error.message || "Unknown error"}\n\nPlease try again.`
    }, { quoted: originalMessage });
  }
}

// Also keep the existing message handler for compatibility
cmd({
  on: "message"
}, async (danuwa, mek, m, { body, sender, from, reply }) => {
  debugLog("CMD HANDLER: Message received", { sender, body: body?.substring(0, 100) });
  
  // Only process if user has pending quality selection
  if (!pendingQuality[sender]) return;
  
  const messageText = (body || "").trim();
  
  debugLog("CMD HANDLER: Message from user with pending quality", {
    sender,
    messageText,
    buttonTexts: pendingQuality[sender]?.buttonTexts
  });
  
  // Call the same processing function
  await processButtonClick(danuwa, sender, messageText, m);
});

// Add debug command to check current state
cmd({
  pattern: "moviedebug",
  desc: "Debug movie plugin state",
  category: "debug"
}, async (danuwa, mek, m, { sender, reply }) => {
  debugLog("Debug command called", { sender });
  
  const pendingSearchCount = Object.keys(pendingSearch).length;
  const pendingQualityCount = Object.keys(pendingQuality).length;
  
  let debugMsg = `*🎬 Movie Plugin Debug Info*\n\n`;
  debugMsg += `*Pending Searches:* ${pendingSearchCount}\n`;
  debugMsg += `*Pending Qualities:* ${pendingQualityCount}\n\n`;
  
  if (pendingQuality[sender]) {
    const session = pendingQuality[sender];
    debugMsg += `*Your Session:*\n`;
    debugMsg += `• Movie: ${session.movie.metadata.title}\n`;
    debugMsg += `• Available Qualities: ${session.movie.downloadLinks.length}\n`;
    debugMsg += `• Button Texts: ${session.buttonTexts?.join(', ') || 'None'}\n`;
    debugMsg += `• Button Map: ${JSON.stringify(session.buttonMap || {})}\n`;
  }
  
  await reply(debugMsg);
});

// Keep the session cleanup
setInterval(() => {
  const now = Date.now();
  const timeout = 10*60*1000;
  for (const s in pendingSearch) if (now - pendingSearch[s].timestamp > timeout) delete pendingSearch[s];
  for (const s in pendingQuality) if (now - pendingQuality[s].timestamp > timeout) delete pendingQuality[s];
}, 5*60*1000);

module.exports = { pendingSearch, pendingQuality };

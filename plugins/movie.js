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
      const size = row.querySelector("td:nth-child(3) span")?.textContent.trim() || ""; // FIXED: textContent not textcontent
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
  });
  
  // METHOD 1: Try sendInteractiveMessage first
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
      
      debugLog("Trying fallback sendButtons", { 
        sender, 
        buttonCount: buttons.length 
      });
      
      await sendButtons(danuwa, from, {
        text: `*📥 Available Qualities (Max 2GB)*\n*🎬 Movie:* ${metadata.title}`,
        footer: "Click a button to download | Sinhalasub.lk",
        buttons
      }, { quoted: mek });
      
    } catch (error2) {
      console.error("Error with sendButtons:", error2);
      
      // METHOD 3: Fallback to text-based selection
      debugLog("Falling back to text selection", { sender });
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
    hasPendingQuality: true
  });
  
  const session = pendingQuality[sender];
  
  // Check for cancel
  if (messageText === "❌ Cancel" || messageText === "cancel" || messageText === "Cancel") {
    debugLog("Cancel detected", { sender, messageText });
    delete pendingQuality[sender];
    await danuwa.sendMessage(from, { 
      text: "*❌ Download cancelled*"
    }, { quoted: m });
    await danuwa.sendMessage(from, { react: { text: "❌", key: m.key } });
    return;
  }
  
  // Check if message matches any button text
  let qualityIndex = null;
  if (session.buttonMap && session.buttonMap[messageText] !== undefined) {
    qualityIndex = session.buttonMap[messageText];
    debugLog("Button text matched in buttonMap", {
      sender,
      messageText,
      qualityIndex
    });
  }
  
  // Also check for numeric fallback
  if (qualityIndex === null && !isNaN(parseInt(messageText))) {
    const num = parseInt(messageText);
    if (num >= 1 && num <= session.movie.downloadLinks.length) {
      qualityIndex = num - 1;
      debugLog("Numeric selection detected", {
        sender,
        number: num,
        qualityIndex
      });
    }
  }
  
  // Handle quality selection
  if (qualityIndex !== null) {
    const selectedLink = session.movie.downloadLinks[qualityIndex];
    const metadata = session.movie.metadata;
    
    debugLog("Processing quality selection", {
      sender,
      qualityIndex,
      quality: selectedLink.quality,
      size: selectedLink.size,
      pixeldrainLink: selectedLink.link,
      movie: metadata.title
    });
    
    // React to acknowledge
    await danuwa.sendMessage(from, { react: { text: "✅", key: m.key } });
    
    // Send processing message with debug info
    const processingMsg = `*⬇️ Preparing ${selectedLink.quality} quality...*\nPlease wait while we fetch your movie...\n\n*Debug Info:*\n• Quality: ${selectedLink.quality}\n• Size: ${selectedLink.size}\n• Pixeldrain: ${selectedLink.link}`;
    
    await danuwa.sendMessage(from, { 
      text: processingMsg
    }, { quoted: m });
    
    try {
      const directUrl = getDirectPixeldrainUrl(selectedLink.link);
      if (!directUrl) {
        throw new Error("Could not get direct download URL");
      }
      
      debugLog("Direct download URL", {
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
      
      debugLog("Sending document", {
        fileName,
        directUrl
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
      debugLog("Download completed", { sender, movie: metadata.title });
      
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
    
    return;
  }
  
  // If we get here and user has pending quality, remind them
  debugLog("Unknown message from user with pending quality", {
    sender,
    messageText,
    expectedButtonTexts: Object.keys(session.buttonMap || {})
  });
  
  let reminder = "*⚠️ Please select a quality:*\n\n";
  session.movie.downloadLinks.forEach((d, i) => {
    const buttonText = `${d.quality} - ${d.size}`;
    reminder += `• ${buttonText}\n`;
  });
  reminder += "\n*Click one of the buttons above or type 'cancel' to cancel*";
  
  await danuwa.sendMessage(from, { text: reminder }, { quoted: m });
});

// Add a test command to see button format
cmd({
  pattern: "testbutton",
  desc: "Test button response format",
  category: "debug"
}, async (danuwa, mek, m, { sender, from, reply }) => {
  debugLog("Test button command", { sender });
  
  // Create a test session
  pendingQuality[sender] = {
    movie: {
      metadata: { title: "Test Movie" },
      downloadLinks: [
        { quality: "720p", size: "1.5GB", link: "https://test.com/1" },
        { quality: "480p", size: "800MB", link: "https://test.com/2" }
      ]
    },
    timestamp: Date.now(),
    buttonMap: {
      "720p - 1.5GB": 0,
      "480p - 800MB": 1
    }
  };
  
  // Send test buttons
  try {
    const interactiveButtons = [
      {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: "720p - 1.5GB",
          id: "test_0"
        })
      },
      {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: "480p - 800MB",
          id: "test_1"
        })
      },
      {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: "❌ Cancel",
          id: "cancel"
        })
      }
    ];
    
    await sendInteractiveMessage(danuwa, from, {
      text: "*Test Buttons*\nClick a button and check console",
      footer: "Debug test",
      interactiveButtons
    }, { quoted: m });
    
  } catch (error) {
    console.error("Test button error:", error);
    await reply(`Error: ${error.message}`);
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

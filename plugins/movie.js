
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
  
  // Create unique session ID for this user
  const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  
  // Store session data
  pendingQuality[sessionId] = { 
    sender: sender,
    movie: { 
      metadata, 
      downloadLinks,
      movieUrl: selected.movieUrl
    }, 
    timestamp: Date.now()
  };
  
  // Create buttons for quality selection
  const buttons = [];
  
  downloadLinks.forEach((d, i) => {
    // Each button gets a unique ID that includes the session ID and quality index
    const buttonId = `${sessionId}_${i}`;
    
    buttons.push({
      id: buttonId,
      text: `${d.quality} - ${d.size}`
    });
  });
  
  // Add a cancel button
  buttons.push({
    id: `${sessionId}_cancel`,
    text: "❌ Cancel"
  });
  
  // Send quality selection buttons
  try {
    await sendButtons(danuwa, from, {
      text: `*📥 Available Qualities (Max 2GB)*\n*🎬 Movie:* ${metadata.title.substring(0, 50)}${metadata.title.length > 50 ? '...' : ''}`,
      footer: "Click a button to download | Sinhalasub.lk",
      buttons
    }, { quoted: mek });
  } catch (error) {
    console.error("Error sending buttons:", error);
    // Fallback to text-based selection
    let qualityMsg = "*📥 Available Qualities (Max 2GB):*\n";
    downloadLinks.forEach((d,i) => qualityMsg += `*${i+1}.* ${d.quality} - ${d.size}\n`);
    qualityMsg += `\n*Reply with quality number (1-${downloadLinks.length})*`;
    pendingQuality[sender] = { movie: { metadata, downloadLinks }, timestamp: Date.now() };
    await danuwa.sendMessage(from, { text: qualityMsg }, { quoted: mek });
  }
});

// Handle button clicks for quality selection
cmd({
  pattern: "movie_button", // We'll use a pattern to catch button clicks
  fromMe: false,
  desc: "Handle movie quality button clicks",
  dontAddCommandList: true
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  // Check if this is a button response
  if (!body || typeof body !== 'string') return;
  
  // Parse the button ID
  const buttonId = body.trim();
  
  // Find which session this belongs to
  let foundSession = null;
  let qualityIndex = null;
  let isCancel = false;
  
  for (const sessionId in pendingQuality) {
    const session = pendingQuality[sessionId];
    
    // Check if sender matches
    if (session.sender !== sender) continue;
    
    // Check if button ID matches any quality button
    const parts = buttonId.split('_');
    const baseSessionId = parts[0] + '_' + parts[1];
    
    if (sessionId.startsWith(baseSessionId)) {
      foundSession = session;
      
      // Check if it's a cancel button
      if (buttonId.includes('cancel')) {
        isCancel = true;
        break;
      }
      
      // Extract quality index from button ID
      const lastPart = parts[parts.length - 1];
      qualityIndex = parseInt(lastPart);
      
      if (!isNaN(qualityIndex) && qualityIndex >= 0 && qualityIndex < session.movie.downloadLinks.length) {
        break;
      }
    }
  }
  
  if (!foundSession) {
    // Not a movie quality button click
    return;
  }
  
  // React to acknowledge button click
  await danuwa.sendMessage(from, { react: { text: "✅", key: m.key } });
  
  // Handle cancel button
  if (isCancel) {
    delete pendingQuality[foundSession.sender];
    await danuwa.sendMessage(from, { 
      text: "*❌ Download cancelled*"
    }, { quoted: mek });
    return;
  }
  
  if (qualityIndex === null || qualityIndex === undefined) {
    await danuwa.sendMessage(from, { 
      text: "*❌ Invalid selection. Please try again.*"
    }, { quoted: mek });
    return;
  }
  
  const { movie } = foundSession;
  const selectedLink = movie.downloadLinks[qualityIndex];
  
  // Send processing message
  const processingMsg = await danuwa.sendMessage(from, { 
    text: `*⬇️ Preparing ${selectedLink.quality} quality...*\nPlease wait while we fetch your movie.\nThis may take a few seconds...`
  }, { quoted: mek });
  
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
    
    // Clean up the session
    delete pendingQuality[foundSession.sender];
    
  } catch (error) {
    console.error("Download error:", error);
    
    // Send error message
    await danuwa.sendMessage(from, { 
      text: `*❌ Download failed*\nError: ${error.message || "Unknown error"}\n\nPlease try the command again.`
    }, { quoted: mek });
  }
});

// Alternative: Handle button clicks via the interactive response
// This handles the actual button response from gifted-btns
cmd({
  filter: (text, { sender }) => {
    // Check if this looks like a button response (sessionId_0, sessionId_1, etc.)
    return /^[a-z0-9]+_[a-z0-9]+(_\d+)?$/.test(text);
  }
}, async (danuwa, mek, m, { body, sender, reply, from }) => {
  const buttonId = body.trim();
  
  // Find session by sender first
  for (const sessionId in pendingQuality) {
    const session = pendingQuality[sessionId];
    if (session.sender === sender) {
      // This is our user's session
      const parts = buttonId.split('_');
      
      // Handle cancel
      if (buttonId.includes('cancel')) {
        delete pendingQuality[sessionId];
        await danuwa.sendMessage(from, { 
          text: "*❌ Download cancelled*"
        }, { quoted: mek });
        return;
      }
      
      // Extract quality index
      const lastPart = parts[parts.length - 1];
      const qualityIndex = parseInt(lastPart);
      
      if (!isNaN(qualityIndex) && qualityIndex >= 0 && qualityIndex < session.movie.downloadLinks.length) {
        const { movie } = session;
        const selectedLink = movie.downloadLinks[qualityIndex];
        
        // React to acknowledge
        await danuwa.sendMessage(from, { react: { text: "✅", key: m.key } });
        
        // Send processing message
        await danuwa.sendMessage(from, { 
          text: `*⬇️ Sending ${selectedLink.quality} movie as document...*\nPlease wait.`
        }, { quoted: mek });
        
        try {
          const directUrl = getDirectPixeldrainUrl(selectedLink.link);
          if (!directUrl) throw new Error("No direct URL");
          
          const fileName = `${movie.metadata.title.substring(0,50)} - ${selectedLink.quality}.mp4`.replace(/[^\w\s.-]/gi,'');
          
          await danuwa.sendMessage(from, {
            document: { url: directUrl },
            mimetype: "video/mp4",
            fileName: fileName,
            caption: `*🎬 ${movie.metadata.title}*\n*📊 Quality:* ${selectedLink.quality}\n*💾 Size:* ${selectedLink.size}\n\n*Enjoy your movie! 🍿*`
          }, { quoted: mek });
          
          delete pendingQuality[sessionId];
          return;
        } catch (error) {
          console.error("Send document error:", error);
          await danuwa.sendMessage(from, { 
            text: `*❌ Failed to send movie:* ${error.message || "Unknown error"}`
          }, { quoted: mek });
          return;
        }
      }
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

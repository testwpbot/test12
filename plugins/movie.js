const { cmd } = require("../command");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// Map qualities to friendly names and sorting order
function normalizeQuality(text) {
  if (!text) return "Unknown";
  text = text.toUpperCase();
  if (/1080|FHD/.test(text)) return "1080p";
  if (/720|HD/.test(text)) return "720p";
  if (/480|SD/.test(text)) return "480p";
  return text || "Unknown";
}

function getQualityOrder(quality) {
  if (quality === "1080p") return 1;
  if (quality === "720p") return 2;
  if (quality === "480p") return 3;
  return 4;
}

// User session management
const userSessions = new Map();

// Helper to clear old sessions
function cleanupSessions(userId) {
  if (userSessions.has(userId)) {
    const session = userSessions.get(userId);
    // Clear after 10 minutes
    if (Date.now() - session.timestamp > 10 * 60 * 1000) {
      userSessions.delete(userId);
    }
  }
}

// --- Search Movies ---
async function searchMovies(query) {
  const searchUrl = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}&post_type=movies`;
  const browser = await puppeteer.launch({ 
    headless: true, 
    args: ["--no-sandbox", "--disable-setuid-sandbox"] 
  });
  const page = await browser.newPage();
  
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
      }).filter(movie => movie.title && movie.movieUrl)
    );

    return results;
  } catch (error) {
    console.error("Search error:", error);
    return [];
  } finally {
    await browser.close();
  }
}

// --- Fetch Movie Metadata ---
async function getMovieMetadata(url) {
  const browser = await puppeteer.launch({ 
    headless: true, 
    args: ["--no-sandbox", "--disable-setuid-sandbox"] 
  });
  const page = await browser.newPage();
  
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    const metadata = await page.evaluate(() => {
      const getText = (el) => el?.textContent.trim() || "";
      const getList = (selector) => Array.from(document.querySelectorAll(selector)).map(el => el.textContent.trim());

      const title = getText(document.querySelector(".info-details .details-title h3"));
      
      // Get language
      let language = "";
      const infoPs = document.querySelectorAll(".info-col p");
      infoPs.forEach(p => {
        const strong = p.querySelector("strong");
        if (strong && strong.textContent.includes("Language:")) {
          language = strong.nextSibling?.textContent?.trim() || "";
        }
      });

      // Get directors
      let directors = [];
      infoPs.forEach(p => {
        const strong = p.querySelector("strong");
        if (strong && strong.textContent.includes("Director:")) {
          directors = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
        }
      });

      // Get stars
      let stars = [];
      infoPs.forEach(p => {
        const strong = p.querySelector("strong");
        if (strong && strong.textContent.includes("Stars:")) {
          stars = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
        }
      });

      const duration = getText(document.querySelector(".info-details .data-views[itemprop='duration']"));
      const imdb = getText(document.querySelector(".info-details .data-imdb"))?.replace("IMDb:", "").trim();
      const genres = getList(".details-genre a");
      const thumbnail = document.querySelector(".splash-bg img")?.src || 
                       document.querySelector(".thumb")?.src || "";

      return { 
        title: title || "Unknown", 
        language: language || "Unknown",
        duration: duration || "Unknown",
        imdb: imdb || "N/A",
        genres: genres.length > 0 ? genres : ["Unknown"],
        directors: directors.length > 0 ? directors : ["Unknown"],
        stars: stars.length > 0 ? stars : ["Unknown"],
        thumbnail: thumbnail 
      };
    });

    return metadata;
  } catch (error) {
    console.error("Metadata error:", error);
    return null;
  } finally {
    await browser.close();
  }
}

// --- Fetch Pixeldrain Direct Links ---
async function getPixeldrainLinks(movieUrl) {
  const browser = await puppeteer.launch({ 
    headless: true, 
    args: ["--no-sandbox", "--disable-setuid-sandbox"] 
  });
  const page = await browser.newPage();
  
  try {
    await page.goto(movieUrl, { waitUntil: "networkidle2", timeout: 30000 });

    const pixeldrainPages = await page.$$eval("table tr a", links =>
      links
        .filter(a => a.textContent.toLowerCase().includes("pixeldrain"))
        .map(a => a.href)
        .slice(0, 5) // Limit to 5 links
    );

    if (pixeldrainPages.length === 0) {
      return [];
    }

    const directLinks = [];
    
    for (const link of pixeldrainPages) {
      try {
        const subPage = await browser.newPage();
        await subPage.goto(link, { waitUntil: "networkidle2", timeout: 30000 });

        // Wait for countdown
        await subPage.waitForTimeout(10000);
        
        const result = await subPage.evaluate(() => {
          const linkEl = document.querySelector(".wait-done a[href^='https://pixeldrain.com/']") || 
                        document.querySelector("a[href*='pixeldrain']");
          if (!linkEl) return null;
          
          const qualityMatch = linkEl.textContent.match(/\b(1080|720|480)p\b/i);
          return { 
            link: linkEl.href, 
            quality: qualityMatch ? qualityMatch[0] : "Unknown" 
          };
        });

        if (result) {
          directLinks.push({ 
            link: result.link, 
            quality: normalizeQuality(result.quality),
            id: directLinks.length + 1
          });
        }
        
        await subPage.close();
      } catch (error) {
        console.error("Error processing pixeldrain page:", error);
        continue;
      }
    }

    return directLinks.sort((a, b) => getQualityOrder(a.quality) - getQualityOrder(b.quality));
  } catch (error) {
    console.error("Pixeldrain links error:", error);
    return [];
  } finally {
    await browser.close();
  }
}

// --- Download file from Pixeldrain ---
async function downloadFile(url, userId) {
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const filename = `movie_${userId}_${Date.now()}.mp4`;
  const filepath = path.join(tempDir, filename);
  
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 300000 // 5 minutes
    });

    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filepath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error("Download error:", error);
    throw error;
  }
}

// Main command handler with reply logic
cmd(
  {
    pattern: "movie",
    alias: ["sinhalasub", "films", "cinema"],
    react: "🎬",
    desc: "Search and download movies from Sinhalasub.lk",
    category: "download",
    filename: __filename,
  },
  async (
    danuwa,
    mek,
    m,
    {
      from,
      quoted,
      body,
      isCmd,
      command,
      args,
      q,
      isGroup,
      sender,
      senderNumber,
      botNumber2,
      botNumber,
      pushname,
      isMe,
      isOwner,
      groupMetadata,
      groupName,
      participants,
      groupAdmins,
      isBotAdmins,
      isAdmins,
      reply,
    }
  ) => {
    try {
      // Check if this is a reply to a previous movie session
      cleanupSessions(sender);
      
      if (userSessions.has(sender)) {
        const session = userSessions.get(sender);
        const userInput = body.trim();
        
        // Handle movie selection (step 1)
        if (session.step === "movie_selection") {
          const movieIndex = parseInt(userInput) - 1;
          
          if (isNaN(movieIndex) || movieIndex < 0 || movieIndex >= session.searchResults.length) {
            userSessions.delete(sender);
            return reply(`*❌ Invalid selection! Please start over with \`!movie movie_name\`.*`);
          }

          const selectedMovie = session.searchResults[movieIndex];
          
          reply("*📥 Fetching movie details... Please wait...*");

          // Update session
          session.step = "downloading";
          session.data.selectedMovie = selectedMovie;
          session.timestamp = Date.now();

          // Get metadata
          const metadata = await getMovieMetadata(selectedMovie.movieUrl);
          
          if (!metadata) {
            userSessions.delete(sender);
            return reply("*❌ Failed to fetch movie details. Please try again.*");
          }

          // Format metadata message
          let metadataText = `*🎬 ${metadata.title}*\n\n`;
          metadataText += `*📝 Language:* ${metadata.language}\n`;
          metadataText += `*⏱️ Duration:* ${metadata.duration}\n`;
          metadataText += `*⭐ IMDb:* ${metadata.imdb}\n`;
          metadataText += `*🎭 Genres:* ${metadata.genres.join(", ")}\n`;
          metadataText += `*🎥 Directors:* ${metadata.directors.join(", ")}\n`;
          metadataText += `*🌟 Stars:* ${metadata.stars.slice(0, 5).join(", ")}${metadata.stars.length > 5 ? "..." : ""}\n\n`;
          metadataText += "*⏳ Fetching download links... This may take a minute...*";

          // Send thumbnail if available
          if (metadata.thumbnail) {
            await danuwa.sendMessage(
              from,
              {
                image: { url: metadata.thumbnail },
                caption: metadataText
              },
              { quoted: mek }
            );
          } else {
            await danuwa.sendMessage(
              from,
              { text: metadataText },
              { quoted: mek }
            );
          }

          // Get download links
          const downloadLinks = await getPixeldrainLinks(selectedMovie.movieUrl);
          
          if (!downloadLinks.length) {
            userSessions.delete(sender);
            return reply("*❌ No download links found for this movie!*");
          }

          // Update session with download links
          session.step = "quality_selection";
          session.data.downloadLinks = downloadLinks;
          session.data.metadata = metadata;
          session.timestamp = Date.now();

          // Format download options
          let linksText = "*📥 Available Downloads:*\n\n";
          downloadLinks.forEach((link, index) => {
            linksText += `*${index + 1}.* ${link.quality}\n`;
          });
          
          linksText += `\n*Reply with quality number (1-${downloadLinks.length}) to download.*\n`;
          linksText += "*Note: Large files may take time to download.*";

          return reply(linksText);
        }
        
        // Handle quality selection (step 2)
        else if (session.step === "quality_selection") {
          const linkIndex = parseInt(userInput) - 1;
          
          if (isNaN(linkIndex) || linkIndex < 0 || linkIndex >= session.data.downloadLinks.length) {
            userSessions.delete(sender);
            return reply(`*❌ Invalid selection! Please start over with \`!movie movie_name\`.*`);
          }

          const selectedLink = session.data.downloadLinks[linkIndex];
          
          reply(`*⬇️ Downloading ${selectedLink.quality} quality... This may take several minutes...*\n*Please wait...*`);

          try {
            // Download the file
            const filepath = await downloadFile(selectedLink.link, sender);
            
            // Get file size
            const stats = fs.statSync(filepath);
            const fileSize = (stats.size / (1024 * 1024)).toFixed(2);

            // Check file size (WhatsApp limit ~16MB for videos)
            if (stats.size > 15 * 1024 * 1024) {
              fs.unlinkSync(filepath);
              userSessions.delete(sender);
              return reply(`*❌ File too large (${fileSize}MB)! WhatsApp has a 16MB limit for videos.*`);
            }

            // Send the video
            await danuwa.sendMessage(
              from,
              {
                video: fs.readFileSync(filepath),
                caption: `*✅ Download Complete!*\n\n` +
                         `*🎬 Title:* ${session.data.metadata.title}\n` +
                         `*📊 Quality:* ${selectedLink.quality}\n` +
                         `*💾 Size:* ${fileSize} MB\n\n` +
                         `*Enjoy your movie! 🍿*`
              },
              { quoted: mek }
            );

            // Cleanup
            fs.unlinkSync(filepath);
            userSessions.delete(sender);
            return;

          } catch (error) {
            console.error("Download error:", error);
            
            // Try to cleanup temp file
            try {
              const tempDir = path.join(__dirname, 'temp');
              if (fs.existsSync(tempDir)) {
                const files = fs.readdirSync(tempDir);
                files.forEach(file => {
                  if (file.includes(sender)) {
                    fs.unlinkSync(path.join(tempDir, file));
                  }
                });
              }
            } catch (e) {}
            
            userSessions.delete(sender);
            return reply(`*❌ Download failed:* ${error.message || "File too large or link expired"}`);
          }
        }
      }

      // If no session or new command, start search
      if (!q) {
        return reply(`*🎬 Movie Search Plugin*\n\n*Usage:* ${command} movie_name\n*Example:* ${command} avengers\n\nSearch movies from Sinhalasub.lk`);
      }

      reply("*🔍 Searching for movies... Please wait...*");

      const searchResults = await searchMovies(q);
      
      if (!searchResults.length) {
        return reply("*❌ No movies found! Try a different search term.*");
      }

      // Create session for user
      const sessionId = `${sender}-${Date.now()}`;
      userSessions.set(sender, {
        id: sessionId,
        timestamp: Date.now(),
        step: "movie_selection",
        searchResults: searchResults,
        data: {}
      });

      // Format search results message
      let resultsText = "*🎬 Search Results:*\n\n";
      searchResults.forEach((movie, index) => {
        resultsText += `*${index + 1}.* ${movie.title}\n`;
        resultsText += `   📝 Language: ${movie.language || "Unknown"}\n`;
        resultsText += `   📊 Quality: ${movie.quality || "Unknown"}\n`;
        resultsText += `   🎞️ Format: ${movie.qty || "Unknown"}\n\n`;
      });
      
      resultsText += `*Reply with the movie number (1-${searchResults.length}) to select.*`;

      await danuwa.sendMessage(from, { text: resultsText }, { quoted: mek });

    } catch (error) {
      console.error("Movie plugin error:", error);
      
      // Cleanup session on error
      if (userSessions.has(sender)) {
        userSessions.delete(sender);
      }
      
      // Try to cleanup temp files
      try {
        const tempDir = path.join(__dirname, 'temp');
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir);
          files.forEach(file => {
            if (file.includes(sender)) {
              fs.unlinkSync(path.join(tempDir, file));
            }
          });
        }
      } catch (e) {}
      
      reply(`*❌ Error:* ${error.message || "Something went wrong!"}`);
    }
  }
);

// Add cleanup for old sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.timestamp > 10 * 60 * 1000) {
      userSessions.delete(userId);
      
      // Cleanup temp files for this user
      try {
        const tempDir = path.join(__dirname, 'temp');
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir);
          files.forEach(file => {
            if (file.includes(userId)) {
              fs.unlinkSync(path.join(tempDir, file));
            }
          });
        }
      } catch (e) {}
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

// Export session manager for debugging if needed
module.exports = { userSessions };


const { cmd } = require("../command");
const puppeteer = require("puppeteer");

// Storage for active user sessions (mirrors your movie.js structure)
const pendingAnimeSearch = {};
const pendingAnimeQuality = {};

// Helper to launch browser with necessary args for Linux servers
async function launchBrowser() {
  return await puppeteer.launch({ 
    headless: true, 
    args: ["--no-sandbox", "--disable-setuid-sandbox"] 
  });
}

// Main Search Command
cmd({
  pattern: "9anime",
  desc: "Search for anime on 9animetv.to",
  category: "search",
  use: ".9anime <anime name>",
  filename: __filename
}, async (conn, mek, m, { text, reply, from, sender }) => {
  if (!text) return reply("❌ Please provide an anime name!");

  await conn.sendMessage(from, { react: { text: "", key: m.key } });
  
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const searchUrl = `https://9animetv.to/search?keyword=${encodeURIComponent(text)}`;
    
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Scrape search results
    const results = await page.$$eval(".flw-item", items => 
      items.slice(0, 10).map((item, index) => ({
        index: index + 1,
        title: item.querySelector(".film-name a")?.innerText.trim(),
        link: "https://9animetv.to" + item.querySelector(".film-name a")?.getAttribute("href"),
        img: item.querySelector("img.film-poster-img")?.getAttribute("data-src"),
        eps: item.querySelector(".tick-eps")?.innerText.trim() || "N/A"
      }))
    );

    if (results.length === 0) {
      await browser.close();
      return reply("❌ No anime found matching that name.");
    }

    pendingAnimeSearch[sender] = results;

    let response = ` *9ANIME SEARCH RESULTS* \n\n`;
    results.forEach(res => {
      response += `${res.index}. *${res.title}*\n    Eps: ${res.eps}\n\n`;
    });
    response += `*Reply with the number (1-10) to get details.*`;

    await conn.sendMessage(from, { 
      image: { url: results[0].img }, 
      caption: response 
    }, { quoted: mek });

  } catch (error) {
    console.error("9Anime Search Error:", error);
    reply("⚠️ An error occurred while searching.");
  } finally {
    await browser.close();
  }
});

// Listener for User Selection (Matches your movie.js listener pattern)
cmd({
  on: "text",
  nocmd: true,
  filter: ({ body, sender }) => pendingAnimeSearch[sender] && !isNaN(body) && parseInt(body) > 0 && parseInt(body) <= 10
}, async (conn, mek, m, { body, sender, reply, from }) => {
  const index = parseInt(body.trim()) - 1;
  const selected = pendingAnimeSearch[sender][index];
  delete pendingAnimeSearch[sender]; // Clear after selection

  await conn.sendMessage(from, { react: { text: "⌛", key: m.key } });

  // Here you can add logic to scrape actual download links or more info
  let detailMsg = ` *${selected.title}*\n\n`;
  detailMsg += ` *Link:* ${selected.link}\n`;
  detailMsg += ` *Episodes:* ${selected.eps}\n\n`;
  detailMsg += `_You can visit the link above to watch directly!_`;

  await conn.sendMessage(from, { 
    image: { url: selected.img }, 
    caption: detailMsg 
  }, { quoted: mek });
});

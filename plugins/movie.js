const { cmd } = require("../command");
const { sendButtons } = require("gifted-btns");
const puppeteer = require("puppeteer");

const pendingSearch = {};
const pendingQuality = {};

/* ================= UTIL FUNCTIONS ================= */

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

/* ================= SCRAPERS ================= */

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
        qty: qty.trim()
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

    return {
      title,
      language,
      duration: getText(document.querySelector(".data-views[itemprop='duration']")),
      imdb: getText(document.querySelector(".data-imdb")).replace("IMDb:", "").trim(),
      genres: getList(".details-genre a"),
      directors,
      stars,
      thumbnail: document.querySelector(".splash-bg img")?.src || ""
    };
  });

  await browser.close();
  return metadata;
}

async function getPixeldrainLinks(movieUrl) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(movieUrl, { waitUntil: "networkidle2", timeout: 30000 });

  const links = await page.$$eval(".link-pixeldrain tbody tr", rows =>
    rows.map(row => {
      const a = row.querySelector(".link-opt a");
      const quality = row.querySelector(".quality")?.textContent.trim() || "";
      const size = row.querySelector("td:nth-child(3) span")?.textContent.trim() || "";
      return { pageLink: a?.href || "", quality, size };
    })
  );

  const results = [];

  for (const l of links) {
    try {
      const sub = await browser.newPage();
      await sub.goto(l.pageLink, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 12000));

      const finalUrl = await sub.$eval(".wait-done a[href^='https://pixeldrain.com/']", el => el.href).catch(() => null);
      if (finalUrl) {
        results.push({
          link: finalUrl,
          quality: normalizeQuality(l.quality),
          size: l.size
        });
      }
      await sub.close();
    } catch {}
  }

  await browser.close();
  return results;
}

/* ================= COMMANDS ================= */

cmd({
  pattern: "movie",
  alias: ["sinhalasub", "films"],
  react: "🎬",
  desc: "Search SinhalaSub movies",
  category: "download",
  filename: __filename
}, async (danuwa, mek, m, { q, sender, reply }) => {
  if (!q) return reply("🎬 *Usage:* movie <name>");

  reply("🔍 Searching movies...");
  const results = await searchMovies(q);
  if (!results.length) return reply("❌ No movies found");

  pendingSearch[sender] = { results, timestamp: Date.now() };

  let msg = "*🎬 Search Results:*\n\n";
  results.forEach((r, i) => {
    msg += `*${i + 1}.* ${r.title}\n🌐 ${r.language} | ${r.quality}\n\n`;
  });
  msg += "_Reply with movie number_";

  reply(msg);
});

cmd({
  filter: (t, { sender }) =>
    pendingSearch[sender] &&
    !isNaN(t) &&
    t > 0 &&
    t <= pendingSearch[sender].results.length
}, async (danuwa, mek, m, { body, sender, from }) => {

  const index = Number(body) - 1;
  const selected = pendingSearch[sender].results[index];
  delete pendingSearch[sender];

  const metadata = await getMovieMetadata(selected.movieUrl);
  const links = await getPixeldrainLinks(selected.movieUrl);

  pendingQuality[sender] = { metadata, links };

  const buttons = links.map((l, i) => ({
    id: `.movieq_${i}`,
    text: `🎞️ ${l.quality} (${l.size})`
  }));

  await sendButtons(
    danuwa,
    from,
    {
      text: `🎬 *${metadata.title}*\nSelect quality:`,
      footer: "Movie Downloader",
      buttons
    },
    { quoted: mek }
  );
});

/* ================= QUALITY BUTTON HANDLER ================= */

cmd({
  pattern: "movieq_(.*)",
  dontAddCommandList: true
}, async (danuwa, mek, m, { from, sender }) => {

  if (!pendingQuality[sender]) return;
  const index = Number(m.text.split("_")[1]);

  const { metadata, links } = pendingQuality[sender];
  const selected = links[index];
  delete pendingQuality[sender];

  const direct = getDirectPixeldrainUrl(selected.link);

  await danuwa.sendMessage(from, {
    document: { url: direct },
    mimetype: "video/mp4",
    fileName: `${metadata.title} - ${selected.quality}.mp4`,
    caption: `🎬 *${metadata.title}*\n📊 ${selected.quality}\n💾 ${selected.size}`
  }, { quoted: mek });
});

/* ================= CLEANUP ================= */

setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000;
  for (const u in pendingSearch)
    if (now - pendingSearch[u].timestamp > timeout) delete pendingSearch[u];
  for (const u in pendingQuality)
    if (now - pendingQuality[u]?.timestamp > timeout) delete pendingQuality[u];
}, 5 * 60 * 1000);

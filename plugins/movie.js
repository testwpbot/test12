const { cmd } = require("../command");
const puppeteer = require("puppeteer");
const { sendButtons } = require("gifted-btns");

const pendingSearch = {};
const pendingQuality = {};

/* ================= HELPERS ================= */

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
  const url = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}&post_type=movies`;
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const results = await page.$$eval(".display-item .item-box", boxes =>
    boxes.slice(0, 10).map((box, i) => {
      const a = box.querySelector("a");
      const img = box.querySelector(".thumb");
      return {
        id: i + 1,
        title: a?.title?.trim() || "",
        movieUrl: a?.href || "",
        thumb: img?.src || "",
        language: box.querySelector(".language")?.textContent.trim() || "",
        quality: box.querySelector(".quality")?.textContent.trim() || "",
        qty: box.querySelector(".qty")?.textContent.trim() || ""
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

  const data = await page.evaluate(() => {
    const txt = el => el?.textContent.trim() || "";
    const list = sel => [...document.querySelectorAll(sel)].map(e => e.textContent.trim());

    let language = "", directors = [], stars = [];

    document.querySelectorAll(".info-col p").forEach(p => {
      const strong = p.querySelector("strong");
      if (!strong) return;
      const t = strong.textContent;
      if (t.includes("Language")) language = strong.nextSibling?.textContent?.trim() || "";
      if (t.includes("Director")) directors = list("a", p);
      if (t.includes("Stars")) stars = list("a", p);
    });

    return {
      title: txt(document.querySelector(".details-title h3")),
      duration: txt(document.querySelector("[itemprop='duration']")),
      imdb: txt(document.querySelector(".data-imdb")).replace("IMDb:", "").trim(),
      genres: list(".details-genre a"),
      language,
      directors,
      stars,
      thumbnail: document.querySelector(".splash-bg img")?.src || ""
    };
  });

  await browser.close();
  return data;
}

async function getPixeldrainLinks(movieUrl) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  await page.goto(movieUrl, { waitUntil: "networkidle2", timeout: 30000 });

  const rows = await page.$$eval(".link-pixeldrain tbody tr", trs =>
    trs.map(tr => ({
      pageLink: tr.querySelector(".link-opt a")?.href || "",
      quality: tr.querySelector(".quality")?.textContent.trim() || "",
      size: tr.querySelector("td:nth-child(3) span")?.textContent.trim() || ""
    }))
  );

  const links = [];

  for (const r of rows) {
    try {
      const p = await browser.newPage();
      await p.goto(r.pageLink, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(res => setTimeout(res, 12000));

      const final = await p.$eval(
        ".wait-done a[href^='https://pixeldrain.com/']",
        el => el.href
      ).catch(() => null);

      if (final) {
        let mb = 0;
        const s = r.size.toUpperCase();
        if (s.includes("GB")) mb = parseFloat(s) * 1024;
        if (s.includes("MB")) mb = parseFloat(s);

        if (mb <= 2048) {
          links.push({
            link: final,
            quality: normalizeQuality(r.quality),
            size: r.size
          });
        }
      }
      await p.close();
    } catch {}
  }

  await browser.close();
  return links;
}

/* ================= COMMANDS ================= */

cmd({
  pattern: "movie",
  alias: ["sinhalasub", "films", "cinema"],
  react: "🎬",
  desc: "Search movies from Sinhalasub.lk",
  category: "download",
  filename: __filename
}, async (danuwa, mek, m, { q, sender, from, reply }) => {

  if (!q) return reply("*🎬 Usage:* movie avengers");

  reply("*🔍 Searching movies...*");

  const results = await searchMovies(q);
  if (!results.length) return reply("*❌ No movies found!*");

  pendingSearch[sender] = { results, timestamp: Date.now() };

  let msg = "*🎬 Search Results*\n\n";
  results.forEach((r, i) => {
    msg += `*${i + 1}.* ${r.title}\n📝 ${r.language} | 📊 ${r.quality}\n\n`;
  });

  msg += "*Reply with movie number*";
  reply(msg);
});

/* ===== MOVIE SELECTION ===== */

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

  const meta = await getMovieMetadata(selected.movieUrl);

  const caption =
    `*🎬 ${meta.title}*\n` +
    `📝 ${meta.language}\n` +
    `⏱️ ${meta.duration}\n` +
    `⭐ IMDb: ${meta.imdb}\n` +
    `🎭 ${meta.genres.join(", ")}\n\n` +
    "*🔗 Fetching download links...*";

  if (meta.thumbnail) {
    await danuwa.sendMessage(from, { image: { url: meta.thumbnail }, caption }, { quoted: mek });
  } else {
    await danuwa.sendMessage(from, { text: caption }, { quoted: mek });
  }

  const links = await getPixeldrainLinks(selected.movieUrl);
  if (!links.length) return danuwa.sendMessage(from, { text: "*❌ No links under 2GB!*" });

  pendingQuality[sender] = { movie: { metadata: meta, downloadLinks: links }, timestamp: Date.now() };

  const buttons = links.map((l, i) => ({
    id: `MOVIE_Q_${sender}_${i}`,
    text: `🎞️ ${l.quality} (${l.size})`
  }));

  await sendButtons(danuwa, from, {
    text: "📥 Select Movie Quality",
    footer: meta.title,
    buttons
  }, { quoted: mek });
});

/* ===== BUTTON QUALITY HANDLER ===== */

cmd({
  filter: (t, { sender }) =>
    pendingQuality[sender] &&
    t.startsWith(`MOVIE_Q_${sender}_`)
}, async (danuwa, mek, m, { body, sender, from, reply }) => {

  const index = Number(body.split("_").pop());
  const { movie } = pendingQuality[sender];
  delete pendingQuality[sender];

  const sel = movie.downloadLinks[index];
  reply(`*⬇️ Sending ${sel.quality} movie...*`);

  const direct = getDirectPixeldrainUrl(sel.link);

  await danuwa.sendMessage(from, {
    document: { url: direct },
    mimetype: "video/mp4",
    fileName: `${movie.metadata.title} - ${sel.quality}.mp4`
      .replace(/[^\w\s.-]/gi, ""),
    caption:
      `*🎬 ${movie.metadata.title}*\n` +
      `📊 ${sel.quality}\n` +
      `💾 ${sel.size}\n\nEnjoy 🍿`
  }, { quoted: mek });
});

/* ================= CLEANUP ================= */

setInterval(() => {
  const now = Date.now();
  const ttl = 10 * 60 * 1000;

  for (const u in pendingSearch)
    if (now - pendingSearch[u].timestamp > ttl) delete pendingSearch[u];

  for (const u in pendingQuality)
    if (now - pendingQuality[u].timestamp > ttl) delete pendingQuality[u];
}, 5 * 60 * 1000);

module.exports = { pendingSearch, pendingQuality };

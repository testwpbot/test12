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
  const m = url.match(/pixeldrain\.com\/u\/(\w+)/);
  return m ? `https://pixeldrain.com/api/file/${m[1]}?download` : null;
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
      return {
        id: i + 1,
        title: a?.title?.trim(),
        movieUrl: a?.href
      };
    }).filter(Boolean)
  );

  await browser.close();
  return results;
}

async function getMovieMetadata(url) {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const data = await page.evaluate(() => {
    const txt = s => document.querySelector(s)?.textContent.trim() || "";
    return {
      title: txt(".details-title h3"),
      language: txt(".info-col strong:contains('Language')") || "English",
      duration: txt("[itemprop='duration']"),
      imdb: txt(".data-imdb").replace("IMDb:", "").trim(),
      genres: [...document.querySelectorAll(".details-genre a")].map(a => a.textContent),
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
      pageLink: tr.querySelector(".link-opt a")?.href,
      quality: tr.querySelector(".quality")?.textContent,
      size: tr.querySelector("td:nth-child(3) span")?.textContent
    }))
  );

  const out = [];

  for (const r of rows) {
    try {
      const p = await browser.newPage();
      await p.goto(r.pageLink, { waitUntil: "networkidle2" });
      await new Promise(r => setTimeout(r, 12000));

      const final = await p.$eval(
        ".wait-done a[href^='https://pixeldrain.com/']",
        el => el.href
      ).catch(() => null);

      if (final) {
        let mb = r.size.includes("GB")
          ? parseFloat(r.size) * 1024
          : parseFloat(r.size);

        if (mb <= 2048) {
          out.push({
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
  return out;
}

/* ================= COMMAND ================= */

cmd({
  pattern: "movie",
  react: "🎬",
  category: "download",
  filename: __filename
}, async (danuwa, mek, m, { q, sender, from, reply }) => {

  if (!q) return reply("Usage: movie avengers");

  reply("🔍 Searching movies...");
  const results = await searchMovies(q);

  if (!results.length) return reply("❌ No movies found");

  pendingSearch[sender] = { results };

  let txt = "*🎬 Search Results*\n\n";
  results.forEach((r, i) => txt += `*${i + 1}.* ${r.title}\n`);
  txt += "\nReply with number";

  reply(txt);
});

/* ===== MOVIE NUMBER ===== */

cmd({
  filter: (t, { sender }) =>
    pendingSearch[sender] && !isNaN(t)
}, async (danuwa, mek, m, { body, sender, from }) => {

  const idx = Number(body) - 1;
  const sel = pendingSearch[sender].results[idx];
  delete pendingSearch[sender];

  const meta = await getMovieMetadata(sel.movieUrl);
  const links = await getPixeldrainLinks(sel.movieUrl);

  pendingQuality[sender] = { movie: { meta, links } };

  const buttons = links.map((l, i) => ({
    id: `MOVIE_Q_${sender}_${i}`,
    text: `${l.quality} (${l.size})`
  }));

  await sendButtons(danuwa, from, {
    text: "📥 Select Movie Quality",
    footer: meta.title,
    buttons
  }, { quoted: mek });
});

/* ===== BUTTON HANDLER (CORRECT FOR YOUR BOT) ===== */

cmd({
  filter: (_, ctx) =>
    ctx.message?.message?.interactiveResponseMessage
}, async (danuwa, mek, m, { sender, from, reply }) => {

  const native =
    mek.message.interactiveResponseMessage.nativeFlowResponseMessage;

  let parsed;
  try {
    parsed = JSON.parse(native.paramsJson);
  } catch {
    return;
  }

  const id = parsed.id;
  if (!id || !id.startsWith(`MOVIE_Q_${sender}_`)) return;

  const index = Number(id.split("_").pop());
  const data = pendingQuality[sender];
  if (!data) return reply("❌ Session expired");

  delete pendingQuality[sender];

  const sel = data.movie.links[index];
  reply(`⬇️ Sending ${sel.quality}...`);

  const direct = getDirectPixeldrainUrl(sel.link);

  await danuwa.sendMessage(from, {
    document: { url: direct },
    mimetype: "video/mp4",
    fileName: `${data.movie.meta.title} - ${sel.quality}.mp4`,
    caption: "Enjoy 🍿"
  }, { quoted: mek });
});

module.exports = {};

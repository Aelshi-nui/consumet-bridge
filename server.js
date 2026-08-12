
"use strict";

const { execSync } = require("node:child_process");
const express    = require("express");
const puppeteer  = require("puppeteer-extra");
const Stealth    = require("puppeteer-extra-plugin-stealth");
puppeteer.use(Stealth());

const app  = express();
const PORT = parseInt(process.env.PORT || "7860", 10);

function findChromium() {
  try {
    return execSync(
      `find /ms-playwright -path "*/chromium*" -name "chrome" 2>/dev/null | head -1`,
      { encoding: "utf8" }
    ).trim() || null;
  } catch { return null; }
}

const CHROMIUM = findChromium();
console.log("Chromium:", CHROMIUM || "NOT FOUND");

let _browser = null;

async function launch() {
  if (!_browser) {
    _browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: true,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
             "--disable-gpu","--single-process","--window-size=1280,800"],
    });
  }
  return _browser;
}

/**
 * Navigate a fresh page to `url`, intercept the matching JSON response,
 * return the parsed body. Timeout 40s.
 */
async function intercept(url) {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 800 });

  try {
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error("timeout 40s")), 40000);

        page.on("response", async (resp) => {
          if (resp.url() === url && resp.status() === 200) {
            try {
              const body = await resp.text();
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error("JSON parse: " + e.message));
            }
          }
        });

        page.goto(url, { waitUntil: "networkidle0", timeout: 38000 })
          .then(async () => {
            // If networkidle fired but we haven't resolved yet,
            // try reading the page body directly (plain JSON response page).
            const raw = await page.evaluate(() => document.body.innerText).catch(() => "");
            try { resolve(JSON.parse(raw)); } catch { /* already resolved or will timeout */ }
          })
          .catch(reject);
      }),
    ]);
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

const _c = new Map();
const cget = k => { const e = _c.get(k); if (!e || Date.now() > e.x) { _c.delete(k); return null; } return e.d; };
const cset = (k, d, ms) => _c.set(k, { d, x: Date.now() + ms });
const ok   = (res, d) => res.json(d);
const fail = (res, m, s = 500) => res.status(s).json({ message: String(m) });

const PAHE = "https://animepahe.ru";

app.get("/health", (_req, res) => res.json({ ok: true, chromium: !!CHROMIUM }));

app.get("/anime/:b/top-airing", async (_req, res) => {
  try {
    const d = await intercept(`${PAHE}/api?m=release&sort=date_last_added&page=1`);
    ok(res, { results: (d.data || []).slice(0,10).map(i => ({ id: i.anime_session, title: i.anime_title })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/anime/:b/info", async (req, res) => {
  const { id } = req.query; if (!id) return fail(res, "id required", 400);
  const ck = "inf:" + id; const c = cget(ck); if (c) return ok(res, c);
  try {
    let paheId = id;
    if (/^\d+$/.test(id)) {
      const r = await intercept(`${PAHE}/api?m=search&q=${encodeURIComponent(id)}`);
      if (!r.data || !r.data.length) return fail(res, "Not found", 404);
      paheId = r.data[0].session;
    }
    const eps = []; let pg = 1;
    while (true) {
      const d = await intercept(`${PAHE}/api?m=release&id=${paheId}&sort=episode_asc&page=${pg}`);
      if (!d.data || !d.data.length) break;
      for (const ep of d.data) eps.push({ id: `${paheId}/${ep.session}`, number: ep.episode, title: null, isFiller: false });
      if (!d.next_page_url || eps.length >= (d.total || 99999)) break;
      if (++pg > 50) break;
    }
    const result = { id: paheId, title: paheId, episodes: eps };
    cset(ck, result, 21600000); ok(res, result);
  } catch (e) { fail(res, e.message); }
});

app.get("/anime/:b/servers", (_req, res) => ok(res, { sub: [{ name: "kwik", url: "" }], dub: [], raw: [] }));

app.get("/anime/:b/watch", async (req, res) => {
  const { episodeId } = req.query; if (!episodeId) return fail(res, "episodeId required", 400);
  const ck = "w:" + episodeId; const c = cget(ck); if (c) return ok(res, c);
  try {
    const [paheId, epSession] = episodeId.split("/");
    const d = await intercept(`${PAHE}/api?m=links&id=${paheId}&session=${epSession}&p=kwik`);
    const sources = Object.entries(d.data || {})
      .map(([q, info]) => ({ url: info.kwik || "", quality: q, isM3U8: false }))
      .filter(s => s.url);
    if (!sources.length) return fail(res, "No sources", 404);
    cset(ck, { sources, subtitles: [] }, 180000); ok(res, { sources, subtitles: [] });
  } catch (e) { fail(res, e.message); }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Bridge :${PORT}`));

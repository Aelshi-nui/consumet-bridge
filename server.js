
"use strict";

const { execSync } = require("node:child_process");
const express = require("express");
const puppeteer = require("puppeteer-core");

const app = express();
const PORT = parseInt(process.env.PORT || "7860", 10);

// The Playwright Docker image installs Chromium at /ms-playwright
// Find the actual executable path
function findChromium() {
  const bases = [
    "/ms-playwright",
    process.env.PLAYWRIGHT_BROWSERS_PATH,
  ].filter(Boolean);

  for (const base of bases) {
    try {
      const result = execSync(`find "${base}" -name "chrome" -o -name "chromium" -o -name "headless_shell" -o -name "chrome-headless-shell" 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
      if (result) return result;
    } catch {}
  }

  // Fallback: system paths
  for (const p of ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
    try { execSync("test -f " + p); return p; } catch {}
  }
  return null;
}

const CHROMIUM = findChromium();
console.log("Chromium:", CHROMIUM || "NOT FOUND");

let browser = null;
let _page = null;

async function getBrowser() {
  if (!browser) {
    if (!CHROMIUM) throw new Error("No chromium executable found");
    browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: true,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process"],
    });
  }
  return browser;
}

async function getPage() {
  if (!_page || _page.isClosed()) {
    const b = await getBrowser();
    _page = await b.newPage();
    await _page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
    console.log("Navigating to animepahe.ru for CF clearance...");
    await _page.goto("https://animepahe.ru", { waitUntil: "networkidle0", timeout: 45000 });
    const title = await _page.title();
    console.log("animepahe title:", title);
    if (title.toLowerCase().includes("just a moment") || title === "...") {
      console.log("CF challenge detected, waiting...");
      await _page.waitForFunction(() => !document.title.toLowerCase().includes("just a moment") && document.title !== "...", { timeout: 30000 });
      console.log("CF cleared:", await _page.title());
    }
  }
  return _page;
}

const _c = new Map();
const cget = k => { const e = _c.get(k); if (!e || Date.now() > e.x) { _c.delete(k); return null; } return e.d; };
const cset = (k, d, ms) => _c.set(k, { d, x: Date.now() + ms });
const ok = (res, d) => res.json(d);
const fail = (res, m, s = 500) => res.status(s).json({ message: String(m) });

const PAHE = "https://animepahe.ru";

async function paheApi(path) {
  const pg = await getPage();
  const r = await pg.evaluate(async (url) => {
    const res = await fetch(url, { credentials: "include" });
    return { status: res.status, text: await res.text() };
  }, PAHE + path);
  if (r.status !== 200) throw new Error("animepahe " + r.status + ": " + r.text.slice(0, 100));
  try { return JSON.parse(r.text); }
  catch { throw new Error("animepahe returned non-JSON: " + r.text.slice(0, 100)); }
}

app.get("/health", (_req, res) => res.json({ ok: true, chromium: CHROMIUM }));

app.get("/anime/:b/top-airing", async (_req, res) => {
  try {
    const d = await paheApi("/api?m=release&sort=date_last_added&page=1");
    ok(res, { results: (d.data || []).slice(0,10).map(i => ({ id: i.anime_session, title: i.anime_title })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/anime/:b/info", async (req, res) => {
  const { id } = req.query; if (!id) return fail(res, "id required", 400);
  const ck = "inf:" + id; const cached = cget(ck); if (cached) return ok(res, cached);
  try {
    let paheId = id;
    if (/^\d+$/.test(id)) {
      const r = await paheApi("/api?m=search&q=" + encodeURIComponent(id));
      if (!r.data || !r.data.length) return fail(res, "Not found", 404);
      paheId = r.data[0].session;
    }
    const eps = []; let pg = 1;
    while (true) {
      const d = await paheApi("/api?m=release&id=" + paheId + "&sort=episode_asc&page=" + pg);
      if (!d.data || !d.data.length) break;
      for (const ep of d.data) eps.push({ id: paheId + "/" + ep.session, number: ep.episode, title: null, isFiller: false });
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
  const ck = "w:" + episodeId; const cached = cget(ck); if (cached) return ok(res, cached);
  try {
    const [paheId, epSession] = episodeId.split("/");
    const d = await paheApi("/api?m=links&id=" + paheId + "&session=" + epSession + "&p=kwik");
    const sources = Object.entries(d.data || {}).map(([q, info]) => ({ url: info.kwik || "", quality: q, isM3U8: false })).filter(s => s.url);
    if (!sources.length) return fail(res, "No sources", 404);
    const result = { sources, subtitles: [] };
    cset(ck, result, 180000); ok(res, result);
  } catch (e) { fail(res, e.message); }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log("Bridge :" + PORT);
  try { await getPage(); console.log("Ready."); }
  catch (e) { console.error("Prefetch failed:", e.message); }
});

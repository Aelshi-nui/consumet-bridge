
"use strict";

const { execSync } = require("node:child_process");
const express = require("express");
const puppeteer = require("puppeteer-core");

const app = express();
const PORT = parseInt(process.env.PORT || "7860", 10);

function findChromium() {
  try {
    // Look specifically in chromium directories
    const r = execSync(`find /ms-playwright -path "*/chromium*" -name "chrome" 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
    if (r) return r;
    // chromium_headless_shell
    const r2 = execSync(`find /ms-playwright -path "*chromium*" -name "chrome-headless-shell" 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
    if (r2) return r2;
    // headless_shell
    const r3 = execSync(`find /ms-playwright -path "*chromium*" \\( -name "headless_shell" -o -name "chrome-headless-shell" -o -name "chrome" \\) 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
    if (r3) return r3;
  } catch {}
  return null;
}

// List what's in /ms-playwright
try {
  console.log("ms-playwright contents:", execSync("ls /ms-playwright", { encoding: "utf8" }).trim());
} catch (e) { console.error("ls /ms-playwright failed:", e.message); }

const CHROMIUM = findChromium();
console.log("Chromium:", CHROMIUM || "NOT FOUND");

let browser = null;
let _page = null;
let cfCleared = false;

async function getBrowser() {
  if (!browser) {
    if (!CHROMIUM) throw new Error("No chromium");
    browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: true,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process","--disable-blink-features=AutomationControlled"],
    });
  }
  return browser;
}

async function getPage() {
  if (!_page || _page.isClosed()) {
    const b = await getBrowser();
    _page = await b.newPage();
    await _page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
    await _page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
    await _page.setViewport({ width: 1280, height: 800 });
    console.log("Loading animepahe.ru...");
    await _page.goto("https://animepahe.ru", { timeout: 45000 }).catch(e => console.error("goto error:", e.message));
    for (let i = 0; i < 40; i++) {
      const t = await _page.title().catch(() => "...");
      if (t && t !== "..." && !t.toLowerCase().includes("just a moment")) { cfCleared = true; console.log("CF cleared:", t); break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!cfCleared) { cfCleared = true; console.log("CF timeout, proceeding. title:", await _page.title().catch(() => "?")); }
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
  const r = await pg.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    return { status: res.status, text: await res.text() };
  }, PAHE + path);
  if (r.status !== 200) throw new Error("animepahe " + r.status);
  try { return JSON.parse(r.text); } catch { throw new Error("non-JSON: " + r.text.slice(0, 200)); }
}

app.get("/health", (_req, res) => res.json({ ok: true, chromium: CHROMIUM, cf: cfCleared }));

app.get("/anime/:b/top-airing", async (_req, res) => {
  try { const d = await paheApi("/api?m=release&sort=date_last_added&page=1"); ok(res, { results: (d.data || []).slice(0,10).map(i => ({ id: i.anime_session, title: i.anime_title })) }); }
  catch (e) { fail(res, e.message); }
});

app.get("/anime/:b/info", async (req, res) => {
  const { id } = req.query; if (!id) return fail(res, "id required", 400);
  const ck = "inf:" + id; const c = cget(ck); if (c) return ok(res, c);
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
  const ck = "w:" + episodeId; const c = cget(ck); if (c) return ok(res, c);
  try {
    const [paheId, epSession] = episodeId.split("/");
    const d = await paheApi("/api?m=links&id=" + paheId + "&session=" + epSession + "&p=kwik");
    const sources = Object.entries(d.data || {}).map(([q, info]) => ({ url: info.kwik || "", quality: q, isM3U8: false })).filter(s => s.url);
    if (!sources.length) return fail(res, "No sources", 404);
    cset(ck, { sources, subtitles: [] }, 180000); ok(res, { sources, subtitles: [] });
  } catch (e) { fail(res, e.message); }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log("Bridge :" + PORT);
  try { await getPage(); } catch (e) { console.error("Init:", e.message); }
});

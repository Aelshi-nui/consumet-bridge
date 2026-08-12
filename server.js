
"use strict";

const { execSync } = require("node:child_process");
const express = require("express");
const puppeteer = require("puppeteer-core");

const app = express();
const PORT = parseInt(process.env.PORT || "7860", 10);

function findChromium() {
  try {
    const r = execSync("find /ms-playwright -name 'chrome' -o -name 'chromium' -o -name 'headless_shell' -o -name 'chrome-headless-shell' 2>/dev/null | head -1", { encoding: "utf8" }).trim();
    if (r) return r;
  } catch {}
  return null;
}

const CHROMIUM = findChromium();
console.log("Chromium:", CHROMIUM || "NOT FOUND");

let browser = null;
let _page = null;
let cfCleared = false;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: true,
      args: [
        "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
        "--disable-gpu","--single-process",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,800",
      ],
    });
  }
  return browser;
}

async function getPage() {
  if (!_page || _page.isClosed()) {
    const b = await getBrowser();
    _page = await b.newPage();
    // Mask automation flags
    await _page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    await _page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
    await _page.setViewport({ width: 1280, height: 800 });
    console.log("Loading animepahe.ru...");
    try {
      await _page.goto("https://animepahe.ru", { timeout: 45000 });
      // Wait up to 35 seconds for CF to pass
      for (let i = 0; i < 35; i++) {
        const t = await _page.title().catch(() => "...");
        if (t && t !== "..." && !t.toLowerCase().includes("just a moment")) {
          cfCleared = true;
          console.log("CF cleared:", t);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!cfCleared) {
        // CF didn't clear but we try anyway — the cookie might be set even if title didn't update
        console.log("CF timeout, proceeding anyway. Title:", await _page.title().catch(() => "?"));
        cfCleared = true; // proceed anyway
      }
    } catch (e) {
      console.error("Init navigation error:", e.message);
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
  const url = PAHE + path;
  const r = await pg.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    return { status: res.status, text: await res.text() };
  }, url);
  if (r.status !== 200) throw new Error("animepahe " + r.status);
  try { return JSON.parse(r.text); }
  catch { throw new Error("non-JSON: " + r.text.slice(0, 200)); }
}

app.get("/health", (_req, res) => res.json({ ok: true, chromium: CHROMIUM, cf: cfCleared }));

app.get("/anime/:b/top-airing", async (_req, res) => {
  try {
    const d = await paheApi("/api?m=release&sort=date_last_added&page=1");
    ok(res, { results: (d.data || []).slice(0,10).map(i => ({ id: i.anime_session, title: i.anime_title })) });
  } catch (e) { fail(res, e.message); }
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
    cset(ck, { sources, subtitles: [] }, 180000);
    ok(res, { sources, subtitles: [] });
  } catch (e) { fail(res, e.message); }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log("Bridge :" + PORT);
  try { await getPage(); } catch (e) { console.error("Init failed:", e.message); }
});

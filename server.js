
import express from "express";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// /ms-playwright is where the Playwright Docker image keeps Chromium
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright";
chromium.use(StealthPlugin());

const app  = express();
const PORT = parseInt(process.env.PORT || "7860", 10);

let browser = null;
let context = null;

async function getContext() {
  if (!context) {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH
        ? undefined  // let playwright-extra resolve from PLAYWRIGHT_BROWSERS_PATH
        : undefined,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process"],
    });
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
  }
  return context;
}

const _c = new Map();
const cget = k => { const e = _c.get(k); if (!e || Date.now() > e.x) { _c.delete(k); return null; } return e.d; };
const cset = (k, d, ms) => _c.set(k, { d, x: Date.now() + ms });
const ok   = (res, d) => res.json(d);
const fail = (res, m, s = 500) => res.status(s).json({ message: String(m) });

const PAHE = "https://animepahe.ru";
const TIMEOUT = 40000;

async function fetchPageJson(url, matchPath) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), TIMEOUT);
        page.on("response", async resp => {
          if (resp.url().includes(matchPath) && resp.status() === 200) {
            try { const j = await resp.json(); clearTimeout(t); resolve(j); } catch {}
          }
        });
        page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT })
          .then(async () => {
            for (let i = 0; i < 25; i++) {
              const t2 = await page.title().catch(() => "...");
              if (t2 && t2 !== "..." && !t2.toLowerCase().includes("just a moment") && !t2.toLowerCase().includes("moment")) break;
              await page.waitForTimeout(1500);
            }
          })
          .catch(reject);
      }),
    ]);
  } finally { await page.close().catch(() => {}); }
}

async function paheSearch(query) {
  const ck = "ps:" + query; const hit = cget(ck); if (hit) return hit;
  const d = await fetchPageJson(`${PAHE}/api?m=search&q=${encodeURIComponent(query)}`, "?m=search");
  const r = (d?.data ?? []).map(i => ({ id: i.session, title: i.title }));
  cset(ck, r, 3600_000); return r;
}

async function paheEpisodes(paheId) {
  const ck = "pe:" + paheId; const hit = cget(ck); if (hit) return hit;
  const eps = []; let page = 1;
  while (true) {
    const d = await fetchPageJson(`${PAHE}/api?m=release&id=${paheId}&sort=episode_asc&page=${page}`, "?m=release");
    if (!d?.data?.length) break;
    for (const ep of d.data) eps.push({ id: `${paheId}/${ep.session}`, number: ep.episode });
    if (!d.next_page_url || eps.length >= (d.total ?? 99999)) break;
    if (++page > 50) break;
  }
  cset(ck, eps, 21600_000); return eps;
}

async function paheSources(episodeFullId) {
  const ck = "pw:" + episodeFullId; const hit = cget(ck); if (hit) return hit;
  const [paheId, epSession] = episodeFullId.split("/");
  if (!epSession) throw new Error("Invalid episode id");
  const ctx = await getContext();
  const page = await ctx.newPage();
  const m3u8Urls = new Set();
  try {
    page.on("response", resp => { const u = resp.url(); if (u.includes(".m3u8") && u.startsWith("https")) m3u8Urls.add(u); });
    await page.goto(`${PAHE}/play/${paheId}/${epSession}`, { waitUntil: "networkidle", timeout: TIMEOUT });
    for (let i = 0; i < 25; i++) {
      const t = await page.title().catch(() => "...");
      if (t && !t.toLowerCase().includes("just a moment") && !t.toLowerCase().includes("moment")) break;
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(5000);
  } finally { await page.close().catch(() => {}); }
  const sources = [...m3u8Urls].map(u => ({ url: u, quality: "auto", isM3U8: true }));
  if (!sources.length) throw new Error("No m3u8 intercepted");
  cset(ck, sources, 180_000); return sources;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

async function handleTopAiring(_req, res) {
  try { const r = await paheSearch("one piece"); ok(res, { results: r.slice(0,5) }); }
  catch (e) { fail(res, e.message); }
}
async function handleInfo(req, res) {
  const { id } = req.query; if (!id) return fail(res, "id required", 400);
  const ck = "inf:" + id; const cached = cget(ck); if (cached) return ok(res, cached);
  try {
    let paheId = id;
    if (/^\d+$/.test(id)) { const r = await paheSearch(id); if (!r.length) return fail(res, `Could not resolve ${id}`, 404); paheId = r[0].id; }
    const eps = await paheEpisodes(paheId);
    const result = { id: paheId, title: paheId, episodes: eps };
    cset(ck, result, 21600_000); ok(res, result);
  } catch (e) { fail(res, e.message); }
}
function handleServers(_req, res) { ok(res, { sub: [{ name: "kwik", url: "" }], dub: [], raw: [] }); }
async function handleWatch(req, res) {
  const { episodeId } = req.query; if (!episodeId) return fail(res, "episodeId required", 400);
  try { ok(res, { sources: await paheSources(episodeId), subtitles: [] }); }
  catch (e) { fail(res, e.message); }
}

for (const b of ["zoro", "gogoanime"]) {
  app.get(`/anime/${b}/top-airing`, handleTopAiring);
  app.get(`/anime/${b}/info`,       handleInfo);
  app.get(`/anime/${b}/servers`,    handleServers);
  app.get(`/anime/${b}/watch`,      handleWatch);
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Bridge :${PORT}  PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
  try { await getContext(); console.log("Browser ready."); }
  catch (e) { console.error("Browser failed:", e.message); }
});

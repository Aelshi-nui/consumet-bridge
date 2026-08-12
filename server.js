/**
 * Animora Consumet Bridge — Playwright stealth scraper
 *
 * Uses a persistent stealth Chromium context to bypass Cloudflare JS challenges
 * on AnimePahe (for gogoanime backend) and HiAnime (for zoro backend).
 * One browser, one context, shared across all requests.
 *
 * Endpoints consumed by ConsumetProvider:
 *   GET /anime/zoro/info?id=<anilistId>
 *   GET /anime/zoro/servers?episodeId=<id>
 *   GET /anime/zoro/watch?episodeId=<id>&server=<name>
 *   GET /anime/zoro/top-airing
 *   GET /anime/gogoanime/* (same, hits AnimePahe)
 */

import express from "express";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const app  = express();
const PORT = parseInt(process.env.PORT || "7860", 10);

// ─── browser singleton ───────────────────────────────────────────────────────
let browser = null;
let context = null;

async function getContext() {
  if (!context) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
  }
  return context;
}

// ─── tiny in-process cache ───────────────────────────────────────────────────
const _c = new Map();
const cget = k => { const e = _c.get(k); if (!e || Date.now() > e.x) { _c.delete(k); return null; } return e.d; };
const cset = (k, d, ms) => _c.set(k, { d, x: Date.now() + ms });

const ok   = (res, d) => res.json(d);
const fail = (res, m, s = 500) => res.status(s).json({ message: String(m) });

/**
 * Fetch a URL through the stealth browser context and intercept the JSON
 * response for the given API path pattern. Returns parsed JSON.
 * Falls back to evaluating the page for a direct JSON body if the intercept
 * misses.
 */
async function fetchJson(url, interceptPattern) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    // Intercept the matching API call
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 18000);
      page.on("response", async resp => {
        if (resp.url().includes(interceptPattern) && resp.status() === 200) {
          try {
            const j = await resp.json();
            clearTimeout(timer);
            resolve(j);
          } catch { /* not JSON, keep waiting */ }
        }
      });
      setTimeout(() => { /* also resolve on page load if already JSON */ }, 500);
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });

    // Check if the page itself is raw JSON (direct API URL)
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    try {
      const direct = JSON.parse(bodyText);
      return direct;
    } catch { /* not direct JSON */ }

    return await responsePromise;
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── AnimePahe helpers ───────────────────────────────────────────────────────

const PAHE = "https://animepahe.ru";

async function paheSearch(query) {
  const ck = `ps:${query}`;
  const hit = cget(ck);
  if (hit) return hit;
  const data = await fetchJson(`${PAHE}/api?m=search&q=${encodeURIComponent(query)}`, "?m=search");
  const results = (data?.data ?? []).map(item => ({ id: item.session, title: item.title }));
  cset(ck, results, 3600_000);
  return results;
}

async function paheInfo(paheId) {
  const ck = `pi:${paheId}`;
  const hit = cget(ck);
  if (hit) return hit;

  // Fetch episode list — paginated, get all pages
  const episodes = [];
  let page = 1;
  let total = null;
  while (true) {
    const data = await fetchJson(
      `${PAHE}/api?m=release&id=${paheId}&sort=episode_asc&page=${page}`,
      "?m=release"
    );
    if (!data?.data?.length) break;
    for (const ep of data.data) {
      episodes.push({ id: `${paheId}/${ep.session}`, number: ep.episode });
    }
    total = data.total ?? episodes.length;
    if (data.next_page_url === null || episodes.length >= total) break;
    page++;
    if (page > 50) break; // safety cap
  }

  // Get title from anime page
  const ctx = await getContext();
  const pg = await ctx.newPage();
  let title = paheId;
  try {
    await pg.goto(`${PAHE}/anime/${paheId}`, { waitUntil: "domcontentloaded", timeout: 15000 });
    title = await pg.evaluate(() => {
      const el = document.querySelector("div.title-wrapper h1 span") ||
                 document.querySelector("h1.title") ||
                 document.querySelector("title");
      return el?.textContent?.trim() || document.title;
    });
  } catch { /* use paheId as title */ }
  await pg.close().catch(() => {});

  const result = { id: paheId, title, episodes };
  cset(ck, result, 21600_000);
  return result;
}

async function paheSources(episodeFullId) {
  const ck = `pw:${episodeFullId}`;
  const hit = cget(ck);
  if (hit) return hit;

  // episodeFullId = "<paheId>/<epSession>"
  const [paheId, epSession] = episodeFullId.split("/");
  if (!epSession) throw new Error("Invalid episode id format");

  // Get the embed page for the episode
  const embedUrl = `${PAHE}/play/${paheId}/${epSession}`;
  const ctx = await getContext();
  const page = await ctx.newPage();
  const sources = [];

  try {
    // Intercept kwik.si embed responses for the m3u8
    const m3u8Urls = new Set();
    page.on("response", async resp => {
      const url = resp.url();
      if (url.includes(".m3u8") && url.startsWith("https")) {
        m3u8Urls.add(url);
      }
    });

    await page.goto(embedUrl, { waitUntil: "networkidle", timeout: 20000 });

    // Click the first available quality button to trigger the player
    await page.click("button.play-button, a.play-now, #play, .player-container", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(3000);

    for (const url of m3u8Urls) {
      sources.push({ url, quality: "auto", isM3U8: true });
    }
  } finally {
    await page.close().catch(() => {});
  }

  if (!sources.length) throw new Error("No m3u8 sources intercepted");
  cset(ck, sources, 180_000);
  return sources;
}

// ─── routes (shared for zoro and gogoanime) ──────────────────────────────────

async function handleTopAiring(_req, res) {
  try {
    const results = await paheSearch("one piece");
    ok(res, { results: results.slice(0, 5) });
  } catch (e) { fail(res, e.message); }
}

async function handleInfo(req, res) {
  const { id } = req.query;
  if (!id) return fail(res, "id required", 400);

  const ck = `inf:${id}`;
  const cached = cget(ck);
  if (cached) return ok(res, cached);

  try {
    let paheId = id;
    if (/^\d+$/.test(id)) {
      // AniList numeric id — search AnimePahe by id string
      const results = await paheSearch(id);
      if (!results.length) return fail(res, `Could not resolve AniList id ${id}`, 404);
      paheId = results[0].id;
    }
    const info = await paheInfo(paheId);
    const result = {
      id: paheId,
      title: info.title,
      episodes: info.episodes,
    };
    cset(ck, result, 21600_000);
    ok(res, result);
  } catch (e) { fail(res, e.message); }
}

function handleServers(_req, res) {
  ok(res, { sub: [{ name: "kwik", url: "" }], dub: [], raw: [] });
}

async function handleWatch(req, res) {
  const { episodeId } = req.query;
  if (!episodeId) return fail(res, "episodeId required", 400);
  try {
    const sources = await paheSources(episodeId);
    ok(res, { sources, subtitles: [] });
  } catch (e) { fail(res, e.message); }
}

for (const backend of ["zoro", "gogoanime"]) {
  app.get(`/anime/${backend}/top-airing`, handleTopAiring);
  app.get(`/anime/${backend}/info`,       handleInfo);
  app.get(`/anime/${backend}/servers`,    handleServers);
  app.get(`/anime/${backend}/watch`,      handleWatch);
}

// ─── start ───────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Consumet bridge :${PORT}  backend=AnimePahe (stealth Playwright)`);
  // Warm up the browser context on startup
  try {
    await getContext();
    console.log("Browser context ready.");
  } catch (e) {
    console.error("Browser warm-up failed:", e.message);
  }
});

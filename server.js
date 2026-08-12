
"use strict";

const fs   = require("node:fs");
const path = require("node:path");

const paheJs = path.join(__dirname, "node_modules/@consumet/extensions/dist/providers/anime/animepahe.js");
try {
  const src = fs.readFileSync(paheJs, "utf8");
  const patched = src
    .replaceAll("animepahe.si", "animepahe.ru")
    .replaceAll("animepahe.me", "animepahe.ru")
    .replaceAll("https://animepahe.com", "https://animepahe.ru");
  fs.writeFileSync(paheJs, patched);
  console.log("Patched OK");
} catch (e) { console.error("Patch failed:", e.message); }

const express   = require("express");
const { ANIME } = require("@consumet/extensions");

const app  = express();
const PORT = parseInt(process.env.PORT || "7860", 10);
const pahe = new ANIME.AnimePahe();

const _c = new Map();
const cget = k => { const e = _c.get(k); if (!e || Date.now() > e.x) { _c.delete(k); return null; } return e.d; };
const cset = (k, d, ms) => _c.set(k, { d, x: Date.now() + ms });
const ok   = (res, d) => res.json(d);
const fail = (res, m, s = 500) => res.status(s).json({ message: String(m) });

// Debug: use fetch to follow redirects and see final response
app.get("/debug", async (_req, res) => {
  try {
    const r = await fetch("https://animepahe.ru/api?m=search&q=naruto", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0", "Referer": "https://animepahe.ru" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    res.json({ status: r.status, ok: r.ok, url: r.url, body: text.slice(0, 400) });
  } catch(e) { res.json({ error: e.message }); }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

async function resolvePaheId(rawId) {
  const ck = "pid:" + rawId; const hit = cget(ck); if (hit) return hit;
  const r = await pahe.search(rawId, 1);
  const id = r && r.results && r.results[0] ? r.results[0].id : null;
  if (id) cset(ck, id, 86400000);
  return id;
}

async function handleTopAiring(_req, res) {
  try {
    const d = await pahe.fetchRecentEpisodes(1);
    ok(res, { results: ((d && d.results) || []).slice(0,10).map(a => ({ id: a.id, title: String(a.title) })) });
  } catch (e) { fail(res, e.message); }
}

async function handleInfo(req, res) {
  const { id } = req.query; if (!id) return fail(res, "id required", 400);
  const ck = "inf:" + id; const cached = cget(ck); if (cached) return ok(res, cached);
  try {
    let paheId = /^\d+$/.test(id) ? await resolvePaheId(id) : id;
    if (!paheId) return fail(res, "Could not resolve " + id, 404);
    const info = await pahe.fetchAnimeInfo(paheId);
    if (!info) return fail(res, "Not found", 404);
    const title = typeof info.title === "string" ? info.title : ((info.title && info.title.english) || String(info.title));
    const result = { id: paheId, title, episodes: (info.episodes || []).map(ep => ({ id: ep.id, number: ep.number, title: null, isFiller: false })) };
    cset(ck, result, 21600000); ok(res, result);
  } catch (e) { fail(res, e.message); }
}

function handleServers(_req, res) { ok(res, { sub: [{ name: "kwik", url: "" }], dub: [], raw: [] }); }

async function handleWatch(req, res) {
  const { episodeId } = req.query; if (!episodeId) return fail(res, "episodeId required", 400);
  const ck = "w:" + episodeId; const cached = cget(ck); if (cached) return ok(res, cached);
  try {
    const data = await pahe.fetchEpisodeSources(episodeId);
    if (!data || !data.sources || !data.sources.length) return fail(res, "No sources", 404);
    const result = { sources: data.sources.map(s => ({ url: s.url, quality: s.quality || "default", isM3U8: s.isM3U8 !== undefined ? s.isM3U8 : Boolean(s.url && s.url.includes(".m3u8")) })), subtitles: [] };
    cset(ck, result, 180000); ok(res, result);
  } catch (e) { fail(res, e.message); }
}

["zoro", "gogoanime"].forEach(b => {
  app.get("/anime/" + b + "/top-airing", handleTopAiring);
  app.get("/anime/" + b + "/info",       handleInfo);
  app.get("/anime/" + b + "/servers",    handleServers);
  app.get("/anime/" + b + "/watch",      handleWatch);
});

app.listen(PORT, "0.0.0.0", () => console.log("Consumet bridge :" + PORT));

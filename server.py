
"""
Animora Consumet Bridge — Python + curl_cffi
Impersonates Chrome TLS fingerprint to bypass Cloudflare IUAM on animepahe.su.
"""
import os, json, time
from flask import Flask, request, jsonify
from curl_cffi import requests as cffi_requests

app = Flask(__name__)
PORT = int(os.environ.get("PORT", 7860))
PAHE = "https://animepahe.su"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Referer": PAHE + "/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

# In-memory cache
_cache = {}
def cget(k):
    e = _cache.get(k)
    if not e: return None
    if time.time() > e["x"]: del _cache[k]; return None
    return e["d"]
def cset(k, d, ttl):
    _cache[k] = {"d": d, "x": time.time() + ttl}

def pahe_get(path):
    """GET with Chrome TLS impersonation to bypass Cloudflare."""
    r = cffi_requests.get(PAHE + path, headers=HEADERS, impersonate="chrome124", timeout=15)
    r.raise_for_status()
    return r.json()

def resolve_pahe_id(raw_id):
    ck = "pid:" + raw_id
    hit = cget(ck)
    if hit: return hit
    data = pahe_get(f"/api?m=search&q={raw_id}")
    results = data.get("data", [])
    if not results: return None
    pid = results[0]["session"]
    cset(ck, pid, 86400)
    return pid

@app.get("/health")
def health():
    return jsonify({"ok": True})

@app.get("/debug")
def debug():
    try:
        r = cffi_requests.get(f"{PAHE}/api?m=search&q=naruto", headers=HEADERS, impersonate="chrome124", timeout=10)
        return jsonify({"status": r.status_code, "ok": r.ok, "body": r.text[:400]})
    except Exception as e:
        return jsonify({"error": str(e)})

@app.get("/anime/<backend>/top-airing")
def top_airing(backend):
    try:
        data = pahe_get("/api?m=release&sort=date_last_added&page=1")
        results = [{"id": i.get("anime_session",""), "title": i.get("anime_title","")} for i in data.get("data", [])]
        return jsonify({"results": results[:10]})
    except Exception as e:
        return jsonify({"message": str(e)}), 500

@app.get("/anime/<backend>/info")
def info(backend):
    aid = request.args.get("id","")
    if not aid: return jsonify({"message": "id required"}), 400
    ck = "inf:" + aid
    cached = cget(ck)
    if cached: return jsonify(cached)
    try:
        pahe_id = resolve_pahe_id(aid) if aid.isdigit() else aid
        if not pahe_id:
            return jsonify({"message": f"Could not resolve {aid}"}), 404
        # Fetch episode list
        episodes = []
        page = 1
        while True:
            data = pahe_get(f"/api?m=release&id={pahe_id}&sort=episode_asc&page={page}")
            batch = data.get("data", [])
            if not batch: break
            for ep in batch:
                episodes.append({
                    "id": f"{pahe_id}/{ep['session']}",
                    "number": ep["episode"],
                    "title": None,
                    "isFiller": False,
                })
            if not data.get("next_page_url") or len(episodes) >= (data.get("total") or 99999): break
            page += 1
            if page > 50: break
        result = {"id": pahe_id, "title": pahe_id, "episodes": episodes}
        cset(ck, result, 21600)
        return jsonify(result)
    except Exception as e:
        return jsonify({"message": str(e)}), 500

@app.get("/anime/<backend>/servers")
def servers(backend):
    return jsonify({"sub": [{"name": "kwik", "url": ""}], "dub": [], "raw": []})

@app.get("/anime/<backend>/watch")
def watch(backend):
    episode_id = request.args.get("episodeId","")
    if not episode_id: return jsonify({"message": "episodeId required"}), 400
    ck = "w:" + episode_id
    cached = cget(ck)
    if cached: return jsonify(cached)
    try:
        # episodeId = "<paheId>/<epSession>"
        parts = episode_id.split("/", 1)
        if len(parts) < 2: return jsonify({"message": "Invalid episodeId"}), 400
        pahe_id, ep_session = parts
        # Get embed page for episode sources
        data = pahe_get(f"/api?m=links&id={pahe_id}&session={ep_session}&p=kwik")
        links = data.get("data", {})
        sources = []
        for quality, info in links.items():
            kwik_url = info.get("kwik","") if isinstance(info, dict) else ""
            if kwik_url:
                sources.append({"url": kwik_url, "quality": quality, "isM3U8": False})
        if not sources:
            return jsonify({"message": "No sources found"}), 404
        result = {"sources": sources, "subtitles": []}
        cset(ck, result, 180)
        return jsonify(result)
    except Exception as e:
        return jsonify({"message": str(e)}), 500

if __name__ == "__main__":
    print(f"Consumet bridge :{PORT} Python curl_cffi")
    app.run(host="0.0.0.0", port=PORT)


import express from "express";
const app = express();
const PORT = parseInt(process.env.PORT || "7860", 10);

// Probe raw reachability of streaming sites from Railway IP
app.get("/probe", async (_req, res) => {
  const results = {};
  for (const site of ["https://animepahe.ru", "https://hianime.to", "https://gogoanime3.co"]) {
    try {
      const r = await fetch(site, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0" },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      });
      results[site] = { status: r.status, ok: r.ok };
    } catch (e) {
      results[site] = { error: e.message };
    }
  }
  res.json(results);
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => console.log(`Probe :${PORT}`));

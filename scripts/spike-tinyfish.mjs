// TinyFish Search + Fetch spike (plan §0, grounded-search.md "Risks").
//
// Confirms the exact endpoint paths (docs index says the hosts' ROOT is the
// endpoint; this probe tries both) and response shapes with a real key, so
// src/lib/ai/tinyfish.ts constants ship correct defaults.
//
// Usage: TINYFISH_API_KEY=... node scripts/spike-tinyfish.mjs
// Both APIs are free (docs.tinyfish.ai, 2026-09): Search 30 req/min,
// Fetch 150 URLs/min.

const KEY = process.env.TINYFISH_API_KEY;
if (!KEY) {
  console.error("Set TINYFISH_API_KEY to run this spike.");
  process.exit(1);
}

const HOSTS = ["https://api.search.tinyfish.ai", "https://api.search.tinyfish.ai/search"];

async function trySearch() {
  for (const url of HOSTS) {
    const target = `${url}?query=${encodeURIComponent("photosynthesis basics")}&language=en`;
    try {
      const res = await fetch(target, {
        headers: { "X-API-Key": KEY, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      console.log(`[search] ${target} → ${res.status}`);
      if (res.ok) {
        const json = JSON.parse(text);
        console.log("  top-level keys:", Object.keys(json));
        const r0 = json.results?.[0];
        console.log("  first result keys:", r0 ? Object.keys(r0) : "(none)");
        console.log("  total_results:", json.total_results);
        console.log("  sample:", JSON.stringify(r0)?.slice(0, 300));
        return url;
      }
      console.log("  body:", text.slice(0, 300));
    } catch (err) {
      console.log(`[search] ${target} → ERROR ${(err?.message ?? "").slice(0, 200)}`);
    }
  }
  return null;
}

async function tryFetch(searchBase) {
  const res = await fetch("https://api.fetch.tinyfish.ai", {
    method: "POST",
    headers: {
      "X-API-Key": KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      urls: ["https://en.wikipedia.org/wiki/Photosynthesis"],
      format: "markdown",
      links: false,
      image_links: false,
      per_url_timeout_ms: 45_000,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  console.log(`[fetch] → ${res.status}`);
  if (res.ok) {
    const json = JSON.parse(text);
    console.log("  top-level keys:", Object.keys(json));
    const r0 = json.results?.[0];
    console.log("  first result keys:", r0 ? Object.keys(r0) : "(none)");
    console.log("  text length:", r0?.text?.length);
    console.log("  errors:", JSON.stringify(json.errors)?.slice(0, 300));
  } else {
    console.log("  body:", text.slice(0, 300));
  }
  void searchBase;
}

const searchBase = await trySearch();
if (searchBase) {
  await tryFetch(searchBase);
} else {
  console.log("[fetch] skipped — search base never succeeded");
}

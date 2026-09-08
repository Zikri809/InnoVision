// Phase 0 spike (docs/plans/agentic-generation.md) — probe the Kenari proxy
// for the capabilities the streaming phases depend on. Never prints the key.
// Usage: node scripts/spike-kenari.mjs [model]
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const BASE = (env.AI_BASE_URL ?? "").replace(/\/$/, "");
const KEY = env.AI_API_KEY ?? "";
if (!BASE || !KEY) {
  console.error("AI_BASE_URL / AI_API_KEY missing in .env.local");
  process.exit(1);
}
const MODEL = process.argv[2] ?? env.AI_MODEL ?? "gpt-4o-mini";
const log = (...a) => console.log(...a);

async function post(body, { timeoutMs = 90_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

// 0) Model catalog — does the requested model (and GLM variants) exist?
try {
  const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  const ids = (j.data ?? []).map((m) => m.id ?? m);
  log("== /models ==", r.status);
  log(ids.join(", "));
} catch (e) {
  log("== /models == FAILED:", e.message);
}

// K1 — streaming: reasoning_content passthrough + cadence
{
  log(`\n== K1 stream:true model=${MODEL} ==`);
  const r = await post({ model: MODEL, stream: true, messages: [{ role: "user", content: "What is 17*23? Reply with the number only." }] });
  log("status:", r.status, r.headers.get("content-type"));
  if (!r.ok) { log(await r.text()); process.exit(0); }
  let sawReasoning = 0, sawContent = 0, chunks = 0, finish = null, buf = "";
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const t0 = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta ?? {};
        if (d.reasoning_content) sawReasoning += 1;
        if (d.reasoning) sawReasoning += 1;
        if (d.content) sawContent += 1;
        if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      } catch { /* keep-alive lines etc. */ }
    }
  }
  log(`chunks=${chunks} reasoning_deltas=${sawReasoning} content_deltas=${sawContent} finish=${finish} elapsed=${Date.now() - t0}ms`);
}

// K2 — effort/thinking parameter acceptance (survives the proxy without 400?)
for (const [name, extra] of [
  ["reasoning_effort", { reasoning_effort: "high" }],
  ["thinking.enabled", { thinking: { type: "enabled" } }],
]) {
  try {
    const r = await post({ model: MODEL, stream: false, max_tokens: 32, messages: [{ role: "user", content: "Say OK." }], ...extra }, { timeoutMs: 45_000 });
    const txt = r.ok ? "accepted" : (await r.text()).slice(0, 200);
    log(`K2 ${name}: HTTP ${r.status} → ${txt}`);
  } catch (e) {
    log(`K2 ${name}: FAILED ${e.message}`);
  }
}

// K3 — tools + json_object + stream coexistence
{
  log(`\n== K3 tools+json+stream model=${MODEL} ==`);
  const r = await post({
    model: MODEL,
    stream: true,
    response_format: { type: "json_object" },
    tools: [{
      type: "function",
      function: {
        name: "calc",
        description: "Evaluate a math expression.",
        parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
      },
    }],
    messages: [
      { role: "system", content: 'Return JSON: {"result": <number>}. Use the calc tool for arithmetic.' },
      { role: "user", content: "What is 2^10 + sqrt(144)? Return JSON {\"result\": n}." },
    ],
  });
  log("status:", r.status);
  if (!r.ok) { log((await r.text()).slice(0, 400)); }
  else {
    const text = await r.text();
    const sawTool = text.includes("tool_calls");
    const sawJson = text.includes('"result"') || text.includes("4096");
    log(`SSE bytes=${text.length} tool_call_deltas=${sawTool} json_content=${sawJson}`);
    log("sample:", text.slice(0, 600).replace(/\n/g, " ⏎ "));
  }
}

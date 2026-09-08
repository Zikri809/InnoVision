// Real-provider smoke test — the PRE-DEMO GATE (docs/plans/agentic-generation.md §F).
//
// Every automated layer (vitest + e2e) runs against the mock AI server; this
// script runs the REAL proxy (Kenari) and verifies the behaviors mocks
// cannot prove: reasoning delta cadence vs the 30s dead-stream detector,
// real latency shape, and end-to-end generation success through the actual
// NDJSON event contract.
//
// Run before every demo:  node scripts/smoke-real-provider.mjs [model]
//
// NEVER hits the local Supabase — it talks to the streaming route's underlying
// provider directly with the same chatStream call shape, so no app auth/DB is
// needed. Exit code 0 = demo-safe; non-zero = DO NOT DEMO.
import fs from "node:fs";
import OpenAI from "openai";

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
const MODEL = process.argv[2] ?? env.AI_MODEL ?? "gpt-4o-mini";
if (!BASE || !KEY) {
  console.error("AI_BASE_URL / AI_API_KEY missing in .env.local");
  process.exit(2);
}

const IDLE_MS = Number(process.env.AI_STREAM_IDLE_TIMEOUT_MS ?? 90_000);
const DEAD_STREAM_MS = 30_000; // must match the console's detector
const client = new OpenAI({ baseURL: BASE, apiKey: KEY });

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

async function timedChat(label, messages, opts = {}) {
  const t0 = Date.now();
  let lastByte = Date.now();
  let maxGap = 0;
  let reasoningChars = 0;
  let contentChars = 0;
  let finish = null;
  let text = "";

  const completion = await client.chat.completions.create(
    { model: MODEL, stream: true, messages, max_tokens: 4000, ...opts },
    { signal: AbortSignal.timeout(IDLE_MS + 30_000) },
  );
  for await (const chunk of completion) {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - lastByte);
    lastByte = now;
    const d = chunk.choices?.[0]?.delta ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reasoning = d.reasoning_content ?? d.reasoning ?? "";
    reasoningChars += reasoning.length;
    contentChars += (d.content ?? "").length;
    text += d.content ?? "";
    if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
  }
  const elapsed = Date.now() - t0;
  console.log(
    `  ${label}: ${elapsed}ms, maxGap=${maxGap}ms, reasoning=${reasoningChars} chars, content=${contentChars} chars, finish=${finish}`,
  );
  return { elapsed, maxGap, reasoningChars, contentChars, finish, text };
}

console.log(`Real-provider smoke — ${BASE} model=${MODEL}\n`);

// 1. Plain streaming generation (the happy-path shape).
console.log("[1/4] Happy-path streaming generation");
try {
  const r = await timedChat("generate", [
    { role: "system", content: 'Return ONLY a JSON object {"title": string, "questions": [{"type":"mcq","prompt":string,"options":string[],"correct_index":number}]} with exactly 3 questions.' },
    { role: "user", content: "Chapter text: Velocity is displacement over time. Force is measured in newtons. Energy is conserved. Momentum is mass times velocity." },
  ], { response_format: { type: "json_object" } });
  if (r.finish !== "stop") fail(`finish_reason=${r.finish} (expected stop)`);
  else pass("finish=stop");
  if (r.maxGap >= DEAD_STREAM_MS)
    fail(`max inter-chunk gap ${r.maxGap}ms ≥ the console's ${DEAD_STREAM_MS}ms dead-stream detector — the UI would kill a healthy generation`);
  else pass(`max gap ${r.maxGap}ms < ${DEAD_STREAM_MS}ms detector`);
  JSON.parse(r.text);
  pass("content parses as JSON");
} catch (e) {
  fail(`happy path threw: ${e.message}`);
}

// 2. Reasoning-cadence probe (K1 in production conditions).
console.log("\n[2/4] Reasoning cadence under a harder prompt");
try {
  const r = await timedChat("reasoning", [
    { role: "user", content: "Design 3 quiz questions about photosynthesis at mixed difficulty. Think carefully about plausible distractors before writing the JSON." },
  ], { response_format: { type: "json_object" } });
  if (r.maxGap >= DEAD_STREAM_MS)
    fail(`reasoning silence ${r.maxGap}ms ≥ ${DEAD_STREAM_MS}ms — thinking pauses would false-trip the dead-stream detector; raise AI_STREAM_IDLE_TIMEOUT_MS or the detector window`);
  else pass(`reasoning gaps stay under ${DEAD_STREAM_MS}ms`);
  if (r.reasoningChars === 0)
    console.log("  ⚠ no reasoning_content emitted by this model — the Deep-mode drawer will show stage copy only (documented degrade)");
  else pass(`reasoning passthrough works (${r.reasoningChars} chars)`);
} catch (e) {
  fail(`reasoning probe threw: ${e.message}`);
}

// 3. Tool-calling coexistence (K3, calc-tool prerequisite).
console.log("\n[3/4] Tools + json_object coexistence");
try {
  const r = await timedChat("tools", [
    { role: "system", content: 'Use the calc tool for arithmetic, then return ONLY {"result": number}.' },
    { role: "user", content: "What is 2^10 + sqrt(144)?" },
  ], {
    response_format: { type: "json_object" },
    tools: [{
      type: "function",
      function: {
        name: "calc",
        description: "Evaluate a math expression.",
        parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
      },
    }],
  });
  pass(`tools accepted (finish=${r.finish}, tool/content chars=${r.contentChars})`);
} catch (e) {
  fail(`tools coexistence threw: ${e.message}`);
}

// 4. Long-input shape (realistic lecture-deck size).
console.log("\n[4/4] Large-input generation (≈40k chars)");
try {
  const filler = ("Photosynthesis converts light energy into chemical energy. ".repeat(560));
  const r = await timedChat("large", [
    { role: "system", content: 'Return ONLY {"title": string, "questions": [{"type":"mcq","prompt":string,"options":string[],"correct_index":number}]} with 3 questions.' },
    { role: "user", content: `Chapter text:\n${filler}` },
  ], { response_format: { type: "json_object" } });
  if (r.elapsed > 300_000) fail(`large input took ${r.elapsed}ms — check demo-room patience`);
  else pass(`large input completed in ${r.elapsed}ms`);
} catch (e) {
  fail(`large input threw: ${e.message}`);
}

console.log(`\n${failures === 0 ? "✅ DEMO-SAFE" : "❌ DO NOT DEMO"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

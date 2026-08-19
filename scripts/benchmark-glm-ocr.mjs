// Benchmark GLM-OCR (Docker/vLLM) — measures real per-page OCR latency the same
// way the app drives it (page image → /v1/chat/completions).
//
// Usage:
//   node scripts/benchmark-glm-ocr.mjs [--reps N] [--url URL] [--model MODEL]
//
// Defaults: 1 warm-up + 3 timed reps of the committed scanned-chapter.png
// fixture (the app's E2E scanned image). No extra deps (no canvas needed).

import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const BASE_URL = process.env.GLM_BASE_URL ?? "http://localhost:11434";
const MODEL = process.env.OCR_GLM_MODEL ?? "glm-ocr";
const FIXTURE = "e2e/fixtures/scanned-chapter.png";

const SYSTEM_PROMPT =
  "You are an OCR engine. Transcribe ALL visible text from this page image " +
  "faithfully, preserving structure (headings, bullets, tables as text). " +
  "Output ONLY the transcribed text, no commentary.";

function parseArgs(argv) {
  const args = { reps: 3, url: BASE_URL, model: MODEL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reps") args.reps = Number(argv[i + 1]);
    if (argv[i] === "--url") args.url = argv[i + 1];
    if (argv[i] === "--model") args.model = argv[i + 1];
  }
  return args;
}

function gpuInfo() {
  try {
    return execFileSync("nvidia-smi", [
      "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits",
    ]).toString().trim();
  } catch {
    return null;
  }
}

function latencyOf(ms) {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = `${args.url.replace(/\/$/, "")}/v1/chat/completions`;

  console.log(`GLM-OCR benchmark`);
  console.log(`  endpoint : ${endpoint}`);
  console.log(`  model    : ${args.model}`);
  console.log(`  fixture  : ${FIXTURE}`);
  console.log(`  reps     : ${args.reps} (after 1 warm-up)`);
  console.log("");

  const fixtureB64 = (await readFile(FIXTURE)).toString("base64");
  const imageUrl = `data:image/png;base64,${fixtureB64}`;

  const gpuBefore = gpuInfo();
  if (gpuBefore) console.log(`GPU before: ${gpuBefore}`);
  else console.log("GPU: nvidia-smi not available (CPU path?)");
  console.log("");

  const body = {
    model: args.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this page:" },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 2000,
    temperature: 0,
  };

  // Warm-up — loads weights / CUDA kernels, allocates KV cache, compiles paths.
  console.log("  warm-up…");
  const warmT = Date.now();
  const warmRes = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!warmRes.ok) throw new Error(`warm-up failed: HTTP ${warmRes.status}`);
  const warmData = await warmRes.json();
  console.log(
    `  warm-up done in ${latencyOf(Date.now() - warmT)} ` +
    `(${(warmData.usage?.completion_tokens ?? 0)} out tok)`,
  );
  console.log("");

  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < args.reps; i++) {
    const t1 = Date.now();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - t1;

    if (!res.ok) {
      rows.push({ rep: i + 1, ok: false, status: res.status, ms: elapsed });
      console.log(`  rep ${i + 1}: HTTP ${res.status} in ${latencyOf(elapsed)}`);
      continue;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage ?? {};
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    rows.push({
      rep: i + 1, ok: true, ms: elapsed, chars: text.length,
      promptTokens, completionTokens,
    });
    console.log(
      `  rep ${i + 1}: ${latencyOf(elapsed)} | ${text.length} chars | ` +
      `${promptTokens} in + ${completionTokens} out | ` +
      `${(completionTokens / (elapsed / 1000)).toFixed(1)} tok/s | ` +
      `preview: ${text.slice(0, 70).replace(/\n/g, " ")}`,
    );
  }
  const total = Date.now() - t0;

  const ok = rows.filter((r) => r.ok);
  const avg = ok.length ? ok.reduce((s, r) => s + r.ms, 0) / ok.length : 0;
  const min = ok.length ? Math.min(...ok.map((r) => r.ms)) : 0;
  const max = ok.length ? Math.max(...ok.map((r) => r.ms)) : 0;
  const median = ok.length ? [...ok.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(ok.length / 2)] : 0;
  const totalOut = ok.reduce((s, r) => s + r.completionTokens, 0);
  const fail = rows.length - ok.length;

  console.log("");
  console.log("── Summary ─────────────────────────────────────────────");
  console.log(`  reps done    : ${ok.length}/${rows.length}`);
  if (ok.length) {
    console.log(`  avg latency  : ${latencyOf(avg)}`);
    console.log(`  median       : ${latencyOf(median)}`);
    console.log(`  min / max    : ${latencyOf(min)} / ${latencyOf(max)}`);
    console.log(`  pages / min  : ${(ok.length / (total / 1000 / 60)).toFixed(1)}`);
    console.log(`  avg output   : ${(totalOut / ok.length).toFixed(0)} tok / ${latencyOf(avg)}`);
    console.log(`  throughput   : ${(totalOut / (total / 1000)).toFixed(1)} out tok/s`);
  }
  if (fail) console.log(`  FAILED reps  : ${fail}`);
  const gpuAfter = gpuInfo();
  if (gpuAfter) console.log(`GPU after : ${gpuAfter}`);

  const out = createWriteStream("bench-glm-ocr.jsonl");
  for (const r of rows) out.write(JSON.stringify(r) + "\n");
  out.end();
  console.log("");
  console.log("Raw timings → bench-glm-ocr.jsonl");

  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

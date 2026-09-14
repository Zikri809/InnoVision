// Benchmark GLM-OCR — measures real OCR latency the same way the app drives it.
//
// TWO LEGS (mirrors `GLM_PROVIDER` in src/lib/ai/glm-provider.ts):
//
//   local  (DEFAULT, free) — the loopback vLLM/Docker container, OpenAI-
//          compatible `POST {GLM_BASE_URL}/v1/chat/completions`, ONE rasterized
//          page per call. The unit of work is a page IMAGE.
//   remote (BILLED)        — the Z.ai PaaS API, `POST {ZAI_BASE_URL}/layout_parsing`,
//          WHOLE document per call, priced per token. The unit of work is a
//          DOCUMENT (PDF), not a page — so `--pdf <path>` is the meaningful
//          shape for this leg. Every call costs money.
//
// Usage:
//   node scripts/benchmark-glm-ocr.mjs [--reps N] [--url URL] [--model MODEL]
//                                      [--auth TOKEN] [--provider local|remote]
//                                      [--pdf PATH] [--key ZAI_KEY]
//
// Defaults: 1 warm-up + 3 timed reps of the committed scanned-chapter.png
// fixture (the app's E2E scanned image). No extra deps (no canvas needed).
//
// Auth (audit-3 R3-DEP-F2): the LOCAL leg sends no auth header unless a token is
// supplied — pass `--auth <token>` or export `VLLM_API_KEY` to benchmark a
// container started with vLLM `--api-key`. The REMOTE leg always sends
// `Authorization: Bearer <ZAI_API_KEY>` (`--key` overrides the env var).
//
// The remote leg deliberately SKIPS the warm-up: it is a stateless HTTP API with
// no weights to load, so a warm-up would only bill an extra document.

import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DEFAULT_LOCAL_URL = process.env.GLM_BASE_URL ?? "http://localhost:11434";
const DEFAULT_ZAI_URL = process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4";
const MODEL = process.env.OCR_GLM_MODEL ?? "glm-ocr";
const FIXTURE = "e2e/fixtures/scanned-chapter.png";
const OUT_JSONL = "bench-glm-ocr.jsonl";

/** Z.ai list price, USD per 1M tokens (in + out). Mirrors glm-spend.ts. */
const PRICE_PER_MILLION = Number(
  process.env.GLM_TOKEN_PRICE_PER_MILLION ?? "0.03",
);

const SYSTEM_PROMPT =
  "You are an OCR engine. Transcribe ALL visible text from this page image " +
  "faithfully, preserving structure (headings, bullets, tables as text). " +
  "Output ONLY the transcribed text, no commentary.";

/** MIME for a fixture path — the remote `file` data URL must declare one. */
function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function parseArgs(argv) {
  const provider = (process.env.GLM_PROVIDER ?? "local").trim().toLowerCase();
  const args = {
    reps: 3,
    provider: provider === "remote" ? "remote" : "local",
    model: MODEL,
    url: null,
    auth: process.env.VLLM_API_KEY || null,
    key: process.env.ZAI_API_KEY || null,
    pdf: null,
    fixture: FIXTURE,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reps") args.reps = Number(argv[i + 1]);
    if (argv[i] === "--url") args.url = argv[i + 1];
    if (argv[i] === "--model") args.model = argv[i + 1];
    if (argv[i] === "--auth") args.auth = argv[i + 1];
    if (argv[i] === "--key") args.key = argv[i + 1];
    if (argv[i] === "--pdf") args.pdf = argv[i + 1];
    if (argv[i] === "--provider") {
      const v = String(argv[i + 1] ?? "").trim().toLowerCase();
      // Fail-closed, same rule as resolveGlmProvider(): only the exact word
      // "remote" selects the metered leg. A typo benchmarks the free one —
      // but say so, so the operator does not read a local run as a remote one.
      args.provider = v === "remote" ? "remote" : "local";
      if (v !== "remote" && v !== "local") args.providerWarn = v;
    }
    if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

function usage() {
  console.log(
    [
      "GLM-OCR benchmark",
      "",
      "  node scripts/benchmark-glm-ocr.mjs [options]",
      "",
      "  --provider local|remote  local (default, FREE) or remote (BILLED, Z.ai)",
      "  --reps N                 timed repetitions (default 3)",
      "  --model MODEL            model id (default $OCR_GLM_MODEL ?? glm-ocr)",
      "  --url URL                base URL for the ACTIVE leg",
      "                             local  default $GLM_BASE_URL  ?? http://localhost:11434",
      "                             remote default $ZAI_BASE_URL  ?? https://api.z.ai/api/paas/v4",
      "  --auth TOKEN             LOCAL leg only: vLLM --api-key token (or $VLLM_API_KEY)",
      "  --key TOKEN              REMOTE leg only: Z.ai key (or $ZAI_API_KEY)",
      "  --pdf PATH               REMOTE leg: whole-document fixture (the real unit)",
      "  --help                   this text",
      "",
      "  The local leg's fixture is e2e/fixtures/scanned-chapter.png (one page image).",
      "  The remote leg defaults to the same PNG (single-image shape); pass --pdf to",
      "  measure the whole-document shape the app actually sends.",
      "",
      "  Output: human summary + bench-glm-ocr.jsonl (one JSON row per rep).",
    ].join("\n"),
  );
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

/** USD for a token count at the configured price. */
function costUsd(totalTokens) {
  return (totalTokens / 1_000_000) * PRICE_PER_MILLION;
}

/** Never print a secret: mask the configured key wherever it appears. */
function redact(text, secret) {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (!secret || secret.length < 8) return s;
  return s.split(secret).join("[redacted]");
}

/** The request the LOCAL leg sends (OpenAI-compatible chat, one page). */
function localBody(args, imageDataUrl) {
  return {
    model: args.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this page:" },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    max_tokens: 2000,
    temperature: 0,
  };
}

/**
 * The request the REMOTE leg sends — contract §3.1, exactly.
 *
 * `start_page_id` / `end_page_id` are OMITTED (inclusivity unverified; guessing
 * silently drops the last page) and `user_id` is OMITTED (a stable hash is a
 * permanent third-party tracking id). `request_id` is fresh per attempt.
 */
function remoteBody(args, fileDataUrl) {
  return {
    model: args.model,
    file: fileDataUrl,
    request_id: randomUUID(),
  };
}

async function postJson(endpoint, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    let json = null;
    let text = null;
    try {
      json = await res.json();
    } catch {
      text = "<non-JSON body>";
    }
    return { res, json, text, ms };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Local leg ──────────────────────────────────────────────────────────────

async function runLocal(args) {
  const base = (args.url ?? DEFAULT_LOCAL_URL).replace(/\/$/, "");
  const endpoint = `${base}/v1/chat/completions`;
  const fixture = args.fixture;

  console.log(`  leg      : local (FREE — loopback vLLM/Docker)`);
  console.log(`  endpoint : ${endpoint}`);
  console.log(`  model    : ${args.model}`);
  console.log(`  fixture  : ${fixture} (one page image)`);
  console.log(`  reps     : ${args.reps} (after 1 warm-up)`);
  console.log(
    `  auth     : ${args.auth ? "Bearer <token> (--auth / VLLM_API_KEY)" : "none (container runs keyless)"}`,
  );
  console.log("");

  const fixtureB64 = (await readFile(fixture)).toString("base64");
  const imageDataUrl = `data:${mimeFor(fixture)};base64,${fixtureB64}`;
  const body = localBody(args, imageDataUrl);
  const headers = { "content-type": "application/json" };
  if (args.auth) headers.authorization = `Bearer ${args.auth}`;

  const gpuBefore = gpuInfo();
  if (gpuBefore) console.log(`GPU before: ${gpuBefore}`);
  else console.log("GPU: nvidia-smi not available (CPU path?)");
  console.log("");

  // Warm-up — loads weights / CUDA kernels, allocates KV cache, compiles paths.
  console.log("  warm-up…");
  const warmT = Date.now();
  const warm = await postJson(endpoint, body, headers, 120_000);
  if (!warm.res.ok) throw new Error(`warm-up failed: HTTP ${warm.res.status}`);
  console.log(
    `  warm-up done in ${latencyOf(Date.now() - warmT)} ` +
    `(${warm.json?.usage?.completion_tokens ?? 0} out tok)`,
  );
  console.log("");

  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < args.reps; i++) {
    const out = await postJson(endpoint, body, headers, 120_000);
    if (!out.res.ok) {
      rows.push({
        rep: i + 1, ok: false, provider: "local", status: out.res.status, ms: out.ms,
      });
      console.log(`  rep ${i + 1}: HTTP ${out.res.status} in ${latencyOf(out.ms)}`);
      continue;
    }
    const text = out.json?.choices?.[0]?.message?.content ?? "";
    const usage = out.json?.usage ?? {};
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    rows.push({
      rep: i + 1, ok: true, provider: "local", ms: out.ms, chars: text.length,
      promptTokens, completionTokens,
    });
    console.log(
      `  rep ${i + 1}: ${latencyOf(out.ms)} | ${text.length} chars | ` +
      `${promptTokens} in + ${completionTokens} out | ` +
      `${(completionTokens / (out.ms / 1000)).toFixed(1)} tok/s | ` +
      `preview: ${text.slice(0, 70).replace(/\n/g, " ")}`,
    );
  }
  const total = Date.now() - t0;
  const gpuAfter = gpuInfo();
  return { rows, total, gpuBefore, gpuAfter };
}

// ─── Remote leg (BILLED) ────────────────────────────────────────────────────

async function runRemote(args) {
  const base = (args.url ?? DEFAULT_ZAI_URL).replace(/\/$/, "");
  const endpoint = `${base}/layout_parsing`;
  const fixture = args.pdf ?? args.fixture;

  if (!args.key) {
    throw new Error(
      "GLM_PROVIDER=remote / --provider remote needs a Z.ai key: pass --key <token> " +
      "or export ZAI_API_KEY.",
    );
  }

  console.log("  ⚠️  BILLED RUN — every rep below charges the Z.ai account behind");
  console.log("      ZAI_API_KEY. The warm-up is SKIPPED (a stateless API has");
  console.log("      nothing to warm; it would only bill one more document).");
  console.log(`  leg      : remote (Z.ai PaaS — METERED)`);
  console.log(`  endpoint : ${endpoint}`);
  console.log(`  model    : ${args.model}`);
  console.log(`  fixture  : ${fixture} (${mimeFor(fixture)}; ${args.pdf ? "whole document" : "single image"})`);
  console.log(`  reps     : ${args.reps} BILLED call(s)`);
  console.log(`  price    : $${PRICE_PER_MILLION}/1M tokens (GLM_TOKEN_PRICE_PER_MILLION)`);
  console.log(`  auth     : Bearer <ZAI_API_KEY>`);
  if (!args.pdf) {
    console.log(
      "  note     : no --pdf given — measuring the SINGLE-IMAGE shape. The remote",
    );
    console.log(
      "             leg's real unit is a whole document; pass --pdf <path> for that.",
    );
  }
  console.log("");

  const bytes = await readFile(fixture);
  const fileDataUrl = `data:${mimeFor(fixture)};base64,${bytes.toString("base64")}`;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${args.key}`,
  };

  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < args.reps; i++) {
    const out = await postJson(endpoint, remoteBody(args, fileDataUrl), headers, 180_000);
    const usage = out.json?.usage ?? {};
    const totalTokens = usage.total_tokens ?? 0;
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const markdown = typeof out.json?.md_results === "string" ? out.json.md_results : "";
    const numPages =
      typeof out.json?.data_info?.num_pages === "number"
        ? out.json.data_info.num_pages
        : null;
    const code = out.json?.code ?? out.json?.error?.code;
    const upstreamMsg = redact(
      out.json?.message ?? out.json?.error?.message ?? "",
      args.key,
    );
    const ok = out.res.ok && (code === undefined || code === 0 || code === "0");

    rows.push({
      rep: i + 1,
      ok,
      provider: "remote",
      status: out.res.status,
      ms: out.ms,
      chars: markdown.length,
      numPages,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd: Number(costUsd(totalTokens).toFixed(6)),
      ...(ok ? {} : { code: code === undefined ? null : String(code), error: upstreamMsg || null }),
    });

    if (!ok) {
      console.log(
        `  rep ${i + 1}: FAILED HTTP ${out.res.status}` +
        `${code !== undefined ? ` code=${code}` : ""}` +
        `${upstreamMsg ? ` — ${upstreamMsg}` : ""} in ${latencyOf(out.ms)}`,
      );
      continue;
    }
    console.log(
      `  rep ${i + 1}: ${latencyOf(out.ms)} | ${markdown.length} chars | ` +
      `${numPages ?? "?"} page(s) | ` +
      `${promptTokens} in + ${completionTokens} out = ${totalTokens} tok | ` +
      `$${costUsd(totalTokens).toFixed(6)} | ` +
      `preview: ${markdown.slice(0, 70).replace(/\n/g, " ")}`,
    );
  }
  const total = Date.now() - t0;
  return { rows, total, gpuBefore: null, gpuAfter: null };
}

// ─── Summary ────────────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!Number.isInteger(args.reps) || args.reps <= 0) {
    throw new Error(`--reps must be a positive integer (got ${args.reps})`);
  }

  console.log("GLM-OCR benchmark");
  console.log(`  provider : ${args.provider}`);
  if (args.providerWarn) {
    console.log("");
    console.log(
      `  ⚠️  --provider "${args.providerWarn}" is not recognised — falling back to the ` +
      "LOCAL (free) leg,",
    );
    console.log("      matching the app's fail-closed resolveGlmProvider() rule.");
  }
  if (args.provider === "remote") {
    console.log("");
    console.log("  ╔══════════════════════════════════════════════════════════════╗");
    console.log("  ║  BILLED RUN — the remote leg charges ZAI_API_KEY per token.  ║");
    console.log("  ║  Every rep is a real Z.ai `layout_parsing` call.             ║");
    console.log("  ╚══════════════════════════════════════════════════════════════╝");
    console.log("");
  } else {
    console.log("");
  }

  const { rows, total, gpuBefore, gpuAfter } =
    args.provider === "remote" ? await runRemote(args) : await runLocal(args);

  const ok = rows.filter((r) => r.ok);
  const avg = ok.length ? ok.reduce((s, r) => s + r.ms, 0) / ok.length : 0;
  const min = ok.length ? Math.min(...ok.map((r) => r.ms)) : 0;
  const max = ok.length ? Math.max(...ok.map((r) => r.ms)) : 0;
  const median = ok.length
    ? [...ok.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(ok.length / 2)]
    : 0;
  const totalOut = ok.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
  const totalTokens = ok.reduce((s, r) => s + (r.totalTokens ?? r.completionTokens ?? 0), 0);
  const fail = rows.length - ok.length;

  console.log("");
  console.log("── Summary ─────────────────────────────────────────────");
  console.log(`  provider     : ${args.provider}`);
  console.log(`  reps done    : ${ok.length}/${rows.length}`);
  if (ok.length) {
    console.log(`  avg latency  : ${latencyOf(avg)}`);
    console.log(`  median       : ${latencyOf(median)}`);
    console.log(`  min / max    : ${latencyOf(min)} / ${latencyOf(max)}`);
    console.log(`  pages / min  : ${(ok.length / (total / 1000 / 60)).toFixed(1)}`);
    console.log(`  avg output   : ${(totalOut / ok.length).toFixed(0)} tok / ${latencyOf(avg)}`);
    console.log(`  throughput   : ${(totalOut / (total / 1000)).toFixed(1)} out tok/s`);
    if (args.provider === "remote") {
      const pages = ok.map((r) => r.numPages).filter((n) => typeof n === "number");
      console.log(`  tokens total : ${totalTokens} (billed)`);
      console.log(`  cost total   : $${costUsd(totalTokens).toFixed(6)}`);
      console.log(
        `  avg cost/doc : $${(costUsd(totalTokens) / ok.length).toFixed(6)}` +
        ` (price $${PRICE_PER_MILLION}/1M)`,
      );
      if (pages.length) {
        const avgPages = pages.reduce((s, n) => s + n, 0) / pages.length;
        console.log(`  avg pages/doc: ${avgPages.toFixed(1)}`);
        if (totalTokens > 0) {
          console.log(`  tokens/page  : ${(totalTokens / ok.length / avgPages).toFixed(1)}`);
        }
      } else {
        console.log("  pages/doc    : upstream returned no data_info.num_pages");
      }
      if (ok.every((r) => r.totalTokens === 0)) {
        console.log(
          "  ⚠️  usage.total_tokens was 0 on every rep — the cost figures above are",
        );
        console.log(
          "      therefore LOWER BOUNDS. Record the real usage shape from a live",
        );
        console.log("      curl before trusting the spend governor's cap math.");
      }
    }
  }
  if (fail) console.log(`  FAILED reps  : ${fail}`);
  if (gpuAfter) console.log(`GPU after : ${gpuAfter}`);
  else if (gpuBefore) console.log("GPU after : unavailable");

  const out = createWriteStream(OUT_JSONL);
  for (const r of rows) out.write(JSON.stringify(r) + "\n");
  out.end();
  console.log("");
  console.log(`Raw timings → ${OUT_JSONL}`);

  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

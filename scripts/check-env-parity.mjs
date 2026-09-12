/**
 * Env-parity check (audit-1 §5 top-5 item 5).
 *
 * .env.local.example is the operator contract: a key the application reads
 * but the example omits ships as an invisible misconfiguration (the 2026-09
 * audit found 11 missing: all rate-limit tunables, the E2E kill switches,
 * both NEXT_PUBLIC_* seams, TRUSTED_ORIGINS, AI_STREAM_IDLE_TIMEOUT_MS).
 *
 * The check walks every literal `process.env.KEY` / `env.KEY` reference in
 * src/** and asserts the key appears in .env.local.example — as an active
 * `KEY=` line OR a commented `# KEY=` mention (harness-only knobs are
 * documented but intentionally not preset). Keys referenced ONLY outside
 * src (e2e fixtures, scripts, CI) are allowlisted.
 *
 * Run: npm run check:env
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const EXAMPLE_PATH = join(ROOT, ".env.local.example");

/** Harness/process-only keys that must never be preset in the example. */
const ALLOWED_ABSENT = new Set([
  // Node/CI intrinsics
  "NODE_ENV",
  "CI",
  "BASE_URL",
  "FULL",
  // Playwright harness wiring (playwright.config.ts / e2e fixtures only)
  "PLAYWRIGHT_PORT",
  "PLAYWRIGHT_NOWEBSEARCH_PORT",
  "MOCK_AI_PORT",
  "MOCK_TINYFISH_PORT",
  "E2E_ALLOW_ALL_SKIPPED",
  "FACE_SMOKE",
  "INTEGRITY_E2E",
  "E51_HARDENING_E2E",
  "MOBILE_FIRST_EMAIL",
  "MOBILE_LECTURER_EMAIL",
  "MOBILE_STUDENT_EMAIL",
  "TINYFISH_FETCH_URL",
  "TINYFISH_SEARCH_URL", // documented in the example as an optional override
  // Seeding guard (scripts/seed-*.mjs only)
  "ALLOW_PROD_SEED",
]);

function collectEnvRefs(dir, refs) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
      collectEnvRefs(full, refs);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(entry) || entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    const text = readFileSync(full, "utf8");
    for (const m of text.matchAll(/\b(?:process\.)?env\.([A-Z_0-9]+)/g)) {
      refs.set(m[1], join(full, "").replace(ROOT + "\\", "").replace(ROOT + "/", ""));
    }
  }
}

const refs = new Map();
collectEnvRefs(join(ROOT, "src"), refs);

const example = readFileSync(EXAMPLE_PATH, "utf8");
const mentioned = new Set();
for (const line of example.split(/\r?\n/)) {
  const active = line.match(/^([A-Z_0-9]+)=/);
  if (active) mentioned.add(active[1]);
  const commented = line.match(/^#\s*([A-Z_0-9]+)=/);
  if (commented) mentioned.add(commented[1]);
}

const missing = [...refs.entries()]
  .filter(([key]) => !mentioned.has(key) && !ALLOWED_ABSENT.has(key))
  .map(([key, file]) => `  ${key}  (referenced in ${file})`);

if (missing.length > 0) {
  console.error(
    `env parity: ${missing.length} key(s) referenced in src but missing from .env.local.example:\n` +
      missing.join("\n"),
  );
  process.exit(1);
}

console.log(`env parity: OK — ${refs.size} src-referenced key(s) all documented in .env.local.example`);

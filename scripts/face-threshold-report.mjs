// Face-threshold tuning report — read-only analytics over recorded
// `face_checks` data. Prints similarity distributions for matched vs failed
// checks and suggests the empirical ROC elbow for FACE_SIMILARITY_MIN
// (currently the CompreFace default 0.5, mirrored in
// src/lib/face/constants.ts + record_face_check SQL).
//
// Usage:
//   node scripts/face-threshold-report.mjs [--days 30] [--remote]
//
// Reads .env.local (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).
// Read-only, but by default it refuses non-local DB targets (repo guard
// convention); pass --remote to analyze a production DB explicitly.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env.local");
const args = process.argv.slice(2);
const daysIdx = args.indexOf("--days");
const DAYS = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 30 : 30;
const REMOTE = args.includes("--remote");

if (!fs.existsSync(envPath)) {
  console.error("Missing .env.local — cannot read Supabase keys.");
  process.exit(1);
}
const env = fs
  .readFileSync(envPath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l && !l.trim().startsWith("#"))
  .reduce((acc, l) => {
    const idx = l.indexOf("=");
    if (idx > 0) acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
    return acc;
  }, {});

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}
const isLocal = /localhost|127\.0\.0\.1/.test(URL);
if (!isLocal && !REMOTE) {
  console.error(
    `Refusing non-local target ${URL} without --remote (read-only, but be deliberate).`,
  );
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
const { data, error } = await admin
  .from("face_checks")
  .select("matched, distance, checked_at")
  .gte("checked_at", since)
  .order("checked_at", { ascending: false })
  .limit(200_000);

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

const rows = data ?? [];
console.log(`face_checks in the last ${DAYS}d: ${rows.length}`);
if (rows.length < 50) {
  console.log("Too few samples (<50) for a meaningful threshold recommendation.");
  process.exit(0);
}

// distance = 1 − max(self-similarity). Convert back to similarity space.
const sims = rows.map((r) => ({
  matched: r.matched === true,
  sim: r.distance == null ? null : 1 - Number(r.distance),
}));

const matchedSims = sims.filter((s) => s.matched && s.sim != null).map((s) => s.sim);
const failedSims = sims.filter((s) => !s.matched && s.sim != null).map((s) => s.sim);

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function histogram(values, buckets) {
  const lines = [];
  for (let i = 0; i < buckets; i++) {
    const lo = i / buckets;
    const hi = (i + 1) / buckets;
    const n = values.filter((v) => v >= lo && v < (i === buckets - 1 ? 1.0001 : hi)).length;
    const bar = "#".repeat(Math.round((n / Math.max(1, values.length)) * 60));
    lines.push(`  ${lo.toFixed(2)}–${hi.toFixed(2)}  ${String(n).padStart(7)}  ${bar}`);
  }
  return lines.join("\n");
}

const sortedMatched = [...matchedSims].sort((a, b) => a - b);
const sortedFailed = [...failedSims].sort((a, b) => a - b);

console.log(`\nMATCHED checks (n=${matchedSims.length}):`);
console.log(histogram(matchedSims, 10));
console.log(`  p05=${percentile(sortedMatched, 5).toFixed(3)}  p25=${percentile(sortedMatched, 25).toFixed(3)}  median=${percentile(sortedMatched, 50).toFixed(3)}`);

console.log(`\nFAILED checks (n=${failedSims.length}):`);
console.log(histogram(failedSims, 10));
if (sortedFailed.length > 0) {
  console.log(`  p95=${percentile(sortedFailed, 95).toFixed(3)}  p99=${percentile(sortedFailed, 99).toFixed(3)}  max=${sortedFailed[sortedFailed.length - 1].toFixed(3)}`);
}

// Suggested operating point: keep ≥95% of FAILED checks below threshold
// (false-positive budget) while maximizing matched retention.
let best = { t: 0.5, retained: -1 };
for (let t = 0.3; t <= 0.9; t += 0.01) {
  const falseFailRate = sortedFailed.length
    ? sortedFailed.filter((s) => s >= t).length / sortedFailed.length
    : 0;
  const retained = sortedMatched.length
    ? sortedMatched.filter((s) => s >= t).length / sortedMatched.length
    : 0;
  if (falseFailRate <= 0.05 && retained > best.retained) {
    best = { t, retained };
  }
}
console.log(
  `\nSuggestion: threshold ≈ ${best.t.toFixed(2)} keeps ~${(best.retained * 100).toFixed(1)}% of matched checks while letting ≤5% of failed checks through.`,
);
console.log("Apply to BOTH mirrors: src/lib/face/constants.ts FACE_SIMILARITY_MIN and the");
console.log("FACE_SIMILARITY_MIN constant inside record_face_check (migration SQL).");

/**
 * Shared env loader for scripts that may target either the local seam or the
 * hosted project.
 *
 * Default target is LOCAL: reads .env.local (NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY), exactly as before.
 *
 * Pass --remote to target the HOSTED project: .env.local is overlaid with
 * .env.production.local (which holds the hosted URL + keys). .env.production.local
 * only carries the Supabase connection vars — AI/CompreFace/etc. still come from
 * .env.local since those are server-side calls from this machine.
 *
 * Usage in a script:
 *   const { URL, SERVICE, isRemote } = parseArgs(loadEnv(process.argv));
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * audit-3 R3-DEP-F6 — the prod-destructive confirmation gate.
 *
 * The expected token used to be the project-ref LITERAL hardcoded below, which
 * is committed in this same file: anyone who can read the repo can answer the
 * interactive prompt (or script it). The expected token is now read from the
 * out-of-band env var `PROD_CONFIRM_TOKEN`; the literal survives only as a
 * clearly-marked, loudly-warned fallback for the current single deployment so
 * existing operators are not locked out.
 *
 * Every confirmed (or bypassed) destructive run also writes a timestamped
 * audit line to stdout and to PROD_AUDIT_LOG (default `.prod-audit.log` at the
 * repo root, gitignored) — `ALLOW_PROD_SEED=1` used to skip the gate with no
 * record at all.
 */
const FALLBACK_CONFIRM_TOKEN = "yjzezkvfbeknknzaqymw";
const AUDIT_LOG_PATH =
  process.env.PROD_AUDIT_LOG || path.resolve(__dirname, "../../.prod-audit.log");

function expectedConfirmToken() {
  const outOfBand = (process.env.PROD_CONFIRM_TOKEN ?? "").trim();
  if (outOfBand) return outOfBand;
  console.warn(
    "⚠️  PROD_CONFIRM_TOKEN is not set — falling back to the project-ref " +
      "literal committed in scripts/lib/remote-env.mjs. That value is readable " +
      "by anyone with repo access, so the interactive gate is NOT a real secret. " +
      "Export PROD_CONFIRM_TOKEN (out-of-band) before running destructive prod " +
      "operations.",
  );
  return FALLBACK_CONFIRM_TOKEN;
}

/** Timestamped audit trail for every destructive prod decision. */
function auditProd(action, label, target) {
  const line =
    `${new Date().toISOString()} action=${action} label=${JSON.stringify(label)} ` +
    `target=${target ?? "?"} pid=${process.pid} cwd=${process.cwd()}`;
  console.log(`[prod-audit] ${line}`);
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, `${line}\n`);
  } catch (err) {
    // A logging failure must not silently cancel the operation — surface it.
    console.warn(
      `[prod-audit] WARNING: could not write ${AUDIT_LOG_PATH} (${err.message}); ` +
        "the stdout line above is the only record of this run.",
    );
  }
}

export function loadEnvFile(name) {
  const p = path.resolve(__dirname, "../../", name);
  if (!fs.existsSync(p)) return {};
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trim().startsWith("#"))
    .reduce((acc, l) => {
      const idx = l.indexOf("=");
      if (idx > 0) acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
      return acc;
    }, {});
}

/** Overlay local + (optionally) production envs based on argv flags. */
export function resolveEnv(argv) {
  const remote = argv.includes("--remote");
  const base = loadEnvFile(".env.local");
  const prod = remote ? loadEnvFile(".env.production.local") : {};
  const merged = { ...base, ...prod };

  const URL = merged.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE = merged.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !SERVICE) {
    console.error(
      remote
        ? "Missing Supabase keys — ensure .env.production.local has NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."
        : "Missing .env.local keys (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).",
    );
    process.exit(1);
  }

  const isLocalUrl = /localhost|127\.0\.0\.1|kong/.test(URL);
  if (remote && isLocalUrl) {
    console.error(`--remote requested but resolved URL is local (${URL}). Check .env.production.local.`);
    process.exit(1);
  }
  if (!remote && !isLocalUrl && process.env.ALLOW_PROD_SEED !== "1") {
    console.error(
      `\n⚠️ SAFETY GUARD: .env.local points at a non-local URL (${URL}).` +
        `\nDefault target must be local; to force, re-run with ALLOW_PROD_SEED=1.\n`,
    );
    process.exit(1);
  }
  if (!remote && !isLocalUrl) {
    // audit-3 R3-DEP-F6: forcing a prod target without --remote is itself a
    // destructive-relevant decision — record it instead of skipping silently.
    console.warn(
      `⚠️  ALLOW_PROD_SEED=1 — running against the NON-LOCAL URL ${URL} without --remote.`,
    );
    auditProd("allow-prod-seed", "resolveEnv: non-local target without --remote", URL);
  }
  return { URL, SERVICE, isRemote: remote };
}

/** Confirm before running a destructive operation against the hosted project. */
export async function confirmRemote(label) {
  const target = loadEnvFile(".env.production.local").NEXT_PUBLIC_SUPABASE_URL ?? "?";
  if (process.env.ALLOW_PROD_SEED === "1") {
    // audit-3 R3-DEP-F6: this path used to return true with no confirmation
    // and no record. It still skips the prompt (that is its purpose), but the
    // skip is now announced and audited.
    console.warn(
      "⚠️  ALLOW_PROD_SEED=1 — interactive confirmation SKIPPED for a destructive " +
        "hosted-project operation.",
    );
    auditProd("bypassed", label, target);
    return true;
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n⚠️  About to ${label} on the HOSTED project (${target}).\nType the project ref to confirm, or anything else to abort: `,
  );
  rl.close();
  if (answer.trim() === expectedConfirmToken()) {
    auditProd("confirmed", label, target);
    console.log("Confirmed.\n");
    return true;
  }
  auditProd("aborted", label, target);
  console.log("Aborted.\n");
  process.exit(1);
}

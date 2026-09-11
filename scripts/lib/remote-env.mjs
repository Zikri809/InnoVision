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
  return { URL, SERVICE, isRemote: remote };
}

/** Confirm before running a destructive operation against the hosted project. */
export async function confirmRemote(label) {
  if (process.env.ALLOW_PROD_SEED === "1") return true;
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n⚠️  About to ${label} on the HOSTED project (${loadEnvFile(".env.production.local").NEXT_PUBLIC_SUPABASE_URL ?? "?"}).\nType the project ref to confirm, or anything else to abort: `,
  );
  rl.close();
  if (answer.trim() === "yjzezkvfbeknknzaqymw") {
    console.log("Confirmed.\n");
    return true;
  }
  console.log("Aborted.\n");
  process.exit(1);
}

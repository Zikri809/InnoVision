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
 * audit-3 R3-DEP-F6 / gate S2 — the prod-destructive confirmation gate.
 *
 * The expected token used to be the project-ref LITERAL hardcoded in this file
 * (`FALLBACK_CONFIRM_TOKEN = "<project-ref>"`), which is committed in the same
 * file as the gate it guards: anyone who can read the repo can answer the
 * interactive prompt (or script it), so the prompt was theater. Gate S2
 * DELETED that literal. `PROD_CONFIRM_TOKEN` is now the only accepted answer
 * and must come from the environment (out-of-band: a password manager, an
 * operator's shell, CI secret) — an unset variable ABORTS every destructive
 * `--remote` run with instructions instead of falling back to a public value.
 *
 * ⚠️  This makes `PROD_CONFIRM_TOKEN` a REQUIRED operator step. Destructive
 * scripts that call `confirmRemote()` now fail closed when it is missing; that
 * is the intended trade (the previous behaviour was a gate anyone could pass).
 *
 * ⚠️  The token must be a value the repo does NOT already hold. S2 deleted the
 * committed fallback, but the project ref it used is still readable elsewhere
 * (`docs/audit/audit-3-ledger.md`, `.env.production.local`), so exporting
 * `PROD_CONFIRM_TOKEN=<project-ref>` would have restored the same theater with
 * one extra step. `isCommittedProjectRef()` therefore REFUSES it, structurally
 * (parsing the ref out of the configured Supabase URL) as well as literally, and
 * the runbook's `PROD_CONFIRM_TOKEN=<secret>` line means exactly that: a
 * distinct out-of-band secret, never the project ref.
 *
 * ⚠️  The prompt does NOT echo what you type. `readline`'s default
 * (`terminal: true`) prints every keystroke, so the old prompt wrote the secret
 * onto any shared screen or recorded session. See `promptHidden()`: `terminal:
 * false` for piped stdin (scripting keeps working) and raw mode for a TTY, where
 * the echo comes from the terminal driver rather than from readline.
 *
 * Every confirmed (or bypassed) destructive run also writes a timestamped
 * audit line to stdout and to `PROD_AUDIT_LOG` (default `.prod-audit.log` at
 * the repo root, gitignored) — `ALLOW_PROD_SEED=1` used to skip the gate with
 * no record at all.
 *
 * ⚠️  AUDIT-TRAIL SCOPE: `PROD_AUDIT_LOG` is a LOCAL file on the operator's
 * machine and it is gitignored, so it is NOT a durable record on its own —
 * it vanishes with the machine and is invisible to everyone else. To be a real
 * audit trail it must be SHIPPED OFF-HOST (set `PROD_AUDIT_LOG` to a mounted
 * volume, or forward the stdout `[prod-audit]` lines to your log collector).
 * The default path is a convenience, not compliance.
 */
const AUDIT_LOG_PATH =
  process.env.PROD_AUDIT_LOG || path.resolve(__dirname, "../../.prod-audit.log");

/**
 * The hosted project ref that WAS the hardcoded fallback this gate's S2 fix
 * deleted. It survives here ONLY as a DENY-LIST entry.
 *
 * Why a deny-list entry is legitimate when a fallback was not: the two roles are
 * opposites. A FALLBACK made the gate passable with a value anyone who can read
 * the repo already knows, so it was theater. A DENY-LIST entry makes the gate
 * REFUSE that same value — it can only ever reject, never admit. The rule it
 * encodes is "a value readable from the repo cannot be a secret", so the gate
 * must refuse it rather than accept it.
 *
 * It is also why this is not "re-introducing the literal": the string being
 * present in this file no longer helps an attacker, because answering with it
 * now aborts (rc=1) instead of confirming. Keeping it out of this file entirely
 * would be marginally tidier, but then the check would depend on the value
 * still being discoverable somewhere else, and the whole point is to catch the
 * operator who reads it out of the audit ledger and pastes it in.
 */
const HISTORICAL_PROJECT_REF = "yjzezkvfbeknknzaqymw";

/** Extract the project ref from a hosted Supabase URL, or `null`. */
function projectRefFromUrl(url) {
  const m = /^https?:\/\/([a-z0-9]{20})\.supabase\.(?:co|in)\b/i.exec((url ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Every project-ref-shaped value an operator could have read out of this
 * checkout's deployment configuration.
 *
 * Detection is STRUCTURAL first (parse the ref out of the configured Supabase
 * URL) rather than a pure literal list, so re-pointing the project does not
 * quietly re-open the hole: the new ref is denied the moment it is configured,
 * without anyone remembering to add it here. The historical literal is included
 * because it is still committed in `docs/audit/audit-3-ledger.md`, where an
 * operator can read it even after the env files move on.
 *
 * `.env.production.local` / `.env.local` are the two files that hold the hosted
 * URL; both are read defensively (a missing file is just `{}`).
 */
function committedProjectRefs() {
  const refs = new Set([HISTORICAL_PROJECT_REF]);
  for (const file of [".env.production.local", ".env.local"]) {
    const ref = projectRefFromUrl(loadEnvFile(file).NEXT_PUBLIC_SUPABASE_URL);
    if (ref) refs.add(ref);
    // The ref also rides in the files' comment lines ("Project: innovision
    // (<ref>)"), which a URL parse alone would miss — so the raw text is
    // substring-scanned for each candidate ref too.
    const text = readEnvFileText(file);
    for (const candidate of [HISTORICAL_PROJECT_REF, ref].filter(Boolean)) {
      if (text.includes(candidate)) refs.add(candidate);
    }
  }
  return refs;
}

/**
 * True when `value` is, or embeds, a project ref the operator could have read
 * from this checkout.
 *
 * EQUALITY is the case the critic named (`PROD_CONFIRM_TOKEN=<project-ref>`).
 * CONTAINMENT covers the likelier copy-paste: `.env.production.local` holds the
 * ref inside a URL, so `https://<ref>.supabase.co` (and `<ref>.supabase.co`) are
 * just as readable as the bare ref and would otherwise sail through. The rule is
 * the same in both directions — a value readable from the repo cannot be the
 * secret — and there is no legitimate reason for an out-of-band secret to embed
 * the project ref. A false positive needs a random secret to contain a specific
 * 20-character token, which is not a real risk.
 */
function isCommittedProjectRef(value) {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return false;
  for (const ref of committedProjectRefs()) {
    if (trimmed === ref || trimmed.includes(ref)) return true;
  }
  return false;
}

/** Raw text of an env file, or "" — for the substring scan above. */
function readEnvFileText(name) {
  try {
    const p = path.resolve(__dirname, "../../", name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

/**
 * The out-of-band confirmation token, or `null` when unset.
 *
 * No fallback: a committed default is readable by anyone with repo access, so
 * it cannot be a secret. Returns `null` (rather than throwing here) so callers
 * can print context-specific instructions.
 */
function expectedConfirmToken() {
  const outOfBand = (process.env.PROD_CONFIRM_TOKEN ?? "").trim();
  return outOfBand || null;
}

/** Abort when the configured token is a value the repo/checkout already holds. */
function abortDeniedConfirmToken() {
  console.error(
    "\n⛔ PROD_CONFIRM_TOKEN is set to a project ref that is readable from this " +
      "checkout — refusing to run a destructive hosted-project operation.\n" +
      "   The project ref was the value gate S2 deleted as a fallback, precisely " +
      "because anyone who\n" +
      "   can read the repo can read it; accepting it as the answer would restore " +
      "the theater the gate\n" +
      "   exists to remove.\n\n" +
      "   Choose a DISTINCT out-of-band secret (NOT the project ref, NOT the Supabase " +
      "URL or any key in\n" +
      "   .env.production.local) and store it in a password manager / CI secret:\n" +
      "     PROD_CONFIRM_TOKEN=<a-distinct-secret> npm run db:reset:remote\n",
  );
  process.exit(1);
}

/** Abort with actionable instructions when the out-of-band token is missing. */
function abortMissingConfirmToken() {
  console.error(
    "\n⛔ PROD_CONFIRM_TOKEN is not set — refusing to run a destructive hosted-project " +
      "operation.\n" +
      "   Gate S2 removed the committed project-ref fallback: a value in the repo is " +
      "readable by anyone\n" +
      "   with repo access, so it cannot act as a secret.\n\n" +
      "   Provide the token out-of-band, e.g.:\n" +
      "     PROD_CONFIRM_TOKEN=<secret> npm run db:reset:remote\n" +
      "   The accepted answer is the value of PROD_CONFIRM_TOKEN itself (not the project " +
      "ref) —\n" +
      "   store it in a password manager / CI secret and share it with operators out of band.\n" +
      "   ALLOW_PROD_SEED=1 still bypasses the prompt, but it is audited and does not " +
      "supply a token.\n",
  );
  process.exit(1);
}

/**
 * Read one line from the operator WITHOUT echoing it.
 *
 * Why this exists: `readline.question()` with its default `terminal: true`
 * echoes every keystroke to the TTY, so the old prompt printed the secret onto
 * any shared screen, pair-programming session or recorded terminal — turning a
 * shared-secret gate into a disclosure. Two paths, one per input kind:
 *
 *  - NOT a TTY (piped/redirected stdin, the scripted case):
 *    `terminal: false` makes readline neither echo nor line-edit, so
 *    `printf '%s\n' "$PROD_CONFIRM_TOKEN" | npm run db:reset:remote -- --remote`
 *    keeps working. Nothing is written by us, and a pipe does not echo anyway.
 *  - A TTY: the terminal DRIVER does the echoing, not readline, so muting
 *    readline alone would not help. Raw mode clears the tty's ECHO flag before
 *    the first keystroke, so the characters never reach the screen. Only the
 *    prompt is printed; Enter ends the line (a newline is emitted so the next
 *    output does not run on), Ctrl-C exits 130, Ctrl-D ends input, and
 *    backspace edits the invisible buffer.
 *
 * The returned string is the raw line; callers `.trim()` it.
 */
async function promptHidden(question) {
  if (!process.stdin.isTTY) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    try {
      // `question()` never settles if stdin is already at EOF (no input at
      // all), which used to leave the script as an unsettled top-level await
      // and exit 13 — a confusing "crash" rather than a refusal. EOF therefore
      // answers with the empty string, which can never match a real token and
      // takes the normal "Aborted." path.
      let done = false;
      const answered = rl.question(question).then((a) => {
        done = true;
        return a;
      });
      const eof = new Promise((resolve) => rl.once("close", () => resolve("")));
      const result = await Promise.race([answered, eof]);
      // If EOF won, the pending question must not keep the process alive.
      if (!done) rl.close();
      return result;
    } finally {
      rl.close();
    }
  }

  process.stdout.write(question);
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve) => {
    let value = "";
    const finish = (result) => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      resolve(result);
    };
    const onEnd = () => finish(value);
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(value);
        if (ch === "\u0004") return finish(value); // Ctrl-D: end of input.
        if (ch === "\u0003") {
          // Ctrl-C: honour the interrupt instead of swallowing it in raw mode.
          stdin.removeListener("data", onData);
          stdin.removeListener("end", onEnd);
          stdin.setRawMode(wasRaw);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
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

/**
 * Confirm before running a destructive operation against the hosted project.
 *
 * The prompt asks for the value of `PROD_CONFIRM_TOKEN` (NOT the project ref —
 * that was the theater gate S2 deleted). A missing/empty token aborts before
 * the prompt, and the abort itself is audited so a refused run is still
 * recorded.
 */
export async function confirmRemote(label) {
  const target = loadEnvFile(".env.production.local").NEXT_PUBLIC_SUPABASE_URL ?? "?";
  if (process.env.ALLOW_PROD_SEED === "1") {
    // audit-3 R3-DEP-F6: this path used to return true with no confirmation
    // and no record. It still skips the prompt (that is its purpose), but the
    // skip is now announced and audited. Gate S2 keeps this working — note it
    // does NOT supply a token, so it is the only path that runs without one.
    console.warn(
      "⚠️  ALLOW_PROD_SEED=1 — interactive confirmation SKIPPED for a destructive " +
        "hosted-project operation.",
    );
    auditProd("bypassed", label, target);
    return true;
  }

  const expected = expectedConfirmToken();
  if (!expected) {
    // Fail closed BEFORE prompting: there is nothing legitimate to compare
    // against, and prompting for a value that cannot be checked is the exact
    // false-confidence shape S2 removed.
    auditProd("aborted-missing-token", label, target);
    abortMissingConfirmToken();
  }

  // Fail closed on a token the checkout itself holds. Without this, an operator
  // who reads the project ref out of `docs/audit/audit-3-ledger.md` (or
  // `.env.production.local`) and exports it as PROD_CONFIRM_TOKEN restores the
  // exact theater S2 deleted — the gate would accept a publicly-readable value.
  if (isCommittedProjectRef(expected)) {
    auditProd("aborted-token-is-project-ref", label, target);
    abortDeniedConfirmToken();
  }

  const answer = await promptHidden(
    `\n⚠️  About to ${label} on the HOSTED project (${target}).\n` +
      "Type the value of PROD_CONFIRM_TOKEN to confirm, or anything else to abort " +
      "(input is NOT echoed): ",
  );
  // Constant-time-ish comparison is not the point here (this is a human prompt,
  // not a network oracle); the point is that the expected value is not in the
  // repo.
  if (answer.trim() === expected) {
    auditProd("confirmed", label, target);
    console.log("Confirmed.\n");
    return true;
  }
  auditProd("aborted", label, target);
  console.log("Aborted.\n");
  process.exit(1);
}

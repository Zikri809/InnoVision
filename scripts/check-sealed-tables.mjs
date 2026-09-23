/**
 * E-60 gate (audit-4 M5) — the v4.9 rich-type integrity invariants that were
 * previously "verified clean at handover" by hand, now enforced:
 *
 *   1. SEALED-TABLE READS — `questions`, `session_answers`, `quiz_sessions`
 *      and `ai_marking_ledger` are revoked from `authenticated` (0054/0057);
 *      every read must run on the service-role client. The scan flags any
 *      `.from("<sealed>")` whose chain has no `createAdminClient()` /
 *      `tryCreateAdminClient()` within 300 chars before it AND whose receiver
 *      variable was not assigned from one of those factories. Verified-clean
 *      user-scoped reads (RLS owner-scoped, explicit columns) live in the
 *      ALLOWLIST below with a reason; a new hit fails the gate.
 *   2. MIGRATION NOTIFY — the five v4.9 object-creating migrations must end
 *      with `notify pgrst, 'reload schema'` (D5/D11). Other files in the
 *      batch are warned, not failed (house precedent: historical files never
 *      notified; hosted PostgREST auto-invalidates).
 *   3. CRON COUNT TIE — `EXPECTED_JOBS` (health route), `EXPECTED_CRON_JOBS`
 *      (sync script) and the SEVEN assertion in 0059_cron.sql must all agree.
 *      The health fixture mocks both sides, so a DB-vs-constant drift could
 *      never surface there; this is the static tie.
 *   4. FROZEN TESTIDS — the six §0 testids the E2E suite targets must exist in
 *      src/** (M2's override dialog is the current gate subject).
 *
 * Run: npm run check:sealed
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "src");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const CRON_TEST_PATH = path.join(ROOT, "supabase", "tests", "0059_cron.sql");
const HEALTH_PATH = path.join(ROOT, "src", "app", "api", "health", "route.ts");
const SYNC_PATH = path.join(ROOT, "deploy", "sync-migrations.sh");

const SEALED_TABLES = ["questions", "session_answers", "quiz_sessions", "ai_marking_ledger"];

/**
 * Verified-clean user-scoped reads. Each entry is matched on file + table +
 * a snippet that must appear inside the statement window (300 chars before
 * the `.from(...)`, 400 after) — a line-number-free key, so a code edit that
 * changes the read fails the gate until a human re-verifies it.
 */
const ALLOWLIST = [
  {
    file: "src/components/notifications/notification-bell.tsx",
    table: "quiz_sessions",
    snippet: "resolveSessionQuizId",
    reason:
      "Notification-link resolver reads the caller's OWN completed session (RLS owner-scoped, select(\"id\") only).",
  },
  {
    file: "src/app/(lecturer)/lecturer/quizzes/[id]/builder/page.tsx",
    table: "quiz_sessions",
    snippet: "head: true",
    reason:
      "Owner-checked count of completed sessions for the lecturer's own quiz (select(\"id\", count) only).",
  },
  {
    file: "src/app/api/face/verify/route.ts",
    table: "quiz_sessions",
    snippet: "face_exempt",
    reason:
      "Own-session RLS read of the caller's face_exempt flag; only decides whether the baseline guard applies.",
  },
  {
    file: "src/app/api/sessions/[id]/incident/route.ts",
    table: "quiz_sessions",
    snippet: "session.student_id !== auth.userId",
    reason:
      "Own-session ownership gate (RLS-scoped) before the admin upload; the admin client is never the authority.",
  },
  {
    file: "src/app/api/sessions/[id]/incident/route.ts",
    table: "quiz_sessions",
    snippet: "incident recheck error:",
    reason:
      "TOCTOU re-check of the same own-session ownership gate through the USER client (the ownership assertion follows in the stillCollectable expression); the admin client is never the authority.",
  },
  {
    file: "src/app/api/sessions/[id]/pause/route.ts",
    table: "quiz_sessions",
    snippet: "statusProbe",
    reason:
      "Own-session RLS read of the pause status (select(\"status\") only) to coalesce replayed pause POSTs; a non-owned id returns null and falls through to the RPC's not_owner.",
  },
  {
    file: "src/app/api/quizzes/[id]/route.ts",
    table: "quiz_sessions",
    snippet: "countError",
    reason: "Owner-checked session count guarding quiz delete.",
  },
  {
    file: "src/app/api/quizzes/[id]/reveal/route.ts",
    table: "quiz_sessions",
    snippet: "liveSessions",
    reason: "Owner-checked live-session id list for the reveal guard.",
  },
  {
    file: "src/app/api/quizzes/[id]/reveal/route.ts",
    table: "session_answers",
    snippet: "liveIds",
    reason: "Existence count (head:true) of answers in the lecturer's own live sessions.",
  },
];

const REQUIRED_NOTIFY = ["0054", "0055", "0057", "0058", "0060"];
const JOB_COUNT = 7;

const FROZEN_TESTIDS = [
  "gestures-toggle",
  "skip-question",
  "short-text-input",
  "pending-banner",
  "needs-review-row",
  "override-mark-dialog",
];

let hasError = false;

function walk(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== ".next" && entry !== ".git") {
        out.push(...walk(full, exts));
      }
    } else if (exts.includes(path.extname(full))) {
      out.push(full);
    }
  }
  return out;
}

function rel(full) {
  return path.relative(ROOT, full).split(path.sep).join("/");
}

function lineAt(content, pos) {
  return content.slice(0, pos).split("\n").length;
}

// ── 1. Sealed-table reads ──────────────────────────────────────────────
const srcFiles = walk(SRC_DIR, [".ts", ".tsx"]);
const sealedHits = [];
const allowlisted = [];

for (const full of srcFiles) {
  const file = rel(full);
  const content = fs.readFileSync(full, "utf8");

  // Every variable ever assigned from the admin factories in this file.
  const adminVars = new Set();
  const assignRe =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:createAdminClient|tryCreateAdminClient)\s*\(/g;
  let assignMatch;
  while ((assignMatch = assignRe.exec(content)) !== null) {
    adminVars.add(assignMatch[1]);
  }

  for (const table of SEALED_TABLES) {
    const fromRe = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g");
    let fromMatch;
    while ((fromMatch = fromRe.exec(content)) !== null) {
      const pos = fromMatch.index;
      const before = content.slice(Math.max(0, pos - 300), pos);
      const directAdmin = /createAdminClient\s*\(|tryCreateAdminClient\s*\(/.test(before);
      // Receiver identifier immediately before `.from(` — `admin.from(...)`.
      const receiver = /([A-Za-z_$][\w$]*)\s*$/.exec(before.replace(/\s+$/, ""));
      const varAdmin = receiver !== null && adminVars.has(receiver[1]);
      if (directAdmin || varAdmin) continue;

      const window = content.slice(Math.max(0, pos - 300), Math.min(content.length, pos + 400));
      const exempt = ALLOWLIST.find(
        (a) => a.file === file && a.table === table && window.includes(a.snippet),
      );
      if (exempt) {
        allowlisted.push({ file, table, reason: exempt.reason });
        continue;
      }
      sealedHits.push({ file, line: lineAt(content, pos), table });
    }
  }
}

console.log(`\n=== Sealed-table read scan ===`);
console.log(`Scanned ${srcFiles.length} src file(s); ${allowlisted.length} allowlisted exception(s).`);
for (const a of allowlisted) {
  console.log(`  ℹ️  allowlisted ${a.table} in ${a.file} — ${a.reason}`);
}
if (sealedHits.length > 0) {
  hasError = true;
  console.error(`\n❌ User-scoped reads of sealed tables (${sealedHits.length}):`);
  for (const h of sealedHits) {
    console.error(`  - ${h.file}:${h.line}  .from("${h.table}") — no admin client in the chain`);
  }
  console.error(
    "  Fix: read through createAdminClient()/tryCreateAdminClient(), or add a verified\n" +
      "  allowlist entry in scripts/check-sealed-tables.mjs with a reason.",
  );
} else {
  console.log(`✅ No unaccounted sealed-table reads.`);
}

// ── 2. Migration NOTIFY ────────────────────────────────────────────────
console.log(`\n=== Migration NOTIFY pgrst check ===`);
const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const NOTIFY_RE = /notify\s+pgrst\s*,\s*'reload schema'/i;
const OBJECT_CREATING_RE =
  /create\s+(or\s+replace\s+)?(function|table|view|materialized\s+view|trigger)|alter\s+table\s+[^\s;]+\s+add\s+column/i;

for (const prefix of REQUIRED_NOTIFY) {
  const file = migrationFiles.find((f) => f.startsWith(`${prefix}_`));
  if (!file) {
    hasError = true;
    console.error(`❌ required migration ${prefix}_*.sql not found`);
    continue;
  }
  const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  if (!NOTIFY_RE.test(content)) {
    hasError = true;
    console.error(`❌ ${file} is missing: notify pgrst, 'reload schema';`);
  } else {
    console.log(`✅ ${file} republishes the PostgREST schema cache.`);
  }
}

// Warn (never fail) on other v4.9-batch files that create objects silently.
for (const file of migrationFiles) {
  const prefix = file.slice(0, 4);
  if (REQUIRED_NOTIFY.includes(prefix)) continue;
  const batchNumber = Number.parseInt(prefix, 10);
  if (!Number.isFinite(batchNumber) || batchNumber < 51) continue;
  const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  if (OBJECT_CREATING_RE.test(content) && !NOTIFY_RE.test(content)) {
    console.warn(`  ⚠️  ${file} creates objects without a NOTIFY (self-hosted cache may stay stale).`);
  }
}

// ── 3. Cron count tie (health ↔ sync script ↔ 0059 test) ───────────────
console.log(`\n=== Cron count tie (EXPECTED_JOBS ↔ EXPECTED_CRON_JOBS ↔ 0059) ===`);
const healthSrc = fs.readFileSync(HEALTH_PATH, "utf8");
const jobsBlock = /const EXPECTED_JOBS = \[([\s\S]*?)\]\s*as const;/.exec(healthSrc);
const healthCount = jobsBlock ? [...jobsBlock[1].matchAll(/"([^"]+)"/g)].length : null;

const syncSrc = fs.readFileSync(SYNC_PATH, "utf8");
const syncMatch = /EXPECTED_CRON_JOBS="\$\{EXPECTED_CRON_JOBS:-(\d+)\}"/.exec(syncSrc);
const syncCount = syncMatch ? Number.parseInt(syncMatch[1], 10) : null;

const cronTestSrc = fs.readFileSync(CRON_TEST_PATH, "utf8");
const testMatch = /count\(\*\)[\s\S]{0,200}?(\d+)::bigint,\s*'exactly SEVEN/.exec(cronTestSrc);
const testCount = testMatch ? Number.parseInt(testMatch[1], 10) : null;

console.log(`health EXPECTED_JOBS: ${healthCount}`);
console.log(`sync EXPECTED_CRON_JOBS: ${syncCount}`);
console.log(`0059_cron.sql expected count: ${testCount}`);

if (healthCount === null) {
  hasError = true;
  console.error("❌ could not parse EXPECTED_JOBS from src/app/api/health/route.ts");
}
if (syncCount === null) {
  hasError = true;
  console.error("❌ could not parse EXPECTED_CRON_JOBS from deploy/sync-migrations.sh");
}
if (testCount === null) {
  hasError = true;
  console.error("❌ could not parse the SEVEN count from supabase/tests/0059_cron.sql");
}
if (healthCount !== null && syncCount !== null && testCount !== null) {
  if (healthCount !== JOB_COUNT || syncCount !== JOB_COUNT || testCount !== JOB_COUNT) {
    hasError = true;
    console.error(
      `❌ cron counts must all be ${JOB_COUNT} (health=${healthCount}, sync=${syncCount}, 0059=${testCount}).`,
    );
  } else if (healthCount !== syncCount || healthCount !== testCount) {
    hasError = true;
    console.error(
      `❌ cron counts disagree (health=${healthCount}, sync=${syncCount}, 0059=${testCount}).`,
    );
  } else {
    console.log(`✅ all three pin ${JOB_COUNT} cron jobs.`);
  }
}

// ── 4. Frozen testids ──────────────────────────────────────────────────
console.log(`\n=== Frozen testid check ===`);
const srcBlob = srcFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
// A testid may be a literal attribute OR a value inside a ternary expression
// (end-screen's needs-review-row is `data-testid={cond ? "needs-review-row" :
// undefined}`), so match the id within 120 chars after a `data-testid` token.
const missingTestids = FROZEN_TESTIDS.filter(
  (id) => !new RegExp(`data-testid[\\s\\S]{0,120}?["']${id}["']`).test(srcBlob),
);
if (missingTestids.length > 0) {
  hasError = true;
  console.error(`❌ frozen testids missing from src/** (${missingTestids.length}):`);
  for (const id of missingTestids) console.error(`  - ${id}`);
} else {
  console.log(`✅ all ${FROZEN_TESTIDS.length} frozen testids present.`);
}

if (hasError) {
  console.error(`\n❌ sealed-table gate failed.`);
  process.exit(1);
} else {
  console.log(`\n✅ sealed-table gate passed.\n`);
  process.exit(0);
}

#!/usr/bin/env bash
#
# sync-migrations.sh — push supabase/migrations to the HOSTED project, then
# verify the push actually did what it claims.
#
#   bash deploy/sync-migrations.sh              # link → dry-run → push → verify
#   bash deploy/sync-migrations.sh --dry-run    # list pending migrations, change nothing
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
# Deploying the image without the schema is a half-deploy: the new code queries
# columns that do not exist yet, and the failure surfaces as 500s on whichever
# page touches the newest migration. This is the step that makes "deploy" mean
# code + schema.
#
# ── WHERE THIS RUNS, AND WHY NOT ON THE VPS ─────────────────────────────────
# It runs on the CI runner (the `migrate` job in .github/workflows/deploy.yml),
# NOT on the VPS. Three reasons, in order of weight:
#
#   1. The migration credentials are not app credentials. `SUPABASE_ACCESS_TOKEN`
#      (CLI auth) and the database password can ALTER and DROP every table in the
#      project. The app needs neither — it talks to Supabase over HTTPS/PostgREST
#      with the service-role key. Putting schema-mutating credentials on the
#      internet-facing host to save a job is a bad trade.
#   2. The Supabase CLI is already a devDependency, so `npm ci` provides it in CI
#      and nothing has to be installed or version-managed on the VPS.
#   3. Ordering is enforceable here. The `deploy` job `needs: [migrate]`, so a
#      failed migration SKIPS the rollout and the old image keeps serving the old
#      schema — instead of a new image running against a schema that is half
#      applied.
#
# ── THE SILENT FAILURES THIS SCRIPT GUARDS AGAINST ───────────────────────────
# `DEPLOY_VPS.md` §3.1 documents two ways `db push` succeeds while doing nothing
# useful, both of which leave a green deploy over a broken database:
#
#   - `vector` not pre-enabled in the `extensions` schema. Migration 0001
#     installs it unqualified while 0039 hard-fails if it is elsewhere, so the
#     push can abort MID-SEQUENCE leaving a partially applied history.
#   - `pg_cron` not pre-enabled. The schedules are created inside guarded blocks
#     (`0019/0022/0030/0042`) and `create extension pg_cron` needs superuser, so
#     the push reports success with ZERO jobs. The app then looks healthy while
#     autoclose, the silence check and both prunes never run.
#
# Both are checked BEFORE the push (fail early, change nothing) and the cron jobs
# are re-counted AFTER it (fail loud, because a push that applied the schedules
# into a project without pg_cron records them as applied and never retries).

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

# ── Configuration ────────────────────────────────────────────────────────────

SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
SUPABASE_DB_PASSWORD="${SUPABASE_DB_PASSWORD:-}"
SUPABASE_ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"

# AI marking worker provisioning (0057's sweep_ai_marks POST target).
#
# WHY THESE ARE DB SETTINGS AND NOT APP ENV: `sweep_ai_marks()` runs INSIDE
# Postgres and reads `app.settings.ai_mark_worker_url` + the Vault secret
# `ai_mark_worker_key`. It cannot read the app container's `.env.local`, so
# putting them only in SOPS would leave the sweep finding NULL: it would claim
# rows and never POST, and every short_text answer would stay `pending` forever
# (which blocks v_all_done, so the quiz never auto-reveals). This step closes
# that gap — the values reach the database here, in CI, where the schema push
# already runs and the DB credentials already live.
#
# AI_MARK_WORKER_URL  the public origin + /api/internal/ai-mark-sweep. Defaults
#                     to SITE_ORIGIN (the same host the app serves on) when the
#                     dedicated var is unset, so a standard deploy needs no new
#                     configuration.
# AI_MARK_WORKER_KEY  the bearer the route accepts. Defaults to
#                     SUPABASE_SERVICE_ROLE_KEY (the route's own fallback), so
#                     the default deployment provisions no new secret.
#
# Both are OPTIONAL: when the URL cannot be determined the step warns and skips
# (marking stays operator-invokable, per DEPLOY_VPS.md). It never fails the
# deploy — the schema and image are still correct.
AI_MARK_WORKER_URL="${AI_MARK_WORKER_URL:-${SITE_ORIGIN:-}}"
AI_MARK_WORKER_KEY="${AI_MARK_WORKER_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"

# Expected post-push invariants, from DEPLOY_VPS.md §3.1 steps 5-6.
EXPECTED_CRON_JOBS="${EXPECTED_CRON_JOBS:-7}"
EXPECTED_BUCKETS="${EXPECTED_BUCKETS:-4}"

DRY_RUN=0
SKIP_VERIFY=0

step() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   \033[0;32mOK\033[0m  %s\n' "$*"; }
warn() { printf '   \033[0;33mWARN\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[0;31mFAIL\033[0m  %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
sync-migrations.sh — push supabase/migrations to the hosted project and verify.

  bash deploy/sync-migrations.sh             # link → dry-run → push → verify
  bash deploy/sync-migrations.sh --dry-run   # list pending migrations only
  bash deploy/sync-migrations.sh --skip-verify

Required environment:
  SUPABASE_PROJECT_REF     the hosted project ref (e.g. abcdefghijklmnop)
  SUPABASE_DB_PASSWORD     database password (link + push)
  SUPABASE_ACCESS_TOKEN    Supabase CLI access token (sbp_...)

Optional:
  EXPECTED_CRON_JOBS       default 7   (DEPLOY_VPS.md §3.1 step 5; 0059 added the AI marking pair)
  EXPECTED_BUCKETS         default 4   (DEPLOY_VPS.md §3.1 step 6)
  SITE_ORIGIN              default for AI_MARK_WORKER_URL (https://<host>)
  AI_MARK_WORKER_URL       the sweep's POST target; default <SITE_ORIGIN>/api/internal/ai-mark-sweep
  AI_MARK_WORKER_KEY       the bearer the worker route accepts; default SUPABASE_SERVICE_ROLE_KEY

The two AI_MARK_* values are written into the DATABASE (app.settings + Vault),
because sweep_ai_marks() runs in Postgres and cannot read the app's env file.
When AI_MARK_WORKER_URL cannot be determined the step warns and skips.

Idempotent: with nothing pending it reports "up to date" and exits 0.
USAGE
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY_RUN=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    -h|--help)     usage ;;
    *)             die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# ── Step 1: preflight ────────────────────────────────────────────────────────

step "1/6  Preflight"

[ -d supabase/migrations ] || die "no supabase/migrations in $(pwd) — is this the repo root?"
[ -n "$SUPABASE_PROJECT_REF" ] || die "SUPABASE_PROJECT_REF is not set"
[ -n "$SUPABASE_DB_PASSWORD" ] || die "SUPABASE_DB_PASSWORD is not set"
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "SUPABASE_ACCESS_TOKEN is not set"

# The CLI reads the token from the environment; `supabase login` is interactive
# and cannot be used unattended. A malformed token fails here with a clear
# message instead of deep inside a push.
case "$SUPABASE_ACCESS_TOKEN" in
  sbp_*) ;;
  *) die "SUPABASE_ACCESS_TOKEN does not look like a Supabase access token (expected the 'sbp_' prefix). Generate one at https://supabase.com/dashboard/account/tokens" ;;
esac

command -v npx >/dev/null 2>&1 || die "npx not found — node is required (the Supabase CLI is a devDependency; run npm ci first)"

local_count="$(find supabase/migrations -name '*.sql' | wc -l | tr -d ' ')"
[ "$local_count" -gt 0 ] || die "supabase/migrations contains no .sql files"
ok "repo has $local_count migration file(s)"

# The CLI version is pinned by package.json; printing it makes a behaviour change
# in a future release visible in the deploy log rather than mysterious.
cli_version="$(npx --no-install supabase --version 2>/dev/null || true)"
[ -n "$cli_version" ] || die "the supabase CLI is not installed — run: npm ci"
ok "supabase CLI $cli_version"

# ── Step 2: link ─────────────────────────────────────────────────────────────
# `link` writes supabase/.temp/project-ref (gitignored). On CI the runner is
# ephemeral, so this is a no-op cost; locally it means the project stays linked
# for the next run.

step "2/6  Link to project $SUPABASE_PROJECT_REF"

if npx --no-install supabase link \
     --project-ref "$SUPABASE_PROJECT_REF" \
     --password "$SUPABASE_DB_PASSWORD" 2>&1 | tail -5; then
  ok "linked"
else
  die "supabase link failed — check SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD (the DB password, not the anon/service keys)"
fi

# A small JSON helper. jq is not guaranteed on every runner or dev box, but node
# is required by the CLI itself, so it is always present.
#
# The CLI writes its human progress line ("Connecting to local database...") to
# STDERR, which every call site discards with `2>/dev/null` — so stdin here is
# pure JSON. The parse is still wrapped: an unexpected stdout line (a future CLI
# release adding a warning to stdout, a proxy injecting a banner) must produce a
# clear message rather than a raw node stack trace, because this runs unattended
# in CI where the stack trace would be the only clue.
json_query() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let d;
      try {
        d = JSON.parse(s);
      } catch (err) {
        console.error("sync-migrations: expected JSON on stdin but got: " + s.slice(0, 200));
        process.exit(1);
      }
      console.log(eval(process.argv[1]));
    });
  ' "$2" <<<"$1"
}

# ── Step 3: what is pending? ─────────────────────────────────────────────────
# Computed from `migration list --output-format json` rather than by scraping the
# dry-run text: the JSON is a documented shape, while the human table has changed
# between CLI releases. A version present locally with an empty `remote` is one
# the hosted project has not applied.

step "3/6  Compare local vs remote history"

if ! listing="$(npx --no-install supabase migration list --linked --output-format json 2>/dev/null)"; then
  die "could not read the remote migration history. Check the project ref, the DB password, and that the project is not paused (free-tier projects pause after ~7 days of inactivity)."
fi

pending="$(json_query "$listing" "d.migrations.filter(m=>!m.remote||String(m.remote).trim()==='').map(m=>m.local).join(',')")"
remote_only="$(json_query "$listing" "d.migrations.filter(m=>m.remote&&(!m.local||String(m.local).trim()==='')).map(m=>m.remote).join(',')")"
total="$(json_query "$listing" "d.migrations.length")"

info "history rows: $total"

# A version the REMOTE has and the local repo does not means someone pushed from
# a branch that is not merged, or a migration file was deleted. Either way the
# histories have diverged and `db push` cannot reconcile it — surface it now
# rather than discovering it in production.
if [ -n "$remote_only" ]; then
  die "the hosted project has migration(s) this checkout does NOT: $remote_only
    The histories have diverged. Likely causes: a migration was pushed from an
    unmerged branch, or a file was deleted/renamed locally. Reconcile before
    deploying — see DEPLOY_VPS.md §3.2 (migration repair)."
fi

if [ -z "$pending" ]; then
  ok "hosted project is UP TO DATE — nothing to apply"
  step "Done"
  info "no migrations were applied; the rollout can proceed"
  exit 0
fi

pending_count="$(printf '%s' "$pending" | tr ',' '\n' | grep -c . || true)"
warn "$pending_count pending migration(s): $pending"

# ── Step 4: pre-enable checks ────────────────────────────────────────────────
# See the header: both of these make a push "succeed" while leaving the database
# unable to run the schedules the migrations define. Checked ONLY when something
# is actually pending — on an up-to-date project these extensions are already in
# place and re-asserting them would fail a no-op run for no reason.

step "4/6  Pre-enable checks (vector / pg_cron)"

ext_sql="select
  coalesce((select e.extnamespace::regnamespace::text from pg_extension e where e.extname='vector'),'') as vector_schema,
  coalesce((select count(*)::text from pg_extension e where e.extname='pg_cron'),'0') as pg_cron_count"

if ! ext_json="$(npx --no-install supabase db query --linked --output-format json "$ext_sql" 2>/dev/null)"; then
  die "could not query the hosted project for extension state. If the project is paused, resume it in the dashboard and re-run."
fi

vector_schema="$(json_query "$ext_json" "d[0].vector_schema")"
pg_cron_count="$(json_query "$ext_json" "d[0].pg_cron_count")"

if [ -z "$vector_schema" ]; then
  die "the 'vector' extension is NOT enabled on the hosted project.
    Migrations 0001/0039 need it. Enable it FIRST:
      Dashboard → Database → Extensions → enable 'vector' with schema = extensions
    Skipping this makes 0039 abort MID-PUSH and leaves a partially applied
    history (DEPLOY_VPS.md §3.1 step 1)."
fi
if [ "$vector_schema" != "extensions" ]; then
  die "the 'vector' extension is in schema '$vector_schema', but 0039 requires 'extensions'.
    It hard-fails otherwise (raise exception ... found elsewhere). Drop and
    reinstall the extension in the 'extensions' schema before migrating."
fi
ok "vector extension present in schema 'extensions'"

if [ "$pg_cron_count" = "0" ]; then
  die "the 'pg_cron' extension is NOT enabled on the hosted project.
    The seven schedules (0019/0022/0030/0042 + 0059's AI sweep/escalate pair)
    are created inside guarded blocks and 'create extension pg_cron' needs
    superuser, so the push would report SUCCESS with ZERO jobs and the app
    would look healthy while autoclose, the silence check, both prunes and AI
    marking never run. Enable it FIRST:
      Dashboard → Database → Extensions → enable 'pg_cron'
    Then re-run this script (DEPLOY_VPS.md §3.1 step 2)."
fi
ok "pg_cron extension present"

# ── Step 4b: destructive-DDL check on the PENDING migrations only ────────────
# This is what makes the documented rollback story true rather than aspirational.
# Rollback reverts the IMAGE but never the schema (`migrate` is skipped on a
# rollback), so rolling back is only safe while migrations are ADDITIVE: the
# older image ignores columns it does not know about. A pending migration that
# DROPs a column or table breaks that property — the old image would be missing
# something it reads, and the correct fix is a forward migration, not a rollback.
#
# Only PENDING files are scanned: the two historical `drop column` statements
# (0010, 0039) are already applied and `if exists`-guarded, so flagging them
# would train the operator to ignore this check. A warning rather than a hard
# failure, because a destructive migration is sometimes exactly what is intended
# — the point is that it is never accidental and never silent.

destructive_hits=""
for v in $(printf '%s' "$pending" | tr ',' ' '); do
  # The version in the history is the numeric prefix of the filename.
  f="$(find supabase/migrations -name "${v}_*.sql" | head -1)"
  [ -n "$f" ] || continue
  # Match real destructive DDL, excluding the routine drop-if-exists of
  # policies/triggers/functions/indexes/views/types that every migration here
  # uses to be re-runnable.
  hits="$(grep -n -i -E '^[[:space:]]*(alter[[:space:]]+table[^;]*[[:space:]]drop[[:space:]]+column|drop[[:space:]]+table|alter[[:space:]]+table[^;]*[[:space:]]drop[[:space:]]+constraint)' "$f" 2>/dev/null \
    | grep -v -i 'if exists' || true)"
  [ -n "$hits" ] && destructive_hits="${destructive_hits}${f}:
${hits}
"
done

if [ -n "$destructive_hits" ]; then
  printf '\n\033[1;33m⚠  DESTRUCTIVE DDL in a PENDING migration:\033[0m\n'
  printf '%s' "$destructive_hits" | sed 's/^/   /'
  warn "if this deploy fails after the push, ROLLING BACK THE IMAGE IS NOT SAFE —"
  warn "the older image may read a column this migration removes. The fix is a"
  warn "forward migration that re-adds it, or a restore from backup (DEPLOY_VPS.md §10)."
  warn "Continuing, because a destructive migration is sometimes intended."
else
  ok "pending migrations are additive (no destructive DDL) — image rollback stays safe"
fi

# ── Step 5: push ─────────────────────────────────────────────────────────────
# The dry-run is run even when not in --dry-run mode, so the CLI's own list is in
# the deploy log next to the decision this script made from JSON. If the two ever
# disagree, the log shows it.

step "5/6  Push"

info "--- CLI dry-run (authoritative listing) ---"
npx --no-install supabase db push --linked --dry-run 2>&1 | sed 's/^/   /' || true
info "--- end dry-run ---"

if [ "$DRY_RUN" -eq 1 ]; then
  step "Done (dry run)"
  info "$pending_count migration(s) WOULD be applied; nothing was changed"
  exit 0
fi

# --yes: the CLI otherwise prompts for confirmation, which hangs an unattended
# job until its timeout.
if npx --no-install supabase db push --linked --yes 2>&1 | sed 's/^/   /'; then
  ok "push completed"
else
  die "supabase db push FAILED. If it aborted part-way, the history is now
    inconsistent (a version recorded as neither applied nor absent) — inspect with
    'supabase migration list --linked' and repair before re-running
    (DEPLOY_VPS.md §3.2)."
fi

# ── Step 6: verify ───────────────────────────────────────────────────────────
# `db push` reporting success is not evidence the schema is usable: see the
# pg_cron case in the header, where it succeeds and silently creates no jobs.
# These are the checks that turn "the command exited 0" into "the database is
# actually in the state the app needs".

if [ "$SKIP_VERIFY" -eq 1 ]; then
  warn "--skip-verify given: the post-push checks did NOT run"
  exit 0
fi

step "6/6  Verify"

# 6a — history parity. After a successful push every local version must have a
# remote counterpart. A version still showing local-only means it did not apply.
if ! after="$(npx --no-install supabase migration list --linked --output-format json 2>/dev/null)"; then
  die "could not re-read the migration history after the push"
fi
still_pending="$(json_query "$after" "d.migrations.filter(m=>!m.remote||String(m.remote).trim()==='').map(m=>m.local).join(',')")"
if [ -n "$still_pending" ]; then
  die "these migration(s) are STILL not applied after a push that reported success: $still_pending
    The push did not do what it claimed. Inspect the remote history and repair
    (DEPLOY_VPS.md §3.2) before deploying the image."
fi
ok "history parity: every local migration is applied remotely"

# 6b — the cron jobs actually exist. This is the check for the silent failure:
# without pg_cron pre-enabled the push succeeds and creates nothing, and because
# the versions are then recorded as applied, re-running the push will NOT retry.
cron_sql="select count(*)::text as n from cron.job where jobname like 'innovision-%'"
if cron_json="$(npx --no-install supabase db query --linked --output-format json "$cron_sql" 2>/dev/null)"; then
  cron_n="$(json_query "$cron_json" "d[0].n")"
  if [ "$cron_n" = "$EXPECTED_CRON_JOBS" ]; then
    ok "pg_cron: $cron_n/$EXPECTED_CRON_JOBS innovision-* jobs scheduled"
  else
    die "pg_cron has $cron_n innovision-* job(s), expected $EXPECTED_CRON_JOBS.
    The schedules did not take. Because the migration versions are now recorded
    as APPLIED, re-running db push will NOT retry them — re-create the jobs from
    the dashboard Cron UI, or 'supabase migration repair <version> --status
    reverted' for 0019/0022/0030/0042/0059 and push again (DEPLOY_VPS.md §3.1 step 5)."
  fi
else
  warn "could not query cron.job (permissions?) — verify the seven schedules manually (DEPLOY_VPS.md §3.1 step 5)"
fi

# 6b-ii — the AI marking worker URL/key. `sweep_ai_marks()` reads these from the
# DATABASE (it cannot see the app's env file), so an unprovisioned project
# claims rows and never POSTs: short_text answers stay `pending` forever, which
# blocks v_all_done and the quiz never auto-reveals. This is the step that makes
# the feature actually function on a fresh deploy.
#
# Idempotent: `alter database ... set` overwrites, and the Vault write deletes
# any prior secret of the same name first (vault.create_secret raises on a
# duplicate name). A failure here WARNS rather than dies — the schema is already
# correct and marking can be driven by the operator curl fallback, so a hard
# failure would block an otherwise-good deploy.
if [ -n "$AI_MARK_WORKER_URL" ] && [ -n "$AI_MARK_WORKER_KEY" ]; then
  # VAULT IS THE PRIMARY HOME for both values, because it is the only mechanism
  # that works on a hosted project: `alter database ... set` requires superuser,
  # which the hosted `postgres` role does not have. Vault is available on every
  # paid/hosted plan and is encrypted at rest, which is the right place for the
  # key regardless. `app.settings` remains the migration's fallback read for
  # self-hosted installs where Vault may be absent.
  #
  # vault.create_secret takes its value as a SQL literal (it is a function
  # argument, not a parameterizable placeholder through this CLI), so reject a
  # single quote rather than trusting the shape: a broken deploy log is far
  # better than an injected statement against the production database.
  case "$AI_MARK_WORKER_URL" in
    *"'"*) die "AI_MARK_WORKER_URL contains a single quote — refusing to interpolate it into SQL" ;;
  esac
  case "$AI_MARK_WORKER_KEY" in
    *"'"*) die "AI_MARK_WORKER_KEY contains a single quote — refusing to interpolate it into SQL" ;;
  esac

  # Delete-then-create keeps the step re-runnable; vault.create_secret rejects a
  # duplicate name.
  vault_sql="do \$\$ begin
    delete from vault.secrets where name in ('ai_mark_worker_url', 'ai_mark_worker_key');
    perform vault.create_secret('$AI_MARK_WORKER_URL', 'ai_mark_worker_url',
      'POST target for 0057 sweep_ai_marks (Bearer to /api/internal/ai-mark-sweep)');
    perform vault.create_secret('$AI_MARK_WORKER_KEY', 'ai_mark_worker_key',
      'Bearer for /api/internal/ai-mark-sweep (0057 sweep_ai_marks)');
  end \$\$;"
  if npx --no-install supabase db query --linked "$vault_sql" >/dev/null 2>&1; then
    ok "ai_mark_worker_url + ai_mark_worker_key stored in Vault"
  else
    warn "could not write the Vault secrets (Vault unavailable on this plan?) —"
    warn "trying app.settings, which sweep_ai_marks also reads (self-hosted path)"
    if npx --no-install supabase db query --linked \
         "alter database postgres set app.settings.ai_mark_worker_url to '$AI_MARK_WORKER_URL'" \
         >/dev/null 2>&1 \
       && npx --no-install supabase db query --linked \
         "alter database postgres set app.settings.ai_mark_worker_key to '$AI_MARK_WORKER_KEY'" \
         >/dev/null 2>&1; then
      ok "ai_mark_worker_url + ai_mark_worker_key provisioned as database-level settings"
    else
      warn "could not provision either store — set them manually (DEPLOY_VPS.md §3.1 step 5b)."
      warn "Until then short_text AI marking does NOT fire (answers stay pending)."
    fi
  fi
else
  warn "AI_MARK_WORKER_URL/KEY not provided (no SITE_ORIGIN / service-role key) —"
  warn "short_text AI marking will NOT fire until they are provisioned (DEPLOY_VPS.md §3.1 step 5b)"
fi

# 6c — storage buckets. Migration-owned, so a push should have created them; the
# count is the cheap invariant that catches a partially applied history.
bucket_sql="select count(*)::text as n from storage.buckets"
if bucket_json="$(npx --no-install supabase db query --linked --output-format json "$bucket_sql" 2>/dev/null)"; then
  bucket_n="$(json_query "$bucket_json" "d[0].n")"
  if [ "$bucket_n" -ge "$EXPECTED_BUCKETS" ] 2>/dev/null; then
    ok "storage: $bucket_n bucket(s) present (expected >= $EXPECTED_BUCKETS)"
  else
    warn "storage has $bucket_n bucket(s), expected at least $EXPECTED_BUCKETS — check DEPLOY_VPS.md §3.1 step 6"
  fi
else
  warn "could not query storage.buckets — verify the four buckets manually"
fi

# ── The re-apply checklist ───────────────────────────────────────────────────
# Documented in DEPLOY_VPS.md §2.7. A push re-asserts whatever the migrations
# own, so dashboard tuning that a migration also sets is reverted. This is by
# design, but it is invisible unless something says so at the moment it happens.

printf '\n\033[1;33m⚠  A db push re-applies migration-owned settings. Verify these in the dashboard:\033[0m\n'
cat <<'EOF'
   [ ] Data API "Max Rows" (migrations reset it)
   [ ] Storage bucket size limits / allowed MIME types, if you had raised them
   [ ] SMTP settings (re-send a test email if the push touched auth)
   [ ] Realtime publication membership for `notifications`
   [ ] pg_cron jobs present and firing  (checked above)
   Full list: docs/DEPLOY_VPS.md §2.7
EOF

printf '\n\033[1;32mSchema sync complete\033[0m — %s migration(s) applied\n\n' "$pending_count"

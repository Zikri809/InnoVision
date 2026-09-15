#!/usr/bin/env bash
#
# remote-deploy.sh — the VPS side of the CI → GHCR → VPS rollout.
#
# Invoked by .github/workflows/deploy.yml over SSH after CI passes, and usable
# by hand for a rollback or a manual deploy:
#
#   bash deploy/remote-deploy.sh                     # normal rollout
#   bash deploy/remote-deploy.sh --rollback          # back to the previous images
#   bash deploy/remote-deploy.sh --no-decrypt        # keep the existing .env.local
#
# WHY THIS EXISTS AS A SCRIPT AND NOT AS A LIST OF SSH COMMANDS IN THE WORKFLOW:
# a rollout has ordering that matters (decrypt → pull → record rollback point →
# recreate → wait healthy → verify what actually shipped) and every step can
# fail in a way that leaves the host in a state an operator must be able to read
# back. Multi-line YAML `script:` blocks cannot be run or debugged locally, and
# a partial failure there is invisible. This file runs on the VPS, is readable
# in full, and prints a rollback command on every path.
#
# ── WHAT THIS SCRIPT DELIBERATELY DOES NOT DO ───────────────────────────────
#
# 1. It does NOT start `caddy`. This host runs NGINX on :80/:443 (see
#    deploy/nginx/innovision.conf). A bare `docker compose up -d` starts only
#    the unprofiled services — `app` + `insightface-service` — because `caddy`
#    and `glm-ocr` are both profile-gated. Step 3 below additionally STOPS a
#    caddy container left running by an earlier revision of the compose file,
#    because a leftover Caddy would crash-loop against nginx's port bind while
#    the rest of the stack stayed green.
#
# 2. It does NOT start `glm-ocr`. There is no GPU on this host and the OCR runs
#    on the Z.ai API (`GLM_PROVIDER=remote`). Starting the container would fail
#    on the nvidia device reservation, or fall back to CPU and hold 16g/8cpu.
#
# 3. It does NOT build. The image is built on a GitHub runner (where the vCPU
#    cost is free and the build args come from repository config) and pulled
#    from GHCR here. `PLAN_VPS_DEPLOYMENT.md` leaves GHCR-vs-build open; this is
#    the GHCR arm, and `COSTS.md` recommends it for exactly the reason above.
#
# ── THE BUILD/RUNTIME SPLIT THIS SCRIPT GUARDS ──────────────────────────────
#
# `NEXT_PUBLIC_*`, `ALLOWED_HOSTS` and the `/sb` rewrite gate are INLINED by
# `next build` on the runner and cannot be changed by anything done here. The
# runbook's "named trap" is a VPS whose `.env.local` names one origin while the
# image baked another: the stack boots healthy and the failure surfaces later as
# "the login form silently resets" or "every browser-direct Supabase call
# fails". Step 7 closes that gap by reading back what the running container
# reports it baked and failing the deploy on a mismatch — but only when the
# expectations are supplied (see EXPECT_BAKED_SUPABASE_ORIGIN below).

set -euo pipefail

# ── Configuration (override via environment) ─────────────────────────────────

# Where the repo is checked out on this host. Matches docs/DEPLOY_VPS.md §1,
# with a fallback to $HOME/innovision: the deploy user is not necessarily
# `deploy` (the workflow's sync step accepts either location), and a hardcoded
# path would make this script die with "repo dir not found" on a host whose
# checkout lives elsewhere. Override explicitly with REPO_DIR=...
if [ -z "${REPO_DIR:-}" ]; then
  if [ -d /home/deploy/innovision ]; then
    REPO_DIR=/home/deploy/innovision
  else
    REPO_DIR="$HOME/innovision"
  fi
fi

# Compose project name — must equal `name:` in docker-compose.yml. Used to find
# this project's containers by label.
COMPOSE_PROJECT="${COMPOSE_PROJECT:-innovision}"

# SOPS-encrypted secrets and the age key that decrypts them.
SECRETS_ENC="${SECRETS_ENC:-deploy/secrets/prod.env.enc}"
AGE_KEY_FILE="${AGE_KEY_FILE:-/etc/innovision/age.key}"

# The runtime env file the compose `app` service reads via `env_file:`.
ENV_FILE="${ENV_FILE:-.env.local}"

# Where the image refs are written for compose interpolation. Compose reads
# `.env` (NOT `.env.local`) for `${VAR}` substitution.
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env}"

# Image refs to deploy. Empty means "keep whatever .env already names", which is
# what makes `--rollback` work: it swaps in the previous refs and re-runs.
APP_IMAGE="${APP_IMAGE:-}"
INSIGHTFACE_IMAGE="${INSIGHTFACE_IMAGE:-}"

# Optional expectations for what the IMAGE baked (see the header). Left unset,
# step 7 reports the observed values and warns instead of asserting.
EXPECT_BAKED_SUPABASE_ORIGIN="${EXPECT_BAKED_SUPABASE_ORIGIN:-}"
EXPECT_ALLOWED_HOSTS="${EXPECT_ALLOWED_HOSTS:-}"

# Local URL for health polling. The app publishes 127.0.0.1:3000 ONLY.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"

# Registry login (optional; only needed if the GHCR packages are private).
GHCR_USER="${GHCR_USER:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"

ROLLBACK=0
DECRYPT=1

# ── Output helpers ───────────────────────────────────────────────────────────

step()  { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
info()  { printf '   %s\n' "$*"; }
ok()    { printf '   \033[0;32mOK\033[0m  %s\n' "$*"; }
warn()  { printf '   \033[0;33mWARN\033[0m  %s\n' "$*"; }
die()   { printf '\n\033[0;31mFAIL\033[0m  %s\n' "$*" >&2; exit 1; }

# Upsert a KEY=VALUE into the compose interpolation file without disturbing any
# other line an operator may have added there.
#
# Defined here, in the helpers section, rather than next to its first caller:
# bash resolves a function at the point of CALL, so a definition placed after a
# use fails at runtime with "command not found" — and only on the code path that
# reaches it. The first call is in step 4b (the sidecar-token mirror).
upsert_env() {
  local file="$1" key="$2" value="$3"
  if [ -f "$file" ] && grep -qE "^${key}=" "$file"; then
    # Rewrite via a temp file so a failure cannot truncate the original.
    awk -v k="$key" -v v="$value" '
      $0 ~ "^"k"=" { print k"="v; next } { print }
    ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# A heredoc rather than `sed -n '2,40p' "$0"`: the CI workflow pipes this script
# into `bash -s`, where $0 is just "bash" and reading "$0" would fail. The usage
# text must not depend on how the script was invoked.
usage() {
  cat <<'USAGE'
remote-deploy.sh — the VPS side of the CI → GHCR → VPS rollout.

  bash deploy/remote-deploy.sh                # normal rollout
  bash deploy/remote-deploy.sh --rollback     # back to the previous images
  bash deploy/remote-deploy.sh --no-decrypt   # keep the existing .env.local

Environment overrides:
  REPO_DIR      checkout location (default: /home/deploy/innovision, else $HOME/innovision)
  APP_IMAGE     image ref to deploy (default: whatever .env already names)
  INSIGHTFACE_IMAGE
  ENV_FILE      runtime env file (default: .env.local)
  AGE_KEY_FILE  age private key (default: /etc/innovision/age.key)
  GHCR_USER / GHCR_TOKEN   only needed for private GHCR packages
  EXPECT_BAKED_SUPABASE_ORIGIN / EXPECT_ALLOWED_HOSTS
                assert what the IMAGE baked (see the header)

Starts `app` + `insightface-service` only. `caddy` (nginx owns :80/:443) and
`glm-ocr` (no GPU here) are profile-gated and are not started.
USAGE
  exit 0
}

# ── Argument parsing ─────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --rollback)   ROLLBACK=1 ;;
    --no-decrypt) DECRYPT=0 ;;
    -h|--help)    usage ;;
    *)            die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# ── Step 1: preflight ────────────────────────────────────────────────────────
# Every requirement is checked BEFORE anything is mutated, so a missing tool or
# a typo'd path fails here rather than half way through a rollout.

step "1/7  Preflight"

[ -d "$REPO_DIR" ] || die "repo dir not found: $REPO_DIR (set REPO_DIR=...)"
cd "$REPO_DIR" || die "cannot cd to $REPO_DIR"
[ -f docker-compose.yml ] || die "no docker-compose.yml in $REPO_DIR — is this the repo root?"
ok "repo $REPO_DIR"

for cmd in docker curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not available (docker compose version failed)"

if [ "$DECRYPT" -eq 1 ]; then
  command -v sops >/dev/null 2>&1 || die "sops not found — see deploy/secrets/README.md for install"
  [ -f "$SECRETS_ENC" ] || die "encrypted secrets not found: $SECRETS_ENC"
  [ -f "$AGE_KEY_FILE" ] || die "age key not found: $AGE_KEY_FILE (set AGE_KEY_FILE=...)"
  # Refuse a world- or group-readable private key. This is the whole security
  # property of the SOPS setup: if the key is readable by anything else on the
  # box, the encryption protects the file only from the git history.
  perms="$(stat -c '%a' "$AGE_KEY_FILE" 2>/dev/null || echo '')"
  case "$perms" in
    600|400) ok "age key present, mode $perms" ;;
    "")      warn "cannot stat $AGE_KEY_FILE — continuing" ;;
    *)       die "age key $AGE_KEY_FILE is mode $perms; must be 600 (chmod 600)" ;;
  esac
fi

# Warn (never fail) on an absent optional expectation — the deploy still works,
# but the build/runtime divergence guard below is inert.
[ -n "$EXPECT_BAKED_SUPABASE_ORIGIN" ] || warn "EXPECT_BAKED_SUPABASE_ORIGIN unset — the baked-Supabase check will report, not assert"
[ -n "$EXPECT_ALLOWED_HOSTS" ] || warn "EXPECT_ALLOWED_HOSTS unset — the baked-allowlist check will report, not assert"

ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
ok "compose $(docker compose version --short 2>/dev/null || echo '?')"
ok "repo $REPO_DIR"

# ── Step 2: registry login (optional) ────────────────────────────────────────
# Only when credentials were supplied. Public GHCR packages need no login, so an
# absent token is not an error — it is the documented default for this repo.

if [ -n "$GHCR_USER" ] && [ -n "$GHCR_TOKEN" ]; then
  step "2/7  Registry login"
  # Never echo the token; --password-stdin keeps it out of the process table.
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null \
    || die "docker login ghcr.io failed — check the token's read:packages scope"
  ok "logged in to ghcr.io as $GHCR_USER"
else
  step "2/7  Registry login — skipped (no GHCR_USER/GHCR_TOKEN supplied)"
fi

# ── Step 3: make sure the port-80/443 services are NOT running ───────────────
# The compose file profile-gates `caddy`, so a bare `up` will not start it. This
# step covers the OTHER direction: a caddy container already running from an
# earlier revision (before the profile existed). Left alone it would hold :443
# and nginx would fail to reload — or Caddy itself would crash-loop against
# nginx's bind, which is the failure mode that looks like "nothing is wrong"
# because every other container stays healthy.

step "3/7  Guard the host-proxy ports"

caddy_id="$(docker ps \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
  --filter "label=com.docker.compose.service=caddy" \
  --format '{{.ID}}' 2>/dev/null || true)"

if [ -n "$caddy_id" ]; then
  warn "a caddy container from this project is RUNNING (${caddy_id:0:12}) but this host uses NGINX on :80/:443"
  docker compose --profile tls stop caddy >/dev/null 2>&1 || docker stop "$caddy_id" >/dev/null 2>&1 || true
  ok "stopped caddy (nginx owns the public ports; see deploy/nginx/innovision.conf)"
else
  ok "no caddy container running"
fi

glm_id="$(docker ps \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
  --filter "label=com.docker.compose.service=glm-ocr" \
  --format '{{.ID}}' 2>/dev/null || true)"
if [ -n "$glm_id" ]; then
  warn "a glm-ocr container is running (${glm_id:0:12}) — this host has no GPU and uses the Z.ai remote leg"
  warn "leaving it alone; if it is holding 16g/8cpu, stop it: docker compose --profile gpu stop glm-ocr"
else
  ok "no glm-ocr container running"
fi

# ── Step 4: decrypt runtime secrets ─────────────────────────────────────────
# The plaintext exists only here, at deploy time, mode 0600. The committed file
# is the encrypted form (deploy/secrets/prod.env.enc).

step "4/7  Runtime secrets"

if [ "$DECRYPT" -eq 1 ]; then
  # umask before the redirect so the file is never briefly world-readable.
  # `sops --output` writes the plaintext directly; the previous file is replaced
  # only on success, so a decrypt failure cannot leave an empty env file that
  # would silently boot the app with no service-role key.
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod 600 "$tmp"
  # ⚠️ --input-type/--output-type dotenv ARE REQUIRED, not tidiness.
  # sops auto-detects the format from the file EXTENSION, and `.enc` tells it
  # nothing — so it falls back to JSON and dies on a dotenv file with:
  #
  #     Error unmarshalling input json: invalid character 'S' looking for beginning of value
  #
  # MEASURED with sops 3.12.2: without these flags the decrypt fails and writes
  # NO output file, so the deploy aborts at this step every time. The message
  # names JSON parsing, which sends you looking at the wrong thing entirely.
  if ! SOPS_AGE_KEY_FILE="$AGE_KEY_FILE" sops --decrypt \
         --input-type dotenv --output-type dotenv \
         --output "$tmp" "$SECRETS_ENC"; then
    rm -f "$tmp"
    die "sops decryption failed — is AGE_KEY_FILE ($AGE_KEY_FILE) the key this file was encrypted to?"
  fi
  # A decrypt that "succeeds" into an empty file would boot an app with no
  # secrets at all, which fails much later and less clearly than failing here.
  [ -s "$tmp" ] || { rm -f "$tmp"; die "decrypted secrets are EMPTY — refusing to deploy"; }
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "decrypted $SECRETS_ENC -> $ENV_FILE (mode 600)"
else
  [ -f "$ENV_FILE" ] || die "--no-decrypt given but $ENV_FILE does not exist"
  ok "kept existing $ENV_FILE"
fi

# A missing or empty service-role key is the single most common half-finished
# VPS env, and the app boots and serves anonymous traffic before anything
# visibly breaks. Fail here instead.
grep -qE '^SUPABASE_SERVICE_ROLE_KEY=.+' "$ENV_FILE" \
  || die "$ENV_FILE has no non-empty SUPABASE_SERVICE_ROLE_KEY — the app would boot without server-side DB access"

# ── Step 4b: mirror FACE_SIDECAR_TOKEN into the compose-interpolation .env ───
# This var is the ONE secret that must hold the SAME value in two places, and
# they are read by two different mechanisms:
#
#   app container                reads .env.local  (env_file:)   ← decrypted from SOPS
#   insightface-service container reads the project-root .env     ← compose interpolation
#
# SOPS writes only the first. Without this step, ROTATING the token updates the
# app but leaves the sidecar expecting the old value — and because the sidecar
# rejects a mismatch with 401 (docker/insightface/app/main.py:_check_token), the
# symptom is that every face enrolment and verification silently stops working
# while /api/health stays green. The app's client omits the header entirely when
# its token is empty, so the reverse drift (sidecar set, app empty) fails the
# same way.
#
# Copying it on EVERY deploy is what makes the two sides converge no matter which
# one was edited: an operator only ever changes the SOPS file, and the host's
# .env is derived state. Doing this in the deploy script (rather than documenting
# "remember to update both") is the difference between a mechanism and a wish.
#
# The value is never echoed — only whether it is set.
sidecar_token="$(grep -E '^FACE_SIDECAR_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
if [ -n "$sidecar_token" ]; then
  upsert_env "$COMPOSE_ENV_FILE" FACE_SIDECAR_TOKEN "$sidecar_token"
  ok "FACE_SIDECAR_TOKEN mirrored into $COMPOSE_ENV_FILE (sidecar + app in sync)"
else
  # Not fatal, but loud: an empty token is a prod-guards violation under
  # PROD_ENV_STRICT=1, so the app will refuse to boot and the error names the key.
  warn "FACE_SIDECAR_TOKEN is empty in $ENV_FILE — the app will refuse to boot (prod-guards gate S1). Set it in SOPS."
fi

# ── Step 5: image refs + rollback point ─────────────────────────────────────

step "5/7  Images"

# Rollback support: remember what is CURRENTLY deployed before anything changes,
# so `--rollback` has something to go back to. Recorded as the resolved image
# refs, which is what compose needs to recreate the containers.
PREV_FILE=".deploy-previous-images"
if [ "$ROLLBACK" -eq 1 ]; then
  [ -f "$PREV_FILE" ] || die "--rollback requested but $PREV_FILE does not exist (no previous deploy recorded)"
  # shellcheck disable=SC1090
  . "$PREV_FILE"
  APP_IMAGE="${PREV_APP_IMAGE:?$PREV_FILE has no PREV_APP_IMAGE}"
  INSIGHTFACE_IMAGE="${PREV_INSIGHTFACE_IMAGE:?$PREV_FILE has no PREV_INSIGHTFACE_IMAGE}"
  # ⚠️ THIS WRITE IS THE WHOLE ROLLBACK. compose interpolates ${APP_IMAGE} from
  # $COMPOSE_ENV_FILE, so setting the shell variable alone would change nothing:
  # `compose pull` would re-pull the ref still recorded in the file (i.e. the
  # one being rolled back FROM) and the "rollback" would be a no-op that
  # reported success. PREV_FILE is deliberately left UNCHANGED so repeated
  # --rollback runs are idempotent and keep returning to the same known-good
  # ref, rather than toggling between the last two deploys.
  upsert_env "$COMPOSE_ENV_FILE" APP_IMAGE "$APP_IMAGE"
  upsert_env "$COMPOSE_ENV_FILE" INSIGHTFACE_IMAGE "$INSIGHTFACE_IMAGE"
  warn "rolling back to app=$APP_IMAGE insightface=$INSIGHTFACE_IMAGE"
else
  if [ -n "$APP_IMAGE" ] && [ -n "$INSIGHTFACE_IMAGE" ]; then
    # Snapshot the refs compose is currently interpolating, not the running
    # container's digest: a tag-based rollback re-pulls that tag, which is what
    # an operator expects.
    cur_app="$(grep -E '^APP_IMAGE=' "$COMPOSE_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    cur_face="$(grep -E '^INSIGHTFACE_IMAGE=' "$COMPOSE_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    if [ -n "$cur_app" ] && [ "$cur_app" != "$APP_IMAGE" ]; then
      {
        printf 'PREV_APP_IMAGE=%s\n' "$cur_app"
        printf 'PREV_INSIGHTFACE_IMAGE=%s\n' "${cur_face:-}"
      } > "$PREV_FILE"
      ok "rollback point recorded (app=$cur_app)"
    elif [ -n "$cur_app" ]; then
      info "re-deploying the same app ref already recorded — rollback point kept"
    else
      warn "no previous APP_IMAGE in $COMPOSE_ENV_FILE — nothing to roll back to yet"
    fi
    upsert_env "$COMPOSE_ENV_FILE" APP_IMAGE "$APP_IMAGE"
    upsert_env "$COMPOSE_ENV_FILE" INSIGHTFACE_IMAGE "$INSIGHTFACE_IMAGE"
  else
    [ -f "$COMPOSE_ENV_FILE" ] || die "no APP_IMAGE/INSIGHTFACE_IMAGE supplied and no $COMPOSE_ENV_FILE to read them from"
    APP_IMAGE="$(grep -E '^APP_IMAGE=' "$COMPOSE_ENV_FILE" | head -1 | cut -d= -f2-)"
    INSIGHTFACE_IMAGE="$(grep -E '^INSIGHTFACE_IMAGE=' "$COMPOSE_ENV_FILE" | head -1 | cut -d= -f2-)"
    [ -n "$APP_IMAGE" ] || die "APP_IMAGE is not set anywhere — pass APP_IMAGE=ghcr.io/... or set it in $COMPOSE_ENV_FILE"
  fi
fi

info "app          $APP_IMAGE"
info "insightface  ${INSIGHTFACE_IMAGE:-<from .env>}"

# The compose file must still resolve with these values before we touch the
# running stack — a syntax error here is caught with the OLD stack still up.
docker compose config --quiet || die "docker compose config failed with the current $COMPOSE_ENV_FILE"

docker compose pull || die "image pull failed — check the refs above and the registry login"
ok "images pulled"

# ── Step 6: recreate the stack ──────────────────────────────────────────────
# No --profile: this starts exactly `app` + `insightface-service`. `--wait`
# blocks until both are healthy (both images carry HEALTHCHECKs), which is what
# makes the next step meaningful rather than a race.

step "6/7  Recreate stack"

docker compose up -d --wait --wait-timeout "$HEALTH_TIMEOUT_S" \
  || die "compose up did not reach a healthy state within ${HEALTH_TIMEOUT_S}s — inspect: docker compose logs --tail=100 app"

ok "app + insightface-service healthy"

# ── Step 7: verify what is actually running ─────────────────────────────────

step "7/7  Verify"

# 7a — the app answers on loopback, liveness + DB reachability.
health="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || true)"
[ -n "$health" ] || die "$HEALTH_URL did not answer — docker compose logs app"
case "$health" in
  *'"ok":true'*) ok "health: ok" ;;
  *) die "health returned ok!=true: $health" ;;
esac
case "$health" in
  *'"reachable":true'*) ok "db: reachable" ;;
  # Deliberately fatal. The app can boot without the DB, so a deploy that
  # "succeeds" here would be a green rollout of a stack that cannot serve a
  # single authenticated request.
  *) die "health reports db unreachable — check SUPABASE_* in $ENV_FILE and the hosted project's status: $health" ;;
esac

# 7b — THE UFW/DOCKER CHECK. Docker publishes ports by writing its own iptables
# rules, which BYPASS ufw's filter chain: `ufw deny 3000` is silently
# ineffective against a container that publishes 0.0.0.0:3000. The loopback
# bind in docker-compose.yml is the real access control, so assert on the bind
# rather than trusting a firewall rule that does not apply.
listeners="$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' || true)"
if [ -z "$listeners" ]; then
  warn "cannot list listening sockets (no ss/netstat) — verify manually that 3000/8000 are loopback-only"
else
  for port in 3000 8000; do
    bind="$(printf '%s\n' "$listeners" | grep -E "[:.]${port}\$" | head -1 || true)"
    case "$bind" in
      "")                warn "nothing listening on :$port yet (container may still be starting)" ;;
      127.0.0.1:$port)   ok "port $port bound to 127.0.0.1 (loopback-only)" ;;
      [::1]:$port)       ok "port $port bound to [::1] (loopback-only)" ;;
      *)                 die "port $port is bound to '$bind' — NOT loopback. Docker bypasses ufw, so this is internet-exposed. Check the publish in docker-compose.yml" ;;
    esac
  done
  # 80/443 must be owned by the HOST nginx, not by a container.
  for port in 80 443; do
    bind="$(printf '%s\n' "$listeners" | grep -E "[:.]${port}\$" | head -1 || true)"
    [ -n "$bind" ] || warn "nothing listening on :$port — is nginx running? (systemctl status nginx)"
  done
fi

# 7c — the build/runtime divergence guard (see the header). The app's entrypoint
# prints what the IMAGE baked; compare it against the deployment's expectation.
# This is the only place that can catch "image built for origin A, env file
# names origin B" — a mismatch that otherwise surfaces as a silently failing
# login form much later.
logs="$(docker compose logs --no-color --tail=200 app 2>/dev/null || true)"
if [ -n "$logs" ]; then
  baked_sb="$(printf '%s\n' "$logs" | sed -n 's/.*\[entrypoint\] baked NEXT_PUBLIC_SUPABASE_URL origin: \(.*\)$/\1/p' | tail -1)"
  baked_hosts="$(printf '%s\n' "$logs" | sed -n 's/.*\[entrypoint\] allowed hosts (serverActions\.allowedOrigins, FROZEN): \(.*\)$/\1/p' | tail -1)"

  if [ -n "$baked_sb" ]; then
    if [ -n "$EXPECT_BAKED_SUPABASE_ORIGIN" ]; then
      if [ "$baked_sb" = "$EXPECT_BAKED_SUPABASE_ORIGIN" ]; then
        ok "baked Supabase origin matches: $baked_sb"
      else
        die "BUILD/RUNTIME MISMATCH — the image baked Supabase origin '$baked_sb' but this deployment expects '$EXPECT_BAKED_SUPABASE_ORIGIN'. The image was built with different build args; rebuild and re-push (an origin change is a REBUILD, not an env flip)"
      fi
    else
      info "baked Supabase origin: $baked_sb  (unverified — set EXPECT_BAKED_SUPABASE_ORIGIN to assert)"
    fi
  else
    warn "could not read the baked Supabase origin from the app logs"
  fi

  if [ -n "$baked_hosts" ]; then
    if [ -n "$EXPECT_ALLOWED_HOSTS" ]; then
      # Comma-separated list membership, not equality: next.config.ts folds
      # several inputs into one allowlist, so the frozen list legitimately
      # carries more entries than the single expected host.
      if printf '%s' "$baked_hosts" | tr ',' '\n' | tr -d ' ' | grep -qx "$EXPECT_ALLOWED_HOSTS"; then
        ok "baked allowlist contains $EXPECT_ALLOWED_HOSTS"
      else
        die "BUILD/RUNTIME MISMATCH — the image's frozen allowedOrigins is '$baked_hosts', which does NOT contain '$EXPECT_ALLOWED_HOSTS'. Server actions from that origin will 403; rebuild with ALLOWED_HOSTS/NEXT_PUBLIC_SITE_URL set"
      fi
    else
      info "baked allowlist: $baked_hosts  (unverified — set EXPECT_ALLOWED_HOSTS to assert)"
    fi
  fi

  # The hop count is RUNTIME-read, so it is not baked — but it is the knob whose
  # misconfiguration silently collapses every per-IP rate limit into one shared
  # bucket, which is worth surfacing on every deploy.
  proxy_count="$(printf '%s\n' "$logs" | sed -n 's/.*\[entrypoint\] TRUSTED_PROXY_COUNT: \(.*\)$/\1/p' | tail -1)"
  [ -n "$proxy_count" ] && info "TRUSTED_PROXY_COUNT: $proxy_count (expect 1 behind host nginx)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

printf '\n\033[1;32mDeploy complete\033[0m\n'
info "app          $APP_IMAGE"
info "running      $(docker compose ps --services --status running 2>/dev/null | tr '\n' ' ')"
info "rollback     cd $REPO_DIR && bash deploy/remote-deploy.sh --rollback"
printf '\n'

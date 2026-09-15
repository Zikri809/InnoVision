#!/usr/bin/env bash
#
# vps-preflight.sh — read-only check of everything the deploy pipeline assumes
# about a host, BEFORE the first deploy.
#
#   bash deploy/vps-preflight.sh
#
# Changes NOTHING. No writes, no restarts, no docker commands that mutate state.
# Every FAIL is something that will break a deploy; every WARN is something worth
# knowing that is not necessarily wrong.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
# The pipeline's failure modes are mostly silent-until-production: nginx's 1 MB
# body default 413s an OCR upload before the app sees it; a missing ALLOWED_HOSTS
# makes every server action 403 with the login form just resetting; a missing
# sops binary aborts the rollout on the VPS. Each is cheap to check here and
# expensive to diagnose live. Run this on the host, once, before the first
# deploy — and again after any host rebuild.

set -uo pipefail

# Not `set -e`: every check must run even when an earlier one fails, so the
# operator sees the whole picture in one pass instead of fixing one thing at a
# time and re-running.

fails=0
warns=0

hdr()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
pass() { printf '  \033[0;32mPASS\033[0m  %s\n' "$*"; }
warn() { printf '  \033[0;33mWARN\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
fail() { printf '  \033[0;31mFAIL\033[0m  %s\n' "$*"; fails=$((fails + 1)); }
note() { printf '        %s\n' "$*"; }

# Values the pipeline expects. Override to match a different layout.
REPO_CANDIDATES="/home/deploy/innovision $HOME/innovision /opt/innovision"
AGE_KEY_FILE="${AGE_KEY_FILE:-/etc/innovision/age.key}"
APP_DOMAIN="${APP_DOMAIN:-prod-innovision.zikr-i.uk}"

printf '\033[1mInnoVision VPS preflight\033[0m — read-only, changes nothing\n'
printf 'host: %s   user: %s   date: %s\n' "$(hostname 2>/dev/null || echo '?')" "$(id -un)" "$(date -u +%Y-%m-%dT%H:%MZ)"

# ── 1. Base tooling ──────────────────────────────────────────────────────────

hdr "1. Required tooling"

if command -v docker >/dev/null 2>&1; then
  pass "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
  if docker compose version >/dev/null 2>&1; then
    pass "compose plugin $(docker compose version --short 2>/dev/null)"
  else
    fail "the docker compose PLUGIN is missing (docker compose version failed).
        The pipeline runs 'docker compose pull/up'. Install docker-compose-plugin."
  fi
  if docker info >/dev/null 2>&1; then
    pass "docker daemon reachable by $(id -un)"
  else
    fail "docker daemon NOT reachable by $(id -un) — add the user to the docker group
        (usermod -aG docker $(id -un) && re-login), or the deploy cannot run."
  fi
else
  fail "docker not installed"
fi

# sops is REQUIRED on the host: remote-deploy.sh decrypts the env file here.
if command -v sops >/dev/null 2>&1; then
  pass "sops $(sops --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
else
  fail "sops NOT installed — the deploy aborts at step 4 (it decrypts secrets on this host).
        Debian/Ubuntu default repos usually do NOT carry it. Install the release binary:
          curl -L https://github.com/getsops/sops/releases/latest/download/sops-v3.12.2.linux.amd64 -o /usr/local/bin/sops
          chmod +x /usr/local/bin/sops
        (or add the official apt repo)."
fi

command -v git >/dev/null 2>&1 && pass "git $(git --version 2>/dev/null | awk '{print $3}')" || fail "git not installed"
command -v curl >/dev/null 2>&1 && pass "curl present" || fail "curl not installed (the deploy health-checks with it)"

# ── 2. Host resources ────────────────────────────────────────────────────────
# COSTS.md §2.1: >=2 vCPU, >=4 GB RAM, >=20 GB disk. The insightface image alone
# is ~2.65 GB on disk and its model bake is CPU-heavy at build time (built in CI
# here, but pulled to this host).

hdr "2. Resources"

cpus="$(nproc 2>/dev/null || echo 0)"
if [ "$cpus" -ge 2 ] 2>/dev/null; then pass "$cpus vCPU"; else warn "$cpus vCPU — COSTS.md suggests >= 2"; fi

mem_mb="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$mem_mb" -ge 3800 ] 2>/dev/null; then
  pass "$((mem_mb / 1024)) GB RAM"
elif [ "$mem_mb" -gt 0 ] 2>/dev/null; then
  warn "$((mem_mb / 1024)) GB RAM — COSTS.md suggests >= 4 GB. The app and the face
        sidecar both carry mem_limit ceilings; an undersized host OOM-kills under load."
else
  warn "could not read /proc/meminfo"
fi

disk_gb="$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
if [ "${disk_gb:-0}" -ge 20 ] 2>/dev/null; then
  pass "${disk_gb} GB free on /"
elif [ "${disk_gb:-0}" -gt 0 ] 2>/dev/null; then
  warn "${disk_gb} GB free on / — images alone need ~3 GB, plus build layers on pull"
fi

# ── 3. nginx: the two MEASURED breakages ─────────────────────────────────────
# Both are nginx DEFAULTS that are wrong for this app, and both fail before the
# app sees the request, so nothing appears in the app's logs.

hdr "3. nginx"

if command -v nginx >/dev/null 2>&1; then
  pass "nginx $(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

  # Search every place a directive can legitimately live.
  conf_files="/etc/nginx/nginx.conf"
  for d in /etc/nginx/conf.d /etc/nginx/sites-enabled /etc/nginx/sites-available; do
    [ -d "$d" ] && conf_files="$conf_files $(find "$d" -name '*.conf' 2>/dev/null | tr '\n' ' ')"
  done

  # shellcheck disable=SC2086
  body_size="$(grep -rhoE '^[[:space:]]*client_max_body_size[[:space:]]+[^;]+;' $conf_files 2>/dev/null | head -1)"
  if [ -n "$body_size" ]; then
    pass "client_max_body_size: $(printf '%s' "$body_size" | awk '{print $2}')"
    note "(the app accepts ~34 MB OCR bodies and 25 MB x 5 PDF batches)"
  else
    fail "client_max_body_size is NOT set — nginx defaults to 1 MB.
        MEASURED: a 2 MB POST returns 413. Every OCR upload and quiz-source PDF
        above 1 MB fails BEFORE the app sees it, so nothing is logged app-side.
        Add at SERVER level in the 443 block:  client_max_body_size 60M;"
  fi

  # shellcheck disable=SC2086
  read_to="$(grep -rhoE '^[[:space:]]*proxy_read_timeout[[:space:]]+[^;]+;' $conf_files 2>/dev/null | head -1)"
  if [ -n "$read_to" ]; then
    pass "proxy_read_timeout: $(printf '%s' "$read_to" | awk '{print $2}')"
  else
    fail "proxy_read_timeout is NOT set — nginx defaults to 60s.
        MEASURED: 75s of upstream silence returns 504 at exactly 60.1s. The OCR
        remote leg budgets 120s, so large PDFs fail intermittently with a
        gateway timeout no app log explains.
        Add at SERVER level:  proxy_read_timeout 300s;  proxy_send_timeout 300s;"
  fi

  # A config that does not parse cannot be reloaded, and the next reload fails.
  if nginx -t >/dev/null 2>&1; then
    pass "nginx -t (current config parses)"
  else
    fail "nginx -t FAILED — the config on disk does not parse. Fix before deploying:
        sudo nginx -t   # shows the error"
  fi

  # Which vhost names are served (the domain must match the baked ALLOWED_HOSTS).
  # shellcheck disable=SC2086
  names="$(grep -rhoE '^[[:space:]]*server_name[[:space:]]+[^;]+;' $conf_files 2>/dev/null | awk '{$1=""; print}' | tr -d ';' | tr -s ' ' | sort -u | tr '\n' ' ')"
  if [ -n "$names" ]; then
    pass "server_name: $names"
    case "$names" in
      *"$APP_DOMAIN"*) pass "the expected domain '$APP_DOMAIN' is served" ;;
      *) warn "'$APP_DOMAIN' was not found in server_name. The image bakes an allowlist
        from ALLOWED_HOSTS/SITE_ORIGIN — a mismatch makes every server action 403
        and the login form appear to just reset. Set APP_DOMAIN=... if this host
        legitimately serves a different name." ;;
    esac
  fi

  # The proxy target must be the app's loopback publish.
  # shellcheck disable=SC2086
  proxied="$(grep -rhoE 'proxy_pass[[:space:]]+http://[^;]+;' $conf_files 2>/dev/null | head -3 | tr '\n' ' ')"
  [ -n "$proxied" ] && { pass "proxy_pass: $proxied"; note "(the app publishes 127.0.0.1:3000 ONLY)"; }
else
  fail "nginx not installed — but this host is documented to run it on :80/:443.
        If you use the compose 'caddy' service instead, start it with:
          docker compose --profile tls up -d"
fi

# ── 4. Ports — the loopback bind is the real access control ──────────────────
# Docker publishes ports by writing its own iptables rules, which BYPASS ufw's
# filter chain. So 'ufw deny 3000' does not stop a container publishing
# 0.0.0.0:3000 — the loopback bind in docker-compose.yml is the control, and it
# is what the deploy asserts.

hdr "4. Listening ports"

listeners="$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' )"
if [ -z "$listeners" ]; then
  warn "neither ss nor netstat available — cannot verify port bindings"
else
  for port in 3000 8000; do
    bind="$(printf '%s\n' "$listeners" | grep -E "[:.]${port}\$" | head -1)"
    case "$bind" in
      "")               pass "nothing on :$port (expected before the first deploy)" ;;
      127.0.0.1:$port|\[::1\]:$port) pass ":$port bound to $bind (loopback-only)" ;;
      *)                fail ":$port is bound to '$bind' — NOT loopback, so it is internet-exposed.
        Docker bypasses ufw, so a firewall rule will not save this. Find and stop
        whatever is publishing it:  ss -ltnp | grep :$port" ;;
    esac
  done
  for port in 80 443; do
    bind="$(printf '%s\n' "$listeners" | grep -E "[:.]${port}\$" | head -1)"
    if [ -n "$bind" ]; then pass ":$port listening ($bind)"
    else warn "nothing on :$port — is nginx running? (systemctl status nginx)"; fi
  done
fi

# A leftover Caddy from a pre-profile compose revision fights nginx for :80/:443.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -qi caddy; then
    warn "a CADDY container is running. This host uses nginx on :80/:443, so Caddy is
        either crash-looping on the port bind or holding the port. Check:
          docker ps | grep caddy ; docker logs <id> --tail 20
        The compose 'caddy' service is profile-gated (profiles: [tls]) so a bare
        'docker compose up -d' will not start it — remote-deploy.sh stops a
        leftover one automatically."
  else
    pass "no caddy container running"
  fi
  if docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -qi glm-ocr; then
    warn "a glm-ocr container is running. This host has no GPU and uses the Z.ai remote
        leg; the container would hold 16g/8cpu. Stop it: docker compose --profile gpu stop glm-ocr"
  fi
fi

# ── 5. Firewall ──────────────────────────────────────────────────────────────

hdr "5. Firewall (ufw)"

if command -v ufw >/dev/null 2>&1; then
  status="$(ufw status 2>/dev/null | head -1)"
  printf '  %s\n' "$status"
  if ufw status 2>/dev/null | grep -qE '^Status: active'; then
    for rule in 22 80 443; do
      if ufw status 2>/dev/null | grep -qE "^${rule}(/tcp)?\s+ALLOW"; then
        pass "port $rule allowed"
      else
        # 22 is the lockout risk; 80/443 are the public service.
        if [ "$rule" = "22" ]; then
          warn "port 22 is not explicitly allowed — if ufw is enabled with default-deny
        you may lose SSH on the next reload. Verify before touching ufw."
        else
          warn "port $rule not explicitly allowed (needed for ACME + HTTPS)"
        fi
      fi
    done
    note "NOTE: published container ports BYPASS ufw entirely (Docker writes its own"
    note "iptables rules). The loopback bind checked in section 4 is the real control."
  else
    warn "ufw is inactive — the loopback binds are then the only access control"
  fi
else
  warn "ufw not installed (fine if you use another firewall, or none)"
fi

# ── 6. Repo checkout + secrets ───────────────────────────────────────────────

hdr "6. Repo checkout and secrets"

repo=""
for c in $REPO_CANDIDATES; do
  # shellcheck disable=SC2086
  [ -d "$c" ] && [ -f "$c/docker-compose.yml" ] && { repo="$c"; break; }
done

if [ -n "$repo" ]; then
  pass "repo at $repo"
  cd "$repo" || true
  if [ -d .git ]; then
    pass "git checkout at $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
    if [ -n "$(git status --porcelain 2>/dev/null | head -1)" ]; then
      warn "the checkout has LOCAL MODIFICATIONS. The deploy does 'git checkout --force',
        which discards them. Untracked .env files survive (verified), but tracked-file
        edits are lost."
    fi
  else
    warn "$repo is not a git checkout — the deploy syncs it with git fetch/checkout"
  fi

  if [ -f .env ]; then
    pass "project-root .env present (compose interpolation)"
    if grep -qE '^FACE_SIDECAR_TOKEN=.+' .env; then
      pass "FACE_SIDECAR_TOKEN is set in .env (matches the app's copy)"
    else
      warn "FACE_SIDECAR_TOKEN is empty/absent in .env. remote-deploy.sh mirrors it from
        the decrypted secrets on every deploy, so this is only a problem if the SOPS
        value is also empty — which makes the app REFUSE TO BOOT (prod-guards gate S1)."
    fi
    if grep -qE '^(APP_IMAGE|INSIGHTFACE_IMAGE)=' .env; then
      pass "APP_IMAGE / INSIGHTFACE_IMAGE recorded (rollback point)"
    else
      note "no APP_IMAGE yet — written by the first deploy"
    fi
  else
    warn "no project-root .env. The deploy creates/writes it (it is where APP_IMAGE and
        the sidecar token live). compose reads .env, NOT .env.local."
  fi

  if [ -f deploy/secrets/prod.env.enc ]; then
    pass "encrypted secrets present (deploy/secrets/prod.env.enc)"
  else
    warn "deploy/secrets/prod.env.enc is ABSENT — nothing to decrypt, so the deploy will
        fail at step 4. Run deploy/secrets/bootstrap.sh on your machine and commit it."
  fi
else
  warn "no repo checkout found in: $REPO_CANDIDATES
        Clone it (or set REPO_DIR=... for the deploy):
          sudo -u deploy git clone <repo-url> /home/deploy/innovision"
fi

hdr "6b. age key"

if [ -f "$AGE_KEY_FILE" ]; then
  perms="$(stat -c '%a' "$AGE_KEY_FILE" 2>/dev/null)"
  case "$perms" in
    600|400) pass "$AGE_KEY_FILE mode $perms" ;;
    *) fail "$AGE_KEY_FILE is mode $perms — must be 600. remote-deploy.sh REFUSES to
        decrypt otherwise: a world-readable private key protects the file only from
        the git history. Fix:  chmod 600 $AGE_KEY_FILE" ;;
  esac
  owner="$(stat -c '%U' "$AGE_KEY_FILE" 2>/dev/null)"
  [ "$owner" = "$(id -un)" ] && pass "owned by $(id -un)" \
    || note "owned by '$owner' — the deploy user must be able to read it"
else
  fail "age key NOT found at $AGE_KEY_FILE — the deploy cannot decrypt secrets.
        Copy it from your machine (NEVER via git):
          scp deploy/secrets/innovision-prod.agekey root@<host>:/etc/innovision/age.key
          chown deploy:deploy /etc/innovision/age.key && chmod 600 /etc/innovision/age.key"
fi

# ── 7. Network reachability ──────────────────────────────────────────────────

hdr "7. Outbound reachability"

if command -v curl >/dev/null 2>&1; then
  curl -fsS -m 10 -o /dev/null https://ghcr.io/v2/ 2>/dev/null \
    && pass "ghcr.io reachable (image pull)" \
    || note "ghcr.io returned non-200 (normal for an unauthenticated /v2/ probe — not necessarily a problem)"

  curl -fsS -m 10 -o /dev/null https://api.z.ai/ 2>/dev/null \
    && pass "api.z.ai reachable (remote OCR leg)" \
    || warn "api.z.ai did not answer — the remote OCR leg would fail. Check DNS/egress."

  # The hosted Supabase URL is baked into the image, so read it from the env if present.
  sb="$(grep -hoE '^NEXT_PUBLIC_SUPABASE_URL=https://[^[:space:]]+' .env .env.local 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ -n "$sb" ]; then
    curl -fsS -m 10 -o /dev/null "$sb/auth/v1/health" 2>/dev/null \
      && pass "Supabase project reachable ($sb)" \
      || warn "Supabase project did NOT answer at $sb — free-tier projects PAUSE after
        ~7 days idle, which also stops the pg_cron jobs. Resume it in the dashboard."
  else
    note "no hosted NEXT_PUBLIC_SUPABASE_URL found in .env/.env.local to probe"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

printf '\n\033[1m── Summary ──────────────────────────────────────────\033[0m\n'
if [ "$fails" -eq 0 ] && [ "$warns" -eq 0 ]; then
  printf '\033[1;32mAll checks passed.\033[0m The host is ready for a deploy.\n\n'
elif [ "$fails" -eq 0 ]; then
  printf '\033[1;33m%d warning(s), 0 failures.\033[0m Review the warnings; the deploy can proceed.\n\n' "$warns"
else
  printf '\033[0;31m%d failure(s), %d warning(s).\033[0m Fix the failures before deploying —\n' "$fails" "$warns"
  printf 'each one aborts the rollout or breaks a feature at runtime.\n\n'
  exit 1
fi

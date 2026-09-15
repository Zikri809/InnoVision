#!/usr/bin/env bash
#
# build-images.sh — build the two images the VPS runs, and optionally push them.
#
# This is the "build script" that runs right after CI passes (see
# .github/workflows/deploy.yml). It is ALSO runnable by hand, which is the
# point: the build-arg contract below is the part of a deploy that is easiest to
# get subtly wrong, so it lives in one reviewable file rather than in a
# multi-line `run:` block inside YAML that nobody can execute locally.
#
#   bash deploy/build-images.sh                        # build both, no push
#   bash deploy/build-images.sh --push                 # build + push to GHCR
#   bash deploy/build-images.sh --app-only --push
#
# ── WHAT IT BUILDS ───────────────────────────────────────────────────────────
#   app                the Next.js standalone server (repo-root Dockerfile),
#                      listening on :3000. Multi-stage: deps → next build →
#                      standalone runner as `node` (uid 1000).
#   insightface-service  the face sidecar (docker/insightface). Built in CI
#                      because it COMPILES C extensions (insightface 0.7.3
#                      sdist + Cython mesh) — COSTS.md flags vCPU build minutes
#                      as UNVERIFIED and recommends pulling a prebuilt image
#                      rather than building on the VPS for exactly this reason.
#
# ── THE BUILD-TIME CONTRACT (the part that bites) ────────────────────────────
# Three families bake into the app artifact at `next build` and CANNOT be
# changed afterwards by editing the container's runtime environment:
#
#   1. `NEXT_PUBLIC_*`   — inlined into the client bundle.
#   2. `ALLOWED_HOSTS`   — read at module scope in next.config.ts to build
#                          serverActions.allowedOrigins / allowedDevOrigins.
#   3. the `/sb` rewrite gate — `rewrites()` runs once during loadCustomRoutes;
#                          the standalone server serves the FROZEN routes
#                          manifest and never re-invokes it.
#
# VERIFIED IN THIS REPO, not assumed: `.next/standalone` contains the literal
# Supabase URL and does NOT contain the string
# `process.env.NEXT_PUBLIC_SUPABASE_URL`. So an origin change is a REBUILD, and
# this script is the only place that decides it.
#
# ── THE KILL SWITCHES ARE HARD-PINNED, AND THE SCRIPT REFUSES TO LEAK THEM ───
# `NEXT_PUBLIC_E2E_FAKE_SEAM` and `NEXT_PUBLIC_INTEGRITY_HARDENING_OFF` are
# INLINED at build time. A harness-built image promoted to the VPS keeps them
# forever and silently disables every face verification / integrity hardening.
# They are passed as literal "0" below — never read from the environment — and
# the script FAILS if the ambient environment tries to set either to 1, so a
# leaked value in the CI job env is a loud error rather than a poisoned
# artifact. This mirrors the assertion in .github/workflows/ci.yml (gate S5).

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.." || exit 1

APP_ONLY=0
FACE_ONLY=0
PUSH=0
PLATFORM="${PLATFORM:-linux/amd64}"

# Tag defaults to the short SHA so every push is traceable to a commit; CI
# overrides it with the same value it records in the run summary.
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo manual)}"

# Registry prefix. GHCR requires a LOWERCASE repository path, and the GitHub
# owner is `Zikri809` — so the prefix is lowercased explicitly rather than
# hoping the caller remembers.
REGISTRY="${REGISTRY:-ghcr.io}"
OWNER="${OWNER:-$(git config --get remote.origin.url 2>/dev/null \
  | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#' | tr '[:upper:]' '[:lower:]')}"
OWNER="${OWNER:-zikri809}"

APP_IMAGE="${APP_IMAGE:-${REGISTRY}/${OWNER}/innovision-app}"
FACE_IMAGE="${FACE_IMAGE:-${REGISTRY}/${OWNER}/innovision-insightface}"

step() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   \033[0;32mOK\033[0m  %s\n' "$*"; }
warn() { printf '   \033[0;33mWARN\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[0;31mFAIL\033[0m  %s\n' "$*" >&2; exit 1; }

# Defined BEFORE the argument loop below, which calls it for -h/--help: bash
# resolves the function at the point of CALL, so a definition placed after the
# loop would make `--help` fail with "usage: command not found".
#
# A heredoc rather than reading "$0", so the text does not depend on how the
# script was invoked (a piped `bash -s` has $0 == "bash").
usage() {
  cat <<'USAGE'
build-images.sh — build the two images the VPS runs, and optionally push them.

  bash deploy/build-images.sh                 # build both, no push
  bash deploy/build-images.sh --push          # build + push to GHCR
  bash deploy/build-images.sh --app-only --push
  bash deploy/build-images.sh --face-only --push

Flags:
  --push            push to the registry (default: build only)
  --app-only        build only the Next.js app image
  --face-only       build only the insightface sidecar image
  --tag TAG         image tag (default: the short git SHA)
  --platform P      target platform (default: linux/amd64)

Environment:
  NEXT_PUBLIC_SUPABASE_URL        REQUIRED  hosted project URL (build arg)
  NEXT_PUBLIC_SUPABASE_ANON_KEY   REQUIRED  hosted anon key  (build arg)
  SITE_ORIGIN                     public https origin (also used for SITE_URL
                                  and TRUSTED_ORIGINS unless overridden)
  ALLOWED_HOSTS / ALLOWED_ORIGINS extra hostnames for the action allowlist
  APP_IMAGE / FACE_IMAGE          image names (default: ghcr.io/<owner>/...)
  REGISTRY / OWNER                registry + namespace overrides
  ALLOW_LOCAL_SUPABASE_BUILD=1    permit a loopback Supabase URL (local-only image)

The kill switches NEXT_PUBLIC_E2E_FAKE_SEAM / NEXT_PUBLIC_INTEGRITY_HARDENING_OFF
are hard-pinned to "0" and the script REFUSES to run if the ambient environment
arms them — they would be inlined into the artifact permanently.
USAGE
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --push)      PUSH=1 ;;
    --app-only)  APP_ONLY=1 ;;
    --face-only) FACE_ONLY=1 ;;
    --platform)  PLATFORM="${2:?--platform needs a value}"; shift ;;
    --tag)       TAG="${2:?--tag needs a value}"; shift ;;
    -h|--help)   usage ;;
    *)           die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || die "docker not found"

# ── Gate S5: refuse to bake a harness kill switch ────────────────────────────
# Checked BEFORE any build so a poisoned env fails in seconds instead of after a
# multi-minute image build. Normalized (trim + lowercase) so `False` and `"0 "`
# are handled deliberately rather than by the glob not matching.

step "0/3  Kill-switch preflight (gate S5)"

for key in NEXT_PUBLIC_E2E_FAKE_SEAM NEXT_PUBLIC_INTEGRITY_HARDENING_OFF E2E_RATE_LIMIT_DISABLED FACE_MOCK_ENABLED; do
  raw="${!key:-}"
  value="${raw#"${raw%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value,,}"
  case "$value" in
    ""|"0"|"false") ;;
    *) die "$key=$raw is set in this build environment. It would be INLINED into the app image and silently disable face verification / integrity hardening forever. Unset it and rebuild." ;;
  esac
done
ok "no kill switch is armed in the build environment"

# ── Build args for the app image ─────────────────────────────────────────────

build_app() {
  step "1/3  Build app image"

  # Every one of these is a BUILD-time input (see the header). An empty
  # NEXT_PUBLIC_SUPABASE_ANON_KEY is not merely unwise: src/lib/env.ts throws at
  # boot on an empty value, and the Dockerfile documents a MEASURED
  # `docker build .` → exit 1 for exactly this reason. Fail with a clear message
  # here rather than letting Next's page-data collection report it obscurely.
  : "${NEXT_PUBLIC_SUPABASE_URL:?set NEXT_PUBLIC_SUPABASE_URL (e.g. https://<ref>.supabase.co)}"
  : "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?set NEXT_PUBLIC_SUPABASE_ANON_KEY (the build FAILS without it — src/lib/env.ts throws on an empty value)}"

  # The public origin. Set BOTH NEXT_PUBLIC_SITE_URL and SITE_URL to the same
  # https:// value: site-url.ts prefers SITE_URL for emailed links (password
  # reset, confirmation, SSO callback) while the public one feeds ALLOWED_HOSTS.
  # A deploy that sets only one gets working pages and broken emails.
  SITE_ORIGIN="${SITE_ORIGIN:-${NEXT_PUBLIC_SITE_URL:-}}"
  if [ -z "$SITE_ORIGIN" ]; then
    warn "NEXT_PUBLIC_SITE_URL/SITE_ORIGIN unset — the image will bake the repo's DEFAULT host allowlist"
  fi
  if [ -n "$SITE_ORIGIN" ] && [ -z "${SITE_URL:-}" ]; then
    warn "SITE_URL unset while SITE_ORIGIN is set — emailed links (reset/confirm/SSO) will use the public origin instead. Set both to the same value."
  fi

  # ALLOWED_HOSTS is the operator-facing name; ALLOWED_ORIGINS is the original
  # one next.config.ts reads. BOTH are passed because the config folds the pair
  # into the same allowlist — before the alias existed, setting only
  # ALLOWED_HOSTS had NO effect.
  local host="${ALLOWED_HOSTS:-$(printf '%s' "$SITE_ORIGIN" | sed -E 's#^https?://##; s#/.*$##')}"

  info "image                ${APP_IMAGE}:${TAG}"
  info "NEXT_PUBLIC_SUPABASE_URL  ${NEXT_PUBLIC_SUPABASE_URL}"
  info "site origin          ${SITE_ORIGIN:-<unset>}"
  info "allowed host         ${host:-<unset>}"
  info "platform             $PLATFORM"

  # Guard the single highest-consequence arg: a LOCAL Supabase URL baked into an
  # image that is then deployed to a VPS bakes a 127.0.0.1 origin that a remote
  # browser resolves to its own machine, so every browser-direct Supabase call
  # fails while the server keeps working. That asymmetry is why this is worth a
  # hard stop rather than a warning.
  case "$NEXT_PUBLIC_SUPABASE_URL" in
    *127.0.0.1*|*localhost*)
      if [ "${ALLOW_LOCAL_SUPABASE_BUILD:-0}" != "1" ]; then
        die "NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL is a LOOPBACK url. That is right for a local dev image and wrong for a deployed one — a remote browser resolves 127.0.0.1 to its own machine, so every browser-direct Supabase call fails while the server keeps working. Set the hosted URL, or set ALLOW_LOCAL_SUPABASE_BUILD=1 if you really mean a local-only image."
      fi
      warn "building with a LOOPBACK Supabase URL (ALLOW_LOCAL_SUPABASE_BUILD=1) — this image cannot serve a remote browser"
      ;;
  esac

  docker build \
    --file Dockerfile \
    --tag "${APP_IMAGE}:${TAG}" \
    --tag "${APP_IMAGE}:latest" \
    --platform "$PLATFORM" \
    --build-arg "NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}" \
    --build-arg "NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
    --build-arg "NEXT_PUBLIC_SITE_URL=${SITE_ORIGIN}" \
    --build-arg "SITE_URL=${SITE_URL:-}" \
    --build-arg "TRUSTED_ORIGINS=${TRUSTED_ORIGINS:-}" \
    --build-arg "ALLOWED_HOSTS=${host}" \
    --build-arg "ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-}" \
    --build-arg "NEXT_PUBLIC_E2E_FAKE_SEAM=0" \
    --build-arg "NEXT_PUBLIC_INTEGRITY_HARDENING_OFF=0" \
    . || die "app image build failed"

  ok "built ${APP_IMAGE}:${TAG}"
}

build_face() {
  step "2/3  Build insightface image"

  info "image     ${FACE_IMAGE}:${TAG}"
  info "platform  $PLATFORM"
  info "(compiles insightface from sdist + bakes sha256-pinned model weights — expect several minutes cold)"

  # Context is docker/insightface, NOT the repo root: the sidecar needs only its
  # own app/ + requirements.txt, and shipping node_modules/playwright-report to
  # the daemon costs minutes for nothing.
  docker build \
    --file docker/insightface/Dockerfile \
    --tag "${FACE_IMAGE}:${TAG}" \
    --tag "${FACE_IMAGE}:latest" \
    --platform "$PLATFORM" \
    docker/insightface || die "insightface image build failed"

  ok "built ${FACE_IMAGE}:${TAG}"
}

# ── Push ─────────────────────────────────────────────────────────────────────

push_images() {
  step "3/3  Push to ${REGISTRY}"

  [ "$APP_ONLY" -eq 1 ] || docker push "${FACE_IMAGE}:${TAG}" || die "push failed: ${FACE_IMAGE}:${TAG}"
  [ "$APP_ONLY" -eq 1 ] || docker push "${FACE_IMAGE}:latest" || die "push failed: ${FACE_IMAGE}:latest"
  [ "$FACE_ONLY" -eq 1 ] || docker push "${APP_IMAGE}:${TAG}" || die "push failed: ${APP_IMAGE}:${TAG}"
  [ "$FACE_ONLY" -eq 1 ] || docker push "${APP_IMAGE}:latest" || die "push failed: ${APP_IMAGE}:latest"

  ok "pushed (tag ${TAG} + latest)"
}

# ── Run ──────────────────────────────────────────────────────────────────────

if [ "$FACE_ONLY" -eq 1 ]; then
  build_face
elif [ "$APP_ONLY" -eq 1 ]; then
  build_app
else
  build_app
  build_face
fi

if [ "$PUSH" -eq 1 ]; then
  push_images
else
  step "3/3  Push — skipped (pass --push to publish)"
fi

# Emit the refs in a form both a human and the workflow can consume. Printed
# LAST so it is the final thing in the log on success.
printf '\n\033[1;32mBuild complete\033[0m\n'
printf 'APP_IMAGE=%s:%s\n' "$APP_IMAGE" "$TAG"
printf 'INSIGHTFACE_IMAGE=%s:%s\n' "$FACE_IMAGE" "$TAG"

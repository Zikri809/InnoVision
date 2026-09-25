# ─────────────────────────────────────────────────────────────────────────────
# InnoVision — application image (Next.js 16, `next build` → `node server.js`).
#
# The runtime is the STANDALONE server (`output: "standalone"` emits
# `.next/standalone/server.js`), NOT `next start`. The two are not
# interchangeable: `next start` refuses to run against a standalone build
# ("next start does not work with output: standalone"), so any doc or comment
# that describes this container as running `next start` is wrong and will
# misdirect an operator debugging a frozen routes manifest.
#
# Gate O1 of docs/PLAN_VPS_DEPLOYMENT.md §10.3. Target: the vCPU VPS, where
# Supabase is HOSTED and GLM-OCR is the Z.ai API (no GPU, no local Kong).
#
# WHY THIS IMAGE EXISTS: `output: "standalone"` (next.config.ts) emits a
# self-contained server under `.next/standalone` (traced node_modules +
# server.js). The repo had no app Dockerfile at all, so the VPS had nothing to
# run; the two sidecars (insightface, glm-ocr) are NOT this image.
#
# ── THE BUILD-TIME vs RUNTIME SPLIT (plan §B1.8) — READ BEFORE DEBUGGING ─────
# These bake into the artifact at `next build` and CANNOT be changed by editing
# the container's runtime environment; every one of them needs a REBUILD:
#   - NEXT_PUBLIC_*                  (inlined into the client bundle)
#   - ALLOWED_HOSTS family           (next.config.ts → serverActions.allowedOrigins)
#   - the /sb rewrite gate           (rewrites() runs once in loadCustomRoutes;
#                                     the standalone server serves the FROZEN
#                                     routes manifest and never re-invokes it)
# The build args below therefore carry exactly that family. An operator who
# sets them only at runtime gets silent server-action aborts (wrong origin) and
# a `/sb` proxy pointing at a Kong gateway that does not exist on the VPS.
# `TRUSTED_ORIGINS` is the ONE origin var that reads per request — it is
# runtime-flippable, and it lives in the compose `env_file`, not here.
#
# ── SECRETS ──────────────────────────────────────────────────────────────────
# There are deliberately NO `COPY .env*` instructions anywhere below.
# `.dockerignore` excludes `.env`, `.env.*` and `.env.local.example`'s siblings,
# so no dotenv file can enter the build context. The build args below are
# TREATED as non-secret: every one is INTENDED to be a public origin or a
# NEXT_PUBLIC_* value that ships to the browser anyway. Server-only secrets
# (SUPABASE_SERVICE_ROLE_KEY, ZAI_API_KEY, FACE_SIDECAR_TOKEN, VLLM_API_KEY)
# arrive at RUNTIME through compose's `env_file:` and are never seen by the
# build.
#
# "TREATED as non-secret" is NOT "verified non-secret", and this file used to
# claim the stronger one. The build cannot check what an operator actually
# passes, and a CREDENTIALED URL is a real shape for the highest-consequence arg
# here: a Supabase pooler connection string is
# `postgres://user:password@host:port/db`, and the pooler URL sits next to the
# API URL in the dashboard. The entrypoint used to echo the authority verbatim,
# so `docker run -e BUILD_NEXT_PUBLIC_SUPABASE_URL=https://user:pw@x.supabase.co`
# printed the password into `docker logs` on every restart. It now prints a
# SANITIZED origin only (scheme://host[:port]: userinfo, query and hash dropped;
# an unparseable value is never echoed at all) — see /app/startup-check.mjs.
# Treat every build arg as log-safe-BY-SANITIZATION, not as clean input.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependencies ────────────────────────────────────────────────────
# node:22-slim (Debian bookworm, glibc) rather than alpine: `sharp` ships
# prebuilt glibc binaries and musl would force a source build; CI pins node 22,
# so the runtime matches the tested engine.
FROM node:22-slim AS deps

WORKDIR /app

# `npm ci` needs the lockfile + manifest only. Copying them FIRST (before the
# source) keeps this layer cached across code edits — a rebuild after a
# src-only change never re-downloads the dependency tree.
COPY package.json package-lock.json ./

# `npm ci` is the CI-equivalent install: lockfile-exact, and it fails loudly if
# package.json and package-lock.json have drifted. Optional deps stay ON
# (default) because that is how the linux-x64 sharp binary and @next/swc are
# selected — `--omit=optional` would strip the platform bindings the build needs.
RUN npm ci

# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# The whole dependency tree (dev deps included — `next build` needs TypeScript,
# Tailwind/PostCSS and the eslint-config-next toolchain to resolve).
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# ── BUILD ARGS — the build-time env family (contract §2 / plan §B1.8) ────────
# Every one of these is consumed by `next build` BELOW, not by the runtime.
# Defaults are the LOCAL posture (local-Kong Supabase, no extra origins), which
# is the right DEFAULT for a dev build; the VPS build passes its hosted values
# explicitly.
#
# ⚠️ A BARE `docker build .` DOES NOT SUCCEED — it fails during "Collecting page
# data" with `NEXT_PUBLIC_SUPABASE_ANON_KEY: Too small: expected string to have
# >=1 characters` (src/lib/env.ts validates it at module evaluation, and
# `src/lib/supabase/server.ts` imports it into every API route). That is
# deliberate fail-closed behaviour in the app, not a bug here: an image built
# with a blank anon key could not talk to Supabase at all. But the arg defaults
# below cannot rescue it — there is no safe non-empty default for a key that
# must match a specific project. MEASURED: `docker build .` → exit 1 with the
# error above; `docker build --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<key> …`
# → exit 0. So every real build MUST pass the anon key (compose does, via
# `docker compose build app` with the project-root `.env`). Do NOT add secrets
# here (see the SECRETS note in the header).

# Which Supabase the bundle points at. This single value decides TWO things:
#   1. what the browser talks to (baked into the client bundle), and
#   2. the /sb rewrite gate — a hosted `https://<ref>.supabase.co` makes
#      `rewrites()` return [] so the dead local-Kong proxy is NOT shipped.
# A hosted build with this left at the default bakes a 127.0.0.1 origin that a
# remote browser resolves to its own machine: every browser-direct Supabase
# call fails. This is the highest-consequence arg in the file.
ARG NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:58021"
# Public anon key — ships to the browser by design. `src/lib/env.ts` validates
# it at boot and THROWS on an empty value, so a blank build arg breaks startup
# rather than degrading silently (which is the intent). Consequence: there is NO
# usable default, and a bare `docker build .` fails at page-data collection —
# see the BUILD ARGS note above. Always pass it.
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
# Public deployment origin. Feeds next.config.ts ALLOWED_HOSTS (→
# serverActions.allowedOrigins / allowedDevOrigins) and the GoTrue redirect
# origins via src/lib/auth/site-url.ts.
ARG NEXT_PUBLIC_SITE_URL=""
# Server-side absolute origin for emailed links (password reset, confirmation,
# SSO callback). src/lib/auth/site-url.ts prefers SITE_URL over the public one.
ARG SITE_URL=""
# Comma-separated scheme-included origins allowed to differ from Host. Feeds
# next.config.ts ALLOWED_HOSTS (BUILD) — the runtime twin of the same name is
# read per request by checkSameOrigin (src/lib/http.ts), and BOTH must list the
# public origin or actions abort silently / mutations 403.
ARG TRUSTED_ORIGINS=""
# Extra hostnames (wildcards OK) for the same allowlist. `ALLOWED_HOSTS` is the
# name the operator docs use; `ALLOWED_ORIGINS` is the name next.config.ts reads.
# BOTH are declared and both feed the allowlist (next.config.ts reads the pair),
# because a documented build arg that nothing reads is a silent no-op: an
# operator who set only ALLOWED_HOSTS used to get NO effect from it.
ARG ALLOWED_HOSTS=""
ARG ALLOWED_ORIGINS=""
# Harness kill switches. MUST be "0" (or empty) for a production image: these
# are INLINED into the client bundle, so a harness-built image promoted to the
# VPS carries them forever and silently bypasses the face mock seam / integrity
# hardening. They are declared here only so an accidental harness value is an
# explicit, reviewable build arg instead of an invisible shell-env leak.
ARG NEXT_PUBLIC_E2E_FAKE_SEAM="0"
ARG NEXT_PUBLIC_INTEGRITY_HARDENING_OFF="0"
# Demo-mode kiosk flag (docs/plans/PLAN_DEMO_MODE.md). MUST be "0" or empty for
# a production image: it is INLINED into the client bundle (and read by the Edge
# middleware at build time), arming the walk-up guest-provisioning flow. Declared
# here so an accidental `=1` is an explicit, reviewable build arg instead of an
# invisible shell-env leak; prod-guards.ts + ci.yml + build-images.sh all reject it.
ARG NEXT_PUBLIC_DEMO_MODE="0"

# Export them for the build. Two reasons this is an ENV and not an inline
# prefix on the RUN below: Next reads them through its own env loader, and the
# values must be visible to every process the build spawns (workers, the
# route-manifest pass) — `next.config.ts` is evaluated in a worker for some
# phases.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    SITE_URL=${SITE_URL} \
    TRUSTED_ORIGINS=${TRUSTED_ORIGINS} \
    ALLOWED_HOSTS=${ALLOWED_HOSTS} \
    ALLOWED_ORIGINS=${ALLOWED_ORIGINS} \
    NEXT_PUBLIC_E2E_FAKE_SEAM=${NEXT_PUBLIC_E2E_FAKE_SEAM} \
    NEXT_PUBLIC_INTEGRITY_HARDENING_OFF=${NEXT_PUBLIC_INTEGRITY_HARDENING_OFF} \
    NEXT_PUBLIC_DEMO_MODE=${NEXT_PUBLIC_DEMO_MODE}

RUN npm run build

# ── Prune scratch that Next's tracer dragged into the standalone tree ────────
# MEASURED PROBLEM: the build log carries
#   "Warning: Dynamic filesystem access causes tracing of the whole project"
# pointing at `src/lib/ai/glm-spend.ts:140` — the spend ledger reads a path only
# known at runtime (`GLM_SPEND_LEDGER_PATH`), so the tracer cannot scope it and
# conservatively copies the WHOLE project into `.next/standalone/`. Measured:
# screenshots/ 37 MB, graphify-out/ 13 MB, e2e/ 4.2 MB, coverage/ 5.3 MB — 59 MB
# of gitignored scratch and dev-only test specs that have no business in a
# production image. (e2e specs also encode route maps and harness credential
# patterns, so shipping them is a mild disclosure of its own.)
#
# This runs in the BUILD stage, BEFORE the `COPY --from=build` below, so the
# pruned files never enter a runner layer at all — pruning in the runtime stage
# would only write whiteouts over an already-copied tree and save no image size.
#
# The durable fix belongs in that source file
# (`fs.readFileSync(/*turbopackIgnore: true*/ …)`), which this workstream does
# not own — so we defend here instead. Removing these is safe: none is reachable
# from the server's runtime import graph (a Playwright suite, an explore-script
# screenshot dump, a code-graph cache, a coverage report). `public/` — the only
# tree the app actually SERVES — is copied separately and is untouched.
RUN rm -rf .next/standalone/screenshots .next/standalone/graphify-out \
           .next/standalone/e2e .next/standalone/coverage

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
# Same base image as the build stages: the standalone server's native deps
# (sharp's libvips, @next/swc) are glibc binaries compiled for bookworm, and
# node_modules is copied wholesale below, so the runtime libc must match.
FROM node:22-slim AS runner

WORKDIR /app

# Non-root. `node` (uid 1000) is built into the official image — no useradd
# needed, and its HOME is already /home/node. The server runs untrusted input
# (uploaded PDFs, camera frames, Z.ai responses) through parsers, so it must
# not be uid 0.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# ── The standalone payload ───────────────────────────────────────────────────
# `.next/standalone` contains server.js + the TRACED subset of node_modules.
# It does NOT contain `public/` or `.next/static` — Next's docs are explicit
# that both must be copied by hand. Skipping either yields a server that boots
# and serves HTML with NO CSS/JS (static) or a broken exam boot path (public).
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# `public/` carries the exam-critical vendored assets: /mediapipe (MediaPipe
# WASM + face/hand models, ~34 MB) and /models (~12 MB). proxy.ts gates the
# exam boot on these, so a missing public/ is a hard functional failure, not a
# cosmetic one.
COPY --from=build --chown=node:node /app/public ./public

# ── exceljs must stay resolvable ─────────────────────────────────────────────
# `serverExternalPackages: ["exceljs"]` (next.config.ts) opts exceljs OUT of
# bundling: the server does a runtime `require`/`import()` of it, so the traced
# standalone tree must physically contain node_modules/exceljs or BOTH export
# routes fail at request time with a typed 503 (per-quiz export via the static
# import in export-workbook.ts; gradebook export via the dynamic import in
# gradebook-export/route.ts). The tracer normally catches it, but that split is
# PROVISIONAL until an in-image smoke hits both routes — so copy the package
# explicitly and deterministically. Its own CJS deps (archiver, unzipper,
# fast-csv, tmp, uuid, saxes, readable-stream, dayjs, jszip) come from the
# standalone trace, which sees them through the same require chain.
COPY --from=build --chown=node:node /app/node_modules/exceljs ./node_modules/exceljs

# NOTE: scratch trees traced into `.next/standalone` (screenshots/, graphify-out/,
# e2e/, coverage/) are pruned in the BUILD stage, before this copy — see the
# comment there. Pruning after the copy would only add whiteout layers.

# ── Startup diagnostic ───────────────────────────────────────────────────────
# A gate requirement (plan §B1.8): the effective /sb mode and the allowed hosts
# must be printed once at boot. We cannot patch `src/**` to do it, so we do it
# here — from the values FROZEN INTO THE IMAGE, not from whatever runtime env
# claims.
#
# WHY NODE AND NOT A SHELL `case` (defect proven by the ops critic): the old
# shell version was a `case "$SB_URL" in https://*.supabase.co)` — case
# SENSITIVE, anchored to a literal `.co` at the END of the string, and blind to
# userinfo and ports. `next.config.ts` normalises through `new URL()` and tests
# `url.hostname`, so the two disagreed on real inputs:
#     https://realref.supabase.co/   shell: local-Kong (4 rules ACTIVE)   app: hosted
#     https://REF.SUPABASE.CO        shell: local-Kong                    app: hosted
#     https://x.supabase.co:443      shell: local-Kong                    app: hosted
# The diagnostic is the FIRST thing an operator reads when /sb is dead, so a
# diagnostic that lies about the mode is worse than none. The predicate below is
# a character-for-character copy of `SUPABASE_IS_HOSTED` in next.config.ts.
#
# TWO SOURCES OF TRUTH, CROSS-CHECKED: the verdict is derived from the build arg
# (the same input `rewrites()` saw), and the RULE COUNT is read out of the
# SHIPPED `.next/routes-manifest.json`. If they disagree the line says so — that
# is exactly the "image was built with a different value than the entrypoint was
# told" case, which no single derivation can catch.
#
# SECRETS: the URL is printed as `new URL(raw).origin` — scheme://host[:port],
# with userinfo, query and hash DROPPED. A credentialed URL (a Supabase pooler
# connection string is `postgres://user:pw@host/db`, and the pooler URL sits
# next to the API URL in the dashboard) therefore cannot leak a password into
# `docker logs`. An UNPARSEABLE value is never echoed at all: it could be
# anything, including a secret pasted into the wrong variable.
#
# This script ALWAYS exits 0. A diagnostic must never be the reason a container
# fails to boot — a wrong verdict is a log line, a crash is an outage.
RUN printf '%s\n' \
  '#!/usr/bin/env node' \
  '// Startup assertion (plan §B1.8): print the EFFECTIVE build-time decisions.' \
  '// These come from the BUILD stage, so they state what the shipped routes' \
  '// manifest and client bundle actually contain — not what a runtime env var' \
  '// claims. A mismatch between this line and the operator expectation is the' \
  '// fastest diagnosis for a silent server-action abort or a dead /sb proxy.' \
  'import { readFileSync } from "node:fs";' \
  '' \
  'const MANIFEST = "/app/.next/routes-manifest.json";' \
  'const RSF = "/app/.next/required-server-files.json";' \
  '' \
  '// IDENTICAL to SUPABASE_IS_HOSTED in next.config.ts. Keep the two in step:' \
  '// the whole point of this rewrite is that there is ONE definition of' \
  '// "hosted". URL.hostname is already lowercased and userinfo-free.' \
  'function isHosted(raw) {' \
  '  const value = (raw ?? "").trim();' \
  '  if (!value) return false;' \
  '  try {' \
  '    const url = new URL(value);' \
  '    if (url.protocol !== "https:") return false;' \
  '    return /^[a-z0-9-]+\.supabase\.(co|in)$/i.test(url.hostname);' \
  '  } catch {' \
  '    return false;' \
  '  }' \
  '}' \
  '' \
  '// scheme://host[:port] only — userinfo/query/hash dropped. Never echo a' \
  '// value we could not parse.' \
  'function safeOrigin(raw) {' \
  '  const value = (raw ?? "").trim();' \
  '  if (!value) return "(unset)";' \
  '  try {' \
  '    return new URL(value).origin;' \
  '  } catch {' \
  '    return "(unparseable - value NOT echoed)";' \
  '  }' \
  '}' \
  '' \
  '// Mirrors hostnamesFrom() in next.config.ts (display only). `.host` cannot' \
  '// contain userinfo, so a credentialed entry is sanitized too.' \
  'function sanitizedHosts(value) {' \
  '  const out = [];' \
  '  for (const entry of String(value ?? "").split(",")) {' \
  '    const trimmed = entry.trim();' \
  '    if (!trimmed) continue;' \
  '    try {' \
  '      out.push(new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).host.toLowerCase());' \
  '    } catch {' \
  '      out.push("(unparseable entry - NOT echoed)");' \
  '    }' \
  '  }' \
  '  return out;' \
  '}' \
  '' \
  'function readJson(path) {' \
  '  try {' \
  '    return JSON.parse(readFileSync(path, "utf8"));' \
  '  } catch {' \
  '    return null;' \
  '  }' \
  '}' \
  '' \
  'try {' \
  '  const sbRaw = process.env.BUILD_NEXT_PUBLIC_SUPABASE_URL ?? "";' \
  '  const hosted = isHosted(sbRaw);' \
  '' \
  '  // What was ACTUALLY shipped, read from the frozen manifest.' \
  '  let sbRules = null;' \
  '  const manifest = readJson(MANIFEST);' \
  '  if (manifest && manifest.rewrites) {' \
  '    const r = manifest.rewrites;' \
  '    sbRules = [...(r.beforeFiles ?? []), ...(r.afterFiles ?? []), ...(r.fallback ?? [])]' \
  '      .filter((rule) => String(rule.source ?? "").startsWith("/sb/"));' \
  '  }' \
  '' \
  '  let mode;' \
  '  if (!sbRaw.trim()) {' \
  '    mode = "UNKNOWN - image built without NEXT_PUBLIC_SUPABASE_URL (the app kept the 4 local-Kong rules: an absent value is NOT hosted)";' \
  '  } else if (hosted) {' \
  '    mode = "hosted - /sb rewrites DISABLED (0 rules); the browser talks to the hosted project directly";' \
  '  } else {' \
  '    mode = "local-Kong - /sb rewrites ACTIVE (4 rules) -> http://127.0.0.1:58021";' \
  '  }' \
  '  console.log(`[entrypoint] /sb mode: ${mode}`);' \
  '' \
  '  if (sbRules === null) {' \
  '    console.log("[entrypoint] /sb rules: routes manifest unreadable - cannot confirm what shipped");' \
  '  } else {' \
  '    const destinations = [...new Set(sbRules.map((rule) => rule.destination))];' \
  '    console.log(' \
  '      `[entrypoint] /sb rules in the SHIPPED routes manifest: ${sbRules.length}` +' \
  '        (destinations.length ? ` -> ${destinations.join(", ")}` : ""),' \
  '    );' \
  '    const expected = hosted ? 0 : 4;' \
  '    if (sbRules.length !== expected) {' \
  '      console.log(' \
  '        `[entrypoint] WARNING: the shipped manifest has ${sbRules.length} /sb rule(s) but the` +' \
  '          ` build arg implies ${expected}. The image was built with a different` +' \
  '          ` NEXT_PUBLIC_SUPABASE_URL than this container reports - REBUILD with the` +' \
  '          ` intended value (this is a build-time decision, not an env flip).`,' \
  '      );' \
  '    }' \
  '  }' \
  '' \
  '  console.log(`[entrypoint] baked NEXT_PUBLIC_SUPABASE_URL origin: ${safeOrigin(sbRaw)}`);' \
  '' \
  '  // The FROZEN action/dev allowlist, as the running server sees it.' \
  '  const rsf = readJson(RSF);' \
  '  const frozen = rsf?.config?.experimental?.serverActions?.allowedOrigins;' \
  '  console.log(' \
  '    `[entrypoint] allowed hosts (serverActions.allowedOrigins, FROZEN): ` +' \
  '      (Array.isArray(frozen) && frozen.length ? frozen.join(", ") : "<none>"),' \
  '  );' \
  '  // The inputs next.config.ts folds in, so an operator can see WHY the list' \
  '  // looks the way it does. Each entry is sanitized (host only).' \
  '  const inputs = [' \
  '    ["ALLOWED_HOSTS", process.env.BUILD_ALLOWED_HOSTS],' \
  '    ["ALLOWED_ORIGINS", process.env.BUILD_ALLOWED_ORIGINS],' \
  '    ["TRUSTED_ORIGINS", process.env.BUILD_TRUSTED_ORIGINS],' \
  '    ["NEXT_PUBLIC_SITE_URL", process.env.BUILD_SITE_ORIGIN],' \
  '    ["SITE_URL", process.env.BUILD_SITE_URL],' \
  '  ]' \
  '    .map(([name, value]) => {' \
  '      const hosts = sanitizedHosts(value);' \
  '      return `${name}=${hosts.length ? hosts.join("|") : "<unset>"}`;' \
  '    })' \
  '    .join(" ");' \
  '  console.log(`[entrypoint] allowlist inputs folded at BUILD: ${inputs}`);' \
  '' \
  '  console.log(' \
  '    `[entrypoint] TRUSTED_PROXY_COUNT: ${process.env.TRUSTED_PROXY_COUNT || "<unset -> request-ip defaults to 1>"}`,' \
  '  );' \
  '  console.log(' \
  '    `[entrypoint] listening on ${process.env.HOSTNAME || "0.0.0.0"}:${process.env.PORT || 3000} as uid ${process.getuid ? process.getuid() : "?"}`,' \
  '  );' \
  '} catch (err) {' \
  '  // Never fail the boot: a diagnostic is not a gate.' \
  '  console.log(`[entrypoint] startup diagnostic failed: ${err && err.message}`);' \
  '}' \
  > /app/startup-check.mjs \
  && chmod 0755 /app/startup-check.mjs

# The entrypoint proper. Kept as a shell wrapper so `exec` replaces it with the
# server process (PID 1 gets the signals directly); the diagnostic runs first and
# is `|| true` so no diagnostic outcome can abort the boot.
RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'node /app/startup-check.mjs || true' \
  'exec node server.js' \
  > /app/entrypoint.sh \
  && chmod 0755 /app/entrypoint.sh

# ── Healthcheck probe (own file, exec form — no shell quoting to get wrong) ──
# Exits 0 only for `ok === true` AND `db.reachable === true`, which is the
# liveness + DB-readiness pair `/api/health` reports to an ANONYMOUS caller.
# It deliberately does NOT read `cron.ok`; see the HEALTHCHECK note below.
RUN printf '%s\n' \
  '#!/usr/bin/env node' \
  '// Liveness probe for Docker HEALTHCHECK. Liveness + DB reachability ONLY.' \
  '// NEVER assert cron.ok here: coupling container health to Supabase pg_cron' \
  '// state turns free-tier project PAUSING into an endless restart loop, and' \
  '// every restart ZEROES the in-memory rate-limit / OCR in-flight Maps.' \
  'const port = process.env.PORT || 3000;' \
  'const url = `http://127.0.0.1:${port}/api/health`;' \
  'try {' \
  '  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });' \
  '  const body = await res.json();' \
  '  if (!res.ok || body.ok !== true || !body.db || body.db.reachable !== true) {' \
  '    console.error("[healthcheck] not live:", res.status, JSON.stringify(body));' \
  '    process.exit(1);' \
  '  }' \
  '  process.exit(0);' \
  '} catch (err) {' \
  '  console.error("[healthcheck] probe failed:", err && err.message);' \
  '  process.exit(1);' \
  '}' \
  > /app/healthcheck.mjs \
  && chmod 0755 /app/healthcheck.mjs

# The values the startup diagnostic REPORTS. They are separate from the
# build-stage ENV because that ENV block is scoped to the build stage; these
# re-import the frozen decisions into the runtime image so the log line can
# state them. The ALLOWLIST INPUTS are carried too, not just ALLOWED_HOSTS:
# next.config.ts folds `ALLOWED_ORIGINS`/`TRUSTED_ORIGINS`/`NEXT_PUBLIC_SITE_URL`/
# `SITE_URL` into the same allowlist, so printing only ALLOWED_HOSTS showed
# `<none>` on a correctly-built image whose frozen allowlist was two hosts.
ARG NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:58021"
ARG NEXT_PUBLIC_SITE_URL=""
ARG SITE_URL=""
ARG TRUSTED_ORIGINS=""
ARG ALLOWED_HOSTS=""
ARG ALLOWED_ORIGINS=""
ENV BUILD_NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    BUILD_SITE_ORIGIN=${NEXT_PUBLIC_SITE_URL} \
    BUILD_SITE_URL=${SITE_URL} \
    BUILD_TRUSTED_ORIGINS=${TRUSTED_ORIGINS} \
    BUILD_ALLOWED_HOSTS=${ALLOWED_HOSTS} \
    BUILD_ALLOWED_ORIGINS=${ALLOWED_ORIGINS}

# WORKDIR creates /app as ROOT, so hand the directory itself to `node` — the
# copied trees are already node-owned via `COPY --chown`, but a root-owned /app
# would make the spend ledger unwritable when GLM_SPEND_LEDGER_PATH points at a
# RELATIVE path (resolved against cwd = /app). Deliberately NON-recursive: a
# `chown -R` here would duplicate the entire multi-hundred-MB tree into a new
# layer for no benefit.
#
# /var/lib/innovision is the ledger's volume mountpoint (compose mounts
# `glm-ledger` there and sets GLM_SPEND_LEDGER_PATH inside it). It MUST be
# created and chowned HERE, in the image, and that is not cosmetic: Docker
# copies an image directory's ownership into a FRESH named volume, but a volume
# mounted at a path that does not exist in the image is created root:root —
# measured: `docker run -u node -v vol:/var/lib/innovision node:22-slim touch …`
# → "Permission denied". The ledger's write path would then fail on every
# record, silently degrading the daily cap to an in-memory counter that a
# restart wipes — the exact defect the volume exists to fix.
RUN mkdir -p /var/lib/innovision \
  && chown node:node /app /app/entrypoint.sh /app/startup-check.mjs /app/healthcheck.mjs /var/lib/innovision

USER node

EXPOSE 3000

# ── HEALTHCHECK — LIVENESS ONLY ──────────────────────────────────────────────
# The probe lives in /app/healthcheck.mjs (see above) and asserts `ok` +
# `db.reachable`. It deliberately does NOT look at `cron.ok`: coupling Docker
# health to Supabase pg_cron state turns free-tier project pausing into an
# endless restart loop, and every restart zeroes the in-memory rate-limit and
# OCR spend Maps — handing an abuser a clean budget each cycle and resetting
# the counters that exist to bound Z.ai spend. Cron is an ops concern: alert on
# it from a monitor, never from the container runtime. (Plan §10.6/§10.7
# ops-critic correction, restated in §B3.1.)
#
# Uses node, not curl: node:22-slim ships no curl, and the probe needs a real
# JSON assertion (curl alone could only check the HTTP status).
HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=60s \
  CMD ["node", "/app/healthcheck.mjs"]

CMD ["/app/entrypoint.sh"]

# PLAN — Laptop + VPS-Remote Deployment

> **Status:** EXECUTED IN CODE (2026-09-14) — the toggle, the container, the
> prod-env gate and the operator runbook are implemented; the LIVE halves
> (Z.ai `code` table, tokens/page, hosted push, VPS cutover) remain OWED-LIVE
> because they need a real key/host. See
> [Implementation status (2026-09-14)](#implementation-status-2026-09-14) below.
> **Date:** 2026-09-14.
> **Review:** 2026-09-14 — 4 chunk investigators + 2 adversarial critics
> (security, ops). Verdict: **NOT executable / NOT safe as-is** — accurate
> seam inventory, insufficient operator procedure. §10 lists the
> corrections folded in from review and the gates that must close before
> cutover. Line refs below were re-verified against the code during review;
> where the code moved, the corrected ref is used.
> **Round-2 (2026-09-14):** P0 closed to doc level (Z.ai shape VERIFIED via
> fetched docs — base `https://api.z.ai/api/paas/v4/`, model `glm-ocr`,
> Bearer, `{code,message}` envelope, separate `layout_parsing` endpoint —
> see §4). Consequence: **env-only toggle is INSUFFICIENT; a second
> request-shaper is required** (§2–§3 updated). Supabase `link→push→repair`
> sequence, Dockerfile/proxy/env-matrix decisions closed to sketch level
> (Context7-verified where noted, UNVERIFIED items marked). Round-2
> red-team (GLM-correctness, VPS-ops) findings folded into §10.6; gates
> S1–S6/O1–O5 stand, plus new GLM gates G1–G5.
> **Terminology (agreed 2026-09-14):**
> - **laptop** — the current setup running on the developer's own laptop.
>   Local Supabase (`supabase start`), Next.js, `insightface-service`, and
>   `glm-ocr`, all loopback-bound. "Local-prod" was the old name; it just
>   means the laptop stack.
> - **vps-remote** — the VPS deployment candidate: a vCPU-only VPS running
>   Next.js + InsightFace, talking to **hosted (free-tier) Supabase** and the
>   **Z.ai GLM-OCR API**. "Prod-remote" was the old name.
> - **GLM toggle** — the one functional change shared by both: the OCR proxy
>   can point at either the local vLLM container or the Z.ai remote API.
>
> When this plan and the code disagree, the code + migrations win — then
> update this doc. Related: `docs/ARCHITECTURE.md` (topology),
> `docs/GLM_OCR_SETUP.md` (current GLM-OCR guide, §6 = the remote leg),
> `docs/COSTS.md` (VPS + hosted-Supabase + Z.ai cost model),
> `docs/DEPLOY_VPS.md` (the OPERATOR RUNBOOK — the §10.1 "how" this plan
> lacked), `docs/README.md` (index).

---

## Implementation status (2026-09-14)

**Code vs owed.** The §1–§10 body below is the *design record* and is left
verbatim: it documents the reasoning and the review history, not the current
state. This section is the current state. (The earlier banner line "no code
changed for this plan" was true at review time and is now FALSE — the plan's
§2/§3 designs are implemented.)

### Implemented in code

| Plan item | Where |
|---|---|
| Provider selector, fail-closed | `src/lib/ai/glm-provider.ts` — `GLM_PROVIDER`, any non-`remote` value → `local` + one-time warn; provider-aware caps (local 24 MB/32 M chars/200 pp; remote 10 MB/50 MB/36 M chars/30 pp) |
| Remote request-shaper (`layout_parsing`) | `src/lib/ai/http-compat.ts` — `httpLayoutParsing`, `GlmLayoutResult`; `ZAI_AUTH_CODES` = `{401, 403}` (standard HTTP meanings), `ZAI_RETRYABLE_CODES` **still EMPTY — see owed** |
| Envelope precedence (G9) | same file — transport > 429 > 401/403 → `auth` > other non-ok > non-JSON > body `code` (flat ?? nested) > `md_results` missing/empty/blank; unknown code → `degraded` with text, non-retryable `ai_error` without |
| Whole-document-once (G3/G6) | `src/lib/extract/glm-ocr.ts` remote branch (one POST, no rasterization, client-side pdf.js page pre-flight), `pipeline.ts` + `types.ts` (`wholeDocumentRetry`, `provider`, `maxPages`) |
| Spend governor (G8) | `src/lib/ai/glm-spend.ts` — durable JSON ledger (`GLM_SPEND_LEDGER_PATH`, gitignored), per-user UTC-day token cap, `GLM_SPEND_DISABLED` kill switch, redacted `[glm-usage]` line |
| Cached billed probe (G4/G7) | `src/lib/ai/glm-health.ts` — 300 s / 30 s TTLs, in-flight collapse, `glmHealthCached()` never probes |
| Route rewrite (both legs, typed failures) | `src/app/api/extract/ocr/route.ts` — `{image}` local / `{file,kind}` remote, `glm_pages_exceeded` / `glm_spend_cap`, auth → 503 `glm_model_unavailable`, separate `ocr-health` bucket |
| Prod fail-closed gate (S1/S5) | `src/lib/prod-guards.ts` + `src/instrumentation.ts` — exits the process under `NODE_ENV=production` + `PROD_ENV_STRICT=1` (a rethrow alone left a zombie listener answering 500s) |
| Health shrink (S6) | `src/app/api/health/route.ts` — the `cron` block (and its service-role RPC) is lecturer-only; anon gets `{ok, db, uptimeSec, checkedAt, elapsedMs}` |
| `server-only` on the admin client (S6) | `src/lib/supabase/admin.ts` |
| Committed confirm-token literal deleted (S2) | `scripts/lib/remote-env.mjs` — `PROD_CONFIRM_TOKEN` required from the environment |
| Container (O1) | `Dockerfile` (new, multi-stage `node:22-slim`, `USER node`, standalone + explicit `public/`/`.next/static`/`exceljs` copies, entrypoint startup assertion, liveness-only HEALTHCHECK), `docker-compose.yml` (`profiles: ["gpu"]` on `glm-ocr`, new `app` + `caddy` services, `caddy-data`/`caddy-config` volumes), `Caddyfile` (new), `next.config.ts` (`output: "standalone"` + the `/sb` rewrite gate on the build-time `NEXT_PUBLIC_SUPABASE_URL`) |
| Operator contract | `.env.local.example` — all 11 previously-undocumented keys now documented (`npm run check:env` green: 50/50) |
| Runbook (the §10.1 gap) | `docs/DEPLOY_VPS.md` (new) |

> **One deployment fact worth stating here because the §1–§10 body predates it:**
> with `output: "standalone"`, the container's runtime is
> `node .next/standalone/server.js`, NOT `next start`. `next start` still serves
> from the frozen manifest but warns loudly
> (`⚠ "next start" does not work with "output: standalone" configuration`), so
> the body's `next start` mentions below should be read as
> "the frozen production server" — `docs/DEPLOY_VPS.md` §4.3 carries the
> operational version of this note.

### Gates that CLOSED

- **S1** — `inspectProdEnv` refuses to start on an empty `FACE_SIDECAR_TOKEN` /
  `VLLM_API_KEY` / `ZAI_API_KEY`-with-remote, so "provision a real token" is a
  control, not a wish.
- **S2** — the committed `FALLBACK_CONFIRM_TOKEN` literal is gone; destructive
  `--remote` runs require an out-of-band `PROD_CONFIRM_TOKEN`.
- **S5** — kill switches hard-fail startup (via `process.exit(1)`, measured —
  Next keeps the listener bound after a rejected `register()`).
- **S6** — `/api/health`'s cron topology is lecturer-only; `admin.ts` carries
  `server-only`.
- **G1–G10** — closed **in code**: contract rupture (G1), envelope precedence
  (G9), whole-document-once (G3), real liveness + auth mapping (G4), `url`-ban
  (G5), chunk-as-retry-unit (G6), cached reasoned liveness (G7), durable spend
  governor (G8), fail-safe omitted params + fresh `request_id` (G10). **G2 (the
  `code` table) closed only structurally** — the mechanism exists, the data is
  owed.
- **O1 (partly)** — the Dockerfile/compose/Caddy spec is written and the
  HEALTHCHECK is decoupled from cron by construction. Still owed: the
  `docker compose config` run, the in-image export smoke, vCPU build minutes,
  GHCR-vs-build.
- **O4 (partly)** — the smoke's *procedure* is documented in
  `docs/DEPLOY_VPS.md` §12 and `scripts/vps-smoke.mjs` now exists (asserts
  health/DB, the unauthenticated OCR 401/403, a login round trip, an
  authenticated quiz-session fetch and the OCR probe shape; reports `cron.*` and
  makes it fatal only under `--expect-cron`). Still owed: a run against a real
  host.
- **O5 (mostly)** — the env value table, BUILD-vs-RUNTIME matrix, origin
  checklist with failure signatures and the `TRUSTED_PROXY_COUNT` rule are
  written into the runbook.

### Gates that did NOT close (OWED-LIVE — need a real key or host)

| Gate | What is missing | Why it cannot close in-repo |
|---|---|---|
| **G2** | The live Z.ai business `code` list → `ZAI_RETRYABLE_CODES` stays empty, so an HTTP-200 capacity envelope lands in the unknown-code branch (fail-safe but over-conservative). `ZAI_AUTH_CODES` is seeded with `{401, 403}` (standard meanings, not invented codes) so an auth failure can never read as a successful extraction | Needs a live curl with a real key (`GLM_OCR_SETUP.md` §6.7) |
| **G3 budgets** | Tokens/page and latency/page | Same — measure `usage.total_tokens` |
| **G3 caps** | The 100-vs-30 page conflict; `start/end_page_id` inclusivity | Same — the interim 30 is the safe bound |
| **G5 live** | `data:`-prefix acceptance and the 1×1-PNG probe's real cost/acceptance | Same |
| **S3** | CSP enforcement | Needs a clean-console window and a `report-to` collector; none exists |
| **S4** | The forged-XFF live proof of the hop count | Needs the real host posture |
| **O1** | `docker compose config`, vCPU build minutes, in-image export smoke, image size, GHCR-vs-build | Needs a Docker host / VPS |
| **O2** | The keep-alive-vs-Pro decision and a cron monitor | An operator decision |
| **O3** | The **restore rehearsal** and therefore the real RPO/RTO | Needs a throwaway hosted project; the procedure is written, the round-trip is UNTESTED |
| **O4** | A run of `scripts/vps-smoke.mjs` against the real host | The script exists; the host does not |
| **§B1/§B1.9** | The hosted dashboard pass, `link → push --dry-run → push`, storage-RLS verification, hosted `gen types`, seed | Needs a hosted project |
| **Cutover** | DNS, `SITE_URL` pin, the smoke run | Needs the host |

**Nothing above can be closed by another doc round** — the plan's own §10.7
termination rule. The next step is execution: live curl → laptop remote-leg run →
hosted dry run → VPS cutover.

### Adversarial review of the implementation (2026-09-14, post-code)

The plan's own review loop terminated at doc level. The *implementation* then got
its own round: four independent adversarial critics (server GLM core / browser
client / container+proxy / gates+harness), each instructed to prove defects with
real commands against the running stack rather than to review by reading. They
found **31 CONFIRMED defects**, including several that would have shipped. All
were fixed and each fix was proven fails-before/passes-after. The load-bearing
ones, kept here so they are not rediscovered:

| # | Defect | Why it mattered |
|---|---|---|
| 1 | The liveness cache was not keyed by provider/key | A `GLM_PROVIDER` flip with no restart served the *other* leg's verdict, driving the client into the per-page path against the metered API — **measured 12 billed calls for a 12-page deck instead of 1**. Now keyed on provider/baseUrl/model + a SHA-256 prefix of the key |
| 2 | A failed probe reported `provider: "local"` | The client then took the local per-page loop against a remote server. Now `OcrProvider` includes `"unknown"`, `maxPages` is `0`, and `glmExtract` **refuses** rather than guessing |
| 3 | The spend ledger threw out of the route AFTER a billed call | A shape-corrupt ledger (`{"<today>":null}`) lost the paid-for markdown and never recorded the spend. Now inner shapes are repaired-or-discarded and no IO/parse failure can escape |
| 4 | A corrupt ledger entry made the cap never bind | `undefined + tokens = NaN`, and `NaN >= cap` is `false` **forever** — a 1-token cap billed 3×. Now every number is `finiteNonNegative()`-gated |
| 5 | Billed calls the ledger never recorded | An HTTP-200 error envelope carrying `usage.total_tokens: 999999` recorded **nothing** — exactly the G9 shape where upstream did the work. Now usage is recorded whenever present, regardless of ok/degraded |
| 6 | The billed liveness probe was unmetered | It now goes through `checkGlmSpend` and is booked under `__glm_probe__` + the requesting user, so a cost audit can see it |
| 7 | The upstream business `code` reached no log | An operator could not see which unknown code was firing — the entire point of the owed live list. Now a redacted `[glm-ocr-code]` line per degraded/error path |
| 8 | The remote `{image}` convenience shape | A 10–200× overspend vector AND it skipped the page cap. Now **rejected** on the remote leg (400) |
| 9 | A detached `admin.rpc` lost `this` | The lecturer `/api/health` cron path was broken in production and degraded silently; the test mock returned a free function, so it was structurally invisible. Now bound, and the mock reproduces the real client's receiver-dependence |
| 10 | `PROD_ENV_STRICT=1` in `.env.local` killed the whole Playwright suite | The runbook *told* operators to set it there; the harness then refused to boot. Now compose pins it `"1"` for the VPS and `playwright.config.ts` pins `""` with a load-time assertion |
| 11 | `vps-smoke.mjs` reported PASS on a dead engine | The O4 cutover gate would green-light a deployment with no working OCR. Now `available: true` is a hard assertion; `--allow-ocr-unavailable` downgrades to SKIP + warning |
| 12 | The Dockerfile entrypoint echoed URL userinfo | A credentialed Supabase URL was printed to `docker logs` on every restart. Now only `origin` is printed and an unparseable value is never echoed |
| 13 | `Caddyfile` crashed on an empty `ACME_EMAIL` | A bare `email` directive is a PARSE ERROR — caddy crash-looped with no TLS on the documented "optional" default path. Now `email "{$ACME_EMAIL:}"` |
| 14 | The `app` service had no ledger volume | The daily spend cap reset on every redeploy. Now `glm-ledger:/var/lib/innovision` (+ a `chown` in the image, without which a fresh named volume is root-owned and the write fails silently) |
| 15 | The confirm-token gate was answerable from the repo | `PROD_CONFIRM_TOKEN` could be set to the project ref, which is still readable in the audit ledger — restoring the theater S2 deleted. Now deny-listed structurally, and the prompt no longer echoes |

Two further corrections worth recording because they were *false claims in the
code's own comments*, not just bugs: the `/api/health` "one query, not two"
rationale (measured: 1 when healthy, up to 4 while PostgREST flaps — the client
conditionally retries `HEAD` on 520/503) and the PDF page pre-flight regex, which
is defeated by any modern compressed-`/ObjStm` PDF and is therefore only a
**lower bound** — the client's pdf.js pre-flight is the real gate and the
post-response check is the backstop.

---

## Table of contents

0. [Implementation status (2026-09-14)](#implementation-status-2026-09-14)
1. [Baseline (what exists today)](#1-baseline-what-exists-today)
2. [Target A — laptop + GLM toggle](#2-target-a--laptop--glm-toggle)
3. [Target B — vps-remote](#3-target-b--vps-remote)
4. [P0 unknown — Z.ai endpoint shape](#4-p0-unknown--zai-endpoint-shape)
5. [Work breakdown](#5-work-breakdown)
6. [Verification per target](#6-verification-per-target)
7. [Rollout order](#7-rollout-order)
8. [Open decisions](#8-open-decisions)
9. [File index (every path this plan touches)](#9-file-index-every-path-this-plan-touches)
10. [Review findings (2026-09-14)](#10-review-findings-2026-09-14) — round-1
    verdict + S1–S6/O1–O5 gates, round-2 P0 close-out + G1–G5 gates (§10.6)

---

## 1. Baseline (what exists today)

### 1.1 Runtime topology (laptop)

```
Browser (localhost:3000)
  │ fetch JSON / supabase-js (RLS-scoped)
Next.js server (Node, `npm run dev` / `next start`)
  │ PostgREST — user JWT or service role
Supabase LOCAL (`supabase start`, supabase/config.toml)
  │ Kong :58021 · DB :58022 · shadow :58020 · pooler :58029 · Studio :58023
  │ 50 migrations (0001_profiles → 0050_audit3_auth_hardening)
  │ 4 private buckets · 5 pg_cron jobs · realtime on `notifications` only
  │ no edge functions (supabase/functions/ absent)
  │ HTTP sidecars (loopback-only publishes)
insightface-service ── 127.0.0.1:8000 (/extract + /health)
glm-ocr (vLLM) ─────── 127.0.0.1:11434 (/v1/chat/completions + /v1/models)
```

### 1.2 Supabase local — the facts

- `supabase/config.toml`: `project_id="innovision"` (`:1`); API `:58021`
  (`:5`), DB `:58022` (`:11`), shadow `:58020` (`:12`), pooler `:58029`
  (`:17`), Studio `:58023` (`:36`), `api_url="http://127.0.0.1:58021"`
  (`:38`); `edge_runtime` enabled (`:44-46`) but **no functions exist**.
- Auth local (`config.toml:22-33`): `site_url="http://localhost:3000"`
  (`:24`), `additional_redirect_urls=["…/auth/callback"]` (`:25`),
  `enable_confirmations=false` (`:33`, demo posture),
  `double_confirm_changes=true` (`:32`).
- Migrations: **50 files** (`0001` → `0050`), authoritative schema.
- Storage buckets, all `public=false`:
  - `quiz-sources` — `0003_storage.sql:5-7`, hardened to 25 MB in
    `0007_ai_generation.sql:233-245`;
  - `question-images` (5 MB) + `avatars` (2 MB) — `0028_media.sql:47-60`;
  - `incident-footage` (deny-by-default) — `0020_integrity_suite.sql:471-476`.
  Bucket list is load-bearing in scripts: `scripts/db-reset-remote.mjs:34`
  enumerates exactly these 4.
- Realtime: only `notifications` — `alter publication`
  (`0022_notifications.sql:97`) / `create publication`
  (`0022_notifications.sql:103`), guarded (`:90-108`). The app treats
  realtime as a latency accelerator; polling is the consistency backbone
  (`poll-state.ts:3,42`: `HEALTHY_POLL_MS = 60_000`, `UNHEALTHY_POLL_MS =
  20_000` — the unhealthy 20 s cadence is the degraded-mode backbone, not
  a single fixed 20 s poll).
- pg_cron, 5 jobs, all best-effort (`exception → raise notice`):
  | Job | Schedule | Migration |
  |---|---|---|
  | `innovision-retention` | `17 3 * * *` | `0019:807-815` |
  | `innovision-notifications` | `43 3 * * 6` | `0022:776-782` |
  | `innovision-quiz-autoclose` | `*/5 * * * *` | `0030:124-129` |
  | `innovision-flag-verify-silence` | `* * * * *` | `0042:294-298` |
  | `innovision-incident-prune` | `23 4 * * *` | `0042:303-308` |
  Observability: `cron_health()` (`0047:1043-1049` comment,
  implementation `:1058-1101`) + `GET /api/health` (`EXPECTED_JOBS
  :28-34`, `cron:{jobs,neverRan,missing,degraded}` payload `:102-133` —
  note: top-level `ok:true` even when `cron.degraded:true` (`:140-150`),
  so monitors must assert on `cron.ok`/`missing`/`neverRan`, never on
  `ok` alone).
- Remote-ready tooling already exists (`docs/README.md:95-107`):
  `scripts/db-reset-remote.mjs` (`--remote` required, `confirmRemote`,
  wipes users-cascade + 4 buckets, schema untouched), `--remote`-aware
  `seed-demo`, `seed-scenarios`, `media-cleanup`, `face-reset`,
  `incident-cleanup`, `face-threshold-report`, shared
  `scripts/lib/remote-env.mjs` (overlay `.env.production.local` over
  `.env.local`, `PROD_CONFIRM_TOKEN` + `.prod-audit.log`). Schema goes
  through `supabase db push` (`package.json:21`), never remote reset.
  `verify-*.mjs` stay local-only by design (`target-guard.mjs`) —
  EXCEPT `verify-mediapipe.mjs:1-22` (manifest-hash check, network-free,
  no `target-guard` import — runs in CI after build).

### 1.3 GLM-OCR local — the facts

- `docker-compose.yml:52-123` (`glm-ocr`): built from
  `docker/glm-ocr/Dockerfile` (pinned `vllm/vllm-openai:v0.19.0-ubuntu2404`
  + Transformers-from-source `@v4.49.0` — stock image predates the
  `glm_ocr` arch), model `zai-org/GLM-OCR` pinned to revision
  `2e85a628…` (`:88-89`, audit-3 R3-DEP-F3), `--served-model-name glm-ocr`
  (`:90-91`), `--max-model-len 8192` / `--gpu-memory-utilization 0.7` /
  `--enforce-eager` (`:96-100`), publish `127.0.0.1:11434:11434`
  (`:101-102`), `mem_limit: 16g` / `cpus: "8.0"` (`:105-106`), log
  rotation (`:107`), **NVIDIA reservation** (`:108-114`), healthcheck
  `GET /health` (`:115-123`, unauthenticated even with key on).
- Talking path (server-side proxy — browser never dials the container):
  `glm-ocr.ts` (rasterize pdf→PNG, one page at a time) → same-origin
  `POST /api/extract/ocr` (`src/app/api/extract/ocr/route.ts`) →
  `httpChatCompletions()` (`src/lib/ai/http-compat.ts:41-99`) →
  `POST {baseUrl}/v1/chat/completions`.
- `glmEnv()` (`route.ts:86-95`) is **single-target, env-only** (SSRF guard
  S8 — URL never comes from the request body):
  `GLM_BASE_URL || "http://localhost:11434"`,
  `OCR_GLM_MODEL || "glm-ocr"`, `VLLM_API_KEY || undefined` → Bearer iff
  set (`http-compat.ts:56-57,117-118`). Compose + app must hold the SAME
  `VLLM_API_KEY` (`GLM_OCR_SETUP.md:117-123`).
- Probe: `probeGlmModel()` → `GET {baseUrl}/v1/models` (2 s default,
  `http-compat.ts:114,120`), requires `{data:[{id}]}` with `id === model`
  or `model:` prefix (`:126-128`). Drives the picker
  (`EnginePicker.tsx:40-48,91-93`); a failed probe hides `glm` and every
  POST becomes `503 glm_model_unavailable` (`route.ts:189-192`).
  ⚠️ The e2e header (`e2c-glm-ocr.spec.ts:13-15`) still claims CLIENT-SIDE
  direct-to-container — stale since the server proxy landed
  (`route.ts:12-18`); the spec itself gates on container reachability
  (`:36-39`) and skips in CI (`:34`).
- Budgets: probe 2 s, page 90 s both sides (`route.ts:54`,
  `glm-ocr.ts:103`), 20/min/user (`route.ts:67`), in-flight 2/user
  (`:76-77`), body 32M chars + 4K (`:51-53`), `MAX_OCR_PAGES=200`.
- Reference perf (`GLM_OCR_SETUP.md:136-150`): RTX 4050 ~0.46 s/page
  (~130 ppm); CPU fallback ~30 s/page, ~65× slower. **A vCPU-only host
  cannot run this container usefully** (and `docker compose up glm-ocr`
  fails at create without the nvidia runtime unless the reservation block
  is stripped).

### 1.4 InsightFace — the facts (vCPU-safe, ships on the VPS)

- `docker-compose.yml:132-154`: context `./docker/insightface`,
  `FACE_SIDECAR_TOKEN:${…:-}` + `WEB_CONCURRENCY=1` (`:139-140`),
  publish `127.0.0.1:8000:8000` (`:141-142`), `mem_limit: 2g` /
  `cpus: "2.0"` (`:146-147`, ~4× headroom over one ~350–500 MB model
  instance), log rotation, healthcheck via urllib (`:149-154`,
  `start_period: 90s`).
- Image (`docker/insightface/Dockerfile`): multi-stage
  `python:3.11-slim`, non-root `app` uid/gid 1001, `buffalo_l.zip`
  sha256-pinned (`:49-56`), two MiniFASNet spoof weights sha256-pinned
  (`:64-74`), `OMP_NUM_THREADS=2` + `WEB_CONCURRENCY=1` (`:83-88`).
- Runtime is CPU-only: `providers=["CPUExecutionProvider"]`,
  `det_size=(640,640)` (`app/main.py:77-82`); `asyncio.to_thread` keeps
  `/health` responsive (`:176`). **No GPU path to break.** Failure mode
  under burst is throughput (5 s route timeout), not startup.
- App side (`src/lib/face/server/insightface-client.ts:203-207,265-268`):
  `INSIGHTFACE_BASE_URL || "http://localhost:8000"`, `FACE_SIDECAR_TOKEN`
  → `x-sidecar-token` (hmac `compare_digest` sidecar-side,
  `app/main.py:56,109-117`); empty = disabled by design. Mock seam needs
  BOTH `NEXT_PUBLIC_E2E_FAKE_SEAM=1` AND `FACE_MOCK_ENABLED=1`
  (`insightface-client.ts:101-105`; prod warn `:82-92` — warn-only, not
  enforcement) — never set either in production.

### 1.5 Next.js + networking seams that assume localhost

- `next.config.ts:141-149`: `/sb/rest|auth|realtime|storage/*` →
  `http://127.0.0.1:58021` (local Kong). Comment `:133-140` documents why:
  the baked `NEXT_PUBLIC_SUPABASE_URL` would resolve `127.0.0.1` on a
  remote browser.
- `src/lib/supabase/client.ts:13-19`: loopback
  (`localhost|127.0.0.1|[::1]` — literal `127.0.0.1` only, NOT the whole
  `127.*` range) → `${origin}/sb`; hosted `https://*.supabase.co` passes
  through **unchanged** — this file needs NO change for vps-remote.
- `src/proxy.ts:37-68`: positive allowlist matcher; `/api/*` and `/sb/*`
  deliberately OUT (routes self-authenticate).
- `src/lib/http.ts:253-290` `checkSameOrigin`: Origin vs bind host; the
  `TRUSTED_ORIGINS` full-origin allowlist (`:270-287`) is REQUIRED
  whenever the browser origin differs from the bind host (tunnel, LAN IP,
  VPS domain). Feeds `next.config.ts` `allowedDevOrigins` +
  `serverActions.allowedOrigins` via `ALLOWED_HOSTS` (`:116-126`,
  default `innovision.zikr-i.uk` `:95`).
- `src/lib/auth/site-url.ts:20-61`: `SITE_URL ?? NEXT_PUBLIC_SITE_URL`
  authoritative; prod-unset degrades to relative/GoTrue-Site-URL (safe
  but unpinned — operator should set it).
- `src/lib/request-ip.ts:48-63`: `TRUSTED_PROXY_COUNT` default `1`
  (tunnel/nginx); `0` = direct access (per-IP budgets become one shared
  global cap — the honest hardening for no-proxy); unparseable values
  fall back to `0` (conservative) with a one-time warn (`:52-61`).
  ⚠️ The default `1` is correct ONLY for a single-hop proxy — wrong for
  both direct access (0) and tunnel+nginx chains (2); see §10
  security gate S4.
- `next.config.ts:46` CSP is **Report-Only** with blanket `https:` in
  `connect-src` — remote HTTPS (Supabase hosted, Z.ai) needs NO change
  today; only if the policy is later pinned.
  ⚠️ Report-Only enforces NOTHING and blanket `https:` permits arbitrary
  exfiltration post-XSS — "no change today" is a migration convenience,
  not a security posture; enforcement is security gate S3 (§10).
- Missing for any prod Docker: app `Dockerfile` + `output:standalone`
  (no Dockerfile exists today — only the two sidecar ones), reverse
  proxy/TLS (HSTS header alone insufficient), app
  restart/healthcheck/mem/logging in compose, deploy workflow (CI is
  local-only: `supabase start` → `db reset` → `verify:*` → `build` →
  Playwright), VPS sizing in `COSTS.md` (stale Vercel-Hobby model).

### 1.6 Env contract (keys only — never values)

`.env.local.example:1-156` is the operator contract (enforced by
`npm run check:env` → `scripts/check-env-parity.mjs`). Groups: Supabase
(`:1-4`), AI (`:6-9,72-75`), OCR (`:11-25` incl. dual-read `VLLM_API_KEY`
compose-side root `.env` + app-side `.env.local`), Face (`:30-32` +
spoof `:128-134`), TinyFish (`:34-39`), lecturer invite (`:41-46`), SSO
domains (`:54`), rate budgets (`:59-70`), SITE/TRUSTED/ALLOWED origins
(`:84,99,114,122,126`), kill switches
(`E2E_RATE_LIMIT_DISABLED:138`, `NEXT_PUBLIC_E2E_FAKE_SEAM:153`,
`NEXT_PUBLIC_INTEGRITY_HARDENING_OFF:156`).
`.env.production.local` (gitignored, local-only) carries the 3 hosted
Supabase vars; `remote-env.mjs:86-90` overlays it for `--remote`
scripts. Note `resolveEnv` validates only URL + SERVICE (`:92-101`) —
the anon key rides along unchecked.

---

## 2. Target A — laptop + GLM toggle

**Definition:** the current laptop stack, unchanged, plus ONE functional
change — the OCR proxy can point at the local vLLM container OR the Z.ai
remote API.

### A0. Scope fence

- Topology unchanged: `supabase start` + Next.js + `insightface-service`
  + `glm-ocr` (optional when on API), `/sb` rewrites stay active,
  `config.toml` untouched, no Supabase/dashboard work, no Dockerfile,
  no TLS/proxy work.
- The seam is `glmEnv()` (`route.ts:86-95`) PLUS a second request-shaper
  (round-2 finding — env-only is insufficient, see §4): today's
  single-target `{baseUrl, model, apiKey}` becomes provider-aware with an
  explicit fail-closed selector, e.g. `GLM_PROVIDER=local|remote`
  (server-only — never `NEXT_PUBLIC_*`, registered in
  `check-env-parity`), plus a distinct remote-key var (`ZAI_API_KEY`)
  so the vLLM `VLLM_API_KEY` dual-read contract
  (`GLM_OCR_SETUP.md:117-123`) is not overloaded with a third meaning.
  `local` keeps `GLM_BASE_URL` + `VLLM_API_KEY` + `httpChatCompletions` +
  `probeGlmModel` as today; `remote` calls a NEW `httpLayoutParsing`
  against `POST {ZAI_BASE}/layout_parsing` (NOT the `/v1/chat/completions`
  shape) and skips `GET /v1/models` (which does not exist remotely —
  probe bypass design in A1.2, liveness done properly per gate G4).

### A1. Changes (design)

1. `route.ts:86-95` — provider resolution in `glmEnv()`
   (`GLM_PROVIDER=local|remote`, fail-closed); `ZAI_API_KEY` as the
   remote key (NOT `VLLM_API_KEY` reuse); remote branch in
   `handleOcrPage` (`route.ts:150,185,194`) validating decoded bytes
   against REMOTE caps (image ≤10 MB, PDF ≤50 MB) BEFORE send, clamping
   pages to interim 30 until the 100-vs-30 conflict resolves live, and
   mapping `md_results` (a whole-doc markdown STRING, not an array —
   correction to the earlier `md_results[]` shorthand) → `{text,
   pageTexts}` explicitly. **Chunk is the retry unit, not page** (gate
   G6): split per-chunk boundaries ONLY from `layout_details[][]` page
   indices — never string-split markdown; if unsplittable, set
   `pageTexts=undefined` and force whole-chunk retry with an explicit
   re-bill warning, updating the dialog splice
   (`GenerateFromFileDialog.tsx:340-351`) + `types.ts:33-38` contract —
   otherwise the per-page F-F2 machine (`glm-ocr.ts:199-232`,
   `pipeline.ts:164-170`) silently regresses. Fail-closed on OWED
   defaults (gate G10): OMIT `start/end_page_id` until inclusivity is
   verified live (wrong guess silently drops the last page with
   `successCount==attempted` — fail-lossy); validate `data_info.num_pages`
   against expectation (`mismatch → glm_error`, not success); fail-closed
   on `data:`-prefix/sniff. `request_id=crypto.randomUUID()` per attempt
   (no reuse until idempotency is verified); `user_id` salted + rotated
   daily or omitted (a stable hash is a permanent cross-request tracking
   ID in third-party logs). Document in the route header (which today
   says "local … container", `:12-22`).
2. `src/lib/ai/http-compat.ts` — NEW `httpLayoutParsing({file, pages})`
   beside `httpChatCompletions` (do NOT reuse the chat shape): explicit
   `{code,message}` error table (unknown `code` → non-retryable
   `glm_error`; only documented capacity codes → `rate_limited` — never
   infer from HTTP status alone); log `code/message` + `usage{…}`
   per-user server-side (redacted, never the key); keep the SSRF guard
   (URL from env only) and pin the key-redaction invariant (safe today —
   `http-compat.ts:13-17`, `route.ts:90-94`, error strings carry no key).
   **Envelope precedence** (gate G9 — PaaS commonly rides errors on HTTP
   200, which `http-compat.ts:66-87` + `glm-ocr.ts:131` never anticipated):
   transport-error > body-code≠0 > `md_results` missing/null >
   `md_results:""` (return `{text:"",pages:N,lowConfidence}` ONLY if
   `data_info.num_pages` confirms blanks, else `glm_error` — blank deck
   must not poison `failedPages`); partial-code-with-text surfaces as
   `lowConfidence+failedPages`, never silent success; accept BOTH flat
   `{code,message}` and nested `{error:{code,message}}` shapes.
   Remote `GET` (`route.ts:98-114`) must do a REAL authenticated liveness
   check (tiny `layout_parsing` call — the only probe that proves
   key/balance/entitlement, gate G4/G7), else `available:false` WITH
   reason (not a silent hide — `glm-ocr.ts:30-39` discards reason today,
   fix the contract to `{available,reason,checkedAt}`); map remote auth
   failures to `glm_model_unavailable` 503 (`:189-192`), never
   `glm_error`. **Cache the verdict server-side** (gate G7 — the remote
   probe is a BILLED POST, not the free local `GET /v1/models`; `GET` and
   `POST` share the 20/min window `route.ts:67,107-109` with no separate
   probe bucket, so N lecturers × dialog opens = chronic spend):
   positive TTL ~300 s, negative ~30 s, separate `ocr-health` bucket.
   Never gate UI on an uncached billed call.
   Update header comments (`:1-18`, probe fn runs to `:134`).
   Ban the `file:url` input shape entirely — accept only validated
   base64 bytes (image sniff `:181` + `%PDF` header check for PDFs);
   forwarding a client URL lets the client aim Z.ai's fetcher at an
   attacker URL (content laundering into the quiz pipeline, billed to
   our key — SSRF-by-proxy), re-opening the SSRF the proxy was built to
   close (gate G5).
3. Client path (`glm-ocr.ts`, `pipeline.ts:99-101,164-170`): remote mode
   sends PDF bytes ONCE (chunked by `start/end_page_id` when over cap —
   omitted entirely until inclusivity is verified, gate G10),
   NOT the per-page loop (`glm-ocr.ts:53-99,121-135` — one billed
   image-parse per page today, 10–200× overspend remotely); keep
   per-page only for single images. Page cap becomes provider-aware
   (`MAX_OCR_PAGES=200`, `types.ts:56`, cannot stand for remote —
   interim 30); bypass `sanitizeGlmText` (`glm-ocr.ts:296-298`, fence-run
   collapsing) for markdown `md_results` — with a markdown-aware
   replacement, not bare removal (remote fence/layout-tag noise is
   otherwise unsanitized). Progress (`onProgress(page,total)`) goes quiet
   on one-POST whole-doc runs (~16 s silence) — chunk progress replaces
   it. **Spend governor ships WITH whole-PDF-once, not after** (gate G8 —
   ESTIMATED tokens × shared key × Map-only limits = uncapped blast
   radius: 4096px canvas `glm-ocr.ts:42,74-77` may tokenize 10× over
   estimate, one 200pp deck × whole-doc retries bills the shared key with
   no circuit-breaker): persist a token ledger (not Maps), interim
   30pp reject-with-413 in `route.ts:150-183`, per-user daily token/$ cap
   + env kill-switch, log `usage.total_tokens × price` per `request_id`.
   Retry/backoff designed for metered use (today only
   `glm_rate_limited`/`glm_busy` retryable, `glm-ocr.ts:114`; 429→
   `rate_limited` else `http_error`, `http-compat.ts:66-81` → `429/504/502`,
   `route.ts:212-222` — the HTTP mapping does NOT transfer to
   `{code,message}`, gate G2). Note the browser-side 5 s probe abort
   (`glm-ocr.ts:32`) vs 2 s upstream default.
   Also note `OCR_VISION_MODEL` (`.env.local.example:15`, `setup.ts:22`,
   CI) has NO reader in `src/**/*.ts` — the toggle must not collide with
   that dead-but-present name.
4. `.env.local.example:11-25` — document `GLM_PROVIDER` + remote triple
   (`ZAI_BASE_URL`/`OCR_GLM_MODEL=glm-ocr`/`ZAI_API_KEY`); keep local
   defaults.
5. `docs/GLM_OCR_SETUP.md` — new § for remote-API mode (env, probe
   behavior, per-doc caps 10 MB/50 MB/30-or-100pp, cost
   `$0.03/1M tokens` + measured tokens/page, how to switch back).
6. `scripts/benchmark-glm-ocr.mjs:14-15` (needs an auth flag — sends NO
   auth today, `:86-90,103-107`) + `src/test/setup.ts:24-25` (GLM vars
   strictly `:24-25`; `:22` is the dead `OCR_VISION_MODEL` default).
   MSW remote-shape units (`ocr-route.test.ts:63-71` pattern), e2e remote
   mock (none exists — `e2c` hardcodes `localhost:11434` at `:36` and
   skips CI at `:34`; header at `:13-15` is stale since the proxy
   landed).

### A2. Explicit non-goals for laptop

No `/sb` rewrite change, no `client.ts` change, no Supabase dashboard
action, no cron/realtime/quota verification, no app Dockerfile, no
`SITE_URL`/`TRUSTED_ORIGINS` change (localhost needs none), no CSP
change (Report-Only + blanket `https:` already covers the API call,
which is server-side anyway — the browser only ever hits
`/api/extract/ocr`).

---

## 3. Target B — vps-remote

**Definition:** vCPU-only VPS runs **Next.js + InsightFace**.
**Supabase is hosted free-tier. GLM-OCR is the Z.ai API** (the laptop
toggle's `remote` leg; the vLLM container is NOT scheduled — §1.3).

```
Student/lecturer browsers (public origin, e.g. https://… )
  │ HTTPS (reverse proxy / tunnel terminates TLS)
VPS (vCPU, no GPU)
  ├─ Next.js (`next build` → `node .next/standalone/server.js`, port 3000, loopback sidecars)
  └─ insightface-service (127.0.0.1:8000, token ON)
Supabase HOSTED free-tier (https://<ref>.supabase.co)
  │ Postgres + Auth + Storage + (dashboard-enabled) cron/realtime
Z.ai API (HTTPS, server-side only via /api/extract/ocr)
TinyFish Search/Fetch (free tier, unchanged, server-side)
kenari.id AI gateway (AI_BASE_URL default, unchanged, server-side)
```

### B1. Supabase → hosted free-tier

Dashboard actions (no code):

1. **Auth URLs**: set Site URL + redirect allowlist to the VPS origin
   (must include `/auth/callback`); reconfigure the Azure SSO provider
   tenant-side if SSO is used; set SMTP for prod mail.
2. **pg_cron**: enable the extension/scheduler in the dashboard
   (Dashboard → Database → Extensions + Cron UI — migration-level
   `create extension pg_cron` needs superuser and the calls are
   best-effort `raise notice`, so `db push` can succeed with ZERO jobs
   and no error), then verify all 5 jobs exist + firing
   (`0019/0022/0030/0042`) via `GET /api/health` (assert
   `cron.ok`/`missing`/`neverRan`/`lastStatus`, NOT top-level `ok` —
   `:140-150`) / `cron_health()`. Free-tier project pausing stops ALL 5
   jobs (autoclose, silence-flag, prunes) — plan a keep-alive or accept
   it (Pro $25/mo decision, §8.3/§8.6).
3. **Realtime**: enable Replication for `notifications` (poll fallback
   covers outage, but enable it anyway).
4. **Data API Max Rows**: field **"Max Rows"** (Dashboard → Project
   Settings → API; same knob as the old Integrations path
   post-reshuffle; underlying `PGRST_DB_MAX_ROWS`, default 1000 =
   `config.toml:8`). Hosted default clamps large `.limit(20000)` reads
   (see `docs/audit/audit-3-ledger.md:191`) — set deliberately. ⚠️
   Re-push CLOBBERS dashboard tuning by design (`0028:58-60` re-tightens
   bucket limits, `0007:233-245` resets `quiz-sources` to 25 MB) — keep a
   "dashboard knobs re-applied after push" checklist (Max Rows, bucket
   limits, SMTP) and re-verify post-push.
5. **Email confirmations**: local runs `enable_confirmations=false`
   (`config.toml:33`) — re-decide for prod (spam vs friction).
6. **Quotas**: ~500 MB DB, 1 GB storage total across the 4 buckets, ~5 GB
   bandwidth. 25 MB `quiz-sources` files + `incident-footage` clips fill
   this fast — the retention/prune crons are load-bearing, not hygiene.
   (`COSTS.md:42-53` quotes these tiers but predates incident footage.)

Code/config changes:

7. `next.config.ts:142-148` — the `/sb/*` rewrites hardcode local Kong
   and are WRONG for hosted. Gate them on the BUILD-time
   `NEXT_PUBLIC_SUPABASE_URL` (hosted `https://*.supabase.co` → return
   `[]`, else the four local-Kong rules). Mental-model correction:
   rewrites are UNCONDITIONAL and evaluated by `loadCustomRoutes` at
   BUILD — `next start` serves the frozen routes manifest and never
   re-invokes `rewrites()`; hosted browsers just never hit `/sb` because
   `client.ts:16-18` returns the raw URL. The stale `127.0.0.1:58021`
   destination stays live dead code until removed/gated — gate it
   explicitly, don't rely on disuse. ⚠️ This makes the URL flip a
   BUILD-arg flip, not an env flip (§7.3 dry-run trap — dev re-evaluates,
   start does not; see B1.8).
8. VPS env: `NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co` + anon
   + service_role (server-only BY CONVENTION — `admin.ts:27-44` carries
   only a comment (`:6-14`), NO `server-only` import, unlike
   `ai/client.ts:1`/`ai/tinyfish.ts:1`/`insightface-client.ts:1`;
   gitignored `.gitignore:51-53`, docker-excluded
   `.dockerignore:17-19`);
   `SITE_URL`/`NEXT_PUBLIC_SITE_URL` + `TRUSTED_ORIGINS` (+
   `ALLOWED_ORIGINS` if needed) → VPS origin; `TRUSTED_PROXY_COUNT` =
   the REAL hop count (Caddy-only = 1, tunnel+Caddy = 2, direct = 0
   MANDATORY — `request-ip.ts:110` trusts `x-real-ip` unconditionally
   when XFF is absent, exactly the header cloudflared strips, so direct
   posture without `=0` accepts client-forged IPs with only a
   once-per-process warn; default 1 is wrong for the other two — prove
   with forged-XFF test, gate S4) behind tunnel/proxy
   (`request-ip.ts:48-63`).
   ⚠️ BUILD-time vs RUNTIME split (gate reword): `NEXT_PUBLIC_*`
   (Supabase URL/anon, site URL, allowed hosts,
   `NEXT_PUBLIC_E2E_FAKE_SEAM`, `NEXT_PUBLIC_INTEGRITY_HARDENING_OFF`),
   `ALLOWED_HOSTS` (`next.config.ts:116-126` → `allowedOrigins`/
   `allowedDevOrigins` `:157-161`), and the §B1.7 rewrite gate ALL bake
   at BUILD — every origin/key change = rebuild + re-push with these as
   build args, not an env flip; `TRUSTED_ORIGINS` (`http.ts:270-287`)
   reads per-request and IS runtime-flippable. An operator who sets only
   `TRUSTED_ORIGINS` at runtime still gets silent action aborts
   (`next.config.ts:150-154`) and misdiagnoses a GoTrue issue. The app
   Dockerfile pins the build args; `next start` asserts effective `/sb`
   target + allowed hosts in a startup log line. Also note HSTS
   (`next.config.ts:72-75`, 2yr + includeSubDomains, no preload) ships
   TODAY on all responses — `includeSubDomains` already binds tunnel
   subdomains; `preload` submit only when HTTPS-everywhere is proven.
   VPS env is a FRESH file per this table, never a copy of laptop
   `.env.local` (which carries `localhost:*` defaults; the
   `remote-env.mjs:86-90` overlay applies to scripts only, not runtime).
9. Schema workflow: `supabase link --project-ref <ref>` FIRST (DB
   password prompt, `--skip-pooler` for direct; scripts/`--remote` need
   NO pooler — app + scripts are HTTPS-PostgREST-only,
   `remote-env.mjs:92-93`, no `DATABASE_URL` in `scripts/`; pooler/password
   is CLI-schema-ops-only), then `supabase db push --dry-run` →
   `supabase db push` (pushes only migrations absent from remote history;
   `migration list --linked` shows LOCAL-vs-REMOTE, `migration repair
   <v> --status applied|reverted` rewrites history only, no SQL re-run);
   pre-enable `vector` (in `extensions` schema) + pg_cron scheduler in
   Dashboard → Extensions FIRST (`0001:5` unqualified vs `0039:46`
   `extensions`-qualified + hard-fail guard `0039:47-52` — push without
   pre-enable aborts mid-0039 leaving a partial migration + diverged
   history; pg_cron is worse, succeeding with ZERO jobs) and post-push
   verify storage RLS (`0003:10-15,22-52`, `0028`) actually applied —
   storage inserts are push-safe by construction (`0003:5-7`,
   `0020:474-476` do-nothing; `0028:47-60` do-update; policies
   drop-if-exists+create);
   `db:reset:remote` for data wipes only (never touches schema);
   `gen-types.mjs:15` (`--local`) → `supabase gen types typescript
   --project-id <ref> --schema public --schema storage --schema cron`
   (flags VERIFIED on pinned CLI 2.113.0 — the earlier "use `--linked`"
   caution is superseded); `verify-*.mjs` stay local-only (by design,
   except `verify-mediapipe`).
10. Auth link flows re-verified against hosted: `site-url.ts:20-62`,
    `sso.ts:61-88`, `reset.ts:97-100`, `register.ts:207-214`.

### B2. GLM-OCR → Z.ai API (the toggle's remote leg)

Same code seam as Target A (§A1) — vps-remote just pins the selector to
`remote` and does NOT start the container:

1. VPS env: `GLM_PROVIDER=remote` + Z.ai root URL + `OCR_GLM_MODEL=glm-ocr`
   + `ZAI_API_KEY` (distinct var — decision §8.2 CLOSED in favor of
   introduce; key issued at the Z.AI Open Platform API-Keys page).
2. Do NOT schedule `glm-ocr` on the vCPU VPS (nvidia reservation fails
   at create; stripped needs 16g/8cpu at ~30 s/page).
3. Per-user budgets (`route.ts:67,76-77`) now ALSO meter spend, not just
   GPU holds — re-tune deliberately (long-deck 429-retries cost money
   against a remote API; see the F-F2/F-F4 note at `route.ts:59-67`).
   Both limiters are per-PROCESS Maps (restart zeroes them; a second
   replica double-spends — single-instance only, gate S6/G3).
4. Liveness MUST be real before cutover (gate G4 — §4): a failed/skipped
   probe hides the engine with no local fallback on the VPS.
5. Whole-PDF-once path ships with the toggle (gate G3): the per-page
   loop is 10–200× overspend remotely and `MAX_OCR_PAGES=200` exceeds the
   remote 30/100 cap — pages 31+ would be rejected or silently dropped
   while `glm-ocr.ts:260-287` partial-run logic reports success.

### B3. Next.js + InsightFace on the vCPU VPS

1. **App container (missing today — must be built):** app `Dockerfile`
   (multi-stage `next build` → `next start`; needs `output:"standalone"`
   in `next.config.ts:128` + explicit `cp -r public .next/standalone/`
   + `cp -r .next/static .next/standalone/.next/` — standalone does NOT
   auto-copy either; `serverExternalPackages:[exceljs]` (`:132`) opts out
   of bundling to runtime `require`, so BOTH import shapes resolve from
   `node_modules/exceljs` (20.93 MB) — but the static import
   (`export-workbook.ts:1`, reached via the per-quiz export route `:12`)
   vs dynamic `import()` (`gradebook-export/route.ts:376`, try/catch →
   typed 503 at `:435-437`) split is PROVISIONAL until an in-image smoke
   hits both export routes; failure mode is request-time typed 503, not
   a build error) + compose service carrying restart/healthcheck/mem+cpu/
   logging parity with the sidecars (`x-logging` anchor `:37-41`,
   `mem_limit/cpus` — app values UNVALIDATED at classroom scale, load-test
   before pinning,    `HEALTHCHECK` asserting liveness `{ok,db.reachable}`
   (`route.ts:66-99`) — NEVER `cron.ok`: coupling Docker health to Supabase
   cron state turns free-tier pausing into a restart loop that also zeroes
   the in-memory Maps). `.dockerignore` already excludes secrets/build
   output (`:17-71`) — note `:23` ignores `.next`, harmless for
   multi-stage `COPY --from=build` but fatal for single-stage `COPY . .`.
   Base-image decision: `node:22-slim` (sharp/glibc, CI pins node:22),
   `USER node` pattern. Ship `public/mediapipe` + `public/models`
   (measured 44.99 MB / 10 files: hand 7.46 + face 3.58 MB, wasm 11.21×2
   + 10.45 MB, js 0.31×3, bundle 0.15 MB, MANIFEST 9 entries — required
   on the exam-critical boot path `proxy.ts:63-65`); set
   `NEXT_TELEMETRY_DISABLED=1`, `NODE_ENV=production`, `PORT/HOSTNAME`,
   publish `127.0.0.1:3000:3000` to the proxy (not public; TCP loopback,
   no unix-socket option in `next start`). Add `profiles:["gpu"]` to
   `glm-ocr` (compose-spec: unprofiled services always start, profiled
   only on request — VERIFIED-spec, `docker compose config` run still
   owed) so a bare `compose up` on the vCPU VPS never tries to create it
   (no `profiles:` exists today — `:52,132`). Insightface image measured
   903 MB content / 2.65 GB disk (local daemon; method: `docker images`);
   vCPU build minutes STILL-UNVERIFIED (sdist C-compile + wheels dominate)
   — GHCR pull (~0.9 GB face + ~0.2–0.4 GB app) recommended over
   build-on-VPS.
2. **InsightFace as-is:** same image, loopback publish `127.0.0.1:8000`,
   `WEB_CONCURRENCY=1`, but provision a REAL `FACE_SIDECAR_TOKEN` on
   BOTH sides (compose root `.env` + app env — the dual-read documented
   in `compose:9-12` and
   `src/lib/face/server/insightface-client.ts:204-207,265-268`).
   Also set `FACE_SPOOF_ENFORCE=1` (`.env.local.example:128-134`,
   commented today). ⚠️ Fail-closed gate (S1): the compose file boots
   healthy with EMPTY tokens (`${…:-}`) — add a prod-env check that
   REFUSES to start the VPS stack without tokens (and without the
   kill-switches OFF), or the "provision a real token" step is a wish.
3. **Reverse proxy + TLS (Caddy recommended):** no proxy exists today
   (no `Caddyfile`, no caddy service in `compose:43-154`). Caddy:
   automatic LE/ZeroSSL issuance + renewal + auto HTTP→HTTPS (needs DNS
   A/AAAA → host, ports 80+443 open, WRITABLE PERSISTENT data dir —
   add `caddy-data:/data` + `caddy-config:/config` volumes to the new
   Caddy service BEFORE cutover, or every recreate re-issues certs into
   ACME rate-limit lockout); 2-line `reverse_proxy 127.0.0.1:3000` with
   headers (incl `Host`) passed through unchanged, `X-Forwarded-For/Proto`
   appended by default → hop rule Caddy-only = 1, tunnel+Caddy = 2
   (forged-XFF live proof still owed, gate S4). Terminate TLS at the
   proxy, forward to `:3000`; keep `TRUSTED_ORIGINS` (RUNTIME,
   `http.ts:270-287`) + `serverActions.allowedOrigins` (BUILD-time,
   `ALLOWED_HOSTS :116-126`) in sync with the public origin or logins
   silently abort (actions) and mutations 403 (`checkSameOrigin`) — see
   the BUILD/RUNTIME split in B1.8. Host firewall (Ubuntu, belt-and-braces
   — `127.0.0.1:` publishes already isolate): `allow 22 → allow 80/443 →
   enable → deny app ports`, IN THAT ORDER (`default deny` before
   `allow 22` locks out SSH); note the Docker-iptables bypass makes
   `deny 3000/8000` silently ineffective once the app is containerized
   with published ports — loopback binding is the real control. SSH:
   key-only (`PasswordAuthentication no`, `PermitRootLogin
   no/prohibit-password`), `fail2ban` optional; `unattended-upgrades`
   security pocket on.
4. **Kill switches stay OFF + enforced:** `E2E_RATE_LIMIT_DISABLED`
   (`:138`), `NEXT_PUBLIC_E2E_FAKE_SEAM` (`:153`) + `FACE_MOCK_ENABLED`
   (`:32`), `NEXT_PUBLIC_INTEGRITY_HARDENING_OFF` (`:156`) —
   harness-only, never `1` in production. Today a leak only `console.warn`s
   (`rate-limit.ts:42-51`, `insightface-client.ts:82-92`) and a
   harness-built image PROMOTED to VPS keeps baked `NEXT_PUBLIC_*=1`.
   Gate S5: hard-fail `next start` when any is `1` under
   `NODE_ENV=production` + CI assert on the VPS image/env.
5. **Rate-limit posture:** classroom-NAT budgets assume one egress IP;
   behind the VPS proxy the same logic holds — pin `TRUSTED_PROXY_COUNT`
   to the real hop count, MANDATORY `=0` for direct posture (gate S4 —
   `request-ip.ts:110` trusts `x-real-ip` unconditionally when XFF is
   absent, exactly what cloudflared strips, so direct-access accepts
   forged IPs on a warn), so per-IP budgets don't collapse into one
   global cap (`request-ip.ts:89-94`) or splinter per forged header
   (`:96-111`); log the effective proxy count at startup. Note both
   limiters are per-PROCESS Maps
   (`rate-limit.ts:2-13,89-117`, OCR `inFlight`, `route.ts:77`) — a
   restart zeroes abuse/spend counters and a second replica would
   double-spend Z.ai; single-instance only until this is externalized.
   Separately: `proxy.ts:57-61` excludes `/api/*` from `updateSession()`,
   so API routes depend on `server.ts:16-26` `setAll` + browser
   `credentials:"include"` on every same-origin fetch (never audited —
   audit all `/api` call sites before cutover) and silent refresh drops
   in Server Components are by design; poll-backed notification flows
   (`use-notifications.ts:42-56`) can lose a mid-poll refresh.

### B4. Explicit non-goals for vps-remote

No self-hosted Supabase on the VPS (no Postgres/Kong/Storage volumes,
backups, or updates to operate); no vLLM container; no MediaPipe change
(client-side WASM, vendored); no TinyFish change (free tier,
server-side, `TINYFISH_API_KEY` absent = feature hidden); no
notification/reveal/session-logic change.

---

## 4. P0 — Z.ai endpoint shape (CLOSED to doc level, 2026-09-14 round-2)

Was the blocker for both the laptop toggle (A1) and the VPS cutover
(B2). Findings below are VERIFIED (fetched Z.ai docs) unless marked
[UNVERIFIED = snippet only / needs live curl]. Consequence: **env-only
toggle is INSUFFICIENT — a second request-shaper is required** (A1
redesigned above; gates G1–G5 in §10.6).

VERIFIED (`docs.z.ai/guides/develop/openai/python`,
`docs.z.ai/guides/overview/quick-start`):

- Base URL **`https://api.z.ai/api/paas/v4/`** — the root CARRIES
  `/api/paas/v4`, no `/v1`. The current client appends
  `/v1/chat/completions` (`http-compat.ts:51`) and `GET /v1/models`
  (`:120`), so BOTH 404 against any Z.ai root (`…/paas/v4/v1/…` or bare
  host + `/v1/…`). (Coding-plan variant `…/api/coding/paas/v4`
  [UNVERIFIED, snippet] — irrelevant to OCR.)
- Auth **`Authorization: Bearer <token>`** + JSON content-type —
  compatible with existing headers (`http-compat.ts:56-57,117-118`).
  Key = Z.AI Open Platform → API Keys page (register → top-up → create;
  docs env var `ZAI_API_KEY`) — supports the §8.2 decision for a distinct
  `ZAI_API_KEY` over reusing `VLLM_API_KEY`.
- Remote model id **`glm-ocr`** (lowercase — `docs.z.ai/guides/vlm/glm-ocr`,
  `docs.z.ai/api-reference/tools/layout-parsing`). Coincidentally equals
  the local default (`route.ts:89`) — same string, different endpoint.
- Separate NON-chat OCR endpoint **`POST …/paas/v4/layout_parsing`**
  with `{model:"glm-ocr", file:url|base64, return_crop_images?,
  need_layout_visualization?, start_page_id?, end_page_id?, request_id?,
  user_id?}` → `{md_results, layout_details[][], layout_visualization[],
  data_info{num_pages}, usage{prompt_tokens,completion_tokens,total_tokens}}`.
  Limits: **image ≤10 MB, PDF ≤50 MB**; max pages **CONFLICTS: 100 (guide)
  vs 30 (API ref)** — paginate via `start/end_page_id`, clamp to `min`
  until resolved. Price **`$0.03/1M tokens` in+out**; throughput
  1.86 pp/s PDF, 0.67 img/s (doc-claimed). Per-page tokens/latency
  [UNVERIFIED — measure live via `usage{…}`].
- Remote error envelope is **`{code,message}`**, NOT OpenAI
  `{error:{…}}` (API-ref response schema). The `429→rate_limited` mapping
  does NOT transfer verbatim — needs the `code` table (gate G2).
- SDK example `timeout: 30` is example-only, not a server guarantee.

STILL NEEDS LIVE CURL (key in hand, server-side): `GET …/paas/v4/models`
existence; exact capacity/429 `code` values + bodies; p50/page +
tokens/page (measure `usage`); 100-vs-30 page-cap resolution. Until then
the `code` table (G2) and budget numbers (G3) stay provisional.

The old "different endpoint → second shaper" conditional (§4 late
paragraph) is now RESOLVED: yes, `layout_parsing` exists — A1 sizes
accordingly.

---

## 5. Work breakdown

| # | Work item | Target | Files / refs | Depends on |
|---|---|---|---|---|
| 1 | P0 doc probe (§4 — CLOSED to doc level; live curl still owed for `code` table + budgets) | both | `http-compat.ts:51,114,120-128` | — |
| 2 | GLM toggle design: `GLM_PROVIDER` (explicit, fail-closed) + `ZAI_API_KEY` (decision CLOSED: introduce) + `httpLayoutParsing` shaper | laptop | `route.ts:86-95,150,185,194`, `.env.local.example:11-25` | 1 |
| 3 | Toggle implementation: shaper + `code` table + envelope precedence + whole-PDF-once (chunk retry unit) + provider-aware caps + cached real liveness + `url`-ban + spend governor + key-redaction invariant | laptop | `route.ts`, `http-compat.ts`, `glm-ocr.ts:199-287`, `pipeline.ts:99-101,164-170`, `types.ts:33-38,56`, `EnginePicker.tsx:40-48`, `GenerateFromFileDialog.tsx:340-351,918-933` | 2 |
| 4 | Docs: remote-API § in GLM guide + toggle contract | laptop | `GLM_OCR_SETUP.md`, `.env.local.example` | 3 |
| 5 | Bench (auth flag) + test seams follow the toggle | laptop | `benchmark-glm-ocr.mjs:14-15,86-107`, `src/test/setup.ts:24-25`, `ocr-route.test.ts:63-71` pattern, `http-compat.test.ts`, `e2c-glm-ocr.spec.ts:34-39` (local leg; remote leg needs a mock — none exists) | 3 |
| 6 | Hosted Supabase dashboard pass (auth URLs, SSO, SMTP, cron, realtime, max-rows, confirmations) | vps | Supabase dashboard; `0019/0022/0030/0042`; `/api/health` | — |
| 7 | Conditional `/sb` rewrites for hosted URL | vps | `next.config.ts:141-149`, `client.ts:13-19` | — |
| 8 | VPS env + origin wiring (`SITE_URL`, `TRUSTED_ORIGINS`, `TRUSTED_PROXY_COUNT`=real hops) + build-vs-runtime matrix | vps | `.env.local.example:84-126`, `site-url.ts:20-62`, `http.ts:253-290`, `request-ip.ts:48-111` | 6 |
| 9 | Link + push + pgvector pre-enable + storage-RLS verify + knobs checklist + remote type gen + seed | vps | `link→push→repair`, `gen-types.mjs:15`, `db-reset-remote.mjs`, `seed-demo --remote` | 6 |
| 10 | App Dockerfile + `output:standalone` + in-image export smoke + compose app service (restart/decoupled-health/mem/logs) | vps | `next.config.ts:128`, `docker-compose.yml`, `.dockerignore` | — |
| 11 | Caddy + TLS + volumes + ufw + origin allowlists (BUILD/RUNTIME split) | vps | Caddyfile (new), proxy/tunnel config, `ALLOWED_HOSTS :116-126` | 8, 10 |
| 12 | Sidecar tokens ON both sides + `FACE_SPOOF_ENFORCE=1` + fail-closed prod-env gate | vps | compose root `.env`, app env, `src/lib/face/server/insightface-client.ts:101-105,203-207,265-268`, `.env.local.example:128-134,138,153,156` | 10 |
| 13 | OCR budget re-tune for metered remote use | vps | `route.ts:59-77` | 1, 3 |
| 14 | `COSTS.md` VPS sizing refresh (VPS + hosted-Supabase + Z.ai, drop Vercel-Hobby model) | vps | `COSTS.md` | 1, 10 |
| 15 | Cutover checklist + REAL atomic rollback (schema+data+roles dump, storage mirror, auth export, knobs snapshot, DNS TTL, env snapshot — NOT `db:reset:remote`, which is a data nuke, not a restore) | vps | this §7 | 6–13 |

Out of scope (both): MediaPipe, TinyFish, notification/reveal/session
logic, new migrations (none anticipated — schema ships via `db push`).

---

## 6. Verification per target

Laptop (toggle): `GET /api/extract/ocr` → `{available:true}` on BOTH
legs; `npm run glm:bench` against local; one scanned-PDF extraction per
leg; `vitest run src/app/api/extract src/lib/ai src/lib/extract`;
`npm run check:env`; existing `e2c-glm-ocr` suite on the local leg.
VPS-remote: `/api/health` asserting `cron.ok` + `missing`/`neverRan`
(assert `cron`, never top-level `ok` — `:140-150`), in-image smoke of
BOTH export routes (typed 503 expected on trace failure, never raw 500 —
`gradebook-export/route.ts:395-438`, per-quiz `export/route.ts:191-197`),
hosted auth flows (signup→confirm→login→reset→SSO if used, with the
BUILD/RUNTIME origin split in §B1.8 — runtime `TRUSTED_ORIGINS` alone
will not fix silent action aborts), class→quiz→session→submit smoke on
hosted, OCR extraction via Z.ai leg, `verify-*.mjs` stay local (they are
NOT a VPS gate — `target-guard.mjs`; a VPS-side smoke replacing them does
not exist yet — ops gate O4), Playwright suite against the VPS origin
with `TRUSTED_ORIGINS` set, CSP console watch (Report-Only violations)
before any enforcement flip (gate S3 — enforce-time delta: add
`https://*.supabase.co` to `img-src` + `media-src`, which direct-hosted
signed URLs need; never blanket `https:`).

---

## 7. Rollout order

1. **P0 live curl (§4)** — `code` table + tokens/page + cap resolution.
2. **Laptop toggle (A1)** — second shaper + whole-PDF-once + caps +
   liveness; proves the remote leg where debugging is cheap.
3. **Hosted Supabase prep (B1: 6–9)** — dashboard + push + seed; the app
   can point at it from the laptop for a FUNCTIONAL dry run (`--remote`
   scripts exist; `client.ts` passes hosted through) — ⚠️ with the
   build-trap caveat: laptop `next dev` re-evaluates `rewrites()` per
   request, but `next start` serves the frozen build manifest, so a green
   dev dry-run does NOT prove the prod image (URL flip = rebuild+repush
   with `NEXT_PUBLIC_*` + `ALLOWED_HOSTS` as build args; the image
   asserts effective `/sb` target + allowed hosts at startup).
4. **VPS app + face (B3) + origins (B2/B3)** — container, proxy/TLS,
   tokens, budgets.
5. **Cutover** — DNS/origin flip (lower TTL ≤300 s pre-flip), `SITE_URL`
   pin, smoke (§6), keep-alive decision for free-tier pausing. Rollback
   is a REAL atomic restore, not `db:reset:remote` (which deletes all
   `auth.users` + 4 buckets — a nuke, `db-reset-remote.mjs:61-88`):
   `-s public,storage` schema dump + `--data-only` + `--role-only` +
   per-bucket `supabase storage cp -r ss:///<bucket> ./mirror/` (objects
   only — NOT limits/MIME/policies/versions/owner) + Admin-API
   paginated `listUsers` export (dump excludes managed `auth`/`storage`
   schemas by default; explicit `-s auth` override UNTESTED — paginate,
   don't trust `perPage:1000` past 1000 users, `seed-demo.mjs:61`) + env
   snapshot + dashboard-knobs snapshot (Max Rows, bucket limits, SMTP —
   re-push CLOBBERS them) + `supabase migration repair` plan for
   `schema_migrations` divergence, with RPO/RTO stated (ops gate O3).
   Round-trip restore is UNTESTED until rehearsed — rehearse it.

---

## 8. Open decisions

1. ~~Z.ai base path + model id + `/v1/models` behavior (§4 — P0).~~
   CLOSED to doc level (§4): base `https://api.z.ai/api/paas/v4/`, model
   `glm-ocr`, Bearer, `{code,message}` envelope, `layout_parsing`
   endpoint. Owed: live curl for `code` table + tokens/page + 100-vs-30.
2. ~~Key var: reuse `VLLM_API_KEY` for the Z.ai key or introduce
   `ZAI_API_KEY` (recommendation: introduce — the current dual-read is
   a same-value contract between compose and app; a third meaning
   invites mismatch 401s).~~ CLOSED: introduce `ZAI_API_KEY`.
3. Free-tier comfort: 1 GB storage / 500 MB DB / pausing vs Supabase Pro
   $25/mo (`COSTS.md:99`).
4. `enable_confirmations` for prod (`config.toml:33`).
5. OCR budgets against metered API (B2.3 — needs §4.5 numbers).
6. Keep-alive strategy for free-tier project pausing.

---

## 9. File index (every path this plan touches)

Must-change (laptop toggle): `src/app/api/extract/ocr/route.ts:86-95`
(+ header `:12-22`, remote branch `:150,185,194`), new
`httpLayoutParsing` in `src/lib/ai/http-compat.ts` (beside, not instead
of, `httpChatCompletions`), `glm-ocr.ts:199-287` (chunk retry unit) + `pipeline.ts:99-101,164-170`
(whole-PDF-once, `pagesToRetry` splice) + `types.ts:33-38,56` (chunk-retry
contract + provider-aware cap) + `GenerateFromFileDialog.tsx:340-351,918-933`
(chunk-retry splice + retry UI),
`.env.local.example:11-25`, `docs/GLM_OCR_SETUP.md`,
`scripts/benchmark-glm-ocr.mjs:14-15,86-107`, `src/test/setup.ts:24-25`.

Must-change (vps-remote): `next.config.ts:141-149` (rewrites),
`next.config.ts:128` (`output:standalone`), VPS env
(`SITE_URL/TRUSTED_ORIGINS/NEXT_PUBLIC_SITE_URL/AI_*/FACE_SIDECAR_TOKEN+ZAI_API_KEY`),
root `.env` (`FACE_SIDECAR_TOKEN`; no `VLLM_API_KEY`/`GLM_OCR_REVISION` on VPS — no local container),
hosted dashboard (Site URL, redirects, Azure SSO, SMTP, Max Rows, cron,
replication, pgvector pre-enable, `supabase link` before `push`), app
`Dockerfile` (new) + compose app service, proxy/TLS config (new),
`docs/COSTS.md`.
Verify (vps-remote): `0019/0022/0030/0042` cron jobs,
`0022:90-108` publication, `0003/0007/0020/0028` buckets vs quota,
`pgvector` (`0001:5`, `0039:46-52`), `site-url.ts:20-62`, `sso.ts:61-88`,
`reset.ts:97-100`, `register.ts:207-214`, `client.ts:13-19`,
`env.ts:16-19`, `http.ts:253-290`, `request-ip.ts:48-111`,
`proxy.ts:37-68` (+ `middleware.ts:63-95` cookie/session handling),
`src/lib/face/server/insightface-client.ts:101-105,203-207,265-268`,
`remote-env.mjs:86-123`, `check-env-parity.mjs`,
`EnginePicker.tsx:40-48,91-93`, `glm-ocr.ts:32,102-135`,
`db-reset-remote.mjs:34`.
No-change: `supabase/config.toml` (laptop leg),
`pdf.ts`, `image-guard.ts`,
`docker/glm-ocr/Dockerfile` + `compose:52-123` (retained as local leg),
`docker/insightface/*` (image as-is), `verify-*.mjs` (local-only by
design, except `verify-mediapipe.mjs:1-22`), `.dockerignore`,
`.gitignore:51-53`, `next.config.ts:46` CSP (until gate S3 enforces it).

---

## 10. Review findings (2026-09-14)

Four chunk investigators (Supabase / GLM toggle / VPS Docker /
env-networking) verified every claim against the code; two adversarial
critics (security, ops/readiness) attacked the plan. Method: read plan →
read code → confirm/correct/gap-hunt. All §1–§9 corrections above are
folded in; the review's line-ref drift list (stale cites the investigators
caught) is resolved inline. No code was changed.

### 10.1 Verdict: is the plan detailed enough?

**NO — not executable, not safe as-is.** Unanimous across all six
reviewers. The plan is an accurate SEAM INVENTORY (every file that must
be touched is named, and the investigators confirmed ~90% of claims with
only line-range drift), but it is insufficient OPERATOR PROCEDURE: it
states *what* (Dockerfile, tokens, dashboard pass, budgets) without the
*how* (exact commands, value tables, decision rules, expected outputs,
failure-mode handling). The P0 (§4) is correctly identified as the
critical path — the GLM investigator adds that "no transport change" was
premature (suffix concat `:51,120` can 404) and that `OCR_VISION_MODEL`
is a dead-but-present name the toggle must avoid colliding with.

### 10.2 Security gates (must close before cutover)

- **S1 — Fail-closed prod env.** Compose boots healthy with EMPTY
  `VLLM_API_KEY`/`FACE_SIDECAR_TOKEN` (`docker-compose.yml:74,139`;
  app sends no header when empty). Add a prod-env check that REFUSES to
  start the VPS stack without real tokens (and kill-switches OFF).
  Without it, "provision a real token" (B3.2) is a wish and bind-drift
  exposes an unauth `/extract` embedding oracle.
- **S2 — Prod-wipe gate is theater.** `FALLBACK_CONFIRM_TOKEN` is
  committed in the repo (`remote-env.mjs:37`) with warn-only fallback
  (`:41-52`); `ALLOW_PROD_SEED=1` skips the prompt (`:129-138`); the
  audit log is local + gitignored (`:38-39`). Delete the literal,
  require out-of-band `PROD_CONFIRM_TOKEN` for destructive `--remote`
  runs, ship the audit log off-host.
- **S3 — Enforce transport policy.** CSP is Report-Only (`next.config.ts:53-57`)
  + blanket `https:` (`:46`); HSTS lacks `preload` (`:72-75`) and no
  proxy/TLS exists yet. Enforce CSP (pin Supabase/Z.ai, drop blanket
  `https:`, add `report-uri`) + TLS/HSTS-preload at the proxy before
  cutover — "no change today" was migration convenience, not posture.
- **S4 — Prove the hop count (REWORDED round-3: `=0` MANDATORY for
  direct).** Default `TRUSTED_PROXY_COUNT=1`
  (`request-ip.ts:48-50`) is wrong for both direct (0) and tunnel+proxy
  (2) chains — wrong value collapses per-IP budgets into a global cap
  (`:89-94`) or mints attacker-chosen buckets (`:96-111`), silently
  aborting actions / 403ing mutations. `request-ip.ts:110` trusts
  `x-real-ip` unconditionally when XFF is absent (exactly what cloudflared
  strips), so direct-access + default = forged-IP acceptance on a warn.
  Pin the real count (Caddy-only 1, tunnel+Caddy 2, direct 0 MANDATORY) +
  forged-XFF smoke test + startup log of the effective count.
- **S5 — Kill-switch enforcement.** Leaks today only `console.warn`
  (`rate-limit.ts:42-51`, `insightface-client.ts:82-92`) and baked
  `NEXT_PUBLIC_*=1` survives a promoted harness build. Hard-fail
  `next start` when any kill-switch is `1` under `NODE_ENV=production`
  + CI assert on the VPS image/env.
- **S6 — Shrink `/api/health` + harden `admin.ts` + durable spend
  (EXTENDED round-3: G8).** Health is anon +
  DB-touching (`route.ts:66-99`) and returns cron topology (`:102-133`).
  Strip anon to `{ok}` / gate cron detail behind lecturer auth;
  add the missing `server-only` import to `admin.ts` (today comment-only,
  `:6-14`); define the Z.ai key var + rotation + DURABLE spend cap with
  per-user daily token/$ budget + env kill-switch + redacted per-call
  `usage.total_tokens × price` log per `request_id` (per-process Maps
  don't meter across instances/restarts — gate G8: persist the token
  ledger, interim 30pp reject-with-413; do not ship whole-PDF-once
  without it).

Statements that gave FALSE confidence (corrected above): "rewrites go
idle" (§B1.7 — rewrites are unconditional, hosted browsers just never hit
`/sb`); "`service_role` server-only — `admin.ts`" (no `server-only`
import); "Report-Only needs NO change" (enforces nothing); "mock seam
never on in production" (two env vars + promoted build = silent bypass);
"verify-*.mjs stay local-only" blanket (except `verify-mediapipe`).

### 10.3 Ops gates (must close before cutover)

- **O1 — App service spec (PARTLY CLOSED round-3, smoke owed).**
  Dockerfile sketch closed (`node:22-slim`, multi-stage, `USER node`,
  `ENV NODE_ENV/NEXT_TELEMETRY_DISABLED/PORT/HOSTNAME`, `EXPOSE 3000`,
  explicit `public/` + `.next/static` copies, `profiles:["gpu"]` guard —
  `docker compose config` run owed), compose `app:` fields closed
  (loopback `:3000`, `depends_on` healthy face, `env_file`, `x-logging`,
  `restart`; mem/cpus UNVALIDATED — load-test at classroom scale before
  pinning), Caddy choice + volumes (`caddy-data:/data`,
  `caddy-config:/config` — WITHOUT them every recreate re-issues certs
  into ACME lockout) + ufw order (`allow 22 → 80/443 → enable → deny`,
  Docker-bypass caveat noted) closed, sizing table still owed (vCPU
  minutes + image GB measured: face 903 MB/2.65 GB; app ~0.2–0.4 GB est).
  `exceljs`/standalone downgraded to PROVISIONAL (round-3 spot-check):
  no app Dockerfile exists to verify against, and failure is request-time
  typed 503 (both routes catch → 503), not a build error — in-image smoke
  of both export routes is the gate.
- **O2 — Free-tier math + pause decision.** 40 decks × 25 MB = 1 GB alone
  (quota: 1 GB storage / 500 MB DB / 5 GB bandwidth); face embeddings live
  in Postgres pressing 500 MB; pausing stops ALL 5 crons (first break:
  silence-flag integrity bypass; second: autoclose; third: prune quota
  death spiral). Decide keep-alive vs Pro $25/mo BEFORE cutover (§8.3/§8.6),
  assign a monitor to poll `/api/health` asserting `cron.ok` (nobody owns
  it today; `ok:true` hides `degraded:true`).
- **O3 — Real rollback (PROCEDURE CLOSED, rehearsal owed).** Atomic set
  specified in §7.5 (schema+data+roles dumps, per-bucket `storage cp`
  mirror with stated limits, paginated Admin-API user export, env +
  knobs snapshots, TTL ≤300 s, RPO/RTO) — but the round-trip restore is
  UNTESTED (dump excludes managed schemas by default; `storage cp`
  copies objects only; re-push clobbers dashboard knobs). Rehearse
  backup→wipe→restore on the hosted project BEFORE cutover; until then
  O3 is procedure-only. §7's old `db:reset:remote` + reseed line is
  struck everywhere — that script is a DATA NUKE
  (`db-reset-remote.mjs:61-88`), not a restore (and `listUsers`
  `perPage:1000` silently truncates past 1000 users).
- **O4 — VPS-side verification.** `verify-*.mjs` refuse remote
  (`target-guard`); only a one-time smoke + CSP watch gated the cutover.
  Write the VPS smoke (health/cron/auth/quiz-session/OCR/latency/error-rate
  assertions) before the flip.
- **O5 — Env procedure (MOSTLY CLOSED round-3).** Closed: env value
  table (change/stay/must-stay-unset — §B1.8), build-vs-runtime
  matrix (BUILD: `NEXT_PUBLIC_*` + `ALLOWED_HOSTS` + rewrite gate;
  RUNTIME: `TRUSTED_ORIGINS`; §B1.7/B1.8), origin checklist with failure
  signatures (dashboard→GoTrue errors `callback:49-54/23-32`;
  `TRUSTED_ORIGINS`→403 `invalid_origin` `http.ts:225-227,289`;
  `ALLOWED_HOSTS`→silent action abort `next.config.ts:150-154`;
  `SITE_URL`→wrong emailed origins), rewrite snippet shape (gate keys off
  build-time `NEXT_PUBLIC_*`), `.env`-vs-`.env.local` drift rule (fresh
  VPS file, never a copy), cookies (no action — host-only, Lax, no
  Secure anywhere; `secure:true` optional hardening), WSS (no action —
  direct `wss://*.supabase.co`, allowed in `connect-src`, no CORS on WS,
  poll-heal by design), IPv6 (no action — opaque string through
  `request-ip.ts:86-111`), TCP-loopback decision (no socket option),
  CSP/HSTS flip design (owner + pin list + `report-uri`-needs-collector;
  enforce-time `img-src`/`media-src` delta for direct-hosted signed
  URLs). Owed: CSP clean-console duration + `report-to` collector
  (STILL-UNVERIFIED — none exists in code).

### 10.4 What's still missing after the gates (known follow-ups — round-3 status)

Supabase chunk: CLOSED — `link→push→repair` sequence, pooler rule
(HTTPS-only scripts vs CLI-ops password), SMTP/template dashboard
counterparts (`MAILER_AUTOCONFIRM` etc.), `--project-id/--schema` types
flags (pinned CLI 2.113.0), dump flags + `storage cp` mirror, seeds ≈ 0
storage / single-digit MB DB (quota risk is production traffic, not
seeds); owed: explicit `-s auth` restore test, `pg_dump` cadence.
GLM chunk: CLOSED to provisional spec — `layout_parsing` schema,
`code` table (generic page; endpoint behavior owed live), interim
chunk 30, cost formula ($0.03/1M + measure `usage`), validation order,
tiny-parse liveness, `url`-ban; owed live: `code` shapes per endpoint,
30-vs-100, tokens/page, `data:`-prefix, page-id inclusivity, probe size.
Docker chunk: CLOSED to sketch — `node:22-slim`, standalone copies,
`app:` fields, Caddy + volumes + ufw order, env table, payload measured
(44.99 MB/10 files), face image 903 MB/2.65 GB; owed: vCPU build minutes,
`docker compose config` run, in-image export smoke, GHCR-vs-build final,
tesseract exact vendor bytes.
Env chunk: CLOSED (see O5) except CSP duration + collector.

### 10.5 Round-1 answer (kept for record — verdict updated by §10.6)

The plan as reviewed in round-1 was a **mapping draft, not an execution
plan**: seam authority only, close S1–S6 + O1–O5, then cut over. Cheapest
risk reduction path (still valid): P0 probe (§4) + laptop toggle (A1) +
hosted dry-run from laptop (§7.3).

### 10.6 Round-2 findings (2026-09-14): P0 closed, shaper required, new gates

Three targeted investigators (Z.ai shape via fetched docs / Supabase
workflow via Context7 / Docker-proxy-env via Context7 + measurement)
closed the round-1 follow-ups to doc/sketch level; two adversarial
critics attacked the revised design. No code changed.

**P0 outcome:** env-only toggle DEAD — `layout_parsing` exists, so §2–§4
were rewritten for a second shaper. Supabase outcome: exact command
sequence closed (`supabase link --project-ref <ref>` →
`db push --dry-run` → `db push`; `migration list --linked` /
`migration repair <v> --status applied|reverted`; `gen types --linked` —
note the plan's earlier `--project-id/--schema` types variant is
UNVERIFIED, use `--linked`); pgvector (`vector` in `extensions` schema)
+ pg_cron pre-enable BEFORE push (else 0001-unqualified vs 0039-hard-fail
→ partial migration + diverged history); Max Rows location confirmed
(section only — field name UNVERIFIED); storage-push idempotency
UNVERIFIED (bucket `0003:5-7` + rerunnable policies `0003:22-52` suggest
safe). Docker outcome: `node:22-slim` (sharp/glibc, CI pins node:22),
`output:"standalone"` + explicit `public/` + `.next/static` copies
(`exceljs` CJS trace UNVERIFIED — smoke-test the export routes in-image),
compose `app:` sketch closed (loopback `:3000`, `depends_on` healthy
face, `env_file`, `profiles:["gpu"]` guard), Caddy preference
(UNVERIFIED as preference), env change/stay/unset table closed,
vendored `public/` measured 45.0 MB / 10 files (hand 7.8 + face 3.76 MB).

**New GLM gates (G1–G5, must close with the toggle implementation):**

- **G1 — Contract rupture.** Route promises `{text}` (`route.ts:224`)
  but upstream returns `{md_results,…}`; route accepts 32M dataURLs vs
  10 MB remote cap; `MAX_OCR_PAGES=200` vs 30/100; `sanitizeGlmText`
  mangles markdown tables; `usage{…}` dropped (spend, no audit). Fix in
  A1.1–A1.3 as specified.
- **G2 — `{code,message}` error table.** HTTP-429 mapping does NOT
  transfer; misclassification burns billing (retry into dead keys) or
  drops capacity retries. Explicit `code` table in `httpLayoutParsing`;
  unknown `code` → non-retryable; log `code/message` server-side.
- **G3 — Whole-PDF-once.** Per-page loop = 10–200× overspend + trips
  `OCR_RATE 20/min` mid-deck + pages 31+ lost while partial-run logic
  (`glm-ocr.ts:260-287`) reports success. Provider-aware caps; chunk by
  `start/end_page_id`.
- **G4 — Real liveness.** "Available:true on auth-config check" proves
  env presence, not key/balance/entitlement — picker lies, POST fails
  with the wrong code after wasted rasterization. Cheap authenticated
  liveness in remote `GET`; auth failures → 503
  `glm_model_unavailable`, never `glm_error`.
- **G5 — `url`-shape ban + durable spend.** `file:url` passthrough re-opens
  the SSRF the proxy closed (`route.ts:20-22`) — base64-bytes only.
  Per-process Maps don't meter spend across restarts/replicas —
  durable cap + redacted per-call usage log (extends S6).

**Ops-critic corrections folded in:** HEALTHCHECK must assert liveness
(`{ok,db.reachable}`, `route.ts:66-99`) NOT `cron.ok` — coupling Docker
health to Supabase cron state turns free-tier pausing into a restart
loop that also zeroes the in-memory Maps. `exceljs` split confirmed:
dynamic `import()` in `gradebook-export/route.ts:376` (trace-safe) vs
STATIC import in `export-workbook.ts:1` (the prod-only 503 risk — round-3 spot-check: both routes catch → typed 503 only, never raw 500; split downgraded to PROVISIONAL —
smoke-test in-image). `env_file .env.local` on VPS is a named trap:
laptop's copy carries `localhost:*` defaults and the overlay
(`remote-env.mjs:86-90`) applies to scripts only — VPS env is a fresh
file per the §B1.8 table, never a copy. First-`push` ordering
(pre-enable → dry-run → push → assert `cron_health()` + storage RLS) is
now in §B1.9.

**UNVERIFIED triage v2 (blocks cutover — round-3 closers applied):**
live-curl `code` shapes per endpoint + tokens/page + 100-vs-30 +
`data:`-prefix + page-id inclusivity + probe size; `standalone`+`exceljs`
in-image smoke (PROVISIONAL until then); Caddy TLS + forged-XFF proof;
tokens fail-closed + kill-switches OFF; decoupled HEALTHCHECK;
backup round-trip REHEARSAL (procedure closed, restore untested) + DNS TTL
+ RPO/RTO; mem/cpus load-tested at classroom scale; vCPU build minutes;
`docker compose config` run; explicit `-s auth` restore test; GHCR-vs-build
final. **Closed since v1:** types `--schema` spelling (pinned CLI 2.113.0),
Max-Rows field name, storage-push safety (by construction), seed-vs-quota
(seeds ~0), pooler rule, SMTP/template counterparts, standalone copy rules,
Caddy semantics, ufw/SSH procedure, env table, cookies/WSS/IPv6/ports
(no action), origin checklist, rewrite build-time semantics. **Deferrable:**
tesseract exact vendor bytes, CSP duration + `report-to` collector,
log aggregation.

**Updated verdict:** plan is now a **reviewed design draft with closed
decisions** (P0 shape, key var, link→push→repair, base image, env
table, atomic backup procedure, envelope precedence, spend governor design)
— still NOT executable/safe until S1–S6 + O1–O5 + G1–G10 close
with the live-curl numbers. Cheapest next step unchanged: live Z.ai curl
(§4 owed list) → laptop toggle (A1) → hosted dry-run from laptop (§7.3, build-trap caveat noted).

### 10.7 Round-3 findings (2026-09-14): closers + second red-team, new gates G6–G10

Four closers (Supabase / Docker / env-net / GLM-spec, all VERIFIED-vs-owed
graded) closed nearly everything doc-closable; two adversarial critics
(GLM-spec, VPS-ops) attacked the result with fresh eyes and found REAL new
holes. All folded into §2/§3/§7/§9/gates above. No code changed.

**New GLM gates (G6–G10, must close with the toggle implementation):**

- **G6 — Chunk is the retry unit.** Whole-doc `md_results` STRING has no
  page boundaries — the per-page F-F2 machine (`pageTexts[]`,
  `failedPages`, `rateLimitedPages`, `pagesToRetry` splice,
  `GenerateFromFileDialog.tsx:340-351`, `types.ts:33-38`) cannot survive
  it. Split ONLY from `layout_details[][]` page indices, never string-split
  markdown; if unsplittable, `pageTexts=undefined` + whole-chunk retry with
  explicit re-bill warning. Progress goes chunk-grained (~16 s silence
  otherwise); `sanitizeGlmText` needs a markdown-aware replacement, not bare
  removal.
- **G7 — Cached, reasoned liveness.** Remote probe is a BILLED POST sharing
  the 20/min window with no separate bucket — N lecturers x dialog opens =
  chronic spend, and boolean `available` conflates dead-key with
  rate-limited. Server-cache verdicts (positive ~300 s, negative ~30 s),
  separate `ocr-health` bucket, `{available,reason,checkedAt}` contract
  through `glmAvailable()` + picker. Never gate UI on an uncached billed call.
- **G8 — Spend governor ships WITH whole-PDF-once** (extends S6).
  ESTIMATED tokens x shared key x Map-only limits = uncapped blast radius
  (4096px canvas may tokenize 10x over estimate; 200pp x whole-doc retries,
  no circuit-breaker). Persist the token ledger; interim 30pp
  reject-with-413; per-user daily token/$ cap + env kill-switch; log
  `usage.total_tokens x price` per `request_id`.
- **G9 — Envelope precedence.** PaaS rides errors on HTTP 200 — define:
  transport-error > body-code!=0 > `md_results` missing/null >
  `md_results:""` (blank only if `data_info.num_pages` confirms blanks,
  else `glm_error`); partial-code-with-text → `lowConfidence+failedPages`,
  never silent success; accept BOTH flat and nested `{error:{code,message}}`
  shapes. Empty-vs-missing conflation builds quizzes on truncated text or
  discards paid-for text.
- **G10 — Fail-safe OWED defaults.** Client is 1-based inclusive — if remote
  `end` is exclusive, `end=N` silently drops the last page with
  `successCount==attempted`. OMIT `start/end_page_id` until verified;
  fail-closed on `data:`-prefix/sniff; `request_id=crypto.randomUUID()` per
  attempt (no reuse until idempotency verified); salt+rotate `user_id` daily
  or omit (stable hash = permanent third-party tracking ID).

**Ops-critic corrections folded in (round-3):** HEALTHCHECK asserts liveness
`{ok,db.reachable}` ONLY (already in §B3.1 — rationale now explicit);
`exceljs` split downgraded to PROVISIONAL (no app Dockerfile exists; failure
is typed 503, not 500); `env_file .env.local` named-trap warning;
first-push ordering; BUILD-vs-RUNTIME origin split (§B1.8);
Caddy volumes + ufw order + Docker-bypass caveat; `TRUSTED_PROXY_COUNT=0`
MANDATE for direct; `/api` credential-forwarding audit owed; HSTS
already-shipping note (preload only is future); `connect-src` blanket removal
must pin traineddata FETCH (script-src pin covers worker/core only);
`storage cp` limits + knobs-clobber checklist; `listUsers` pagination past
1000; build-trap caveat on the §7.3 dry-run (dev re-evaluates, start does not).

**Loop status:** round-1 (6 reviewers) → round-2 (5 investigators + 2 critics)
→ round-3 (4 closers + 2 critics). Each round found fewer, narrower issues
(drift → missing procedures → design corrections → edge-case hardening).
Remaining unknowns are ALL live-key or live-host bound (curl shapes, in-image
smoke, build minutes, restore rehearsal, hop-count proof) — no further
doc-round can close them. **Loop terminates here by exhaustion rule:** next step
is execution (live curl → toggle → dry run), not another review round.

**Termination sweep (same session):** a final fresh-eyes agent re-read the
full doc (then 1169 lines) against code — 8/8 new spot-checks CONFIRMED
(dialog splice `:340-351` + retry UI, no `CLIENT_TIMEOUT_MS` symbol,
`callback/route.ts` paths, `server.ts:16-26` swallow + `middleware.ts:71-89`
replay, typed-503 exports via `http.ts:220-222`, `seed-demo.mjs:61` 1k
truncation, `proxy.ts:63-67` + 9-key MANIFEST, `pipeline.ts:169` +
`tesseract.ts:48,53`), zero stale refs in sample. Only 3 editorial nits
surfaced (duplicate O3 block, duplicated §9 Must-change/Verify copies with
drifted refs, §9 No-change contradicting A1 on `pipeline.ts`/`types.ts`/
dialog) — all fixed inline (§9 single-copy, O1–O5 ordered, G6 contract
files in Must-change). **Loop CLOSED: nothing else surfaces; everything
doc-verifiable is verified.**

# InnoVision — Cost Breakdown

> **Scope:** the infrastructure and services needed to build, run and demo the
> MVP, plus the two deployment targets that exist today — the **laptop stack**
> and the **vCPU VPS** (`docs/DEPLOY_VPS.md`).
>
> **Honesty contract for this file:** every number below is tagged
> **[MEASURED]** (observed in this repo / on the local host),
> **[ESTIMATED]** (derived from a measured quantity, with the derivation shown)
> or **[UNVERIFIED]** (assumed — must be measured before it is trusted). A cost
> model that hides which of the three it is doing is worse than no model.
>
> **Last rewritten: 2026-09-14** (VPS + hosted Supabase + Z.ai model). The
> previous Vercel-Hobby model is preserved in §5 as a historical record — it is
> no longer the deployment shape.

---

## 1. Summary

| Scenario | Monthly cost |
|---|---|
| **Laptop development / demo** (local Supabase + local GLM-OCR container + free tiers) | **$0** |
| **vCPU VPS + hosted Supabase free tier + Z.ai OCR** | **VPS rental only** + OCR tokens |
| Add Supabase Pro (no pausing, no cron gaps) | +$25/mo |
| Add a GPU host for the local GLM-OCR container | GPU rental — **not costed**, see §4.3 |

The dominant *variable* cost is now **Z.ai OCR tokens** (the remote leg), and it
is the only cost that scales with usage rather than with time.

---

## 2. The current model

### 2.1 VPS (hosting) — the only fixed cost

The VPS runs **Next.js + InsightFace only**. Supabase is hosted (free tier), and
GLM-OCR is the Z.ai API — so the host needs **no GPU**.

| Item | Value | Tag |
|---|---|---|
| Required vCPU / RAM | ≥2 vCPU, ≥4 GB RAM, ≥20 GB disk | **[UNVERIFIED]** — no load test has been run at classroom scale |
| InsightFace image (content / on disk) | 903 MB / 2.65 GB | **[MEASURED]** — `docker images`, local daemon |
| App image | ~0.2–0.4 GB | **[ESTIMATED]** — standalone tree + copied `public/` (~45 MB measured: MediaPipe WASM + models) + `node_modules/exceljs` |
| vCPU build minutes | **unknown** | **[UNVERIFIED]** — the insightface build compiles C extensions (sdist + wheels); never timed on a vCPU host. **GHCR pull is recommended over build-on-VPS** for exactly this reason |
| Typical 2 vCPU / 4 GB VPS | ~$6–12/mo (provider-dependent) | **[ESTIMATED]** — check your provider; not a quote |

Memory ceilings are **placeholders**, not measured (`docker-compose.yml`):
`insightface-service` `mem_limit: 2g` / `cpus: "2.0"` (≈4× headroom over one
~350–500 MB model instance — the headroom IS measured); the `app` service
`mem_limit: 2g` / `cpus: "2.0"` is explicitly marked UNVALIDATED in the compose
file. A too-low `cpus` quota surfaces as SSE latency and healthcheck timeouts,
not as a crash.

### 2.2 Supabase (auth + DB + storage) — $0 on the free tier

| Item | Free tier | This app's reality | Tag |
|---|---|---|---|
| Database size | 500 MB | Face embeddings live in Postgres (`profile_face_samples`, pgvector 512-dim) and press this; quiz/answer rows are small | **[MEASURED]** constraint, usage **[UNVERIFIED]** |
| Storage | 1 GB across all 4 buckets | **40 decks × 25 MB = 1 GB alone** — one class's source PDFs can consume the whole allowance | **[MEASURED]** arithmetic |
| Bandwidth | ~5 GB/mo | Signed-URL image reads + uploads + API | **[UNVERIFIED]** |
| Auth MAU | 50,000 | Not a constraint at this scale | — |
| Realtime connections | 200 concurrent | Only `notifications` | — |
| Pausing | after ~7 days of inactivity | **Stops all 5 pg_cron jobs** — see §2.5 | **[UNVERIFIED]** against the current policy |

Seeds are negligible: `seed:demo` / `seed:scenarios` write single-digit MB of
rows and essentially zero storage. **The quota risk is production traffic, not
seeding.**

### 2.3 Z.ai OCR (the remote GLM-OCR leg) — the only variable cost

| Item | Value | Tag |
|---|---|---|
| Price | **$0.03 per 1M tokens, input AND output** | **[MEASURED]** — Z.ai list price, encoded as `GLM_TOKEN_PRICE_PER_MILLION` |
| Tokens per page | **unknown** | **[UNVERIFIED] — OWED.** This is the single number that turns the price into a cost model. Measure `usage.total_tokens ÷ data_info.num_pages` from a live parse (`docs/GLM_OCR_SETUP.md` §6.7 item 2) |
| Cost per page | uncomputable until the above lands | — |
| Cost formula (implemented) | `costUsd = total_tokens / 1e6 × GLM_TOKEN_PRICE_PER_MILLION`, logged per call as a redacted `[glm-usage]` line | **[MEASURED]** — `src/lib/ai/glm-spend.ts` |
| Throughput (doc-claimed) | 1.86 pages/s PDF, 0.67 images/s | **[UNVERIFIED]** — vendor claim, not reproduced |

**Worked illustration — explicitly an illustration, not a measurement.** If a
dense scanned page tokenized ~2,000 tokens end to end, a 30-page deck would be
60,000 tokens ≈ **$0.0018**, and 1,000 such decks ≈ **$1.80**. If a 4096px canvas
tokenizes 10× over a naive estimate (the reason gate G8 exists), the same 1,000
decks are ~$18. The spread between those two numbers *is* the OWED measurement —
do not budget from either until tokens/page is measured.

**Ceilings that exist today** (both implemented, both tunable without a restart):

- `GLM_DAILY_TOKEN_CAP` (default 2,000,000/user/day) — reaching it makes every
  further remote call 429 `glm_spend_cap` until the next UTC day. At the list
  price that is **$0.06/user/day maximum**.
- `GLM_SPEND_DISABLED=1` — refuses every remote call immediately.

**The residual that matters:** the spend ledger is a **per-host JSON file**, so
two app replicas sharing one Z.ai key still double-spend. That is why the VPS
target is **single-instance** (`docs/DEPLOY_VPS.md` §6). A shared store
(Postgres/Redis) is the upgrade path if the app is ever scaled horizontally.

### 2.4 Everything else — $0

| Service | Cost | Notes |
|---|---|---|
| MediaPipe (hand + face landmarker) | $0 | Open source, 100% client-side WASM, vendored under `public/mediapipe` (~45 MB, measured) |
| TinyFish Search + Fetch | $0 | Free at any wallet balance; the shared-key 30 rpm Search ceiling is the real constraint at multi-user scale, and it surfaces as a retryable `search_failed` |
| InsightFace | $0 | Self-hosted container, CPU-only, weights sha256-pinned and baked into the image |
| Tesseract.js | $0 | Client-side WASM, the default OCR engine |
| kenari.id AI gateway | usage-based | Unchanged by this deployment; the app calls it server-side via `AI_BASE_URL` |
| Email | $0 on a provider free tier | **Not** the Supabase built-in sender in production — configure real SMTP (`docs/DEPLOY_VPS.md` §2.3) |
| Redis / queue | $0 | Not needed: single instance, in-memory limiter Maps (and that is the documented constraint) |

### 2.5 The pausing risk, priced

Free-tier pausing stops **all five cron jobs**. In order of damage:

1. `innovision-flag-verify-silence` (every minute) — the **integrity bypass**:
   verification can be suppressed with nothing flagged.
2. `innovision-quiz-autoclose` — sessions stop closing on schedule.
3. `innovision-incident-prune` + `innovision-retention` — nothing is pruned, so
   storage grows toward the 1 GB quota (**the death spiral**: pause → no prune →
   quota hit → uploads fail).
4. `innovision-notifications` — weekly cleanup stalls.

Two ways to price that:

| Option | Cost | Buys |
|---|---|---|
| Keep-alive ping | $0 | No pause — **[UNVERIFIED]** against the current policy |
| Supabase Pro | **$25/mo** | No pausing, no cron gap, and a smaller RPO than the daily-dump procedure in `docs/DEPLOY_VPS.md` §10 |

If real assessments run on this stack, the integrity-bypass window in item 1 is
the argument for Pro. Decide before cutover.

---

## 3. Cost-saving decisions already in the design

1. **Local-first OCR cascade** — native parse → Tesseract in the browser →
   GLM-OCR. The first two are $0, so the *default* extraction path costs nothing;
   the metered leg is opt-in and capped.
2. **Whole-document-once on the remote leg.** The per-page loop that the local
   container uses would be **10–200× overspend** against a metered API (one
   billed parse per page). The remote leg sends one document per call instead.
3. **Cached liveness probe.** The remote probe is a real BILLED call, so its
   verdict is cached (300 s positive / 30 s negative) and concurrent cold
   requests collapse onto one upstream call. Without this, N lecturers × N dialog
   opens = chronic spend on a shared key.
4. **A durable spend governor**, not in-memory Maps: a JSON ledger survives
   restarts, so a crash-loop cannot reset the day's spend. Per-user daily token
   cap + an operator kill switch.
5. **Page cap at the lower documented bound (30)** while Z.ai's docs conflict
   (100 vs 30) — a wrong upward guess truncates a deck silently; a conservative
   cap just refuses it loudly before spending.
6. **SSRF-by-proxy is banned by construction** (`data:` bytes only, never a URL):
   it is a cost control as well as a security one — a client cannot aim Z.ai's
   fetcher at a URL of its choosing on our key.
7. **All vision inference in the browser** (MediaPipe) — no GPU server, no
   per-frame API bills.
8. **400k-char aggregate cap on extracted text** — bounds every AI generation
   call regardless of deck size (enforced in the route's Zod validation *and*
   inside the `save_quiz_questions` RPC).
9. **Single instance, deliberately** — the spend ledger and the rate-limit Maps
   are per-process; running a second replica would double-spend Z.ai and double
   every abuse budget. Scaling horizontally requires externalizing both first.
10. **Polling instead of Realtime as the consistency backbone** — realtime is
    only a latency accelerator for `notifications`.
11. **`AI_BASE_URL` is OpenAI-compatible** — point it at a local vLLM model and
    the whole demo runs at $0 with no internet dependency.
12. **GHCR pull over build-on-VPS** — vCPU build minutes are unmeasured and the
    insightface build compiles C extensions; a prebuilt image removes that
    variable entirely.

---

## 4. If you scale beyond the demo

| Trigger | Cost | Notes |
|---|---|---|
| 7-day pausing becomes unacceptable | Supabase Pro **$25/mo** | §2.5 |
| >1 GB storage | Supabase overage ~$0.021/GB | 40 decks × 25 MB hits it alone |
| >500 MB DB (face embeddings) | Supabase Pro | pgvector rows are the growth driver |
| OCR volume above the daily caps | Raise `GLM_DAILY_TOKEN_CAP` deliberately | Measure tokens/page first (§2.3) |
| Real load at classroom scale | bigger VPS | Pin `mem_limit`/`cpus` only after a load test — today they are placeholders |
| Horizontal scaling | externalize the ledger + rate limiter | Otherwise Z.ai spend doubles per replica (§2.3) |

### Explicitly NOT costed here

- **A GPU host for the local GLM-OCR container.** The vLLM container wants an
  NVIDIA reservation plus `mem_limit: 16g` / `cpus: "8.0"`, and it is
  profile-gated (`profiles: ["gpu"]`) so it is not scheduled on the VPS at all.
  If you ever want the local leg in production, that is a GPU rental line item
  with no number in this file.
- **Log aggregation, error tracking, backups storage.** None is wired today; the
  backup set in `docs/DEPLOY_VPS.md` §10 has no off-host destination configured.
- **The LLM quiz-generation API.** Unchanged by this deployment and out of scope
  by the file's original framing — `AI_BASE_URL`/`AI_API_KEY` are the operator's
  own contract with that provider.

---

## 5. Historical record — the Vercel Hobby model (SUPERSEDED)

> **⚠️ SUPERSEDED 2026-09-14.** The deployment shape is now a vCPU VPS + hosted
> Supabase + the Z.ai OCR API. The Vercel model below is kept because it is the
> record of what was true when it was written, and because one of its findings is
> still load-bearing. **Do not cite any number here as current.**

The original model assumed Vercel Hobby for the app host:

| Item | Hobby (free) tier | Verdict at the time |
|---|---|---|
| Bandwidth | 100 GB/mo | App is small; MediaPipe models load from the app host |
| Serverless executions | 100k/day | Fine at ~20 users |
| Function duration | **60s hard cap, not configurable upward** | ⚠️ **Still true and still disqualifying for Vercel.** The AI quiz-generation routes intentionally run long (per-call timeout up to 10 min, 15-min shared budget) and `maxDuration` is not set. On Hobby the platform kills them at 60s — which is part of why the deployment target became a long-running container instead |
| Builds | 6,000 min/mo | Fine |
| Team members | 1 | Solo project |

Its Supabase section (500 MB DB / 1 GB storage / 5 GB bandwidth / 50k MAU) is
still the tier this deployment runs on — see §2.2, which supersedes it by adding
the incident-footage bucket and the face-embedding growth driver.

Its OCR section claimed **"$0"** for GLM-OCR ("only when the lecturer picks it
and the container is detected locally"). That was true while the local container
was the only leg. It is **no longer true on the VPS**, where the remote Z.ai leg
is the engine and every parse is billed — see §2.3.

Its "things that are NOT needed" table still holds: no cloud vision API, no
dedicated face-recognition API, no Redis/queue, no paid Sentry tier, no custom
domain requirement.

Its §2.3 (browser-side face embeddings) and §2.1 (MediaPipe models from a CDN)
were already marked stale before this rewrite: embeddings moved into a
self-hosted sidecar, and the MediaPipe assets are vendored under `public/` and
served from the app host.

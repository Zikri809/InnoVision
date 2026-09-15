# GLM-OCR Setup Guide (Docker / vLLM · Z.ai remote)

> Last verified: 2026-09-14 (§6 remote leg added; §7/§8 renumbered — the file
> previously printed §7 before §6).
>
> GLM-OCR (Z.ai) is the opt-in high-accuracy OCR engine, and it has **two
> interchangeable legs behind one server route** (`POST/GET /api/extract/ocr`):
>
> - **local** (default) — Docker via vLLM, the officially recommended
>   production runtime, exposing an OpenAI-compatible API on loopback. Free.
>   Sections §1–§5 and §7–§8 below. This replaces the earlier native-Ollama
>   path, whose OpenAI-compatible vision endpoint was unstable (known 502s; see
>   the [GLM-OCR Ollama guide](https://github.com/zai-org/GLM-OCR/blob/main/examples/ollama-deploy/README.md)).
> - **remote** — the Z.ai PaaS API, whole-document, **billed per token**. §6.
>
> The switch is one server-only env var (`GLM_PROVIDER`), never a code change.

## 1. Prereqs

- Docker Desktop running (already required for local Supabase + CompreFace).
- **GPU recommended** (NVIDIA + the Docker Desktop GPU support / NVIDIA
  Container Toolkit). GLM-OCR is a ~0.9B vision-language model — it runs on a
  6 GB GPU comfortably and is fast (<1s/page). Without a GPU it falls back to
  CPU (~30s/page).

## 2. Start GLM-OCR

```bash
# Pull + build + start the vLLM container (first run pulls the image + model
# weights, ~2.5 GB image + model; cached after).
docker compose up -d glm-ocr
# Or the npm shorthand:
npm run glm:start
```

The service:

| Setting | Value | Why |
|---|---|---|
| Image | `innovision-glm-ocr:local` (built from `docker/glm-ocr/Dockerfile`) | Official vLLM OpenAI-compatible server + a Transformers-from-source layer. **No released Transformers tag knows the `glm_ocr` architecture** (`glm_ocr` first appears in the source tree at commit `4854dbf9da40`), so the layer installs from git at a PINNED COMMIT (`TRANSFORMERS_REF`). Verified by building the image and resolving the model config. See the Dockerfile header before changing the pin — the previous `@v4.49.0` pin made the server fail to import (`Gemma3Config` missing). |
| Model | `zai-org/GLM-OCR` | Official GLM-OCR weights (Hugging Face) |
| Revision | `${GLM_OCR_REVISION:-2e85a62840ccac27daa451df36c736c4636b8628}` | audit-3 R3-DEP-F3: pinned commit of the HF repo, so a default-branch change cannot silently swap the OCR engine's weights on a cold start. Override the env var to move the pin deliberately (a bad revision fails loudly at model load). |
| Served name | `glm-ocr` | Matches `OCR_GLM_MODEL` |
| Port | `127.0.0.1:11434:11434` | Loopback-only — the server-side OCR proxy talks to localhost, never the LAN |
| `VLLM_API_KEY` | `${VLLM_API_KEY:-}` (empty = auth off) | audit-3 R3-DEP-F2: bearer auth on `/v1/*`, the mirror of `FACE_SIDECAR_TOKEN`. Empty keeps local dev working; vLLM only installs the auth middleware for a NON-EMPTY key. The Next.js proxy sends the matching `Authorization: Bearer` header from the app's own `VLLM_API_KEY`, so **both sides must be set to the same value** — see §7. |
| Memory / CPU | `mem_limit: 16g`, `cpus: "8.0"` | audit-3 R3-DEP-F2: one bad request cannot take down the host |
| Logging | `json-file`, `max-size: 10m`, `max-file: 3` | audit-3 R3-DEP-F2: vLLM is chatty and `restart: unless-stopped`; unbounded logs fill the disk |
| GPU | NVIDIA reservation (falls back to CPU) | Fast inference |
| `--max-model-len` | `8192` | Bound for a 6 GB GPU; the stock `32768` forces an encoder-cache budget that OOMs / SIGKILLs the engine core |
| `--gpu-memory-utilization` | `0.7` | 6 GB VRAM has ~1 GB used by desktop apps; `0.9` fails startup |

Stop:

```bash
docker compose stop glm-ocr
# Or: npm run glm:stop
```

## 3. Verify

```bash
# OpenAI-compatible model list (the same probe the engine picker uses)
curl http://localhost:11434/v1/models
# {"object":"list","data":[{"id":"glm-ocr",...}]}

# Health via the compose healthcheck
docker compose ps glm-ocr
```

## 4. App config

`.env.local`:

```env
GLM_BASE_URL=http://localhost:11434   # ROOT URL (no /v1); probe: /v1/models,
                                      # chat completions: /v1/chat/completions
OCR_GLM_MODEL=glm-ocr
```

The engine picker only shows **GLM-OCR** when the probe succeeds; Tesseract
stays the default otherwise.

## 5. Notes

- The lecturer's browser no longer talks to the container directly: the
  server-side proxy `/api/extract/ocr` (`src/lib/extract/glm-ocr.ts` →
  `/api/extract/ocr`) forwards page images, so a remote/tunnelled browser can
  use the engine while the container stays loopback-bound. The target URL comes
  only from server env (`GLM_BASE_URL` / `ZAI_BASE_URL`, picked by
  `GLM_PROVIDER`) — never from the request body (SSRF guard, gate G5).
- First start downloads the model weights from Hugging Face — allow a few
  minutes. The compose healthcheck probes `/health` (unauthenticated even with
  `VLLM_API_KEY` set, so it stays green with auth on).
- **Port conflict:** the old native-Ollama install binds `127.0.0.1:11434`.
  Stop it (quit the Ollama tray app) before `docker compose up` — the GLM
  container needs that port.
- **Tune for your GPU:** on a 6 GB card the two flags above matter. On a
  bigger GPU you can raise `--max-model-len` (more page context) and
  `--gpu-memory-utilization` (up to 0.9). If you have no GPU, remove the
  `deploy.resources` block — vLLM will run on CPU, slowly.
- **Troubleshooting:** `npm run glm:logs` streams vLLM output. A healthy
  startup logs `Resolved architecture: GlmOcrForConditionalGeneration` and
  ends with `Application startup complete.`

## 6. Remote API mode (Z.ai)

The remote leg sends the **whole document** to the Z.ai PaaS OCR endpoint in ONE
billed call. No GPU, no container, no rasterization — the vCPU VPS target uses
exactly this leg (`docs/DEPLOY_VPS.md`). Nothing in §1–§5 changes; the local
container simply stops being consulted.

> ⚠️ **Remote mode spends money.** Every parse bills the shared `ZAI_API_KEY` at
> `GLM_TOKEN_PRICE_PER_MILLION`. The spend governor in §6.5 is the only ceiling,
> and its ledger is per-host, so the deployment target is **single-instance**.

### 6.1 Switching legs

```env
# .env.local — server-only, never NEXT_PUBLIC_*
GLM_PROVIDER=remote
ZAI_BASE_URL=https://api.z.ai/api/paas/v4   # root ALREADY carries /api/paas/v4
ZAI_API_KEY=<Z.AI Open Platform API key>    # register → top-up → create
OCR_GLM_MODEL=glm-ocr                       # same id on both legs
```

Then restart the server. The values are read at CALL time rather than at module
load (so tests can stub them and a route never caches a stale read), but
`process.env` is fixed when the process starts — editing `.env.local` still
requires a restart. Verify with the probe (§6.4): the response's `provider` must
read `"remote"`.

**Fail-closed selector.** Only the exact value `remote` (case-insensitive,
trimmed) selects the metered leg. Unset, `local`, or any unrecognised value
(`prod`, `remote-api`, a typo) selects `local` and emits a one-time server warn
naming the fact — never the value. An operator typo can therefore never silently
start spending. `GLM_PROVIDER` must never be `NEXT_PUBLIC_*`: a public selector
would let the browser choose the leg that costs money.

**Remote without a key never degrades to local.** `glmProviderMisconfig()` →
`"missing_key"` makes every POST a 503 `glm_model_unavailable` (and the probe
reports `reason:"misconfigured"`). Silently presenting the local container's
token to Z.ai, or silently spending nothing while the operator believes the
remote leg is live, would both be worse than a loud failure.

**The remote leg ignores the local container's vars.** `GLM_BASE_URL` and
`VLLM_API_KEY` are the local leg's only; `ZAI_BASE_URL` / `ZAI_API_KEY` are the
remote leg's only. Neither set leaks into the other (in particular
`VLLM_API_KEY` is never used as a Z.ai key).

### 6.2 The endpoint and its shapes

`POST {ZAI_BASE_URL}/layout_parsing`, JSON, `Authorization: Bearer <ZAI_API_KEY>`.

> The root **already carries `/api/paas/v4`** — the client appends only
> `/layout_parsing`. Do **not** append `/v1`: `…/api/paas/v4/v1/layout_parsing`
> 404s. (The local leg is the opposite convention: `GLM_BASE_URL` is a bare root
> and the client appends `/v1/chat/completions`.)

Request — exactly these three fields:

```jsonc
{
  "model": "glm-ocr",
  "file": "data:application/pdf;base64,<bytes>",  // or data:image/{png,jpeg,webp};base64,<bytes>
  "request_id": "<uuid, fresh per attempt>"
}
```

Deliberately **NOT** sent (each is a fail-safe decision, gate G10):

| Omitted | Why |
|---|---|
| `start_page_id` / `end_page_id` | Inclusivity is unverified. If remote `end` is exclusive, `end=N` silently drops the last page while reporting success (`successCount == attempted`) — a fail-lossy guess. Omitting is fail-safe; pagination is a documented OWED item (§6.7). |
| `user_id` | A stable hash is a permanent third-party tracking id in Z.ai's logs. |
| `return_crop_images`, `need_layout_visualization` | Unused by the app; extra bytes and cost. |
| any `http(s)://` URL in `file` | **Banned outright** (gate G5). Forwarding a client URL would let the client aim Z.ai's fetcher at an arbitrary host, launder the response into the quiz pipeline and bill our key — SSRF-by-proxy, re-opening exactly the hole the server-side proxy was built to close. |

The route validates before send: the string starts with `data:`, the declared
MIME is in the image allowlist or `application/pdf`, the decoded bytes are
non-empty, images additionally pass `sniffImageType()` (magic bytes) and PDFs
start with `%PDF`.

Success response:

```jsonc
{
  "code": 0,                                        // absent or 0/"0" = success
  "md_results": "<whole-doc markdown STRING>",      // NOT an array
  "layout_details": [[...], [...]],                 // per-page groups
  "layout_visualization": [...],
  "data_info": { "num_pages": 12 },
  "usage": { "prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3 }
}
```

The route returns `{ text, pages, numPages, degraded, blank }` to the client —
`text` is the markdown string, and `pageTexts` is deliberately **undefined**
(the string carries no page boundaries; string-splitting markdown is forbidden —
gate G6). A degraded or blank result is surfaced as `lowConfidence`, and the
dialog offers a **whole-document** retry that re-sends and **re-bills** the
entire file (per-page splicing does not apply on this leg).

Error envelopes — **both** shapes are accepted:

```jsonc
{ "code": 1234, "message": "..." }                 // flat
{ "error": { "code": 1234, "message": "..." } }    // nested
```

### 6.3 Envelope precedence — why it exists

A PaaS commonly **rides errors on HTTP 200**, which the local OpenAI-compatible
path never anticipated (there, `!res.ok` was the whole story). So the route
inspects the BODY even when the transport succeeded, in this exact order
(`httpLayoutParsing`):

1. transport error (fetch reject / abort) → `timeout` | `http_error`
2. `429` → `rate_limited` (capacity, retryable)
3. `401` / `403` → **`auth`** — mapped at the route to 503
   `glm_model_unavailable`, **never** `glm_error` (a dead key is a configuration
   problem, not a page-read failure; the picker must hide the engine and the
   client must not blind-retry it — gate G4)
4. any other non-ok → `http_error` with the status in `message`
5. body not JSON → `ai_error` (non-retryable)
6. read `code` = flat `body.code` ?? nested `body.error.code` (number or string;
   compared via `String(code)`), and `hasText` from `md_results`
7. a present, non-zero code:
   - retryable code → `hasText ? ok:true + degraded : rate_limited`
   - auth code → `auth` (always)
   - **unknown code → `hasText ? ok:true + degraded : ai_error`** — fail-closed:
     never retryable (retrying an unknown code can burn billing into a dead
     key), never silent success
8. no error code: `hasText` → `ok:true`; `md_results` missing/null → `ai_error`
   (never `{text:""}`); `md_results === ""` → a legitimate **blank document**
   (`ok:true, markdown:"", blank:true`) **only if** `data_info.num_pages` is a
   positive finite number, else `ai_error`. A blank deck must not poison the
   client's `failedPages` accounting.

`ZAI_AUTH_CODES` (`src/lib/ai/http-compat.ts`) is seeded with **`401` and `403`** —
those are the standard HTTP meanings, not invented Z.ai-specific codes, so an
auth/entitlement failure can never be reported as a successful extraction even
when the envelope also carries text.

`ZAI_RETRYABLE_CODES` starts **EMPTY** and is the documented extension point: the
live Z.ai business `code` list is OWED (§6.7). Until it lands, the **HTTP-status
mapping above is the load-bearing signal**, and the unknown-code branch is
deliberately non-retryable. Add a code only from a measured upstream response.

Every degraded/error path also emits a redacted `[glm-ocr-code]` server-side log
line carrying the upstream `code` and `message`, so an operator can see which
code is actually firing — which is what makes the owed list closable in
practice.

### 6.4 Probe behaviour — the remote probe is a BILLED POST

`GET /api/extract/ocr` returns `{available, reason, checkedAt, provider,
maxPages, maxImageBytes, maxPdfBytes}` and drives the engine picker.

- **local**: `probeGlmModel` → `GET /v1/models`, free.
- **remote**: a real authenticated `layout_parsing` POST of a 1×1 PNG
  (`GLM_PROBE_PNG_DATA_URL`, 5 s timeout). This is the **only** check that proves
  the key works AND the account has balance AND OCR is entitled — an
  auth-config check would prove env presence and nothing else (gate G4).

Because that call is billed, the verdict is **cached in-process** (gate G7):

| Verdict | TTL | Env |
|---|---|---|
| available | 300 s | `GLM_PROBE_TTL_MS` |
| unavailable | 30 s | `GLM_PROBE_NEGATIVE_TTL_MS` |

The negative TTL is short so a repaired key returns without a restart; the
positive TTL is long so N lecturers × N dialog opens do not each bill a probe.

The cached verdict is **keyed on the identity that produced it** — provider,
base URL, model and a SHA-256 prefix of the API key — so flipping
`GLM_PROVIDER`, moving the base URL or rotating the key invalidates it instead of
serving the other leg's answer. That matters: a stale `local` verdict makes the
client take the per-page path against the metered API (measured: 12 billed calls
for a 12-page deck instead of 1), and a stale *negative* verdict 503s every
extraction for the rest of the TTL.

Probe spend is metered: it goes through `checkGlmSpend` and is booked in the
ledger under `__glm_probe__` plus the requesting user, so a cost audit can see it.

### 6.5 Client-side provider resolution — never guess the leg

`glmEngineInfo()` (`src/lib/extract/glm-ocr.ts`) returns
`{available, reason, provider, maxPages, maxImageBytes, maxPdfBytes}`.
`OcrProvider` is `"local" | "remote" | "unknown"`:

- a **failed probe reports `"unknown"` with `maxPages: 0`** — never a guessed
  `"local"` (guessing is what produced the 12× overspend above);
- `glmExtract` **refuses** on `"unknown"` (typed `glm_model_unavailable`) rather
  than defaulting to the local per-page loop;
- the client probe timeout is **20 s**, deliberately longer than the server's own
  worst cold-cache path (a 5 s billed probe plus the auth round trips) — a 5 s
  client window would abort exactly when the remote probe is cold;
- the dialog clears its cached probe in `reset()`, so one transient blip cannot
  poison every later run in the session.

On the **remote** leg the request body is `{file, kind}` — one whole document.
The `{image}` convenience shape is **rejected** on that leg (400 `glm_error`):
it is a 10–200× overspend vector and it bypasses the page cap.
Concurrent cold/stale requests are collapsed onto **one** upstream call, and the
GET has its own tighter rate bucket (`ocr-health:${userId}`, 6/min) instead of
sharing the 20/min POST budget. The POST path uses `glmHealthCached()` — a FRESH
cached verdict only, **never** a probe — because a real POST is its own liveness
proof; the UI is never gated on an uncached billed call.

`reason` values: `ok` / `disabled` (`GLM_SPEND_DISABLED=1`) / `misconfigured`
(remote without a key) / `unreachable` / `auth` / `rate_limited` / `error`.

### 6.5 Caps and the spend governor

**Size caps** (remote; the local leg is one rasterized page ≤24 MB decoded):

| Limit | Value | Enforced where |
|---|---|---|
| Image | ≤10 MB decoded | Route, before send (`REMOTE_MAX_IMAGE_BYTES`) |
| PDF | ≤50 MB decoded | Route, before send (`REMOTE_MAX_PDF_BYTES`) |
| Request body | ≤36 M chars | `readCappedJson`, provider-aware (`REMOTE_MAX_DATAURL_CHARS`) |
| Pages | **100 in prod** (`GLM_REMOTE_MAX_PAGES=100` in SOPS); code default 30 | Client pre-flight + route lower bound (`GLM_REMOTE_MAX_PAGES`) |

⚠️ **The UI cannot reach the full remote allowance.** `REMOTE_MAX_DATAURL_CHARS`
is derived from the app's own client upload cap (`MAX_FILE_BYTES = 25_000_000`,
`src/lib/extract/types.ts`), which is **below** Z.ai's 50 MB PDF allowance — so
the binding constraint for a PDF upload is InnoVision's 25 MB, not Z.ai's 50 MB.

**The 100-vs-30 page conflict — RESOLVED 2026-09-15.** Z.ai's guide says 100
pages, its API reference says 30. Live verification against the production key
settled it: the endpoint parses documents up to **100 pages** (its own 1214 hard
error names "PDF max 100 pages", and a real PDF parses end to end). Production
therefore runs `GLM_REMOTE_MAX_PAGES=100` (SOPS). The server is authoritative:
the probe reports the effective cap to the picker as `maxPages`. The client
constant `MAX_OCR_PAGES_REMOTE` stays at the lower documented bound (30) as the
fail-closed fallback for a deployment without the env override.
`MAX_OCR_PAGES=200` stays as-is — it is the **local** rasterizer's bound, and the
two legs are capped independently.

A PDF over the cap is refused **before any spend**: the client reads `numPages`
via pdf.js and throws `glm_pages_exceeded` (413) before upload, and the route
re-checks a cheap dependency-free **lower bound** (count of `/Type /Page` objects
in the raw bytes — `/Pages` does not match because of the `\b`). A response that
comes back over the cap is already paid for, so it is a typed `glm_error` plus a
warn line, and the ledger records the real spend.

**Spend governor** (gate G8) — remote only:

| Var | Default | Effect |
|---|---|---|
| `GLM_DAILY_TOKEN_CAP` | `2000000` | Per-user daily token ceiling, UTC day bucket. On reaching it every further remote call is **429 `glm_spend_cap`** until the next UTC day. |
| `GLM_TOKEN_PRICE_PER_MILLION` | `0.03` | USD per 1M tokens (in + out), used only to compute `costUsd` in the log line and the ledger. Never sent upstream. |
| `GLM_SPEND_LEDGER_PATH` | `.glm-spend-ledger.json` | Durable ledger, resolved against the process cwd. Gitignored. |
| `GLM_SPEND_DISABLED` | unset | `1` refuses **every** remote call with 503 `glm_model_unavailable` — the operator kill switch. |

The ledger survives restarts (`{ "<utc-day>": { "<userId>": { tokens, usd, calls } } }`,
last 7 day-buckets retained, atomic temp-file+rename writes). A read failure
starts empty with a warn and a write failure warns and keeps the in-memory count
authoritative — neither ever fails the request, because the cap is a cost guard,
not an authz gate.

**⚠️ The ledger is PER-HOST.** Two app replicas sharing one Z.ai key still
double-spend: each process enforces the cap against the file it can see. That
residual is precisely why the deployment target is **single-instance**
(`docs/DEPLOY_VPS.md`); a shared store (Postgres/Redis) is the upgrade path if
the app is ever scaled horizontally.

Every successful remote call also emits one redacted `[glm-usage]` log line —
`{requestId, userId, provider, model, numPages, promptTokens, completionTokens,
totalTokens, costUsd, ms}`. It never carries the key, and any upstream echo of
the configured key is masked before it reaches a message (`redactSecret`).

### 6.6 Switching back to local

```env
GLM_PROVIDER=local      # or delete the line — unset is already local
```

Restart the process. `GLM_BASE_URL` / `VLLM_API_KEY` take over again, the
200-page cap and the per-page loop return, and the probe becomes the free
`GET /v1/models`. The remote vars can stay in the file — they are inert while
the selector is not `remote`. To **stop remote spending immediately** without
switching legs (e.g. a leaked key), set `GLM_SPEND_DISABLED=1` and restart: every
remote call then 503s while the rest of the stack keeps running.

> Note the cap asymmetry you are switching between: the remote leg's interim
> 30-page cap **rejects** a PDF over the limit (413 `glm_pages_exceeded`, before
> any spend), while the local leg's 200-page cap is a rasterization bound. A deck
> that works locally may be refused remotely — that is the cap, not a bug.

### 6.7 OWED live-curl list (needs a real key)

Everything below is **UNVERIFIED** and requires `ZAI_API_KEY` + a live curl (or
the in-app path) against `https://api.z.ai/api/paas/v4`. They are also the
blockers recorded in `docs/PLAN_VPS_DEPLOYMENT.md` §4 and §10.4/§10.6.

| # | Owed | Why it matters | How to settle it |
|---|---|---|---|
| 1 | The business **`code` table** (per endpoint): which codes mean capacity, which mean auth/entitlement | `ZAI_RETRYABLE_CODES` is EMPTY, so an error that rides on HTTP 200 with a non-zero code lands in the unknown branch: usable text → `degraded`, no text → non-retryable `ai_error`. That is fail-safe but over-conservative — real capacity codes will not be retried. (`ZAI_AUTH_CODES` is already seeded with the standard `401`/`403`, so the auth direction is covered.) | Force errors with a bad key, a drained balance, an oversized file and a burst; record `{httpStatus, code, message}` for each — the `[glm-ocr-code]` log line carries them. Add only measured codes to the sets, and mirror the addition in this table. |
| 2 | **Tokens per page** (and latency per page) | Every cost number in `docs/COSTS.md` and every budget in §6.5 is an estimate until this is measured. A 4096px canvas may tokenize well over a naive estimate. | Parse a known page count, read `usage.total_tokens` from the response (and the `[glm-usage]` line), divide by `data_info.num_pages`. Repeat for a dense vs a sparse page. |
| 3 | The **100-vs-30 page-cap** resolution | The interim 30 rejects legitimate decks; a wrong upward guess truncates silently. | `curl` a >30-page and a >100-page PDF; observe the cap the API actually enforces (or the error it returns). Then set `GLM_REMOTE_MAX_PAGES` and `MAX_OCR_PAGES_REMOTE` to the measured value and update §6.5. |
| 4 | **`data:`-prefix handling** | The route accepts `data:` URLs only (URLs are banned). If the API requires a bare base64 string (or a different `data:` form), every call fails 400/`ai_error`. | Send one document with the exact `file` string the route builds and confirm the parse succeeds. |
| 5 | **Page-id inclusivity** (`start_page_id` / `end_page_id`) | Until proven, both are omitted, so pagination cannot be used and a >30-page deck cannot be chunked. A wrong guess drops the last page while reporting success. | Parse a known PDF with `start_page_id=1, end_page_id=2` and check `data_info.num_pages` / `layout_details` length: 2 means inclusive, 1 means exclusive. |
| 6 | Probe size and cost | `GLM_PROBE_PNG_DATA_URL` (1×1 PNG) is assumed to be the cheapest acceptable call. If the API rejects a 1×1 image, the probe reports `unavailable` on a healthy key and the picker hides a working engine. | `curl` the probe body verbatim; confirm `code:0` and read `usage.total_tokens` for the probe's real cost. |

Also still open from the local side (unchanged by this section):
`docs/PLAN_VPS_DEPLOYMENT.md` §4's `GET …/paas/v4/models` existence check.

## 7. Enabling API-key auth (production)

`VLLM_API_KEY` is read by vLLM natively and installs a bearer-token middleware
only when the value is non-empty (so `docker compose up` with the var unset is
unchanged). To turn it on:

```bash
# project-root .env (compose reads this, NOT .env.local) or the shell env
VLLM_API_KEY=<a-long-random-secret>
```

The Next.js side must send the matching header, and it reads the SAME variable
name from its own process env. Add it to `.env.local` as well:

```bash
# .env.local — read by the Next process (/api/extract/ocr proxy)
VLLM_API_KEY=<the-same-secret>
```

`src/lib/ai/http-compat.ts` (`httpChatCompletions` / `probeGlmModel`) sends
`Authorization: Bearer ${process.env.VLLM_API_KEY}` when set, so the probe and
the transcription call both authenticate. Set the two sides to the same value:
the compose-side var (project-root `.env`) enables vLLM's middleware, and the
app-side var (`.env.local`) satisfies it. A mismatch makes `/api/extract/ocr`
return `glm_model_unavailable` (the probe 401s) — the loopback publish remains
the primary control either way.

## 8. Benchmark

```bash
npm run glm:bench                 # 1 warm-up + 3 reps of the scanned fixture
npm run glm:bench -- --reps 5     # more reps for a steadier average
```

Measures real per-page OCR latency exactly as the app drives it (page image →
`/v1/chat/completions`), and reports GPU utilization from `nvidia-smi`. Raw
timings go to `bench-glm-ocr.jsonl` (git-ignored).

Reference numbers — **RTX 4050 (6 GB), GLM-OCR via vLLM**, scanned chapter page
(900×400 PNG, `e2e/fixtures/scanned-chapter.png`):

| Metric | Value |
|---|---|
| Latency / page (avg) | ~0.46s |
| Median | ~0.45s |
| Pages / minute | ~130 |
| GPU util during inference | 0% idle → ~58% during |
| VRAM used | ~5.0 / 6.1 GiB |
| Output | ~34 tok/page (OCR text) |

For contrast, the old native-Ollama path was ~30s/page on CPU and unstable
(502s on the OpenAI-compat vision endpoint). Docker/vLLM on GPU is **~65×
faster** per page with a stable API.

> **Remote-leg benchmarking is not wired yet.** `scripts/benchmark-glm-ocr.mjs`
> today accepts only `--reps`, `--url` and `--model` and always drives the local
> `/v1/chat/completions` shape (it also sends no auth header, so it cannot reach
> a `VLLM_API_KEY`-protected container). The planned `--provider local|remote`,
> `--key` / `ZAI_API_KEY`, `--auth <token>` and `--pdf <path>` flags are OWED by
> the harness workstream — until they land, measure the remote leg with a raw
> `curl` against `POST {ZAI_BASE_URL}/layout_parsing` and read
> `usage.total_tokens` yourself (§6.7 items 2 and 6).

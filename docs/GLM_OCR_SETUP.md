# GLM-OCR Setup Guide (Docker / vLLM)

> Last verified: 2026-08-22.

> GLM-OCR (Z.ai) is the opt-in high-accuracy OCR engine. It runs **in Docker via
> vLLM** — the officially recommended production runtime — and exposes an
> OpenAI-compatible API on loopback. This replaces the earlier native-Ollama
> path, whose OpenAI-compatible vision endpoint was unstable (known 502s; see
> the [GLM-OCR Ollama guide](https://github.com/zai-org/GLM-OCR/blob/main/examples/ollama-deploy/README.md)).

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
| Image | `innovision-glm-ocr:local` (built from `docker/glm-ocr/Dockerfile`) | Official vLLM OpenAI-compatible server + a Transformers-from-source layer (the stock vLLM image's bundled Transformers predates the `glm_ocr` architecture) |
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
  only from server env (`GLM_BASE_URL` / `OCR_GLM_MODEL`) — never from the
  request body (SSRF guard).
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

## 6. Benchmark

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

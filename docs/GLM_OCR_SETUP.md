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
| Served name | `glm-ocr` | Matches `OCR_GLM_MODEL` |
| Port | `127.0.0.1:11434:11434` | Loopback-only — the browser OCR path talks to localhost, never the LAN |
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

- The lecturer's browser talks to the container directly over loopback. The
  Next.js server never proxies this endpoint (SSRF guard).
- First start downloads the model weights from Hugging Face — allow a few
  minutes. The compose healthcheck waits for `/v1/models` before reporting
  healthy.
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

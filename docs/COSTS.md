# InnoVision — Cost Breakdown (excluding LLM API)

> **⚠️ PARTIALLY STALE (authored pre-CompreFace / pre-integrity-suite).**
> Known-drift sections: §2.3 describes browser-side face embeddings (DEAD since
> migration 0010 — frames now go to a self-hosted CompreFace Docker container,
> which adds its own hosting footprint NOT costed below); §2.1 wrongly says
> MediaPipe models are VENDORED into `public/models` (Phase 6) and served from the app host — CDN assumption removed
> `public/models` since Phase 6); storage/bandwidth estimates predate the
> incident-footage bucket (0020). Numbers below are directional, not quotes. (excluding LLM API)

> Scope: infrastructure and services needed to **build, run, and demo** the MVP for ~20 students.
> LLM/vision token costs are excluded by request — and the [OCR design](PLAN.md#3-text-extraction--ocr-module-cost-saving-design) defaults to **in-browser Tesseract OCR ($0)**, with local GLM-OCR and cloud vision strictly opt-in, so even those stay near zero.

---

## 1. Summary

| Scenario | Monthly cost |
|---|---|
| **Development + demo (default)** | **$0** |
| Post-demo, keep it alive publicly | $0 (free tiers hold at this scale) |
| Custom domain | **Not needed** — `yourapp.vercel.app` is fine |

**Virtually no cost other than the LLM API — and if you also run quiz generation through a local vLLM model, even that drops to $0.**

---

## 2. Detailed Breakdown

### 2.1 Vercel (hosting) — $0

| Item | Hobby (free) tier | Enough? |
|---|---|---|
| Bandwidth | 100 GB/mo | ✅ App is small; MediaPipe models load from Google's CDN, not Vercel |
| Serverless executions | 100k/day | ✅ ~20 users × a few dozen calls each |
| Function duration | **60s hard cap on Hobby — not configurable upward** | ⚠️ The AI quiz-generation routes intentionally run **long** (per-call timeout up to 10 min, 15-min shared budget) and `maxDuration` is **not** set — this is tuned for local/self-hosted runs. On Vercel Hobby the platform kills these functions at 60s; deploy AI generation only behind Pro/Fluid compute or a self-hosted runner (OCR still runs locally/in-browser so it never hits this). |
| Builds | 6,000 min/mo | ✅ |
| Team members | 1 | ✅ Solo project |

**Cost: $0.** Pro ($20/mo) only needed for >60s functions, team seats, or analytics — none apply here.

### 2.2 Supabase (auth + DB + storage) — $0

| Item | Free tier | MVP usage estimate | Enough? |
|---|---|---|---|
| Database size | 500 MB | < 20 MB (quizzes, sessions, embeddings) | ✅ |
| Storage | 1 GB | ~50 PDFs × 2–5 MB ≈ 250 MB | ✅ |
| Bandwidth | 5 GB/mo | File uploads + API ≈ 1–2 GB | ✅ |
| Auth MAU | 50,000 | ~25 users | ✅ |
| Edge function invocations | 500k/mo | Grading + face verify ≈ thousands | ✅ |
| Realtime connections | 200 concurrent | Not used (polling is enough at this scale) | ✅ |

**Cost: $0.** Only note: free-tier projects pause after ~7 days of inactivity — reopen the dashboard a day before the demo.

### 2.3 MediaPipe (hand + face models) — $0, confirmed

- Open-source (Apache 2.0), runs **100% client-side** (WASM/WebGL). No API key, no per-call billing, no usage cap.
- Models (~30 MB total: hand landmarker, face embedder, face landmarker) **self-hosted from the app's `/public/models`** so the demo doesn't depend on Google's CDN being reachable from venue Wi-Fi. $0 either way.
⚠️ STALE (pre-CompreFace): face verification now sends webcam FRAMES to a self-hosted CompreFace service (migration 0010); incident recording (0020) additionally stores short clips in Supabase Storage on incidents only — see docs/PLAN_INTEGRITY_SUITE.md
- Bonus: raw face images never leave the student's device — privacy-friendly by design.

### 2.4 OCR — $0

| Engine | Cost | Notes |
|---|---|---|
| Native text extraction (pdfjs/mammoth/jszip) | $0 | First step of the cascade; handles most digital PDFs/DOCX/PPTX |
| **Tesseract.js (default)** | $0 | WASM in the lecturer's browser; zero setup, works on the deployed app |
| GLM-OCR via Docker/vLLM (opt-in, high accuracy) | $0 | ~0.9B local model, MIT/Apache 2.0; only when lecturer picks it and the container is detected locally |
| Cloud vision OCR (opt-in only) | LLM tokens | Only when lecturer explicitly picks it |

### 2.5 Things that are NOT needed

| Service | Why not |
|---|---|
| Cloud OCR (Google/Azure Vision) | Replaced by local GLM-OCR / Tesseract; cloud vision only on explicit opt-in |
| Dedicated face-recognition API (AWS Rekognition etc.) | MediaPipe runs free in-browser; no per-image fees |
| Redis / queue (Upstash, BullMQ) | 20 concurrent users → plain serverless routes + Postgres RPC suffice |
| Sentry/analytics paid tiers | Free tiers (or none) are fine for MVP |
| Email provider (Resend etc.) | Supabase Auth's built-in email covers ≤20 users; for demo, disable email confirmation entirely |
| Custom domain | `yourapp.vercel.app` works for the demo |

---

## 3. Cost-Saving Decisions Already in the Design

1. **Local-first OCR cascade** (native parse → **Tesseract in-browser by default** → GLM-OCR local and cloud vision strictly opt-in) — extraction costs $0 in every default path.
2. **All vision inference in-browser** (MediaPipe) — no GPU server, no per-frame API bills, better privacy.
3. **400k-char cap on extracted text** — bounds every AI generation call regardless of deck size (enforced in the API route's Zod validation *and* inside the `save_quiz_questions` RPC, so neither path can store more).
4. **Polling instead of Supabase Realtime** — no connection limits to manage at this scale.
5. **Vercel + Supabase free tiers** — zero fixed monthly cost until the product outgrows the demo.
6. **OpenAI-compatible client everywhere** — point `AI_BASE_URL` at a local vLLM model for quiz generation too, and the entire demo runs at $0 with no internet dependency.

---

## 4. If You Scale Beyond the Demo (reference)

| Trigger | Cost |
|---|---|
| 7-day inactivity pause becomes annoying / demo reliability matters | Supabase Pro: **$25/mo** |
| >100 GB bandwidth or team collaboration | Vercel Pro: **$20/mo** |
| >1 GB of uploaded slides/PDFs | Supabase storage overage ~$0.021/GB |
| Hundreds of concurrent students | Add Realtime (Pro tier) and consider grading via Edge Functions (already in plan) |

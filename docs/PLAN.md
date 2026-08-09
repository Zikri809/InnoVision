# InnoVision — Implementation Plan

> **MVP Goal:** Lecturer-created, AI-generated, gesture-answered quizzes with continuous face verification for assessments.
> **Stack:** Next.js 16.3 (App Router) · TypeScript · Supabase · shadcn/ui · MediaPipe · OpenAI-compatible AI
> **Demo scale:** ~20 students · Vercel + Supabase free tiers

---

## 0. Locked Decisions

| Decision | Choice |
|---|---|
| AI provider | `openai` npm SDK with `baseURL` override → works with OpenAI, OpenRouter, Gemini-compatible endpoint, Ollama. Config via env: `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` |
| Question types (gesture-friendly) | **`mcq`** (2–5 options → finger count) and **`true_false`** (1 finger = true, 2 = false). Nothing else for MVP |
| Face stack | **MediaPipe Face Embedder** (same `tasks-vision` bundle already used for hands) → **192-dim** embedding (validated against model config, not hardcoded). Stored as **`vector(192)` via pgvector** (Postgres enforces dims; app-level check is defense-in-depth). Distance semantics: pgvector cosine **distance** `<=>` (lower = more similar); `FACE_MATCH_THRESHOLD` is a **similarity** threshold (~0.6, tunable via env) → **match ⇔ `distance ≤ 1 − threshold`** |
| Gesture stack | **MediaPipe Hand Landmarker** (ported from `Sample Code/index.html`) |
| Liveness | **Face Landmarker blendshapes** — require one blink at enrollment + at assessment start (basic anti-photo-spoof). Also used for self-recovery from `paused` state (see §1) |
| Verification cadence | At start + **every question transition** + **periodic check every 30–45s (uniform jitter), only while a question is displayed; skipped while `paused`/`flagged`** |
| Text extraction | **Pluggable extractor pipeline** — free native parsing → browser **Tesseract OCR (default, zero-setup)** → opt-in local **GLM-OCR** (high accuracy) → opt-in cloud vision OCR (see §3) |
| Scale assumption | ≤20 concurrent → no Redis/queues; Supabase RPC + serverless routes are enough |
| Biometric consent | Consent screen mandatory before face enrollment, even for demo |

---

## 1. Data Model (Supabase / Postgres)

```sql
-- profiles (extends Supabase auth.users)
profiles: id (uuid PK → auth.users), role ('lecturer'|'student'),
          full_name, consent_given_at (timestamptz, null until consent),
          face_embedding (vector(192), null until enrolled), created_at
-- pgvector: Postgres enforces dims; cosine distance via <=> operator

classes: id, lecturer_id → profiles, title, join_code (6-char, unique), created_at

class_enrollments: class_id, student_id, enrolled_at,
                   PK(class_id, student_id)

quizzes: id, class_id, created_by, title, mode ('practice'|'assessment'),
         status ('draft'|'live'|'closed'), time_limit_sec (null = untimed),
         source_file_url (storage path, null if manual), created_at

questions: id, quiz_id, order_index, type ('mcq'|'true_false'),
           prompt (text), options (text[], 2–5), correct_index (int),
           explanation (text, null)

quiz_sessions: id, quiz_id, student_id, mode (copied from quiz),
               started_at, submitted_at, score (int, null),
               status ('active'|'paused'|'completed'|'flagged'),
               face_fail_streak (int, default 0),
               face_exempt (bool, default false),  -- supervisor override
               verify_nonce (uuid, default gen_random_uuid()),
               last_activity_at (timestamptz, default now())
-- status semantics:
--   active    → answering allowed
--   paused    → transient (hand lost >10s, single bad frame); student
--               self-recovers via blink-liveness re-pass; timer keeps running
--   flagged   → integrity breach (sliding-window rule, §2); LECTURER-ONLY
--               unlock/exempt; answers rejected while flagged
--   completed → submitted (or force-closed by lecturer)
-- CRITICAL: partial unique index enforces one-attempt atomically (closes race)
CREATE UNIQUE INDEX one_assessment_attempt
  ON quiz_sessions (quiz_id, student_id) WHERE mode = 'assessment';

session_answers: id, session_id, question_id,
                 selected_index (null = unanswered), is_correct (bool),
                 answered_at,
                 UNIQUE (session_id, question_id)  -- idempotent answers (no double-count)

face_checks: id, session_id, checked_at, matched (bool),
             distance (float4), trigger ('start'|'question'|'periodic')
-- distance = cosine distance (lower = more similar); match ⇔
-- distance ≤ 1 − FACE_MATCH_THRESHOLD

audit_events: id, actor_id → profiles, subject_id (uuid),
              action (text),  -- 'face_reenroll'|'unlock'|'exempt_face'|
                              -- 'session_reset'|'force_close'
              metadata (jsonb), created_at
```

**Key enforcement rules**

- **One-attempt (assessment):** enforced by the **partial unique index** above (not just the RPC check) so concurrent starts can't race. RPC `start_quiz_session(quiz_id)` (security definer) validates live/enrolled then inserts; on unique violation it **returns a typed result** — `{session}` for practice (rejoin existing) or `{error:'already_attempted', session_id}` for assessment (UI shows "You've already taken this assessment", never a 500).
- **Answer secrecy (BOTH modes):** client fetches questions via view/RPC that **omits `correct_index`** for practice *and* assessment (a student can read the network tab before starting). Grading is server-side only; practice additionally returns `correctIndex` *after* the answer is submitted.
- **Server-side timer:** `answer` and `submit` reject when `now() > started_at + time_limit_sec + grace`, where `grace = TIMER_GRACE_SEC` (env, default **5s** — covers network latency in the demo room). Client timer is UX-only, never trusted.
- **RLS:** lecturers → own classes/quizzes/sessions only; students → enrolled classes, own sessions, own profile row. `correct_index` never exposed via any client-readable policy.
- **Re-enrollment audit:** updating `face_embedding` writes an `audit_events` row (who/when); during a live assessment window it requires lecturer approval (closes proxy-attendance hole).
- **Abandoned sessions:** a session still `active`/`paused` after the quiz closes (or after 2h of no `last_activity_at` updates) is rendered as **"abandoned"** in the results dashboard — no status migration needed, it's derived at read time.
- **Storage:** private bucket `quiz-sources` (PDF/DOCX/PPTX/images), RLS: lecturer-owner only. Face photos are **never stored** — embedding computed in-browser, only the float array is uploaded.

---

## 2. API Contracts (Next.js Route Handlers)

| Route | Method | Purpose |
|---|---|---|
| `/api/ai/generate-quiz` | POST | Input: `{ quizId, extractedText?, useVisionOcr? }`. If `extractedText` provided (client did extraction/OCR) → use directly. Else server-side native parse. Validates with Zod → inserts questions as **draft**. `maxDuration = 60` |
| `/api/ai/regenerate-question` | POST | Input: `{ questionId, instruction? }` → regenerate single question |
| `/api/ocr/vision` | POST | Input: `{ images: base64[] }` (page renders from client) → vision LLM → returns concatenated markdown text. Images never stored. **Batched client-side: max 3 pages per request** (~4 MB body, under the Vercel 4.5 MB limit); client sends batches sequentially and concatenates |
| `/api/face/enroll` | POST | Input: `{ embedding: number[] }` → validate dims, store on own profile (requires `consent_given_at` first). Writes `audit_events('face_reenroll')` if replacing an existing embedding; during a live assessment window requires lecturer approval |
| `/api/face/verify` | POST | Input: `{ sessionId, embedding, trigger, nonce }` → reject 409 if `nonce ≠ quiz_sessions.verify_nonce` (anti-replay, rotated on every successful verify) → server computes cosine **distance** (`<=>`) vs stored embedding → `matched = distance ≤ 1 − FACE_MATCH_THRESHOLD` → writes `face_checks` → **sliding-window flag: 3 fails in last 5 checks (flat count, all triggers equal)** → `status='flagged'`. Single fail → `status='paused'` (self-recoverable). Skipped when `face_exempt=true`. Rejected when session is `completed`. Returns `{ matched, distance, sessionStatus, nextNonce }` |
| `/api/face/self-recover` | POST | Student self-service, **`paused` sessions only**: `{ sessionId }` after client-side blink-liveness re-pass → reset streak, rotate nonce, set `active`. **No-op (403) on `flagged` sessions — flagged requires the lecturer.** Audited |
| `/api/face/unlock` | POST | **Lecturer-only**: `{ sessionId }` → reset streak, rotate nonce, set `active`. Writes `audit_events('unlock')` |
| `/api/sessions/[id]/exempt-face` | POST | Lecturer-only supervisor override: `{ sessionId, reason }` → sets `face_exempt=true`, writes `audit_events('exempt_face')` (demo fallback for bad webcams) |
| `/api/sessions/[id]/answer` | POST | Input: `{ questionId, selectedIndex }` → **rejects if past time limit** (403 `time_expired`) → rejects if session `paused`/`flagged` (409) → server grades → **assessment: `INSERT ... ON CONFLICT DO NOTHING`, returns 409 `already_answered` on re-answer (no overwrite); practice: upsert allowed** → returns `{ isCorrect }` (+ `correctIndex` **only in practice mode**) |
| `/api/sessions/[id]/submit` | POST | **Rejects if past time limit** → compute score, set `submitted_at`, `status='completed'`. Idempotent (re-submit returns existing score, no change) |
| `/api/sessions/[id]/reset` | DELETE | **Lecturer-only**: deletes the session + its answers/face_checks, writes `audit_events('session_reset')` → releases the one-attempt unique slot so the student can retake (demo fallback for dead laptops) |
| `/api/classes` | POST | Create class; on join-code unique violation, **retry with a new code (up to 3 attempts)** before erroring |

**AI generation contract** (Zod schema, strict)

```ts
const AiQuizSchema = z.object({
  title: z.string(),
  questions: z.array(z.object({
    type: z.enum(['mcq', 'true_false']),
    prompt: z.string().min(5),
    options: z.array(z.string()).min(2).max(5),   // gesture: 1–5 fingers
    correct_index: z.number().int().min(0),
    explanation: z.string().optional()
  })).min(3).max(30)
}).refine(q => q.questions.every(x => x.correct_index < x.options.length));
```

Flow: request JSON output → parse → Zod validate → on failure, **one retry** with validation errors fed back into the prompt → if still invalid, return 422 ("try a different file/model"). JSON-schema mode isn't universal across OpenAI-compatible providers, so prompt + Zod + retry is the portable approach.

---

## 3. Text Extraction & OCR Module (cost-saving design)

**Goal: the default path costs $0. Vision model is an explicit, per-upload upgrade.**

### 3.1 Pluggable extractor interface

```ts
interface ExtractionResult {
  text: string;
  pages: number;
  engine: 'native' | 'tesseract' | 'vision';
  lowConfidence?: boolean;   // heuristic: too little text per page
}

interface TextExtractor {
  name: string;
  extract(file: File): Promise<ExtractionResult>;
}
```

Implementations:
- `NativeExtractor` — PDF text layer (`pdfjs-dist`), DOCX (`mammoth`), PPTX (`jszip` + slide-XML text nodes), plain text/markdown passthrough
- `TesseractExtractor` — **Tesseract.js (WASM) in the lecturer's browser** — **default OCR engine**. Zero setup, runs in any modern browser, works on the deployed Vercel app with no local server. $0
- `GlmOcrExtractor` — **GLM-OCR via local Ollama** — opt-in **high-accuracy** engine (tables, formulas, messy scans). 1.7 GB. ⚠️ It is a **vision-language chat model, not a strict OCR API** — must be prompted to transcribe, and `ollama pull glm-ocr` may not resolve on stable releases. Only shown as selectable when the **availability probe** (`GET /api/tags`) finds the model locally. Client renders pages to PNG (pdf.js) → local Ollama endpoint → structured text back. $0, offline-capable, no Vercel limits
- `VisionOcrExtractor` — client renders pages to PNG (pdf.js) → POST `/api/ocr/vision` → cloud multimodal LLM via the OpenAI-compatible endpoint (e.g. gpt-4o-mini, Gemini Flash, Qwen-VL via OpenRouter) → markdown text back. Costs tokens; opt-in only

### 3.2 Extraction pipeline (cascade)

```
Upload file
   │
   ▼
[1] NativeExtractor (free, instant)
   │  text density OK? (≥ ~40 chars/page)
   ├── yes ──────────────────────► use text, engine='native'
   ▼ no (scanned doc / image slides)
[2] OCR engine picker (default = Tesseract, always available):
   ├── TesseractExtractor   → client-side WASM, $0, zero setup (DEFAULT)
   ├── GlmOcrExtractor      → high accuracy, local Ollama — only shown
   │     when availability probe finds the model (opt-in upgrade)
   └── VisionOcrExtractor   → cloud vision LLM, costs tokens (opt-in)
   │
   ▼
Extracted text (capped ~15k chars) ──► /api/ai/generate-quiz
```

### 3.3 Engine notes

- **Tesseract.js (default):** zero setup, runs in any modern browser, works on the deployed app with nothing installed. Accuracy is weaker on formulas/tables — that's the trade-off for reliability; the UI offers GLM-OCR as the upgrade when it's detected.
- **GLM-OCR (opt-in upgrade):** `ollama pull glm-ocr` (or vLLM). Runs on CPU (slow, ~30s/page) or GPU (fast, <1s/page). Best accuracy on scanned slides, tables, math formulas. Endpoint: `OLLAMA_BASE_URL` (default `http://localhost:11434`). Only appears in the picker when the probe succeeds.
- **Vision cloud OCR:** best quality without local hardware; per-page images forwarded to the LLM and discarded (never in storage).
- pdf.js already needed for preview; reuse it to rasterize pages for all OCR engines.
- Lecturer sees a live progress bar ("page 3/12") — good demo moment.
- Engine picker is a dropdown in the upload dialog; choice persisted to `localStorage`.

### 3.4 Config

```env
OCR_DEFAULT_ENGINE=tesseract              # tesseract | glm | vision
OLLAMA_BASE_URL=http://localhost:11434    # ROOT URL (no /v1): availability probe hits
                                          # GET {OLLAMA_BASE_URL}/api/tags; chat completions
                                          # go to {OLLAMA_BASE_URL}/v1/chat/completions
OCR_GLM_MODEL=glm-ocr
OCR_VISION_MODEL=gpt-4o-mini              # any multimodal model on the AI_BASE_URL provider
```

The AI client (`lib/ai/client.ts`) is shared between quiz generation, GLM-OCR, and vision OCR — only `baseURL`/model differ (both are OpenAI-compatible).

---

## 4. App Structure

```
app/
├── (auth)/
│   ├── login/page.tsx
│   └── register/page.tsx          # role select + consent checkbox
├── (onboarding)/
│   └── face-enroll/page.tsx       # students: consent → blink liveness → 5-frame capture
├── (lecturer)/lecturer/
│   ├── classes/page.tsx           # list + create (join code shown)
│   ├── classes/[id]/page.tsx      # roster, quizzes in class
│   └── quizzes/[id]/
│       ├── builder/page.tsx       # manual add + "Generate from file" + edit/publish
│       └── results/page.tsx       # sessions, scores, attendance, ⚑ flagged
├── (student)/student/
│   ├── classes/page.tsx           # join via code
│   └── quizzes/page.tsx           # available quizzes (mode badges)
├── play/[sessionId]/page.tsx      # ★ immersive gesture quiz (sample code, evolved)
└── api/...                         # routes per §2

lib/
├── ai/client.ts                   # OpenAI-compatible client (env-driven)
├── ai/quiz-prompt.ts              # system prompt + Zod retry logic
├── extract/
│   ├── types.ts                   # TextExtractor interface
│   ├── native.ts                  # pdfjs + mammoth + jszip
│   ├── tesseract.ts               # client-side WASM OCR (default)
│   ├── glm-ocr.ts                 # local GLM-OCR via Ollama (opt-in upgrade, probe-gated)
│   ├── vision.ts                  # page render → /api/ocr/vision (cloud opt-in)
│   └── pipeline.ts                # cascade logic (§3.2)
├── face/{embedder.ts, cosine.ts, liveness.ts}
├── gestures/{hand-tracker.ts, finger-count.ts, hold-confirm.ts}
└── supabase/{client.ts, server.ts, middleware.ts}

components/
├── ui/...                          # shadcn
├── quiz/{QuestionCard, OptionCard, ProgressHUD, ScoreHUD, EndScreen}.tsx
├── vision/{WebcamPanel, FaceVerifier, GestureLayer}.tsx
├── extract/{UploadDropzone, OcrProgress, EnginePicker}.tsx
└── consent/ConsentDialog.tsx
```

---

## 5. The Play Screen (sample code, re-architected)

**One webcam stream, three consumers** (performance-critical on student laptops):

```
<video> ──► HandLandmarker  → finger count → hold-confirm (800ms) → answer
        ──► FaceEmbedder    → embedding → POST /api/face/verify
        │                     (start / each Q transition / every 30–45s jittered,
        │                      only while question displayed, skipped when paused)
        ──► FaceLandmarker  → blink detection (start + paused self-recovery)
```

| Component | Responsibility |
|---|---|
| `QuizEngine` | State machine: `loading → faceGate → question → locked → feedback → next → submit → end` (+ `paused` / `flagged` overlays). Owns session ID **and `verify_nonce`** (rotated per verify), fetches questions (no answers), calls answer API |
| `GestureLayer` | Ports `renderHandTracking` + finger logic from sample; emits `onSelect(index)`. 1–5 fingers = option, hold-to-confirm fills progress ring |
| `FaceVerifier` | Runs embedder on the same video at verification triggers; status chip (🟢 verified / 🔴 re-check). On **`paused`** (single fail / hand lost) → overlay with **"re-verify (blink)"** self-recovery. On **`flagged`** (3-in-5 window) → hard overlay: "Lecturer notified — wait for unlock", **no self-service path** |
| `OptionCard` | Glassmorphic card + finger badge (☝️✌️🤟🖐) + progress bar, as React |
| `AssessmentGate` | Pre-start screen: consent recap → blink liveness → first face verify → "Begin" |

**Gesture UX decisions (gesture-primary)**

- Countdown "3-2-1-SCAN" at question transitions so students lower hands between questions (prevents accidental locks). **No TTS for the countdown** — it's a visual countdown only, so it can't talk over itself or leak audio in quiet assessment mode.
- Hand lost >3s → subtle warning chip; >10s in assessment → `paused` (self-recoverable via blink; **not** an integrity flag).
- Cards remain clickable as hidden accessibility fallback (harmless, useful if webcam dies mid-demo).
- Sample's audio/confetti/TTS carries over, gated to practice mode (assessment = quiet/clean UI, Malay TTS optional toggle).

---

## 6. Build Phases (gated)

**Execution rule: phases are strictly sequential. A phase is *done* — and the next may start — only when (a) its deliverable works end-to-end, (b) every gate test in its Test Plan section ([TESTING.md §9](TESTING.md#9-phase-gates)) passes, and (c) the full test suite from all earlier phases is still green.** Gate tests are blocking in CI; there is no "merge now, test later" path. Phase 9 additionally runs the full manual real-device checklist (TESTING.md §7) before the demo.

| # | Phase | Depends on | Deliverable | Gate — done when |
|---|---|---|---|---|
| 1 | **Scaffold** | — | Next.js 16 + TS + Tailwind + shadcn + Supabase; env setup; email auth; role selection; consent checkbox | Register/login as both roles; consent state persists |
| 2 | **Classes** | P1 | Class CRUD, join codes (retry-on-collision), enrollment, RLS | Student joins class via code; cross-lecturer isolation proven by DB tests |
| 3 | **Manual builder** | P2 | Question CRUD UI (mcq/true_false only), publish flow | Lecturer builds a quiz by hand, publishes it (status `live`) |
| 4 | **Extraction + AI generation** ★ | P3 | Upload → native/OCR cascade → generate → **review/edit/reorder/regenerate** → publish | AI quiz from a real chapter PDF (incl. scanned PDF via free OCR) is editable and publishable |
| 5 | **Play screen (click-first)** | P3 (P4 optional) | QuizEngine, practice + assessment modes, one-attempt RPC, server timer (+grace), per-question grading, EndScreen | Full quiz playable with mouse; assessment locks retry; answers never leak `correct_index` |
| 6 | **Gesture layer** | P5 | Port Hand Landmarker, hold-to-confirm, calibration screen | Full quiz playable hands-free; accidental-lock guard holds |
| 7 | **Face pipeline** | P5 (P6 optional) | Consent → enrollment (blink + 5 frames) → assessment gate → continuous verify (start / Q-transition / 30–45s jittered) + paused/flagged split | Wrong face at Q3 → paused, then flagged after 3-in-5; lecturer-only unlock |
| 8 | **Results & attendance** | P5 + P7 | Lecturer dashboard: sessions = attendance (incl. **"abandoned"** derived state), scores, face-check timeline, flags, **unlock + face-exempt + session-reset buttons** (all audited), source-text preview in builder | Lecturer sees who attended + integrity status; can reset a dead-laptop attempt |
| 9 | **Hardening & deploy** | P1–P8 | RLS audit, error states, model preloading (self-hosted `/public/models`), Vercel deploy | Demo-ready URL + full manual checklist (TESTING §7) green |

> **Phase 2 detail:** see [docs/PLAN_PHASE2.md](PLAN_PHASE2.md) — the validated, execution-ready plan. Key additions beyond §1/§2 above: lecturer provisioning via a server-side `LECTURER_INVITE_CODE` (env-gated, service-role promotion; the audit's "privileged path"), the private `quiz-sources` storage bucket migration (D12), and the `join_class` security-definer RPC as the **only** enrollment insert path.

### Phase → gate tests (defined in TESTING.md §9)

| Phase | Gate tests that must pass before the next phase starts |
|---|---|
| 1 | E1a (auth both roles + consent persists) |
| 2 | D8 (cross-lecturer isolation) · D12 (storage isolation) · E1 (class → join flow) |
| 3 | D5 (answer secrecy on read) · D6 (owner reads key) · I20 (authZ sweep) |
| 4 | U-A1–U-A7 · U-E1–U-E7 · I14–I19 · E2 |
| 5 | U-T1–U-T3 · D1, D1b, D2, D3, D4, D7, D9 · I7–I13 · E4, E5, E10, E11 |
| 6 | U-G1–U-G7 · E8, E9, E9b |
| 7 | U-F1–U-F7c · D10, D11, D13, D14 · I1–I6c, I22 · E3, E3b, E6, E7, E12 |
| 8 | U-T4 · I21 · E5b, E13 (audit rows verified via D13) |
| 9 | Full suite + manual checklist (TESTING §7) |

**Demo-killer tests** (subset of the above — if any is red, do not demo): **D1, E5, E6, E7, E8, E12**.

Phases 1–4 are the MVP core (priority: AI-gen flow); 5–7 complete the demo. Note the dependency column deliberately allows P6 (gestures) and P7 (face) in either order after P5 — pick based on demo-room confidence.

---

## 7. Environment

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # server-only (grading, face compare)
AI_BASE_URL=https://api.openai.com/v1   # or openrouter / gemini-compat / ollama
AI_API_KEY=
AI_MODEL=gpt-4o-mini
OCR_DEFAULT_ENGINE=tesseract
OLLAMA_BASE_URL=http://localhost:11434   # ROOT URL (no /v1); probe: /api/tags,
                                         # completions: /v1/chat/completions
OCR_GLM_MODEL=glm-ocr
OCR_VISION_MODEL=gpt-4o-mini
FACE_MATCH_THRESHOLD=0.6          # SIMILARITY threshold; match ⇔ cosine distance ≤ 1 − 0.6 = 0.4
TIMER_GRACE_SEC=5                 # server-side grace on time-limit enforcement
```

Vercel notes: AI route sets `maxDuration=60` — on the Hobby plan **60s is the hard cap, not configurable upward** (plan extraction around it, not past it). MediaPipe models (~30MB total across 3 models) **self-hosted from `/public/models`** (committed to repo or fetched via postinstall) — Google CDN is treated as an optimization, not a dependency, because venue/edu Wi-Fi often blocks `storage.googleapis.com`. Supabase free tier covers 20 students easily. GLM-OCR runs on the demo machine (Ollama), never on Vercel.

---

## 8. Risks Accepted for Demo

1. **Face threshold + bad lighting** — sliding-window flag (3-in-5) reduces false flags; recovery via liveness re-pass self-unlock, and lecturer **face-exempt override** guarantees no student is hard-blocked in the demo room.
2. **60s serverless cap** — large PPTs may time out; mitigated by client-side extraction (OCR never touches serverless) + 15k-char cap + question-count picker.
3. **3 MediaPipe models on one stream** — fine on modern laptops, may chug on old ones; hand model gets GPU delegate, face models CPU (they run once per check, not per frame).
4. **GLM-OCR availability on Ollama is uneven** — it's a vision-language chat model, not a strict OCR API; `ollama pull glm-ocr` may not resolve on stable releases. Mitigation: it's **opt-in only**, gated behind an availability probe; Tesseract is the reliable default, cloud vision is the no-hardware opt-in.
5. **Sparse slide decks → weak AI questions** — slides are diagrams+bullets, so extracted text can be thin; builder shows a **source-text preview** so the lecturer sees why before blaming the AI.
6. **Free-tier Supabase pauses after 7 days inactivity** — reopen the project before demo day.
7. **Demo-room reality** — 20 laptops + fluorescent lighting degrades both hand and face tracking; the click fallback + supervisor override are the safety net.
8. **Client-computed embeddings are replayable/forgable** — a student can capture their own enrollment embedding from the network tab and replay it (or hand it to a proxy). Liveness (blink) only guards enrollment + assessment start + paused-recovery. **MVP mitigation:** per-session `verify_nonce` rotated on every successful verify — a replayed captured request 409s once the nonce moves on, forcing any proxy to relay in real time. **Post-MVP:** challenge-response liveness on periodic checks.

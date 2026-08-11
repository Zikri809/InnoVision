# InnoVision — Test Plan

> Scope: what we test, at which layer, and the concrete cases that prove the MVP's risky parts work.
> Stack: **Vitest** (unit) · **Playwright** (E2E) · **supabase test helpers / pgTAP-lite via SQL** (DB/RLS) · MSW for AI mocking.
> Philosophy: the demo dies by **face, gesture, or one-attempt bugs** — so those get the deepest coverage, not the CRUD.
> **Execution:** tests are organized into **phase gates** (§9). The build is strictly sequential — a phase's gate must be green before the next phase starts, and all earlier gates are re-run as regression. See [PLAN.md §6](PLAN.md#6-build-phases-gated).

---

## 1. Test Layers & Responsibilities

| Layer | Tool | What it proves | Runs |
|---|---|---|---|
| **Unit** | Vitest | Pure logic: cosine similarity, finger-count, hold-to-confirm state, Zod schema, extraction cascade, timer math | Every commit, <5s |
| **DB / RLS** | SQL tests against a local Supabase (`supabase start`) | One-attempt uniqueness, RLS isolation, answer-secrecy view, RPC atomicity | Every commit |
| **API / integration** | Vitest + route-handler invocation + MSW (mock OpenAI-compatible endpoint) | Grading, face verify streaks, AI generate with retry, OCR route | Every commit |
| **E2E** | Playwright (+ fake webcam via `--use-fake-device-for-media-stream` / custom `getUserMedia` stub) | Full lecturer→student→assessment flow, gesture sim, face sim | Pre-merge / pre-demo |

**Mocking strategy for vision:** MediaPipe models can't load in CI reliably. All vision code is behind interfaces (`IFaceEmbedder`, `IHandTracker`) — unit tests use fakes; E2E injects a **deterministic fake embedder** (returns stored embedding for "correct face", shifted embedding for "wrong face") and a **fake hand tracker** (scripted finger counts). Real-model smoke test is manual-only.

---

## 2. Unit Tests (Vitest)

### 2.1 Face / cosine (`lib/face`)
| # | Case | Expected |
|---|---|---|
| U-F1 | `cosineSimilarity` identical vectors | returns ~1.0 |
| U-F2 | orthogonal vectors | returns ~0 |
| U-F3 | `isMatch(distance, FACE_MATCH_THRESHOLD=0.6)` boundary — **similarity threshold 0.6 → match ⇔ distance ≤ 0.4** | distance 0.39 → match; distance 0.41 → **no match** (a 0.59-distance face is only 41% similar and must NOT match) |
| U-F4 | embedding validation | rejects wrong length (≠ model dims, e.g. 192), non-finite, empty |
| U-F5 | blink-liveness state machine | no-blink → `pending`; blink within window → `passed`; timeout → `failed` |
| U-F6 | **fail-streak sliding window (flat count, all triggers equal)** | 3 fails in last 5 checks → `flagged`; 3 fails spread over 8 checks → no flag |
| U-F7 | **paused → self-recovery via liveness** | `paused` session + successful blink re-pass → status `active`, streak reset |
| U-F7b | **flagged → NO self-recovery** | `flagged` session + blink re-pass attempt → still `flagged`; only lecturer `unlock`/`exempt` clears it |
| U-F7c | single fail → paused, not flagged | one mismatch → status `paused` (self-recoverable), no flag |

### 2.2 Gestures (`lib/gestures`)
| # | Case | Expected |
|---|---|---|
| U-G1 | finger count from landmarks (1–5 raised) | counts 1..5 correctly |
| U-G2 | 0 or >5 fingers | no selection emitted |
| U-G3 | hold-to-confirm: steady 800ms | emits `onSelect(index)` once |
| U-G4 | finger count changes mid-hold | timer resets, no emit |
| U-G5 | hand lost mid-hold | progress resets, no emit |
| U-G6 | hand lost >3s / >10s (assessment) | warning at 3s, `pause` event at 10s |
| U-G7 | same option held after answer locked | no double-emit (lock respected) |

### 2.3 AI schema & prompt (`lib/ai`)
| # | Case | Expected |
|---|---|---|
| U-A1 | valid AI JSON | passes `AiQuizSchema` |
| U-A2 | `correct_index` ≥ options.length | **rejected** by `.refine` |
| U-A3 | options > 5 or < 2 | rejected (gesture constraint) |
| U-A4 | type not in `mcq`/`true_false` | rejected |
| U-A5 | malformed JSON from model | parse-fail path triggers **one retry** with error fed back |
| U-A6 | retry also invalid | returns 422-equivalent result, no partial insert |
| U-A7 | question count bounds | <3 or >30 questions rejected |
| U-A8 | `normalizeOptions` | trims, dedupes case-insensitively, **remaps `correct_index`**; returns null when the correct option vanishes |
| U-A9 | prompt-injection hardening | system prompt contains the untrusted-data warning + strict-JSON instruction; a mocked model emitting embedded instructions fails Zod → error, zero rows |
| U-A10 | `parseQuizJson` strips ```json fences | fenced and bare JSON both parse |
| U-A11 | schema refines | `true_false` with 3 options rejected; duplicate options rejected |

### 2.4 Extraction pipeline (`lib/extract`)
| # | Case | Expected |
|---|---|---|
| U-E1 | digital PDF (text layer) | `NativeExtractor` wins, `engine='native'` |
| U-E2 | scanned PDF (low chars/page) | falls through to OCR picker |
| U-E3 | text-density heuristic | ≥40 chars/page → native OK; below → `lowConfidence` |
| U-E4 | GLM-OCR endpoint **unavailable** (probe fails) | picker hides glm-ocr entry, **Tesseract stays default** |
| U-E5 | extracted text > 15k chars | truncated to cap, flag set |
| U-E6 | DOCX / PPTX / image inputs | routed to correct extractor, no crash |
| U-E7 | corrupt/zero-byte file | clean error, no cascade run |
| U-E8 | GLM probe timeout/failure | handled gracefully (false), no throw |
| U-E9 | vision batch splitter | pages split into ≤3-per-batch groups |
| U-E9b | vision orchestration | `extractWithVision` issues sequential batched calls (3+3+1 for 7 pages) and concatenates |
| U-E10 | base64 byte estimator | data-URL aware; correct bytes for padded/unpadded base64 |
| U-E11 | (extract) option normalization | OCR-extracted duplicate/whitespace options normalized end-to-end |
| U-E12 | file type/size validation | `.exe` / >25 MB rejected |

### 2.5 Timer & scoring helpers
| # | Case | Expected |
|---|---|---|
| U-T1 | `isWithinTimeLimit(startedAt, limit, now)` with `TIMER_GRACE_SEC=5` | true inside `limit + 5s`, false past it |
| U-T2 | untimed quiz (`time_limit_sec=null`) | always within limit |
| U-T3 | score computation | correct answers count once each |
| U-T4 | **"abandoned" derived state** (PLAN §1) | session `active`/`paused` + quiz closed **or** `last_activity_at` > 2h ago → renders "abandoned"; recently-active session → "in progress"; `completed`/`flagged` never shown as abandoned |

---

## 3. DB / RLS Tests (local Supabase)

| # | Case | Expected |
|---|---|---|
| D1 | **Assessment one-attempt**: two concurrent `start_quiz_session` (same quiz+student) | exactly one succeeds; second returns typed `{error:'already_attempted'}` (unique index prevents the race; no 500) |
| D1b | **Assessment re-answer rejected**: second answer to same question (assessment) | `ON CONFLICT DO NOTHING` → typed 409 `already_answered`; **first answer unchanged** |
| D2 | Practice mode | multiple sessions allowed |
| D3 | Start session, quiz not `live` | RPC raises typed error |
| D4 | Start session, student not enrolled | RPC raises typed error |
| D5 | **Answer secrecy**: `questions` read as student | `correct_index` **not visible** in both modes |
| D6 | Lecturer reads questions | `correct_index` visible (owner) |
| D7 | Student A reads Student B's session/answers | denied by RLS |
| D8 | Lecturer reads other lecturer's class/quiz | denied |
| D9 | Duplicate answer insert (same session+question, practice) | upsert allowed; assessment variant covered by D1b |
| D10 | `face_checks` insert as the session's student | allowed; as another student → denied |
| D11 | profile `face_embedding` update | allowed for self; **re-enrollment writes an `audit_events` row** |
| D12 | `quiz-sources` storage | lecturer reads own file; other users denied |
| D13 | **`audit_events` written on privileged actions** | unlock / exempt-face / session-reset / re-enroll each write a row with correct `actor_id`, `subject_id`, `action` |
| D14 | **`verify_nonce` rotation** | successful verify rotates nonce; replayed request with the old nonce → 409 |
| D15 | **Join idempotency** (P2) | second `join_class` for an already-enrolled student → typed `already_enrolled`, no duplicate row, no error |
| D16 | **Concurrent double-join** (P2) | two simultaneous `join_class` calls, same student+code | exactly one succeeds; the other returns `already_enrolled` (PK conflict, no 500) |
| D17 | **Lecturer cannot join** (P2) | lecturer calls `join_class` with a valid code | typed `not_student`; no enrollment row |
| D18 | **Join-code charset** (P2) | insert/update `classes.join_code` with disallowed chars (`ABC01!`, lowercase, `0/O/1/I`) | CHECK constraint rejects; stored codes always uppercase canonical |
| D19 | **Quiz lifecycle (P3)** | owner creates draft quiz → adds questions → reorders → publishes | draft → live; reorder renumbers correctly; publish succeeds with ≥1 question |
| D20 | **Quiz isolation (P3)** | lecturer B reads A's quiz/questions; student/lecturer-B create a quiz in A's class | 0 rows / RLS insert denied |
| D21 | **Publish empty quiz (P3)** | `UPDATE quizzes SET status='live'` on a 0-question quiz | trigger error `cannot_publish_empty_quiz` |
| D22 | **Questions locked after publish (P3)** | question INSERT/UPDATE/DELETE once quiz is `live` | trigger error `questions_locked_quiz_not_draft` (even direct SQL) |
| D23 | **Draft secrecy (P3)** | enrolled student reads quizzes | sees `live` row, **not** `draft`; unenrolled student sees nothing |
| D24 | **One-way status machine (P3)** | `live→draft`, `closed→live` | trigger errors (`live_quiz_cannot_reopen` / `closed_quiz_cannot_transition`); `live→closed` allowed |
| D25 | **Cascade delete (P3 hardening)** | delete a quiz WITH questions; delete a class containing one | succeeds (cascade); no `quiz_not_found` |
| D26 | **Join-code secrecy (P3 hardening)** | enrolled student reads `classes` directly | 0 rows (owner-only); `student_class_view` exposes `id/title/created_at` only |
| D27 | **Quiz column secrecy (P3 hardening)** | enrolled student reads `quizzes` directly | 0 rows (owner-only); `student_quiz_view` exposes live quiz metadata only (no `source_file_url`/`created_by`) |
| D28 | **Biometric secrecy (P3 hardening)** | lecturer reads enrolled student's `profiles` | 0 rows (self-only); `student_roster_view` exposes names only (no `face_embedding`) |
| D29 | **Quiz starts draft (P3 hardening)** | `INSERT quizzes SET status='live'` | trigger error `quiz_must_start_draft` (D21 holds on every write path) |
| D30 | **Question immutability (P3 hardening)** | `UPDATE questions SET quiz_id=...` on a live quiz | trigger error `question_quiz_id_immutable` |
| D31 | **Metadata edit-lock (P3 hardening)** | `UPDATE quizzes SET title/mode/time_limit` on a live/closed quiz | trigger error `quiz_not_draft_edit` |
| D32 | **Append serialization (P3 hardening)** | N concurrent `append_question` on one draft quiz | order_index 0..N-1, no duplicates (advisory lock) |
| D33 | **DB/Zod length backstops (P3 hardening)** | options >500 / explanation >2000 / duplicate-after-trim via direct SQL | trigger errors (`option_too_long`/`explanation_too_long`/`duplicate_options`); empty-after-trim rejected |
| D34 | **AI replace (P4)** | owner replaces a draft quiz's questions via `replace_quiz_questions` | old gone, new set `order_index 0..n-1`, title/source fields set |
| D35 | **AI authZ (P4)** | non-owner lecturer / student / non-draft | same typed errors; non-existent + non-owned quizzes raise the SAME `not_owner` (no oracle) |
| D36 | **AI atomicity (P4)** | invalid payload (empty, <3/>30, >5 options, OOR, duplicate) | error and **prior questions untouched** (transaction rollback) |
| D37 | **Source edit-lock (P4)** | status-less `UPDATE quizzes SET source_text/source_file_url` on a live quiz | `quiz_not_draft_edit` (edit-lock fires on any UPDATE) |
| D38 | **Source secrecy (P4)** | student reads `student_quiz_view` | no `source_text`/`source_file_url`/`created_by`; second lecturer reads 0 rows (owner-only) |
| D39 | **AI concurrency (P4)** | N concurrent `replace_quiz_questions` on one draft quiz | no errors, valid final state (advisory lock serialization) |
| D40 | **Source size backstop (P4)** | `source_text` > 15000 via direct SQL | CHECK error |

---

## 4. API / Integration Tests (Vitest + MSW)

| # | Route | Case | Expected |
|---|---|---|---|
| I1 | `POST /api/face/enroll` | no consent yet | 403 (consent gate) |
| I2 | enroll | valid 192-dim embedding | stored; returns ok |
| I3 | enroll | wrong dims / NaN | 400 |
| I4 | `POST /api/face/verify` | matching embedding | `{matched:true}`, streak reset, **new `nextNonce` returned** |
| I5 | verify | 3 fails in window | session → `flagged`, returns `sessionStatus:'flagged'` |
| I5b | verify | single fail | session → `paused` (not flagged) |
| I5c | verify | replayed old nonce | 409 (anti-replay) |
| I6 | verify | session not `active` (already submitted) | 409 |
| I6b | `POST /api/face/self-recover` | paused session + liveness re-pass | `active`, streak reset |
| I6c | self-recover | **flagged** session | **403** — lecturer-only unlock |
| I7 | `POST /api/sessions/[id]/answer` | assessment, correct answer | `{isCorrect:true}`, **no `correctIndex` in body** |
| I8 | answer | practice mode | returns `isCorrect` + `correctIndex` |
| I9 | answer | **after time limit (+grace)** | 403 `time_expired` |
| I9b | answer | session `paused` or `flagged` | 409 (answers blocked until recovered/unlocked) |
| I10 | answer | same question twice (assessment) | second → 409 `already_answered`, first unchanged; practice → upsert |
| I11 | answer | question not in this quiz | 400 |
| I12 | `POST /api/sessions/[id]/submit` | happy path | score computed, `submitted_at` set, status `completed` |
| I13 | submit | already submitted | 409, no score change |
| I14 | `POST /api/ai/generate-quiz` | MSW returns valid JSON | questions inserted as `draft`, `correct_index` present server-side |
| I15 | generate-quiz | MSW returns invalid JSON twice | 422, **zero** rows inserted (atomic) |
| I16 | generate-quiz | `extractedText` provided | extraction skipped, text used directly |
| I16b | generate-quiz | **no `extractedText`** → server-side native parse path | parses stored file, generates, no crash |
| I17 | `POST /api/ai/regenerate-question` | valid regen | single question replaced, others untouched |
| I18 | `POST /api/ocr/vision` | images array | returns concatenated text; **nothing written to storage** |
| I19 | vision OCR | **payload too large (>3 pages)** | client batches into ≤3-page requests; oversized single request → 413 |
| I20 | **AuthZ sweep** | student hits every lecturer-only route (`unlock`, `exempt-face`, `reset`, `regenerate-question`, `generate-quiz`) | all → 403 |
| I-A1 | generate | sourcePath sets `source_file_url`+`source_text` | fields persisted on the quiz |
| I-A2 | generate | replaces existing draft questions atomically | old gone, new set present |
| I-A3 | generate | quiz not draft (live/closed) | 409 `quiz_not_draft` |
| I-A4 | regenerate | quiz not draft | 409 `quiz_not_draft` |
| I-A5 | generate | non-owner lecturer | 404 (no oracle) |
| I-A6 | vision | invalid body (missing images) | 400 |
| I-A7 | generate/vision | rate limit exceeded / in-flight guard | 429 |
| I-A8 | generate | AI output with duplicate/whitespace-colliding options | 422 `invalid_ai_output`, **zero rows inserted** (schema gate) |
| I-A9 | generate | `extractedText` > 15k | 400 (server-side cap) |
| I-A10 | generate | 45s AI wrapper timeout | 503 `timeout`, zero inserts (fake clock/abort) |
| I-A11 | generate | `sourcePath` forgery (`..`, `%2F`, `//`, leading/trailing `/`) | 400 |
| I-A12 | generate | neither `extractedText` nor `source_file_url` | 400 |
| I-A13 | regenerate | non-owner questionId | 404 (no oracle) |
| I-A14 | vision | body `baseUrl` ignored | env-configured baseURL used (no SSRF) |
| I-Q1 | `POST /api/classes/[id]/quizzes` (P3) | student creates a quiz | 403 |
| I-Q2 | `PATCH /api/quizzes/[id]` (P3) | student edits a quiz | 403 |
| I-Q3 | `DELETE /api/quizzes/[id]` (P3) | student deletes a quiz | 403 |
| I-Q4 | `POST /api/quizzes/[id]/publish` (P3) | student publishes | 403 |
| I-Q5 | `POST /api/quizzes/[id]/questions` (P3) | student adds a question | 403 |
| I-Q6 | `PATCH/DELETE /api/quizzes/[id]/questions/[questionId]` (P3) | student edits/deletes a question | 403 |
| I-Q7 | `POST /api/quizzes/[id]/reorder` (P3) | student reorders | 403 |
| I-Q8 | any quiz route | **non-owner lecturer** | 404 (no oracle — same as not-found) |
| I-Q9 | create quiz / add question | invalid body (empty title, `correctIndex` out of range) | 400 `invalid_body` |
| I-Q10 | publish | 0 questions | 409 `no_questions` |
| I-Q11 | question edit | quiz not `draft` (live/closed) | 409 `quiz_not_draft` |
| I-Q12 | add question | happy path | 201, `order_index` appended after max |
| I-Q13 | reorder | happy path (RPC stub) | 200 `{ok:true}`; RPC `foreign_question_id` → 400 |
| I21 | `DELETE /api/sessions/[id]/reset` | lecturer resets an attempt | session + answers + face_checks deleted, audit row written, **student can start again** (unique slot released) |
| I22 | **Periodic verify cadence** (fake clock) | advance clock while question displayed | verify fires every 30–45s jittered; **no fire while `paused`/`flagged`/between questions** |

---

## 5. E2E Tests (Playwright)

> Webcam is faked: Playwright launches with a stub `getUserMedia` + injected fake `IFaceEmbedder`/`IHandTracker` so tests are deterministic. Real-device run is a separate manual checklist (§7).

| # | Flow | Steps | Expected |
|---|---|---|---|
| E1a | **Auth both roles + consent persists** | register as lecturer → logout → register as student (check consent) → logout/in | both roles authenticate; consent checkbox state persists across sessions; unconsented user is routed to consent screen |
| E1 | **Lecturer: class → join via code → roster** (P2 scope) | register lecturer → create class (capture join code) → register student → join via code → lecturer opens class | roster shows the enrolled student; student sees the class in their list |
| E1b | **Lecturer: manual quiz → publish** (P3 scope) | (after P3) create class → manual-add 3 questions → publish as practice | quiz appears live for enrolled students |
| E2 | **Lecturer: AI generation** | upload sample chapter PDF → extraction cascade runs (mock native) → generate (MSW/mock AI server) → review screen shows editable questions → edit one → publish | edited question persists; status live |
| E2b | **Lecturer: AI regenerate** | (after E2) lecturer builds a draft quiz → Regenerate one question (mock AI) | target question replaced; siblings untouched |
| E3 | **Student: enroll + consent** | register student → join class via code → consent screen → face-enroll (fake embedder) | `consent_given_at` set, embedding stored |
| E3b | **Consent gate** | student skips consent → attempts to reach face-enroll directly | blocked; no embedding stored (API 403, I1 end-to-end) |
| E4 | **Practice quiz, click-first** | start practice → answer all via clicks → submit | score shown; can re-attempt (new session) |
| E5 | **Assessment one-attempt lock** | start assessment → answer → submit → try to start again | second start blocked with clean "already taken" message (typed RPC result, no 500) |
| E5b | **Lecturer resets attempt** | E5 state → lecturer deletes session from results | student can start fresh; reset audited |
| E6 | **Wrong face at gate → paused → flagged** | enroll as Student A → start assessment with fake embedder returning **mismatched** embedding | first fail → `paused`, self-recovery offered; repeated fails → `flagged` after 3-in-5, **self-recovery path disappears**, lecturer sees ⚑ |
| E7 | **Flagged → lecturer-only unlock** | E6 flagged state → student tries self-recover (still flagged) → lecturer unlocks / marks face-exempt | only lecturer action clears it; student resumes; override audited |
| E8 | **Gesture answering (simulated)** | practice quiz → inject finger sequence `2 (hold 900ms)` → `4 (hold 900ms)` | correct options selected in order, hold-to-confirm fired once each |
| E9 | **Gesture accidental-lock guard** | hold 2 fingers, change to 3 mid-hold | selection resets, no premature answer (U-G4 end-to-end) |
| E9b | **Hand lost → auto-pause** | assessment → hide hand >10s | quiz → `paused` (not flagged); answers blocked (U-G6 end-to-end). *The blink-liveness recovery half is exercised by E6/E7 in P7, so P6 and P7 stay order-independent.* |
| E10 | **Timer expiry** | assessment with 5s limit → wait past `limit + grace` → answer | answer rejected with time-expired message |
| E11 | **Answer secrecy** | student opens DevTools network → question fetch | no `correct_index` in any response |
| E12 | **Continuous verify mid-quiz** | assessment → fake embedder matches at start, **mismatches at Q3** | quiz pauses/flags at Q3, not silently passes (cadence works) |
| E13 | **Attendance = session** | 3 students take quiz → lecturer opens results | 3 sessions listed with scores + face-check timelines; abandoned sessions shown as "abandoned" |

---

## 6. Coverage Targets & CI

- **Unit + integration:** run on every push (`vitest run`), target **≥80%** on `lib/face`, `lib/gestures`, `lib/ai`, `lib/extract`, scoring/timer, **`app/api/sessions/*` and `app/api/face/*`** (they carry the integrity logic). CRUD/UI can be lower.
- **DB/RLS:** `supabase start` in CI, run SQL test suite; **D1–D18 are blocking** (they guard the demo's core promises). Phase 2 D8/D12 are additionally proven by `scripts/verify-classes.mjs` (real anon-token clients).
- **E2E:** Playwright on PRs; **E5, E6, E7, E8, E12 are the five "demo-killer" tests** — if any fail, do not demo.
- **AI tests never hit a real model** — MSW serves canned valid/invalid JSON (keeps CI free and deterministic).

## 7. Manual / Real-Device Checklist (pre-demo, can't be automated)

1. Real webcam: hand tracking selects 1–4 fingers reliably in the **actual demo room lighting**.
2. Real face enroll + verify with the presenter and a volunteer "impostor".
3. GLM-OCR on Ollama (optional high-accuracy path): pull model, confirm the picker entry appears after probe, run one scanned slide deck end-to-end; note per-page latency on the demo machine. Tesseract-only path must work with no Ollama installed.
4. Wake Supabase free tier (7-day pause) the day before.
5. 2–3 laptops simultaneously on one assessment — confirm no race on session start.
6. **Model hosting reachable from the demo room** — confirm `/public/models` (self-hosted MediaPipe files) loads on the venue Wi-Fi; if Google CDN fallback is ever used, verify `storage.googleapis.com` isn't blocked by the network.
7. **Vercel body limit on vision OCR** — run one real multi-page scan through the cloud-vision path and confirm client-side ≤3-page batching keeps each request under 4.5 MB.

---

## 8. Traceability: risk → test

The critical guarantees the demo lives or dies by, and where each is proven:

| Guarantee | Covered by |
|---|---|
| Embedding dims enforced (192) | I3, U-F4 |
| Distance semantics correct (match ⇔ distance ≤ 1 − threshold) | U-F3, I4 |
| GLM-OCR availability probe | U-E4, manual #3 |
| One-attempt race closed | D1, E5 |
| Assessment re-answer rejected / answer idempotency | D1b, D9, I10 |
| Fail-streak fairness (sliding window, flat count) | U-F6, U-F7c, I5, I5b |
| Paused self-recovery vs flagged lecturer-only split | U-F7, U-F7b, I6b, I6c, E6, E7, E9b |
| Answer secrecy (both modes) | D5, I7, E11 |
| Server timer enforcement (+grace) | U-T1, I9, E10 |
| Re-enrollment + privileged-action audit | D11, D13 |
| Supervisor override + session reset | E7, E5b, I21 |
| Anti-replay nonce | I5c, D14 |
| Lecturer-route authorization | I20, I-Q1–I-Q8 |
| Manual-builder publish/lock | D19–D24, I-Q9–I-Q13, E1b |
| AI generation atomicity + retry | I14, I15, U-A5, U-A6, D34, D36 |
| Option normalization / schema gate | U-A8, I-A8 |
| Server-side parse bounds (DoS/zip-bomb) | S1 hardening: bucket limits + route 25 MB/≤50 pages; I-A12 (no text/file) |
| Prompt-injection hardening | U-A9 |
| Source secrecy + edit-lock | D37, D38, I-A1 |
| Vision-OCR body-limit batching | I19, U-E9, U-E9b, U-E10, manual #7 |
| AI route authZ + no-oracle | I20 extension, I-A5, I-A13, D35 |
| Periodic verify cadence | I22 |
| Consent gate | I1, E3b |

---

## 9. Phase Gates

The build is **gated**: each phase below must (a) deliver its feature, (b) pass its gate tests, and (c) keep all earlier gates green before the next phase starts. Gate tests are blocking in CI. (Mirrors [PLAN.md §6](PLAN.md#6-build-phases-gated).)

| Phase | Gate tests | Exit criteria |
|---|---|---|
| **P1 Scaffold** | E1a — register/login as lecturer + student; consent checkbox persists | Both roles authenticate; unconsented users hit the consent screen |
| **P2 Classes** | D8, D12, D15–D18 · E1 — create class → join via code → roster updates | Student enrolls via code; lecturer A cannot see lecturer B's classes/files; join is idempotent and code-checked |
| **P3 Manual builder** | D5, D6 · I20 · D19–D33, I-Q1–I-Q13 · **E1b** | Lecturer hand-builds and publishes a quiz; students never see `correct_index`/join_code/source_file_url/embeddings; student role blocked from all lecturer routes; draft/live/closed state machine + question/metadata immutability enforced at the DB layer |
| **P4 Extraction + AI generation** ★ | U-A1–U-A11 · U-E1–U-E12 · I14–I19 · I-A1–I-A14 · D34–D40 · E2, E2b | Real chapter PDF (incl. scanned via Tesseract) → editable, publishable quiz; invalid AI output inserts **zero** rows; vision-OCR route returns text + stores nothing, batches under body limit |
| **P5 Play screen (click-first)** | U-T1–U-T3 · D1, D1b, D2–D4, D7, D9 · I7–I13 · E4, E5, E10, E11 | Full quiz playable with mouse; one-attempt enforced; timer enforced server-side; re-answer rules correct per mode |
| **P6 Gesture layer** | U-G1–U-G7 · E8, E9, E9b | Full quiz playable hands-free; mid-hold change and hand-loss behave; hand-loss auto-pauses (recovery proven in P7) |
| **P7 Face pipeline** | U-F1–U-F7c · D10, D11, D13, D14 · I1–I6c, I22 · E3, E3b, E6, E7, E12 | Enroll → gate → continuous verify (30–45s cadence proven by fake clock); wrong face at Q3 → paused → flagged; self-recovery only from paused; lecturer-only unlock; nonce replay rejected |
| **P8 Results & attendance** | U-T4 · I21 · E5b, E13 | Dashboard shows attendance (incl. abandoned — derivation pinned by U-T4), scores, face-check timeline; unlock/exempt/reset audited; reset releases the one-attempt slot |
| **P9 Hardening & deploy** | Full suite (all gates above) + manual checklist §7 | Demo URL live; self-hosted models load on venue Wi-Fi; Supabase awake |

**Demo-killer tests** (if any is red → do not demo): **D1, E5, E6, E7, E8, E12**.

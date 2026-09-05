# InnoVision — Test Plan

> Scope: what we test, at which layer, and the concrete cases that prove the MVP's risky parts work.
> Stack: **Vitest** (unit) · **Playwright** (E2E) · **supabase test helpers / pgTAP-lite via SQL** (DB/RLS) · MSW for AI mocking.
> Philosophy: the demo dies by **face, gesture, or one-attempt bugs** — so those get the deepest coverage, not the CRUD.
> **Execution:** tests are organized into **phase gates** (§9). The build is strictly sequential — a phase's gate must be green before the next phase starts, and all earlier gates are re-run as regression. See [PLAN.md §6](PLAN.md#6-build-phases-gated).

---

## 1. Test Layers & Responsibilities

| Layer | Tool | What it proves | Runs |
|---|---|---|---|
| **Unit** | Vitest | Pure logic: cosine similarity (pre-CompreFace) → frame schema, finger-count, hold-to-confirm state, Zod schema, extraction cascade, timer math | Every commit, <5s |
| **DB / RLS** | SQL tests against a local Supabase (`supabase start`) | One-attempt uniqueness, RLS isolation, answer-secrecy view, RPC atomicity | Every commit |
| **API / integration** | Vitest + route-handler invocation + MSW (mock OpenAI-compatible endpoint) | Grading, face verify streaks, AI generate with retry, OCR route | Every commit |
| **E2E** | Playwright (+ fake webcam via `--use-fake-device-for-media-stream` / custom `getUserMedia` stub) | Full lecturer→student→assessment flow, gesture sim, face sim | Pre-merge / pre-demo |

**Mocking strategy for vision:** MediaPipe models can't load in CI reliably. All vision code is behind interfaces (`IFaceTracker`, `IHandTracker`) — unit tests use fakes; E2E injects a **deterministic fake face tracker** (returns `FAKE_FRAME_MATCH`/`FAKE_FRAME_MISMATCH` frame markers that the route-level InsightFace mock maps to match/mismatch) and a **fake hand tracker** (scripted finger counts). Real-model smoke test is manual-only. The InsightFace sidecar is mocked server-side (`FACE_MOCK_ENABLED=1`) — E2E never needs the Docker container.

---

## 2. Unit Tests (Vitest)

### 2.1 Face (`lib/face`) — CompreFace migration
> **Status: MIGRATED to CompreFace, then RE-ARCHITECTED by the integrity suite (0020/0021)**. No cosine test exists anymore (the layer-table mention below is historical). U-F1–U-F3 (cosine) were DELETED with `cosine.ts`; U-F4 is now the frame schema. The matching logic is 1:1-by-lookup + multi-frame majority voting in the `record_face_check` SQL (migration `0020`, hardened `0021`; margin rule DELETED) + route tests (I-vote) + `verify-face.mjs`. See docs/PLAN_INTEGRITY_SUITE.md. Blink liveness (U-F5), the FLAT window (U-F6), and recovery (U-F7) are unchanged.
| # | Case | Expected |
|---|---|---|
| U-F3 | **verify threshold boundary** (CompreFace migration — replaces cosine boundary) | route test: CompreFace mock returns similarity at `FACE_SIMILARITY_MIN`; `matched` flips at the threshold |
| U-F4 | frame validation | rejects empty / non-string / wrong frame count (3 for enroll) |
| U-F5 | blink-liveness state machine | no-blink → `pending`; blink within window → `passed`; timeout → `failed` |
| U-F6 | **fail-streak sliding window (flat count, all triggers equal)** | 3 fails in last 5 checks → `flagged`; 3 fails spread over 8 checks → no flag |
| U-F7 | **paused → self-recovery via liveness** | `paused` session + successful blink re-pass → status `active`, streak reset |
| U-F7b | **flagged → NO self-recovery** | `flagged` session + blink re-pass attempt → still `flagged`; only lecturer `unlock`/`exempt` clears it |
| U-F7c | single fail → paused, not flagged | one mismatch → status `paused` (self-recoverable), no flag |

### 2.2 Gestures (`lib/gestures`)
> **Status: IMPLEMENTED (P6, 2026-08-13; M-DETECT revision)** — `finger-count.test.ts` (U-G1/U-G2 incl. thumb + handedness + full `mapFingersToOption` corner table + tilted-hand regression), `finger-stabilizer.test.ts` (single-frame spike suppression, absence passthrough, re-seed), `hold-confirm.test.ts` (U-G3/U-G4/U-G5/U-G7 incl. latch + reset-release), `hand-loss.test.ts` (U-G6 incl. once-per-episode + re-arm + practice-never-pauses). Browser glue (`hand-tracker.ts`) is E2E/manual-only (0-key coverage).
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
| U-T1 | `isWithinTimeLimit(startedAt, limit, now)` with `graceSec = 5` | true inside `limit + 5s`, false past it |
| U-T2 | untimed quiz (`time_limit_sec=null`) | always within limit |
| U-T3 | score computation | correct answers count once each |
| U-T4 | **"abandoned" derived state** (PLAN §1) | session `active`/`paused` + quiz closed **or** `last_activity_at` > 2h ago → renders "abandoned"; recently-active session → "in progress"; `completed`/`flagged` never shown as abandoned |
| U-T5 | **boundary (inclusive)** | exactly `limit + grace` → still within |
| U-T6 | `firstUnansweredIndex` + `remainingMs` | all answered → -1; mid-list resume; untimed → null; timed → correct ms |

> **U-T4 (abandoned derived state) is a P8 gate** — P5 does not implement or test it; `last_activity_at` is schema completeness only.
>
> **P8 unit suffixes (non-gate):** U-T4b (`summarizeFaceChecks`), U-T4c (`buildIntegrityTimeline` attribution + sort), U-T4d (`assembleResultsRows` comparator + roster-miss + legacy-history placement) — all in `src/lib/results/derive.test.ts`.
>
> **P8 live-DB probes (new, in `verify-results.mjs`):** `D13-reset` (reset → ok + attributable `session_reset` audit row), `I21-D` (reset frees the one-attempt slot + cascade vs the real DB), `D-view` (lecturer_audit_view predicate/projection: cross-class isolation, self-unenroll, key-absence — incl. the documented legacy cross-lecturer visibility trade-off).

### 2.6 Session validation (`lib/sessions`)
| # | Case | Expected |
|---|---|---|
| U-S1 | valid `StartSessionSchema` / `AnswerSchema` / `SubmitSchema` | passes |
| U-S2 | non-UUID `quizId` / `questionId` | rejected |
| U-S3 | negative / non-int `selectedIndex` | rejected |
| U-S4 | `SubmitSchema` accepts `{}` (boundary) | empty body tolerated |

### 2.7 Student practice quizzes (`lib/student-quizzes`, SQ)
> **Status: SHIPPED (0023)** — catalogued here; full design in
> PLAN_STUDENT_PRACTICE_QUIZZES.md. Route tests use the extended fake
> (`fake-student-supabase.ts`: player-view mapping + RPC stubs in lockstep
> with 0023); the authoritative SQL-semantics layer is
> `scripts/verify-student-quizzes.mjs`.
>
> - **Units:** share-code generate/normalize (alphabet-only, I/1/L/0/O
>   excluded — fixtures must respect this), validation schemas incl.
>   bidi-strip titles and exclusive action payloads, guards, pure
>   option-draft reducers (`lib/quizzes/question-draft.ts`).
> - **Route tests:** creator authz (foreign student folds to no-oracle 404),
>   share mint/idempotent/unshare/regenerate via the definer RPC, cap → 429,
>   code-collision retry exhaustion → typed 503, lecturer CAN play shared,
>   answer key never in player payloads, NULL/out-of-bounds selection → one
>   uniform `unavailable`, rate limits (create 5/h, resolve 20/min,
>   answers 60/min).
> - **Live-DB probes (`verify:student-quizzes`, 21 checks):** SQ-D1 creator
>   CRUD via RLS · SQ-D2 unshared-invisible/shared-visible · SQ-D3 questions
>   table creator-only + player view hides `correct_index`/`explanation` ·
>   SQ-D4 grading semantics incl. revoked→unavailable + creator self-grade ·
>   SQ-D5 resolve = first name only, unknown≡revoked → NULL · SQ-D6 unshare →
>   re-share mints fresh · SQ-D7 26th quiz rejected by trigger · SQ-D8
>   lecturers play but cannot author · SQ-D9 direct INSERT with `share_code`
>   permission-denied (revoked-code hijack closed).

### 2.8 Session shuffling (`lib/sessions/shuffle.ts`, QT-3)
> **Status: SHIPPED (0034)** — deterministic per-session question/option
> permutation, derived at read time (never stored). The RPC/wire stays
> canonical; the client translates presented→canonical before POST and the
> play page translates stored canonical indices into presented space for
> resume + EndScreen review. Authoritative layer for the plan: the QT-3
> section of `docs/roadmap/PLAN_R_QUESTION_TYPES.md`.
>
> - **Units (`shuffle.test.ts`, U-QT3-1..18):** golden-vector determinism
>   (cross-process agreement), bijection, permutation-uniformity sweep,
>   scope independence, presented↔canonical round-trips incl. null
>   pass-through, envelope + breakdown transforms.
> - **Route tests (QT3-1..5):** create defaults false / persists true for
>   both modes; draft PATCH applies; shuffle-only PATCH is not an
>   empty-payload 400; **live-quiz PATCH → 409** (frozen metadata,
>   `hasNonWindowFields`).
> - **Live-DB probes (`verify:quizzes`, QT3-D1–D6):** default false · draft
>   flip allowed · live flip → `quiz_not_draft_edit` trigger error · flag
>   exposed via `student_quiz_view` AND `student_closed_revealed_quiz_view` ·
>   base-table RLS denial unchanged.
> - **E2E (`e42-shuffle.spec.ts`, 3 tests):** (1) practice journey —
>   positive ordering assertion (spec re-derives the plan from the session
>   id and asserts the rendered order EQUALS it — a dead feature fails;
>   plan-relative assertions make the legitimate identity permutation
>   pass), reload determinism, answer-by-text full score,
>   persisted-canonical service-role probe, breakdown rows asserted in the
>   derived presented order; (2) resume — all-answered reload renders the
>   presented slot of the canonical answer with aria-pressed; (3)
>   assessment — keyless acks still persist canonical indices.

### 2.9 Multi-select questions (`type = 'multi_select'`, QT-1)
> **Status: SHIPPED (0036 + 0037)** — the answer key is
> `questions.correct_indices` (sorted+distinct; `correct_index` NULL on
> multi rows); students submit `selectedIndices`, the RPC normalizes
> (sorted+distinct, SQL-NULL elements rejected) and grades as exact-set
> equality; `is_correct` semantics unchanged. Student-authored quizzes are
> v1-out-of-scope and blocked by a CHECK on `student_quiz_questions`.
> Authoritative layer for the plan: the QT-1 section of
> `docs/roadmap/PLAN_R_QUESTION_TYPES.md`.
>
> - **Units:** `validation.test.ts` U-QT1-1..7 (strict one-of by type,
>   bounds, sorted+distinct), `sessions/validation.test.ts` U-QT1 one-of
>   answer shape, `quiz-schema.test.ts` U-QT1-A1..A7 (AI contract +
>   normalization collapse→null + row shape), `quiz-prompt.test.ts`
>   U-QT1-P1..P5 (default prompt byte-identical, opt-in steering, retry
>   gate, regenerate), `shuffle.test.ts` U-QT3-19..20 (set translation),
>   `export.test.ts` U-QT1-E1..E4 (cell contract, distribution),
>   `question-draft.test.ts` set-aware ops, `import-parser.test.ts`
>   multi-mark grammar.
> - **Route tests (QT1-1..13):** answer-route set mapping + error map +
>   one-of Zod; questions create/PATCH multi rows; import multi rows;
>   student routes reject multi with 400; AI flag plumbing.
> - **Live-DB probes (QT1-D1–D10 across `verify:quizzes`/`verify:sessions`/
>   `verify:student-quizzes`/`verify:clone`):** exact-set grading matrix
>   (order-insensitive, subset/superset false, full set true) · OOB/
>   NULL-element/empty/cross-shape → `invalid_selected_indices` · assessment
>   keyless ack + canonical stored set via `lecturer_answers_view` ·
>   practice upsert overwrite · `student_results` set arrays · barrier-view
>   key omission (both question views) · authoring guard trigger · clone
>   fidelity · student-domain CHECK.
> - **Calibration practice module (2026-08-30):** when the quiz contains
>   multi questions, the gesture calibration panel renders an interactive
>   4-option practice card (holds toggle on, palm flips the committed chip);
>   calibration-local state only — regression canary is E8 (drives the
>   unchanged Continue flow) + E45.
> - **E2E (`e45-multi-select.spec.ts`, 5 tests):** (1) authoring via the
>   "Correct answers" toggle group + edit-dialog persistence; (2) practice
>   set journey (toggle → Confirm → set feedback → resume aria-pressed on
>   BOTH persisted slots); (3) assessment keyless acks + deterministic
>   service-role probe of the stored canonical set; (4) gesture
>   toggle/commit contract (holds toggle presented options on/off with a
>   pose-change re-arm gate, palm POSTs the sorted canonical set,
>   palm-next advances in feedback).

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
| D11 | profile `face_enrollment_status` update | allowed for self via `enroll_face`; **re-enrollment writes an `audit_events` row**; direct PATCH blocked (column-level revoke + guard trigger) |
| D12 | `quiz-sources` storage | lecturer reads own file; other users denied |
| D13 | **`audit_events` written on privileged actions** | unlock / exempt-face / session-reset / re-enroll each write a row with correct `actor_id`, `subject_id`, `action` |
| D14 | **`verify_nonce` rotation** | successful verify rotates nonce; replayed request with the old nonce → 409 |
| D15 | **Join idempotency** (P2) | second `join_class` for an already-enrolled student → typed `already_enrolled`, no duplicate row, no error |
| D15b | **Join archived class rejected** (P2) | `join_class` against an archived class (`archived_at != null`) → typed `{error:'class_archived'}`, no enrollment row |
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
| D26b | **Class archiving & dispute audit** (P2/P3) | lecturer archives class (`archived_at=now()`) | class hidden from `student_class_view` and `student_quiz_view`; `class_enrollments`, quizzes, and audit logs preserved for owner lecturer |
| D27 | **Quiz column secrecy (P3 hardening)** | enrolled student reads `quizzes` directly | 0 rows (owner-only); `student_quiz_view` exposes live quiz metadata only (no `source_file_url`/`created_by`) |
| D28 | **Biometric secrecy (P3 hardening)** | lecturer reads enrolled student's `profiles` | 0 rows (self-only); `student_roster_view` exposes names only (no `face_enrollment_status`) |
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
| D40 | **Source size (P4)** | `source_text` > 15000 via direct SQL | stored (cap removed) |
| D42 | **Question view secrecy (P5)** | student reads `student_question_view` for a live quiz | row count == seeded count AND `correct_index`/`explanation` absent from the returned object keys; owner lecturer still reads `correct_index` (D6 stays green) |
| D43 | **Index bounds (P5)** | `answer_question` with `p_selected_index` ≥ options length (and NULL) | `{error:'invalid_selected_index'}` |
| D44 | **Real-DB grading (P5)** | answer Q1 correctly + Q2 incorrectly → submit | stored `is_correct` per row; `submit_session` returns `score=1, total=N`; per-mode jsonb shapes (`{is_correct}` vs `{is_correct, correct_index, explanation}`) |
| D44b | **Foreign question (P5)** | `answer_question` with a question id from a different quiz | `{error:'invalid_question'}` |
| D45 | **Timer authoritative (P5)** | sleep ≥ `time_limit_sec + 5s + 1s` then late `answer_question` → `{error:'time_expired'}`; **then submit past deadline → succeeds** (deviation pin); rejected answer created no `session_answers` row |
| D46 | **Session RLS + answer-after-submit (P5)** | student A reads own session/answers (visible); student B reads A's (0 rows); lecturer reads own quiz's sessions/answers (visible); submit then answer on same session | `{error:'session_not_active'}` |
| D47 | **Anon denial (P5)** | raw-anon PostgREST call to `start_quiz_session`/`answer_question`/`submit_session` → denied (execute revoked); anon SELECT on `quiz_sessions`/`session_answers` → 0 rows (RLS/grants) |
| — | **Quiz-delete guard (P5, route-owned)** | quiz DELETE with sessions → 409 `quiz_has_sessions` (route test **I-S12**; the DB layer cascades by design — D41 is deliberately not a D-test) |

---

## 4. API / Integration Tests (Vitest + MSW)

| # | Route | Case | Expected |
|---|---|---|---|
| I1 | `POST /api/face/enroll` | no consent yet | 403 (consent gate) |
| I2 | enroll | 3 base64 JPEG frames (front/left/right), pose valid | CompreFace subject + `face_enrollment_status='enrolled'`; returns ok |
| I3 | enroll | empty / oversized / wrong-count frame | 400 / 413 |
| I4 | `POST /api/face/verify` | frames with self similarity ≥ 0.5 (strict majority) | `{matched:true}`, streak reset, **new `nextNonce` returned** |
| I5 | verify | 3 fails in window | session → `flagged`, returns `sessionStatus:'flagged'` |
| I5b | verify | single fail | session → `paused` (not flagged) |
| I5c | verify | replayed old nonce | 409 (anti-replay) |
| I6 | verify | session not `active` (already submitted) | 409 |
| I6b | `POST /api/face/self-recover` | paused session + liveness re-pass | `active`, streak reset |
| I6c | self-recover | **flagged** session | **403** — lecturer-only unlock |
| I-dup | enroll | CompreFace recognize returns a different subject (sim ≥ 0.45) | `pending_review` status |
| I-vote | verify | 2-of-3 frame majority passes; 1-of-3 fails; a lookalike ranking top-1 does NOT fail (1:1 by lookup — margin rule removed in 0020) | per-vote outcome — face-routes.test.ts I-vote block |
| I-threshold | verify | similarity exactly `FACE_SIMILARITY_MIN` (0.50) vs 0.49 | matched flips at the boundary |
| I4b | verify | **empty-framed no-face sentinel** | fail row (paused), CompreFace NOT called, never a pass |
| I-sidecar-down | verify/enroll | sidecar `insightface_unavailable` / HTTP `insightface_error` | 503 with distinct error keys |
| I-pose | enroll | out-of-range yaw | 400 `pose_invalid` |
| I-health | GET `/api/face/health` | CompreFace up / down | `{ available: true/false }` |
| I-exempt | verify | `face_exempt=true` | `{matched:true, distance:null}`, no nonce rotation |
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
| I-S1 | `POST /api/sessions` (P5) | student start happy | 201 `{ session }` (mode copied from quiz) |
| I-S2 | start | assessment already attempted | 409 `already_attempted` + `session_id` |
| I-S3 | start | quiz not live / not enrolled | 404 (single no-oracle error) |
| I-S4 | start | lecturer caller | 403 |
| I-S5 | `POST /api/sessions/[id]/answer` (P5) | lecturer caller | 403 |
| I-S6 | answer | RPC `not_owner` (session not theirs) | 404 |
| I-S7 | answer | invalid body (non-int `selectedIndex`) | 400 |
| I-S8 | start/answer/submit | cross-origin POST | 403 `invalid_origin` |
| I-S9 | answer | rate limit exceeded | 429 (`_seedRateLimit`) |
| I-S10 | `POST /api/sessions/[id]/submit` (P5) | lecturer caller | 403 |
| I-S11 | submit | RPC `not_owner` | 404 |
| I-S12 | `DELETE /api/quizzes/[id]` (P5) | quiz has a seeded session | 409 `quiz_has_sessions`; without sessions → 200. *(Lives in the existing quiz-route test file, not a new sessions test file.)* |
| I-S14 | answer | RPC `invalid_selected_index` | 400 |
| I-S15 | submit | no answers | 200 `{ score: 0, total }` |
| I-C1 | `PATCH /api/classes/[id]` (P2) | lecturer updates title / archive toggle | 200 `{ class }` with updated `title` and `archived_at` |
| I-C2 | `PATCH /api/classes/[id]` (P2) | invalid body (`empty_update`, `invalid_title`, `invalid_archived`, `invalid_json`) | 400 with typed error |
| I-C3 | `PATCH/DELETE /api/classes/[id]` (P2) | non-owner lecturer / student / cross-origin | 404 (no oracle) / 403 `forbidden` / 403 `invalid_origin` |
| I-C4 | `DELETE /api/classes/[id]` (P2) | lecturer soft-deletes class | 200 `{ ok: true, archived: true }`, sets `archived_at` (audit preservation) |
| I-C5 | `GET /api/classes/[id]` (P2) | student requests archived class | 404 (hidden via `student_class_view`) |
| I-C6 | `POST /api/classes/join` (P2) | student attempts to join archived class | 400 `class_archived` |

---

## 5. E2E Tests (Playwright)

> Webcam is faked: Playwright launches with a stub `getUserMedia` + injected fake `IFaceTracker`/`IHandTracker` so tests are deterministic. Real-device run is a separate manual checklist (§7).
>
> **P6 gesture seam mechanism:** the fake hand tracker is injected via a **`window.__INNOVISION_FAKE_HAND_TRACKER__` / `__INNOVISION_FAKE_HAND_CONTROL__` global** installed by `e2e/fake-hand-tracker.ts` (`installFakeHandTracker` = `addInitScript` + an immediate in-document evaluate, because the student Start→`/play` flow is SPA navigation and `addInitScript` alone is not retroactive to the already-loaded document). App code reads it only through the typed accessor `getFakeHandTracker()` in `lib/gestures/fake-seam.ts`, and the gate is `isFakeFaceSeamEnabled()` (`NEXT_PUBLIC_E2E_FAKE_SEAM === "1"`, `lib/face/seam-gate.ts`) in the GestureLayer boot effect — the flag is set only in `playwright.config.ts`'s webServer env, so the seam is inert in real deployments while surviving the production-build E2E harness (the original `NODE_ENV !== "production"` gate went dead when the suite switched to `next start`, 5f6b1da). The real MediaPipe path (bundle + WASM + model → live feed) is manual-only (§7).

| # | Flow | Steps | Expected |
|---|---|---|---|
| E1a | **Auth both roles + consent persists** | register as lecturer → logout → register as student (check consent) → logout/in | both roles authenticate; consent checkbox state persists across sessions; unconsented user is routed to consent screen |
| E1 | **Lecturer: class → join via code → roster** (P2 scope) | register lecturer → create class (capture join code) → register student → join via code → lecturer opens class | roster shows the enrolled student; student sees the class in their list |
| E1b | **Lecturer: manual quiz → publish** (P3 scope) | (after P3) create class → manual-add 3 questions → publish as practice | quiz appears live for enrolled students |
| E2 | **Lecturer: AI generation** | upload sample chapter PDF → extraction cascade runs (mock native) → generate (MSW/mock AI server) → review screen shows editable questions → edit one → publish | edited question persists; status live |
| E2b | **Lecturer: AI regenerate** | (after E2) lecturer builds a draft quiz → Regenerate one question (mock AI) | target question replaced; siblings untouched |
| E3 | **Student: enroll + consent** | register student → join class via code → consent screen → face-enroll (fake tracker) | `consent_given_at` set, embedding stored |
| E3b | **Consent gate** | student skips consent → attempts to reach face-enroll directly | blocked; no enrollment recorded (API 403, I1 end-to-end) |
| E4 | **Practice quiz, click-first** | start practice → answer all via clicks → submit | score shown; can re-attempt (new session); **resume sub-case**: feedback chip visible BEFORE reload → engine resumes at Q2 (not stuck on Q1 `already_answered`) → finishes; **replay sub-case**: navigate directly to the completed session URL → EndScreen renders (not the quiz) |
| E5 | **Assessment one-attempt lock** | start assessment → answer → submit → try to start again | second start blocked with clean "already taken" message (typed RPC result, no 500); a second student in the same class can still start (one-attempt is per student) |
| E5b | **Lecturer resets attempt** | E5 state → lecturer deletes session from results | student can start fresh; reset audited |
| E6 | **Wrong face at gate → paused → flagged** | enroll as Student A → start assessment with fake tracker returning **mismatch** frame markers | first fail → `paused`, self-recovery offered; repeated fails → `flagged` after 3-in-5, **self-recovery path disappears**, lecturer sees ⚑ |
| E7 | **Flagged → lecturer-only unlock** | E6 flagged state → student tries self-recover (still flagged) → lecturer unlocks / marks face-exempt | only lecturer action clears it; student resumes; override audited |
| E8 | **Gesture answering (simulated)** | practice quiz → inject finger sequence `2 (hold 900ms)` → `4 (hold 900ms)` | correct options selected in order, hold-to-confirm fired once each. **P6 impl**: also palm-next (hold 5 → auto-advance) + hold-once (replay while disarmed → no POST) |
| E9 | **Gesture accidental-lock guard** | hold 2 fingers, change to 3 mid-hold | selection resets, no premature answer (U-G4 end-to-end). **P6 impl**: 400ms finger-2 then finger-3 hold → no `selectedIndex:1`, then `selectedIndex:2` via `waitForRequest` |
| E9b | **Hand lost → auto-pause (server-side, P7 rework)** | assessment (fake face + fake hand) → hide hand >10s | quiz → `paused` (not flagged); **await the `/pause` POST response (200), then GET `paused` (server-truth)**; answers blocked: zero gesture answer POSTs while paused + a direct `page.request` answer → **409 `session_not_active`**; a held gesture while paused must NOT fire (`sessionPaused`); hand returns mid-pause → blink → `self_recover_session` → `active` → fresh hold → answer POST resolves **200**. *The P6 client-only 200 path is replaced: recovery is now 409/blink via the server state machine.* |
| E10 | **Timer expiry (P5)** | **API half**: assessment `time_limit_sec=5`; wait until `started_at + 10s + 2s` (deadline = limit + grace, anchored to the start-session response) → `page.request` answer | 403 `time_expired`; then submit → 200 `{ session, score: 0, total }` (late-submit acceptance + late-answer rejection pinned). **UI half**: separate 10s assessment → client countdown hits 0 → auto-submit → EndScreen with the ANSWERED score |
| E11 | **Answer secrecy (P5, assessment only)** | collect same-origin text responses filtered by content-type + URL + `response.ok()` across the whole flow (incl. answer responses) | `correct_index`/`explanation` absent everywhere; assessment answer body has `isCorrect` but NOT `correctIndex`. (Practice disclosure lives in E4.) |
| E12 | **Continuous verify mid-quiz (P7, UNTIMED)** | assessment → fake tracker match markers at start → reload-before-Begin (gate re-renders) → Q1 → Q-transition verify → Q2 → `setFacePeriodic({minMs:2000,maxMs:3000})` → `expect.poll` a real `trigger:'periodic'` within 5s → mismatch anchored after Q2 feedback → Q3 transition fails → pause overlay AND GET `paused` → blocked-answer proof: direct server answer → **409** + `expectNoAnswerPost` zero-POST | quiz pauses/flags at Q3, not silently passes (cadence works; the gate is not bypassable by reload) |
| E13 | **Timer-gate pin (P7)** | TIMED assessment (`timeLimitSec≈3`); the student starts and lands in the gate; **liveness withheld (no Begin)** | the gate can only be exited by timer expiry; EndScreen with `0 / N` within ~`timeLimitSec + grace + margin` (≈20s), no deadlock |
| E13b | **Attendance = session (P8)** | 4 students take quiz (A/B completed, C in-progress, D abandoned) → lecturer opens results | 4 sessions listed with scores + face-check timelines; abandoned shown as "abandoned"; A's row has ≥1 face check; B's row shows the camera-unavailable marker; no `verify_nonce`/`correct_index` on the rendered DOM |
| E17 | **Student practice quizzes (SQ)** — 3 serial tests | (1) creator: create → builder adds MCQ → self-play wrong answer → feedback "Not quite" → See results end screen. (2) creator mints share code via dialog (spinner→link = stale-snapshot regression guard); recipient registers FIRST, then logged-out visit to `/s/<code>` hits login wall and **returns to the link** after sign-in; plays to end screen. (3) unshare → link renders the SAME neutral invalid screen as unknown codes; delete cascades off dashboard | per-question reveal on every answer incl. the LAST one; login-wall redirect preserved; revocation uniform |
| E18 | **Results Excel export (0027)** | lecturer: class + 2-question assessment + publish; student completes with one right/one wrong → results dashboard → **Export Excel** button captures the real BLOB download → file parsed with exceljs | suggested filename `<title>-results-YYYY-MM-DD.xlsx`; exactly Results / Questions & Key / Choice Distribution sheets; student row carries matric + name + Completed + score `1/2` + numeric `50%` + per-question cells (`B — 4` green, wrong red); key letters B/A with per-question stats; distribution rows for both questions. Also the only UI-level guard that the REQUIRED matric registration field (0027) doesn't strand the flow (`registerUser` helper fills a deterministic 6-digit matric and returns it). **Zero-session leg**: a joined-but-never-attempted student still gets a roster row with Status "Not started" and an empty (null) score cell — headers intact. |
| E26 | **Class archiving lifecycle (HIGH #9)** | 3 serial tests: (1) lecturer archives a live class with an enrolled student (confirm dialog → `/lecturer/classes/archived`; the `#archive-search` filter isolates the card); (2) student loses visibility — class gone from `/student/classes`, quiz gone from `/student/quizzes`, rejoin attempt hits the inline hardcoded alert "This class has been archived and cannot be joined."; (3) restore re-exposes class + quiz (banner "This class is archived" asserted pre-restore) | archive lands on the archived page; student views exclude the class and quiz; `join_class` rejects; restore flips everything back |
| E27 | **Student self-play checkpoint (HIGH #10)** | 3-question quiz → answer Q1 → `page.reload()` → resumes at Q2 ("Question 2 of 3"); corrupt-JSON seed under `sq-progress:<quizId>` via init script → silent fresh Q1 (catch{} fallback); finish → "Practice complete" + "Try again" → retry returns to Q1 and clears the checkpoint (reload stays Q1) | checkpoint survives reload; corrupt data degrades to a fresh start; retry resets progress |
| E28 | **Student quiz editor mutations (HIGH #6)** | move up/down (`aria-label` "Move option up/down") persists after reload (immediate POST /reorder); delete + native confirm "Delete this question?" removes persistently; edit-dialog option surgery (correct=opt2, add opt3, remove opt1) clamps the key to the surviving option via the shared `applyOptionDraftOp`; lecturer `EditQuestionDialog` parity smoke on the shared reducer refactor | reorder/delete/option surgery all round-trip and survive reloads; the correct-answer key never points at a missing option |
| E29 | **URL guards (HIGH #4 page-level)** | student `/lecturer/classes` → redirected to `/student/classes`; a genuinely enrolled peer opening the creator's real `/play/<sessionId>` → notFound (404 + "Page not found"); logged-out `/student/quizzes` → `/login` | role + auth + foreign-session isolation all re-guard at the URL layer |
| E30 | **Notification bell (HIGH #1)** | `__INNOVISION_NOTIF_CONTROL__={pollMs:500}` seam (poll-state.ts:33-53); student joins → lecturer bell "Notifications, 1 unread"; desktop panel opened via trigger click then anchored on "Mark all as read" (the panel has no role) → row click navigates to `/lecturer/classes/<id>` + count decrements; publish → student bell increments → click-through → `/student/quizzes`; mark-all → count 0 + button disabled | bell counts poll/realtime deltas, rows deep-link correctly, mark-all clears the badge |
| E31 | **i18n switch (HIGH #5)** | login toggle "Switch language" flips EN↔BM headings; authenticated toggle (shell chrome) flips "My Classes"→"Kelas Saya" and PERSISTS across goto + reload (cookie); raw-key sweep of `body.innerText` across ~6 core pages: no `segment.token` key leaks (email allowlisted) | language preference flips every surface and persists; zero raw i18n keys render |
| E32 | **Share rotate + unshare (MEDIUM d+e)** | creator "New code"→"Confirm" arms/rotates the code (poll the readonly input — a bare not-toHaveValue reads the transient empty state); a fresh recipient loading the OLD link gets the same neutral screen; unshare mid-play: next answer POST → uniform 404 "unavailable" → question marked unavailable + advances → fatal screen; reload → same neutral screen | code rotation revokes old links uniformly; mid-run revoke degrades gracefully (404, no per-question reveal, fatal + neutral states) |
| E42 | **Per-student shuffle (QT-3)** | lecturer creates an untimed practice quiz with "Shuffle question & option order" checked (3 questions, 4/5/4 options) → service-role probe `quizzes.shuffle_questions=true` → student starts, spec re-derives the session's plan from the sessionId (shared module import) and asserts the rendered first prompt + per-position option accessible names EQUAL the derived plan (also after a reload — determinism) → answers every question by its CORRECT option TEXT in the derived presented order → full score 3/3 → service-role probe: every persisted `session_answers.selected_index` equals the CANONICAL `correct_index` → EndScreen breakdown shows each prompt once with ✓ on the clicked option | presented order matches the derived plan; the wire stays canonical; review matches what the student saw |

### 5.1 E2E debugging playbook — lessons from the 2026-08-26 mass-failure repair

> A full-suite run failed 18 specs while every spec passed solo. Root cause was NOT in any spec.
> These are the durable lessons; check this list BEFORE rewriting assertions.

**Golden rule:** if a spec fails in the full suite but passes solo — and the failing spec set *migrates between runs* — it is shared-infrastructure, not a spec bug. Fix the infrastructure first; only then judge individual specs.

1. **Signup rate limiter vs the suite (THE root cause).** `SIGNUP_IP_RATE = 10 signups/IP/min` (`src/lib/auth/register.ts`) silently rejects overflow with `tooManyAttempts`. The suite mints dozens of accounts from `127.0.0.1` inside one window, so whichever multi-account specs burst hardest that run die at `registerUser`. Signature to recognize: `registerUser` `waitForURL` timeouts + `[WebServer] signInWithPassword error: Invalid login credentials` lines in reporter output (the fallback login runs for an account that was never created) + failures moving across e13/e20/e25-class specs run-to-run. Harness fix: playwright.config.ts injects `SIGNUP_RATE_LIMIT=1000` (+ `INVITE_RATE_LIMIT`) into the webServer env only — production default stays 10/min. Do not "fix" specs for this symptom.
2. **Poisoned retries.** A stalled registration often creates the account BEFORE navigation resolves; Playwright's retry then re-registers the same email and can never succeed. `helpers.registerUser` falls back to signing in via `/login` with `E2E_PASSWORD`; waits are 45s (cold dev-server compiles of `/register`, the server action, and the landing route routinely exceed 30s under load).
3. **Accessible-name conventions (recurring spec bug class).** Play-view option buttons' accessible names are `"<letter> <text>"` (e.g. `"B 4"`), so `{ name: "4", exact: true }` NEVER matches an option — use regex `{ name: /4/ }`. Keep `exact: true` on play CONTROLS (`Start`, `Next`, `Finish`, `Begin assessment`). Never use unanchored `/next/i`: it collides with the Next.js dev-tools overlay button ("Open Next.js Dev Tools") present in dev mode — anchor as `/^(finish|next)$/i`.
4. **Hidden file inputs multiply.** Three exist app-wide now: banner avatar upload, question-image input (`[data-testid="question-image-input"]`), and the AI dropzone inside `role="button"` "Upload course slides or documents". Bare `page.locator('input[type="file"]')` strict-mode-violates — always scope.
5. **Account menu is a modal dialog.** While open, Base UI marks the app shell `aria-hidden`, so the trigger button ("Your InnoVision account") leaves the role-query tree. Assert menu content via `getByRole("dialog")`, close it (Escape) before asserting trigger state.
6. **Post-publish builder has no read-only alert banner.** The old "Active"/alert contract is gone; pin published state via: "Live" chip visible, "View results" link rendered (non-draft only), and draft-only controls (publish button, add-question form) having count 0.
7. **`joinClass` strict-mode hazard.** Its unanchored `/join/i` also matches the dashed "Join a class" card shown once the student has ≥1 class. Fresh single-class students are safe today; specs reusing one student across tests must join inline with an anchored locator.
8. **Dev-server contention.** Next 16 enforces ONE dev server per checkout directory — concurrent Playwright runs collide on `.next/dev/lock` regardless of assigned ports (symptom: intermittent `ERR_CONNECTION_REFUSED`). Serialize suite runs and agent repairs. Workers are capped at 4 locally (uncapped workers saturate `next dev`'s on-demand compilation until even logins exceed 30s).
9. **Read `[WebServer]` output lines.** Server-side truth surfaces there (`signInWithPassword error`, signup errors, face-boot fallbacks) — client-side timeouts often have their explanation already printed above them. `test-results/<spec>/error-context.md` snapshots show actual DOM at failure; they are wiped by later runs, so capture early.
10. **Known-benign noise (do not chase):** `[face-boot] primary boot failed ... NotSupportedError` (headless Chromium lacks WebGL for MediaPipe; fake-tracker path unaffected), `[WebServer] ⨯ Error: The destination stream closed early.` at context teardown, mediapipe `gl_context.cc` warnings.
11. **Hardcoded route rate budgets vs the 6-worker burst (2026-09-04 mass failure).** Beyond the env-tunable auth budgets (lesson 1), ~60 route limiters are hardcoded constants (`VERIFY_RATE`, `START_RATE`, …) plus a non-tunable `invite:global` 100/min bucket in `register.ts`. Under the full suite these overflow mid-run and the failures migrate between specs with the same `registerUser` timeout / fallback-login signature. Fix: `E2E_RATE_LIMIT_DISABLED=1` (webServer env only) short-circuits `rateLimit()` in `lib/classes/rate-limit.ts`; it is inert in production and safe because no e2e spec asserts a 429 — limits are pinned by route-level vitest tests that seed buckets directly (`_seedRateLimit`). Symptom to recognize: first run after a long gap fails ~15+ auth specs cluster-wide; specs pass solo.
12. **Base UI switch & datetime-picker locators (base-lyra migration).** A Base UI `Switch` renders BOTH a `role="switch"` element and a hidden twin form input, so `getByLabel(/.../i).check()` strict-mode-violates (resolved to 2) — target `getByRole("switch", { name: ... })` and `.click()` it (e37/e40/e42 pattern). The `DateTimePicker` trigger label ("Opens at") is also a PREFIX of its segment inputs ("Opens at — hours/minutes"), so `getByLabel("Opens at")` resolves to 3 — use `{ exact: true }` (e38/e46).
13. **`setDateTime` fills UTC wall-clock, not local.** The availability-window surface is a `datetime-local` input that `lib/format/window.windowLocalInputToIso` parses as UTC ("lecturer schedules in UTC quiz time"; edit-dialog labels say "(UTC)"). The helper types `getUTC*` components; filling `getHours()`-style local components shifts every window by the machine's UTC offset (UTC+8 here) and silently inverts window journeys — the student-side "isn't open yet"/"window closed" assertions then fail for schedule reasons that look like RPC bugs.
14. **Share dialog auto-closes on unshare.** Since f80ea9a, `my-quizzes-client` sets `shareTarget(null)` after a successful unshare (a null `share_code` would strand the dialog in its minting spinner). Specs must not click a Close button afterwards — assert `getByRole("dialog")` is hidden instead (e17).

---

## 6. Coverage Targets & CI

- **Unit + integration:** run on every push (`vitest run`), target **≥80%** on `lib/face`, `lib/gestures`, `lib/ai`, `lib/extract`, scoring/timer, **`app/api/sessions/*` and `app/api/face/*`** (they carry the integrity logic). CRUD/UI can be lower. Coverage thresholds are per-file (vitest v8) — P5 added `lib/sessions/**` + `app/api/sessions/**` to `coverage.include` with literal per-file keys; P6 added `lib/gestures/**` (`finger-count`/`hold-confirm`/`hand-loss` ≥80% stmts/lines/funcs, ≥70% branches; `hand-tracker.ts` 0-key browser-only); browser-only UI components (`play-client`, `question-card`, `option-card`, `progress-hud`, `end-screen`, `student-quizzes-client`, `gesture-layer`, `gesture-calibration`) are E2E-covered and excluded from the report; **SQ** added `lib/student-quizzes/**` + `app/api/student-quizzes/**` to include with literal rows (libs 80/80/80/70, routes 60/60/60/50, `question-draft.ts` 80/80/80/70).
- **DB/RLS:** `supabase start` in CI, run SQL test suite; **D1–D18 are blocking** (they guard the demo's core promises). Phase 2 D8/D12 are additionally proven by `scripts/verify-classes.mjs` (real anon-token clients). SQ adds `scripts/verify-student-quizzes.mjs` (SQ-D1–D9, 21 checks) as a blocking CI step.
- **E2E:** Playwright on PRs; **E5, E6, E7, E8, E12 are the "demo-killer" tests** (with the D1 data-integrity gate; counts drifted across phases — treat the §9 list as the canonical set). ⚠️ As of 2026-08-22 the face-cycle specs (e6/e7) carry choreography drift from the integrity-suite re-architecture; `e16-integrity.spec.ts` is the green face-flow reference until they are rehabilitated. — if any fail, do not demo.
- **AI tests never hit a real model** — MSW serves canned valid/invalid JSON (keeps CI free and deterministic).
- **Visual exploration (manual QA aid, not CI):** `scripts/seed-scenarios.mjs` provisions three dataset sizes (first/normal/extreme — see the script header); `scripts/explore-scenarios.mjs` walks every core page per scenario in light+dark at desktop 1440×900, screenshotting each stop and writing `screenshots/explore_scenarios/report.json`. The mobile counterpart `scripts/explore-mobile.mjs` runs at 375×812 (plus a 320px overflow sweep) with touch emulation and *operates* the mobile grammar (plan `PLAN_MOBILE_REDESIGN`): dock tabs + `aria-current`, account sheet, bell popover, keyboard-occlusion dock hide (`data-keyboard-open`), zero-state join hero, gradebook per-quiz/per-student sheets, shared-quiz play stage — 28 checks per theme. **`full` mode** (`node scripts/explore-mobile.mjs full|all`) adds the every-surface sweep: landing page (incl. the EN→BM language toggle), auth pages + password-eye, and every dialog/sheet/confirm that can open — bell mark-all confirm, my-quizzes share + delete dialogs, join-error state, builder settings/generate/import/duplicate/question-edit/regenerate dialogs, results reveal/exempt dialogs, class archive confirm — each screenshotted while open and overflow-audited (110 checks per theme). Screenshots + `report.json` land in `screenshots/explore_mobile/<light|dark>/`. Both need the dev server up and the seeded accounts (password `Password123!`).

## 7. Manual / Real-Device Checklist (pre-demo, can't be automated)

1. Real webcam: hand tracking selects 1–4 fingers reliably in the **actual demo room lighting** (the fake-tracker E2E proves the state machine; real-lighting reliability is this manual item).
2. Real face enroll + verify with the presenter and a volunteer "impostor".
3. GLM-OCR via Docker/vLLM (optional high-accuracy path): `docker compose up -d glm-ocr`, confirm the picker entry appears after probe, run one scanned slide deck end-to-end; note per-page latency on the demo machine. Tesseract-only path must work with no GLM container running. **CI:** the `E2-GLM` Playwright spec is skipped when `CI` is set (GitHub Actions runners don't run the GLM-OCR container); it runs only on a dev machine with the container reachable (`GLM_BASE_URL`).
4. Wake Supabase free tier (7-day pause) the day before.
5. 2–3 laptops simultaneously on one assessment — confirm no race on session start.
6. **Model hosting reachable from the demo room** — confirm `/public/models` (self-hosted MediaPipe files) loads on the venue Wi-Fi; `verify-mediapipe` proves integrity. (P6 vendors + commits the assets; no Google CDN at runtime.)
7. **Vercel body limit on vision OCR** — run one real multi-page scan through the cloud-vision path and confirm client-side ≤3-page batching keeps each request under 4.5 MB.

---

## 8. Traceability: risk → test

The critical guarantees the demo lives or dies by, and where each is proven:

| Guarantee | Covered by |
|---|---|
| Embedding dims enforced (192) → **CompreFace: frame schema + body-size caps (413) + empty-frame no-face sentinel** | I3, I4b |
| Majority vote re-derived in SQL (match ⇔ strict majority of frame sims ≥ 0.5; no margin since 0020) | I-threshold, I-vote |
| GLM-OCR availability probe | U-E4, manual #3 |
| One-attempt race closed | D1, E5 |
| Assessment re-answer rejected / answer idempotency | D1b, D9, I10 |
| Fail-streak fairness (sliding window, flat count) | U-F6, U-F7c, I5, I5b |
| Paused self-recovery vs flagged lecturer-only split | U-F7, U-F7b, I6b, I6c, E6, E7, E9b |
| Answer secrecy (both modes) | D5, I7, E11, D42 |
| Server timer enforcement (+grace) | U-T1, I9, E10, D45 |
| One-attempt race (P5) | D1, E5 |
| Resume (P5) | U-T6, E4 |
| Timer authoritative in RPC (P5) | D45, E10 |
| Submit-after-deadline deviation (P5) | D45, E10 |
| Grading against real DB (P5) | D44 |
| Answer secrecy end-to-end (P5) | D42, I7, E11 |
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
| Per-session shuffle determinism + canonical-wire integrity (QT-3) | U-QT3-1..18, QT3-1..5, QT3-D1–D6, E42 |
| Multi-select exact-set grading, canonical storage, secrecy, authoring (QT-1) | U-QT1-1..7 (validation), U-S-QT1 (answer one-of), U-QT1-A1..A7 + U-QT1-P1..P5 (AI), U-QT3-19..20 (breakdown sets), U-QT1-E1..E4 (export) + multi workbook fixture, U-AP1-9b/9c (import grammar), QT1-1..13 (route tests), QT1-D1–D10 (verify probes), E45 |

---

## 9. Phase Gates

The build is **gated**: each phase below must (a) deliver its feature, (b) pass its gate tests, and (c) keep all earlier gates green before the next phase starts. Gate tests are blocking in CI. (Mirrors [PLAN.md §6](PLAN.md#6-build-phases-gated).)

| Phase | Gate tests | Exit criteria |
|---|---|---|
| **P1 Scaffold** | E1a — register/login as lecturer + student; consent checkbox persists | Both roles authenticate; unconsented users hit the consent screen |
| **P2 Classes** | D8, D12, D15–D18 · E1 — create class → join via code → roster updates | Student enrolls via code; lecturer A cannot see lecturer B's classes/files; join is idempotent and code-checked |
| **P3 Manual builder** | D5, D6 · I20 · D19–D33, I-Q1–I-Q13 · **E1b** | Lecturer hand-builds and publishes a quiz; students never see `correct_index`/join_code/source_file_url/embeddings; student role blocked from all lecturer routes; draft/live/closed state machine + question/metadata immutability enforced at the DB layer |
| **P4 Extraction + AI generation** ★ | U-A1–U-A11 · U-E1–U-E12 · I14–I19 · I-A1–I-A14 · D34–D40 · E2, E2b | Real chapter PDF (incl. scanned via Tesseract) → editable, publishable quiz; invalid AI output inserts **zero** rows; vision-OCR route returns text + stores nothing, batches under body limit |
| **P5 Play screen (click-first)** | U-T1–U-T3, U-T5–U-T6 · U-S1–U-S4 · D1, D1b, D2–D4, D7, D9, D42–D47 · I7–I13, I-S1–I-S12, I-S14–I-S15 · E4 (resume+replay), E5, E10 (API+UI), E11 | Full quiz playable with mouse; one-attempt enforced; timer enforced server-side; re-answer rules correct per mode; `correct_index`/`explanation` never leak to students |
| **P6 Gesture layer** ✅ | U-G1–U-G7 · E8, E9, E9b | Full quiz playable hands-free; mid-hold change and hand-loss behave; hand-loss auto-pauses (client-side overlay; DB pause + blink recovery proven in P7) |
| **P7 Face pipeline** ✅ | U-F3–U-F7c · D10, D11, D13, D14 · I1–I6c, I22 · E3, E3b, E6, E7, E12, E13 · E9b rework | Enroll → gate → continuous verify (30–45s cadence proven by fake clock + E12 periodic observation); wrong face at Q3 → paused → flagged; self-recovery only from paused; lecturer-only unlock; nonce replay rejected; hand-loss pause is server-side (409/blink recovery); gate not bypassable by reload; timer-gate auto-submits score-0 |
| **P8 Results & attendance** | U-T4 · I21 · E5b, E13b | Dashboard shows attendance (incl. abandoned — derivation pinned by U-T4), scores, face-check timeline; unlock/exempt/reset audited (audit rows verified via D13); reset releases the one-attempt slot |
| **P9 Hardening & deploy** | Full suite (all gates above) + manual checklist §7 | Demo URL live; self-hosted models load on venue Wi-Fi; Supabase awake |

**Demo-killer tests** (if any is red → do not demo): **D1, E5, E6, E7, E8, E12**.

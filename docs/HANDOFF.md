# InnoVision — Session Handoff (Phase 6 DONE)

> Purpose: give a fresh session full context without re-reading the large PLAN docs.
> Read this file first. `docs/PLAN_PHASE6.md` has the full implementation + audit-fix log (§8); `docs/TESTING.md` has the test plan.

---

## 1. Where we are

**Phase 6 (Gesture layer) is COMPLETE and fully audited.** All work is on `main`. The audit→fix→re-graphify loop ran and converged clean (no remaining Critical/High findings — see `PLAN_PHASE6.md` §8).

Phases done: **1 Scaffold → 2 Classes → 3 Manual builder → 4 Extraction + AI generation → 5 Play screen (click-first) → 6 Gesture layer** (this phase).

**Next phase (per PLAN.md §6): Phase 7 — Face pipeline (enroll → gate → continuous verify).** Depends on P5/P6 (the play screen + gesture layer); P7 adopts the client-side hand-loss pause into the server state machine (reuse `HandLossMonitor`), flips `quiz_sessions.status` to `paused`/`flagged`, and adds blink-liveness self-recovery (E6/E7).

## 2. Verified green baseline (run these to confirm)

```bash
npm run lint          # 0 errors, 0 warnings
npm run typecheck     # clean
npx vitest run        # 344/344 (25 files)
npx vitest run --coverage   # per-file thresholds pass (incl. lib/sessions + app/api/sessions + lib/gestures)
node scripts/verify-security.mjs   # 3/3
node scripts/verify-classes.mjs    # 21/21
node scripts/verify-quizzes.mjs    # 42/42
node scripts/verify-ai.mjs         # 16/16
node scripts/verify-sessions.mjs   # 19/19 (D1/D1b/D2-D4/D7/D9/D42-D47)
node scripts/verify-mediapipe.mjs  # vendored assets intact (SHA-256 vs MANIFEST)
npx playwright test    # 16/16 E2E (E1a/E1/E1b/E2/E2b/E2c + E4/E5/E10a/E10b/E11 + E8/E9/E9b)
npm run build          # succeeds
```

Prereqs for the harnesses/E2E: **Docker Desktop running** + local Supabase up (`npx supabase start`), `.env.local` populated (gitignored; see `.env.local.example`). `.env.local` currently has the local Supabase keys; `AI_API_KEY` is blank (use a dummy `test-key` for CI; E2E uses the mock AI server).

## 3. What Phase 6 delivered

- **Vendored MediaPipe** — `@mediapipe/tasks-vision@1.0.1` exact-pinned; `scripts/vendor-mediapipe.mjs` copies `vision_bundle.mjs` + `wasm/` → `public/mediapipe/` and downloads `hand_landmarker.task` → `public/models/` (SHA-256-verified, `MANIFEST.json`). The bundled Google telemetry URL is **neutralized at vendor time** (rewritten to a local inert path) so the self-hosted runtime never phones home. `scripts/verify-mediapipe.mjs` re-verifies committed hashes in CI (step after `npm run build`). `proxy.ts` matcher excludes `/mediapipe/` + `/models/` (static-only prefixes, self-auth comment). `src/types/mediapipe-url.d.ts` + `src/types/gestures.d.ts`.
- **`src/lib/gestures/`** — pure, env-free logic (house precedent: `lib/sessions/timer.ts`): `constants.ts` (`HOLD_MS=800`, `SCAN_COUNTDOWN_MS=1200`, `WARN_AFTER_MS=3000`, `PAUSE_AFTER_MS=10000`, `PAUSE_CLEAR_MS=1500`, `BOOT_TIMEOUT_MS=10000`, `MAX_ANSWER_FINGERS=5`, `FAKE_TICK_MS=50`), `types.ts` (`HandFrame`, `HoldProgress`, `HandSegment`, `IHandTracker`, `FakeHandControl`), `finger-count.ts` (`countExtendedFingers` incl. handedness-aware thumb, `mapFingersToOption`), `hold-confirm.ts` (latched `HoldConfirm`), `hand-loss.ts` (`HandLossMonitor`), `fake-seam.ts` (typed accessors for the E2E globals — no `process.env`; the `NODE_ENV` gate lives in GestureLayer). Unit tests U-G1–U-G7 (31 tests).
- **`src/lib/gestures/hand-tracker.ts`** — browser-only `HandLandmarkerTracker` (getUserMedia max-bounded → `webpackIgnore` dynamic import → WASM → GPU→CPU fallback → ~30fps rAF loop with `document.hidden` skip + `readyState>=2` guard; mirrored overlay `1 - l.x`; idempotent `stop()`). 0-key coverage (browser-only precedent).
- **`src/components/vision/`** — `gesture-layer.tsx` (wrapper: boot race against `BOOT_TIMEOUT_MS`, latest-ref frame dispatch, status gate, palm-next accumulator, hand-loss warn/pause with `PAUSE_CLEAR_MS` stabilization, questionId-keyed scan countdown, persistent video/canvas pair, `blockInput` overlay suppression) + `gesture-calibration.tsx` (non-gated, skippable, honest privacy notice).
- **UI wiring** — `option-card.tsx` finger glyphs + hold-progress bar (button semantics unchanged); `question-card.tsx` forwards `holdProgress`; `play-client.tsx` wraps QuestionCard in GestureLayer, adds `selectOption` bounds guard + `goNext` phase guard, palm-next hint.
- **E2E** — `e2e/fake-hand-tracker.ts` (standalone init script; StrictMode-idempotent; `sequence`/`frame` control), `e2e/helpers.ts` additions (`installFakeHandTracker` = addInitScript + immediate evaluate for SPA nav, `playGestureSequence`, `fakeHandFrame`, `completeCalibration`, `waitForScanClear`, `captureAnswerPosts`, `expectNoAnswerPost`), specs E8 (gesture answering + hold-once + palm-next), E9 (accidental-lock), E9b (hand-loss auto-pause + blocked-answers + 200-recovery). All 16 E2E green.
- **Config** — `vendor:mediapipe` / `verify:mediapipe` npm scripts; CI `verify:mediapipe` step; `vitest.config.ts` coverage include + per-file thresholds for `lib/gestures/**` (`hand-tracker.ts` 0-key); `eslint.config.mjs` ignores `public/mediapipe/**` + `public/models/**`.
- **Docs** — `PLAN_PHASE6.md` §8 (execution + audit log), `TESTING.md` P6 rows updated, `HANDOFF.md` (this file).

### What Phase 5 delivered (foundation, still in the repo) — `session_status` enum; `quiz_sessions` (with `face_fail_streak`/`face_exempt`/`verify_nonce`/`last_activity_at` for P7 schema completeness); `session_answers` (NO `correct_index`/`explanation` — never leaks the key); partial unique index `one_assessment_attempt` (the atomic one-attempt race guard); `can_student_view_quiz` + `is_session_owner_or_lecturer` helpers; `student_question_view` (security_barrier, no key); RLS (own-session + lecturer reads only; **no INSERT/UPDATE policies** — RPC-only writes); privilege grants (`revoke all` → `select`-only for authenticated, full `service_role`); RPCs `start_quiz_session` (practice rejoin under advisory lock / assessment one-attempt with `unique_violation` catch), `answer_question` (lock+ownership in one query, `clock_timestamp()` timer with SQL-constant 5s grace, `session_not_active` for paused/flagged/completed, practice upsert vs assessment `already_answered`, never leaks `correct_index` in assessment), `submit_session` (idempotent `already_submitted`, **no timer rejection** — deviation pinned by D45).
- **`src/lib/sessions/`** — `timer.ts` (100% pure, no `process.env`: `isWithinTimeLimit`/`computeScore`/`firstUnansweredIndex`/`remainingMs`) + `validation.ts` (Zod `StartSessionSchema`/`AnswerSchema`/`SubmitSchema`). Unit tests U-T1–U-T6 + U-S1–U-S4.
- **Routes** — `POST /api/sessions` (start/rejoin; `requireStudent` → CSRF → rate-limit → RPC), `POST /api/sessions/[id]/answer` (RPC-authoritative, payload passthrough snake→camel, never synthesizes `correctIndex` in assessment), `POST /api/sessions/[id]/submit` (no timer check — documented deviation), quiz-DELETE guard (`409 quiz_has_sessions` when sessions exist).
- **Play screen** — `src/app/play/[sessionId]/page.tsx` (server component: own session + quiz via `student_quiz_view` + questions via `student_question_view` + own answers; computes `initialIndex`/`initialRemainingMs` server-side; `Promise.allSettled` per-query error capture; 0-question degenerate guard; mode-drift guard; completed → EndScreen). `src/components/quiz/` — `play-client.tsx` (the engine: phases question/locked/feedback/submitting/submitted/timeUp, `submitLock` ref, ~15s `AbortController`, monotonic countdown, timeUp awaits in-flight answer then auto-submits, renders end state from submit payload then `router.refresh()`), `question-card.tsx`, `option-card.tsx`, `progress-hud.tsx`, `end-screen.tsx`. Start button added to `student-quizzes-client.tsx` (201 → push `/play/{id}`; 409 `already_attempted` → push `/play/{session_id}` — the play page disambiguates resume vs already-taken).
- **Tests** — `src/app/api/sessions/__tests__/sessions-routes.test.ts` (35 tests: I7–I13, I-S1–I-S12, I-S14–I-S15); `FakeSupabase` gained session RPC stubs (route-mapping only, lockstep header comment) + `seedSession`/`seedAnswer`; `scripts/verify-sessions.mjs` (18 checks: D1/D1b/D2–D4/D7/D9/D42–D47); E2E `e4-play-practice.spec.ts` (click-first + resume + replay), `e5-assessment-lock.spec.ts`, `e10-timer-expiry.spec.ts` (API + UI halves), `e11-answer-secrecy.spec.ts`; `e2e/helpers.ts` gained `createClass`/`joinClass`/`createQuizWithQuestions`.
- **Config** — `verify:sessions` npm script; CI gains `verify:sessions` + `vitest run --coverage`; `vitest.config.ts` coverage include + per-file thresholds for `lib/sessions/**` + `app/api/sessions/**` (browser UI components E2E-covered, excluded from report).

## 4. Key security/robustness invariants (do not regress)

- **Session writes are RPC-only.** `quiz_sessions`/`session_answers` have NO INSERT/UPDATE policy; `revoke all` then `select`-only grant for `authenticated`. A student can never forge a score/answer via PostgREST.
- **One-attempt is atomic** — partial unique index `one_assessment_attempt` (not just an RPC pre-check). `start_quiz_session` catches `unique_violation` → typed `already_attempted` (D1).
- **Answer secrecy** — `student_question_view` has NO `correct_index`/`explanation` columns; `session_answers` never stores them; assessment answer RPC returns `{is_correct}` only (D42/I7/E11).
- **Timer is RPC-authoritative** — `answer_question` uses `clock_timestamp()` + SQL-constant `interval '5 seconds'` grace (never caller-supplied). Client countdown is UX-only, seeded server-side, monotonic. **Submit past deadline is ALLOWED** (deviation; D45/E10).
- **`answer_question`/`submit_session` lock + ownership in ONE query** — a guessed foreign session id is never row-locked (no contention on the victim's lock).
- **Practice rejoin** is under a per-(quiz,student) advisory lock; completed practice sessions are never rejoined (D2).
- **Quiz-DELETE guard** is route-level/advisory (TOCTOU accepted at demo scale); DB layer cascades by design (I-S12 owns it; D41 deliberately not a D-test).
- **CSRF** `checkSameOrigin()` on start/answer/submit; per-user rate limits (start 10/min, answer 120/min, submit 10/min).

## 5. Known remaining / accepted (documented in PLAN_PHASE5 §5)

- Grace is a SQL constant (`interval '5 seconds'`) AND `TIMER_GRACE_SEC` env mirrors it for JS only — changing grace requires a migration.
- Quiz-DELETE guard TOCTOU (narrow window); class deletion still cascades sessions (P8 item).
- Direct PostgREST RPC abuse bypasses route-level rate limits (RPCs still enforce integrity — D1–D46); DB-backed throttling is post-demo.
- In-memory rate limiter is per-process (P2 caveat).
- Resume feedback loss: previously-answered questions on a refresh show correct/incorrect WITHOUT the key/explanation (never stored) — accepted UX trade-off.
- `verify_nonce`/`face_fail_streak`/`face_exempt`/`last_activity_at` are schema completeness for P7/P8 (U-T4 abandoned state is a P8 gate).
- E10's API half sleeps ~12s past start (deterministic, anchored to `started_at`); kept in a dedicated spec.

## 6. How to start Phase 7 (Face pipeline)

1. Confirm the baseline above is green (docker + supabase up).
2. `docs/PLAN_PHASE6.md` §8.4 shows the exact verification matrix to re-run.
3. `docs/PLAN.md` §6 (P7 row) + `docs/TESTING.md` §9 (P7 gates: U-F1–U-F7c, D10/D11/D13/D14, I1–I6c/I22, E3/E3b/E6/E7/E12) define the deliverable. P7 adopts the client-side hand-loss pause into the server state machine (reuse `HandLossMonitor`), flips `quiz_sessions.status`, and adds blink-liveness self-recovery. The `verify_nonce`/`face_fail_streak`/`face_exempt` columns already exist in migration 0008.
4. Follow the same pattern as prior phases: write a `PLAN_PHASE7.md`, get it reviewed, execute, then run the audit→fix→graphify loop.
5. Graphify is installed (`C:\Users\mohdz\.local\bin\graphify.exe`); run `graphify update .` after changes.

## 7. Commit history (P6)

```
<commits added during this phase — see git log>
```

## 8. P6 gate summary (final)

- **Unit/integration:** 344 vitest tests (25 files), coverage thresholds pass (sessions 100% stmts, lib/sessions 100%, lib/gestures ≥80% stmts/lines/funcs + ≥70% branches; hand-tracker.ts 0-key browser-only).
- **DB/RLS/RPC:** verify-sessions 19/19 (D1/D1b/D2–D4/D7/D9/D42–D47); earlier harnesses stay green (security 3/3, classes 21/21, quizzes 42/42, ai 16/16); verify-mediapipe 8/8 assets intact.
- **E2E:** 16/16 (E4 practice click-first + resume + replay, E5 one-attempt lock, E10 API+UI timer, E11 answer secrecy with 409 error-body assertions, E8 gesture answering + hold-once + palm-next, E9 accidental-lock, E9b hand-loss auto-pause + blocked-answers + 200-recovery).
- **Build/lint/typecheck/graphify:** all clean.

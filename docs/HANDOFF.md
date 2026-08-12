# InnoVision — Session Handoff (Phase 5 DONE)

> Purpose: give a fresh session full context without re-reading the large PLAN docs.
> Read this file first. `docs/PLAN_PHASE5.md` has the full implementation + audit-fix log (§8); `docs/TESTING.md` has the test plan.

---

## 1. Where we are

**Phase 5 (Play screen, click-first) is COMPLETE and fully audited.** All work is on `main`. The audit→fix→re-graphify loop ran and converged clean (no remaining Critical/High findings — see `PLAN_PHASE5.md` §8).

Phases done: **1 Scaffold → 2 Classes → 3 Manual builder → 4 Extraction + AI generation → 5 Play screen (click-first)** (this phase).

**Next phase (per PLAN.md §6): Phase 6 — Gesture layer (finger-count answer selection, hold-to-confirm).** Depends on P5 (the play screen + answer RPCs).

## 2. Verified green baseline (run these to confirm)

```bash
npm run lint          # 0 errors, 0 warnings
npm run typecheck     # clean
npx vitest run        # 303/303 (24 files)
npx vitest run --coverage   # per-file thresholds pass (incl. lib/sessions + app/api/sessions)
node scripts/verify-security.mjs   # 3/3
node scripts/verify-classes.mjs    # 21/21
node scripts/verify-quizzes.mjs    # 42/42
node scripts/verify-ai.mjs         # 16/16
node scripts/verify-sessions.mjs   # 18/18 (D1/D1b/D2-D4/D7/D9/D42-D47)
npx playwright test    # 13/13 E2E (E1a/E1/E1b/E2/E2b/E2c + E4/E5/E10a/E10b/E11)
npm run build          # succeeds
```

Prereqs for the harnesses/E2E: **Docker Desktop running** + local Supabase up (`npx supabase start`), `.env.local` populated (gitignored; see `.env.local.example`). `.env.local` currently has the local Supabase keys; `AI_API_KEY` is blank (use a dummy `test-key` for CI; E2E uses the mock AI server).

## 3. What Phase 5 delivered

- **Migration `supabase/migrations/0008_sessions.sql`** — `session_status` enum; `quiz_sessions` (with `face_fail_streak`/`face_exempt`/`verify_nonce`/`last_activity_at` for P7 schema completeness); `session_answers` (NO `correct_index`/`explanation` — never leaks the key); partial unique index `one_assessment_attempt` (the atomic one-attempt race guard); `can_student_view_quiz` + `is_session_owner_or_lecturer` helpers; `student_question_view` (security_barrier, no key); RLS (own-session + lecturer reads only; **no INSERT/UPDATE policies** — RPC-only writes); privilege grants (`revoke all` → `select`-only for authenticated, full `service_role`); RPCs `start_quiz_session` (practice rejoin under advisory lock / assessment one-attempt with `unique_violation` catch), `answer_question` (lock+ownership in one query, `clock_timestamp()` timer with SQL-constant 5s grace, `session_not_active` for paused/flagged/completed, practice upsert vs assessment `already_answered`, never leaks `correct_index` in assessment), `submit_session` (idempotent `already_submitted`, **no timer rejection** — deviation pinned by D45).
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

## 6. How to start Phase 6 (Gesture layer)

1. Confirm the baseline above is green (docker + supabase up).
2. `docs/PLAN_PHASE5.md` §8.4 shows the exact verification matrix to re-run.
3. `docs/PLAN.md` §6 (P6 row) + `docs/TESTING.md` §9 (P6 gates: U-G1–U-G7, E8/E9/E9b) define the deliverable. The P5 play screen + answer RPCs are the foundation (P6 adds finger-count selection + hold-to-confirm + hand-loss auto-pause).
4. Follow the same pattern as prior phases: write a `PLAN_PHASE6.md`, get it reviewed, execute, then run the audit→fix→graphify loop.
5. Graphify is installed (`C:\Users\mohdz\.local\bin\graphify.exe`); run `graphify update .` after changes.

## 7. Commit history (P5)

```
<commits added during this phase — see git log>
```

## 8. P5 gate summary (final)

- **Unit/integration:** 313 vitest tests (22 files), coverage thresholds pass (sessions 100% stmts, lib/sessions 100%).
- **DB/RLS/RPC:** verify-sessions 19/19 (D1/D1b/D2–D4/D7/D9/D42–D47); earlier harnesses stay green (security 3/3, classes 21/21, quizzes 42/42, ai 16/16).
- **E2E:** 13/13 (E4 practice click-first + resume + replay, E5 one-attempt lock, E10 API+UI timer, E11 answer secrecy with 409 error-body assertions).
- **Build/lint/typecheck/graphify:** all clean; graphify 943 nodes, no import cycles.

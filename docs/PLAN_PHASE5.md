# InnoVision — Phase 5 (Play Screen, Click-First) Implementation Plan

> **Status:** DRAFT — pending review; not approved for execution.
> **Depends on:** Phase 4 (Extraction + AI generation) — committed at `a44db05` (+ `12420d7` handoff doc, `8789776` baseline fixes); gates green (210 vitest · verify-security 3/3 · verify-classes 21/21 · verify-quizzes 42/42 · verify-ai 16/16 · 7 Playwright E2E · lint/typecheck/build clean).
> **Phase 5 deliverable (PLAN §6):** `QuizEngine`, practice + assessment modes, one-attempt RPC, server timer (+grace), per-question grading, EndScreen. A full quiz playable with **mouse**; assessment locks retry; answers never leak `correct_index`.
> **Gate tests (TESTING §9):** **U-T1–U-T3** (timer/score) · **D1, D1b, D2–D4, D7, D9** (one-attempt / re-answer / practice / start rules / RLS / upsert) · **I7–I13** (answer / submit routes) · **E4, E5, E10, E11** (practice click-through, one-attempt lock, timer expiry, answer secrecy). All earlier gates stay green.
> **New tests added by this plan:** U-T5–U-T6, U-S1–U-S4 (unit) · I-S1–I-S12, I-S14–I-S15 (route/integration; I-S13 intentionally not used) · D42–D47 (DB/RLS; D41 not used — quiz-delete guard is route-owned) · E2E E4/E5/E10/E11 (new specs) with resume folded into E4.
> **P5 prerequisite (from HANDOFF §6 / PLAN_PHASE3 §5):** the quiz-DELETE route must gain a "block when sessions exist" guard. Included (Step 3). **No env changes are needed** — `TIMER_GRACE_SEC` already exists in `.env.local.example` and the CI writer (verified).

---

## 1. Current state

- **Phase 4 committed:** migration `0007` (AI generation, `replace_quiz_questions`, storage hardening), `lib/ai/*`, `lib/extract/*`, AI routes, builder UI, 210 unit tests, verify harnesses, E2E.
- **Baseline verified:** `npm run lint` clean · `npm run typecheck` clean · `npx vitest run` 210/210 · `npm run build` succeeds · graphify graph fresh at HEAD (re-run `graphify update .` after changes).
- **What exists that P5 reuses (don't rebuild):**
  - Guards: `requireUser`/`requireLecturer`/`requireStudent` (`lib/classes/guards.ts`).
  - HTTP builders (`lib/http.ts`): `jsonError`, `invalidJson`, `invalidBody`, `notFound`, `unauthorized`, `forbidden`, `rateLimited`, `internalError`, `checkSameOrigin`, `firstIssueMessage` (error shape `{ error, message? }`).
  - Rate limiter (`lib/classes/rate-limit.ts`): `rateLimit(key, {limit, windowMs})`, test-only `_resetRateLimiter()` / `_seedRateLimit(key, count)`.
  - Route-handler harness: `FakeSupabase` + `makeOwnerContext` (`src/app/api/quizzes/__tests__/fake-supabase.ts`), `vi.mock("@/lib/supabase/server")`, `params: Promise.resolve({ id })` (Next 16), and the AI-test "no `resetModules`" rate-limiter caveat.
  - Live-DB harness pattern (`scripts/verify-*.mjs`), E2E helpers (`e2e/helpers.ts`), CI (`ci.yml`).
  - Views: `student_quiz_view` (security_barrier; `id, class_id, title, mode, status, time_limit_sec, created_at`; enrolled + live only) — the student quiz list already renders live cards. `student_question_view` **does not exist yet** (students currently read 0 question rows — D5).
- **What does not exist yet (confirmed by exploration):**
  - No `quiz_sessions` / `session_answers` tables, no `session_status` enum, no `start_quiz_session` RPC, no `verify_nonce`/`face_fail_streak`/`face_exempt`/`last_activity_at` columns, no `face_checks`/`audit_events` (P7/P8).
  - No `src/app/api/sessions/*` routes, no `src/app/play/`, no `src/lib/sessions/`, no `src/components/quiz/`.
  - `student-quizzes-client.tsx` has **no Start action** — cards are informational ("The play screen is Phase 5").
  - Quiz-DELETE route has the P5 prerequisite TODO (block when sessions exist).
- **Key constraint confirmed:** `questions` RLS is **lecturer-only** (`is_lecturer_of_quiz`). Students can read **zero** question rows. P5 must add a student question-read path that omits `correct_index` (PLAN §1). `student_quiz_view` is the model to follow.
- **Env verified (no drift):** `.env.local.example` already lists `TIMER_GRACE_SEC=5`; `ci.yml` already writes it. **No env change is needed in P5.**

---

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Session writes are RPC-only** | `quiz_sessions` and `session_answers` get **no authenticated INSERT/UPDATE policy**. All writes go through security-definer RPCs (`start_quiz_session`, `answer_question`, `submit_session`). `session_answers` gets **no direct INSERT/UPDATE/DELETE policy at all**. Grants are **`select`-only for `authenticated`** (with an explicit `revoke all` first — see Step 1) + full `service_role`; RLS is the backstop but the grants match intent. | A student must never be able to `UPDATE quiz_sessions SET score=…, status='completed'` or insert forged answers via PostgREST. Mirrors `class_enrollments` (enrollment is RPC-only via `join_class`). The RPCs re-validate `auth.uid()` + ownership/status/timer because `security definer` bypasses RLS (SECURITY_AUDIT "notes for future phases"). |
| **Reads stay in server components + views** | The play page (server component) reads: own session (`quiz_sessions` SELECT), quiz metadata via `student_quiz_view`, questions via a new `student_question_view` (no `correct_index`, no `explanation`), own answers via `session_answers` SELECT. No client question-fetch API. | `correct_index`/`explanation` are never exposed via any client-readable policy (D5/E11); server components are RLS-scoped; fewer round trips. |
| **`student_question_view`** | New `security_barrier` view: `id, quiz_id, order_index, type, prompt, options, created_at` (excludes `correct_index` **and** `explanation`), gated by a new security-definer helper `can_student_view_quiz(p_quiz_id)` (enrolled **and** `status='live'`). `created_at` is included so the play page can `ORDER BY order_index, created_at` (P3 ordering convention) — it leaks nothing. | Explanation text identifies the correct option; showing it before answering defeats the quiz. Per-answer disclosure in practice happens only via the answer API, never pre-answered. `created_at` must be in the view or PostgREST rejects the `.order("created_at")` (execution blocker). |
| **One-attempt (assessment)** | Partial unique index `one_assessment_attempt ON quiz_sessions (quiz_id, student_id) WHERE mode = 'assessment'` — the real race guard. `start_quiz_session` catches `unique_violation` and returns `{error:'already_attempted', session_id}` (join_class's return-jsonb style, not a raise). | D1/E5: two concurrent starts → exactly one row; no 500. The index (not just the RPC pre-check) closes the race. |
| **Practice rejoin semantics** | `start_quiz_session` for practice: take a per-(quiz, student) advisory lock (`pg_advisory_xact_lock(hashtext('quiz_start:' || p_quiz_id::text || ':' || auth.uid()::text))`), then if a **non-terminal** session (`active`/`paused`) exists, **rejoin** it; else insert a **new** session. Completed practice sessions are never rejoined. | D2 (multiple practice sessions allowed) + PLAN §1 ("rejoin existing") both hold; the advisory lock closes the double-click/two-tab double-insert race so "refresh resumes the same session" is real, not soft. |
| **Server-side timer (RPC-authoritative)** | `answer_question` enforces (in SQL) `clock_timestamp() > started_at + time_limit_sec + grace` and rejects with `{error:'time_expired'}`. **Grace is a SQL constant `interval '5 seconds'`** — never an argument (a caller can't pass a larger grace). The route maps `time_expired` → 403 and does **not** enforce any timer itself. Use **`clock_timestamp()`** (actual current time) so time spent waiting on the session row-lock counts against the deadline. | PLAN §2: client timer is UX-only, never trusted. `now()` is frozen at transaction start and would be systematically more lenient under lock contention. |
| **Submit after deadline is ALLOWED (documented deviation)** | `submit_session` does **not** reject past the time limit; it computes the score from answers so far and completes the session. Only `answer_question` rejects `time_expired`. | PLAN §2 says submit "rejects if past time limit", but TESTING defines **no** submit-timeout gate, and rejecting submit strands the student (auto-submit at 0s arriving >grace late would 409 and leave the session stuck until P8 force-close). Allowing submit is strictly more robust; the timer's job is stopping **answers**. Pinned by D45 (and reflected in E10's API half). **`docs/PLAN.md` §2 is updated in Step 8 to drop the stale "submit rejects" wording.** |
| **Submit idempotency response** | `submit_session` returns the existing `{session, score, total}` on re-submit with `already_submitted: true`; the route maps it to **409 `already_submitted`** (with the payload) per TESTING I13 ("409, no score change"). The client treats 409 `already_submitted` as terminal success. | I13 is the gate. The client also renders the end state from the submit payload immediately (robustness: `router.refresh()` may fail), then refreshes to reconcile. |
| **Answer on a non-active session → single 409 `session_not_active`** | The answer route performs **no** status pre-check and **no** mode re-read; the RPC is the sole authority. The RPC returns `{error:'session_not_active'}` for `paused`/`flagged`/**`completed`**; the route maps it to 409 `session_not_active`. `already_submitted` (409) is reserved **only** for the submit route's idempotent re-submit. | Avoids two divergent 409 codes for the same underlying state (clean-code finding) and removes the second source of truth for practice-vs-assessment shaping: the RPC's JSON payload is passed through verbatim (snake→camel only). |
| **`correct_index`/`explanation` disclosure** | Assessment answer → `{ isCorrect }` **only**. Practice answer → `{ isCorrect, correctIndex, explanation }`. A **practice** re-answer is a 200 upsert (always returns the full practice payload) — `already_answered` occurs **only in assessment**, where the RPC returns `{ error: 'already_answered', is_correct }` and the route maps it to **409 `{ error: 'already_answered', isCorrect }`** (payload passed through, key-mapped; never synthesized). | PLAN §2 / I7 / I8. The `already_answered` payload keeps the refresh-with-in-flight-answer UX intact (client renders feedback instead of a silent advance) without leaking the key in assessment. The route never branches on mode — it mechanically re-keys whatever keys the RPC payload contains. |
| **Resume support (DB-sourced)** | The play page fetches the student's **own** `session_answers` (only `question_id, selected_index, is_correct` — `correct_index`/`explanation` are **not stored** on answers, so nothing leaks) and the server computes `initialIndex` = first unanswered question. The client pre-fills answered questions and starts at `initialIndex`. Previously-answered questions show a neutral "answered" chip (assessment) or correct/incorrect (practice) — **without** the key/explanation, which are only shown for questions answered in the current page session. | Refresh mid-assessment must not deadlock the student on `already_answered` (Q1 re-answer → 409). Storing `correct_index` on `session_answers` would leak it via the own-session SELECT policy in assessment — so it is never stored. The feedback loss on resume is a documented, accepted UX trade-off. |
| **Route authZ order** | Student routes (`/api/sessions`, `answer`, `submit`) call `requireStudent` **first** (lecturer → 403), then `isUuid`, then CSRF, then rate-limit, then body, then RPC. No-oracle: the RPCs return a single `not_owner` for missing/non-owned sessions → 404. | Mirrors the regenerate-route comment: wrong-role callers get 403, not a resource-derived 404. |
| **Quiz-DELETE guard (advisory)** | `DELETE /api/quizzes/[id]` counts `quiz_sessions` for the quiz **before** deleting; if any exist → **409 `quiz_has_sessions`**. This is a **route-level, advisory guard** — the count-then-delete has a narrow TOCTOU window (a session started between the two round trips would cascade-delete) that is **accepted at demo scale**. A `before delete on quizzes` trigger would close it but would also block class deletion via cascade — deliberately deferred (see §5). | P5 prerequisite; prevents a lecturer accidentally destroying attendance. The guard forces intent; the residual race is a single-round-trip window at demo scale. |
| **No new deps / no env changes** | No new npm deps. `TIMER_GRACE_SEC` already exists (verify, don't add). `lib/sessions/timer.ts` is **100% pure** (grace always an argument; **no `process.env`**) so it can never break a client bundle; it is imported only by server/test code. The client receives a server-computed `initialIndex` and `initialRemainingMs`, never importing `lib/sessions`. | P5 is pure app/DB work; MediaPipe/face/gesture are P6/P7. Keeping `timer.ts` pure avoids the Next client-build env trap. |

---

## 3. Work breakdown

### Step 0 — Prereqs & blockers
1. Docker Desktop up (local Supabase for `gen:types` + verify harnesses + E2E; CI unaffected).
2. Confirm baseline gates green (verified above) before branching.
3. **No env edits.** Confirm `TIMER_GRACE_SEC=5` present in `.env.local.example` + CI writer (it is — don't add it).

### Step 1 — Migration `0008_sessions.sql`
Mirror the house style exactly: idempotent `do $$` enum guard, `create table if not exists public.<t>`, FKs `on delete cascade`, `timestamptz not null default now()`, inline CHECKs, `create index if not exists <t>_<c>_idx`, RLS `enable row level security`, **`revoke all … from anon, authenticated` then `grant select … to authenticated` (not broad)** + `grant all … to service_role`, human-readable quoted policy names, security-definer `set search_path = public`, `revoke execute … from public, anon; grant … to authenticated;` on every RPC, `raise exception '…' using errcode = 'P0001'` / return-jsonb for typed results.

1. **Enum** `public.session_status` = `('active','paused','flagged','completed')` (idempotent guard; `paused`/`flagged` unused until P7 but part of the locked schema).
2. **`public.quiz_sessions`** (per PLAN §1):
   ```sql
   create table if not exists public.quiz_sessions (
     id               uuid primary key default gen_random_uuid(),
     quiz_id          uuid not null references public.quizzes (id) on delete cascade,
     student_id       uuid not null references public.profiles (id) on delete cascade,
     mode             public.quiz_mode not null,
     started_at       timestamptz not null default now(),
     submitted_at     timestamptz,
     score            int check (score is null or score >= 0),
     status           public.session_status not null default 'active',
     face_fail_streak int not null default 0 check (face_fail_streak >= 0),
     face_exempt      boolean not null default false,
     verify_nonce     uuid not null default gen_random_uuid(),
     last_activity_at timestamptz not null default now()
   );
   create index if not exists quiz_sessions_quiz_id_idx    on public.quiz_sessions (quiz_id);
   create index if not exists quiz_sessions_student_id_idx on public.quiz_sessions (student_id);
   create index if not exists quiz_sessions_status_idx     on public.quiz_sessions (status);
   ```
   - `mode` is **copied from the quiz** by the RPC (the only insert path); no direct INSERT policy exists, so a mismatched direct insert is impossible for authenticated users (service_role is trusted).
   - **Partial unique index (the one-attempt guard):**
     ```sql
     create unique index if not exists one_assessment_attempt
       on public.quiz_sessions (quiz_id, student_id) where mode = 'assessment';
     ```
3. **`public.session_answers`**:
   ```sql
   create table if not exists public.session_answers (
     id             uuid primary key default gen_random_uuid(),
     session_id     uuid not null references public.quiz_sessions (id) on delete cascade,
     question_id    uuid not null references public.questions (id) on delete cascade,
     selected_index int check (selected_index is null or selected_index >= 0),
     is_correct     boolean not null,
     answered_at    timestamptz not null default now(),
     unique (session_id, question_id)  -- idempotent answers (no double-count)
   );
   ```
   The `unique (session_id, question_id)` constraint doubles as the session-scoped lookup index (leads with `session_id`). **No `correct_index`/`explanation` columns** — storing them would leak the key through the own-session SELECT policy in assessment.
   > **Grants (privilege-layer intent, not just RLS):** new tables in Supabase inherit broad default privileges, so the migration explicitly does `revoke all on public.quiz_sessions, public.session_answers from anon, authenticated;` before `grant select … to authenticated;` and `grant all … to service_role;`. This makes the **`select`-only** grant real, not just RLS-masked. D47's anon denial asserts **RLS/rows** ("anon reads 0 rows"), not privilege absence.
4. **RLS helper** `public.can_student_view_quiz(p_quiz_id uuid) returns boolean` (security definer, `language sql`, `set search_path = public`):
   ```sql
   select exists (
     select 1 from public.quizzes q
     join public.class_enrollments ce on ce.class_id = q.class_id
     where q.id = p_quiz_id and ce.student_id = auth.uid() and q.status = 'live'
   );
   ```
   Revoke from public/anon, grant to authenticated (house pattern).
5. **`public.student_question_view`** (security_barrier, no `correct_index`, no `explanation`):
   ```sql
   create or replace view public.student_question_view
   with (security_barrier = true)
   as
   select q.id, q.quiz_id, q.order_index, q.type, q.prompt, q.options, q.created_at
   from public.questions q
   where public.can_student_view_quiz(q.quiz_id);
   grant select on public.student_question_view to authenticated;
   ```
   > `created_at` is exposed deliberately so the play page can `ORDER BY order_index, created_at` (P3 convention). Note: `security_barrier` prevents PostgREST from pushing `.eq("quiz_id", …)` under the barrier, so `can_student_view_quiz` runs per row — two index lookups (quizzes PK, class_enrollments PK, both covered) — trivial at demo scale; a comment in the migration records the scale assumption.
6. **RLS on `quiz_sessions`:**
   - Policy **`"Student can view own session or lecturer of quiz"`** (SELECT): `using (student_id = auth.uid() or is_lecturer_of_quiz(quiz_id))` — own sessions (play page) + lecturer (P8 results; D7 cross-student denial).
   - **No INSERT / UPDATE policy** (RPC-only writes). Policy **`"Lecturer can delete session"`** (DELETE): `using (is_lecturer_of_quiz(quiz_id))` (P8 session-reset; harmless now).
7. **RLS on `session_answers`:**
   - Policy **`"Student can view own answers or lecturer of quiz"`** (SELECT): `using (is_session_owner_or_lecturer(session_id))` (helper below).
   - **No INSERT/UPDATE/DELETE policy** (RPC-only writes; students cannot forge answers).
8. **RLS helper** `public.is_session_owner_or_lecturer(p_session_id uuid) returns boolean` (security definer):
   ```sql
   select exists (
     select 1 from public.quiz_sessions s
     where s.id = p_session_id
       and (s.student_id = auth.uid() or public.is_lecturer_of_quiz(s.quiz_id))
   );
   ```
   Revoke/grant house pattern.
9. **RPC `start_quiz_session(p_quiz_id uuid) returns jsonb`** — security definer, `set search_path = public`, return-jsonb (join_class template; **returns** typed errors, never raises for business rules):
   - `auth.uid() is null` → `{error:'not_authenticated'}`.
   - caller not a student (`is_lecturer()` or no profile) → `{error:'not_student'}`.
   - quiz missing / not live → `{error:'quiz_not_live'}` (single error — a draft/closed/nonexistent quiz is indistinguishable to a student, no oracle; D3).
   - not enrolled in the quiz's class → `{error:'not_enrolled'}` (D4).
   - read `q.mode`:
     - **practice**: `perform pg_advisory_xact_lock(hashtext('quiz_start:' || p_quiz_id::text || ':' || auth.uid()::text));` then if a non-terminal session (`status in ('active','paused')`) exists for (quiz, student) → return it (`{session: …}`); else insert `(quiz_id, student_id, mode='practice', status='active')` → return `{session}`.
     - **assessment**: pre-check existing session → if found return `{error:'already_attempted', session_id}`. Else insert; wrap in a `begin … exception when unique_violation then` block that re-reads the existing row and returns `{error:'already_attempted', session_id}` (the partial index closes the concurrent race; D1).
   - Returned session JSON: `id, quiz_id, student_id, mode, status, started_at, submitted_at, score, last_activity_at`.
10. **RPC `answer_question(p_session_id uuid, p_question_id uuid, p_selected_index int) returns jsonb`** — security definer:
    - `auth.uid()` null → `{error:'not_authenticated'}`; caller not a student → `{error:'not_student'}`.
    - **Lock + ownership in one query**: `select s.* from quiz_sessions s where s.id = p_session_id and s.student_id = auth.uid() for update` — missing or non-owned → no row → `{error:'not_owner'}` (single no-oracle 404; a non-owned id is never row-locked, so a guessed foreign id can't contend on the victim's lock).
    - `status <> 'active'` → `{error:'session_not_active'}` (covers paused/flagged/completed; I9b/I10-completed).
    - Quiz: missing or `status <> 'live'` → `{error:'quiz_not_live'}` (lecturer closed mid-session). **Also re-check enrollment**: `if not public.can_student_view_quiz(s.quiz_id) then return {error:'quiz_not_live'} end if;` — a student removed/un-enrolled mid-session cannot keep answering from cached questions (same single error, no oracle).
    - **Timer** (authoritative): `if q.time_limit_sec is not null and clock_timestamp() > s.started_at + (q.time_limit_sec * interval '1 second') + interval '5 seconds'` → `{error:'time_expired'}` (I9/E10).
    - Question: must belong to the quiz (`where id = p_question_id and quiz_id = s.quiz_id`) → else `{error:'invalid_question'}` (I11).
    - `p_selected_index` bounds: **explicitly handle NULL** — `if p_selected_index is null or p_selected_index < 0 or p_selected_index >= cardinality(options)` → `{error:'invalid_selected_index'}` (a direct PostgREST caller could pass NULL; SQL `NULL < 0` is NULL and would slip the guard otherwise).
    - Compute `v_correct := (p_selected_index = correct_index)` reading `correct_index` **server-side only**.
    - **Assessment**: `insert … on conflict (session_id, question_id) do nothing`; `get diagnostics v_rows = row_count`; `v_rows = 0` → re-read the existing row and return `{error:'already_answered', is_correct: existing.is_correct}` (D1b/I10). **Practice**: `insert … on conflict (session_id, question_id) do update set selected_index=excluded.selected_index, is_correct=excluded.is_correct, answered_at=now()` returning `*` — a practice re-answer is always a **200 upsert** and never emits `already_answered` (D9).
    - Update `last_activity_at = now()` on the session.
    - Return (the RPC is the **sole** decider of mode): assessment → `{is_correct}`; practice → `{is_correct, correct_index, explanation}` (`explanation` omitted when null). **Never** `correct_index` in assessment (I7/E11).
11. **RPC `submit_session(p_session_id uuid) returns jsonb`** — security definer:
    - Auth/ownership as in `answer_question`: **lock + ownership in one query** (`where id = p_session_id and student_id = auth.uid() for update`); missing/non-owned → `{error:'not_owner'}` (no-oracle; no foreign-id row-lock contention).
    - **Re-submit idempotency**: `status = 'completed'` → recompute nothing; return `{session, score, total, already_submitted: true}` (I13 — route maps to 409, no score change).
    - `status <> 'active'` → `{error:'session_not_active'}`.
    - **No timer rejection** (deviation, §2): compute `v_score` from `session_answers` (`count(*) where is_correct`), `v_total` = question count for the quiz, set `submitted_at = clock_timestamp()`, `status = 'completed'`, `score = v_score`, `last_activity_at = clock_timestamp()`. Return `{session, score, total}`.
12. Revoke/grant on all three RPCs (revoke from public, anon; grant to authenticated).
13. `npm run gen:types` → commit regenerated `database.ts`. Add `QuizSession`, `SessionAnswer`, `SessionStatus` to `lib/types/aliases.ts` (optional convenience aliases, matching the existing `Quiz`/`Question` pattern — routes may use the generated `Database` types directly, as P3/P4 do; do not churn working code to adopt them).

### Step 2 — `lib/sessions` (pure logic + validation)
- `src/lib/sessions/timer.ts` (**pure, isomorphic, NO `process.env`**):
  - `isWithinTimeLimit({ startedAt, timeLimitSec, graceSec, now })`: `timeLimitSec === null` → true; else `now <= startedAt + (timeLimitSec + graceSec) * 1000`.
  - `computeScore(answers: { is_correct: boolean }[])` → count of `is_correct`.
  - `firstUnansweredIndex(questions, answeredQuestionIds)` → index of first question not in the answered set (or `-1` if all answered). **Server-computed and passed to the client as a prop; the client never imports this module.**
  - `remainingMs({ startedAt, timeLimitSec, serverNow })` → `timeLimitSec === null ? null : startedAt + timeLimitSec*1000 − serverNow` (server computes once; client counts down monotonically to avoid laptop clock skew).
  - This module is a pure **mirror** of the SQL timer used by unit tests and the server component — it is **not** a production enforcement point (the RPC is). Document that in the file header.
- Unit tests `src/lib/sessions/timer.test.ts`: **U-T1** inside limit+grace true / past false (grace=5) · **U-T2** untimed always true · **U-T3** score counts each correct once · **U-T5** boundary: exactly `limit + grace` → within (inclusive) · **U-T6** `firstUnansweredIndex` (all answered → -1; mid-list resume) + `remainingMs` (null for untimed; correct for timed).
- `src/lib/sessions/validation.ts` (Zod):
  - `StartSessionSchema`: `{ quizId: z.string().uuid() }`.
  - `AnswerSchema`: `{ questionId: z.string().uuid(), selectedIndex: z.number().int().min(0) }` (upper bound is enforced **only** by the RPC against the question's options — the route deliberately does not fetch questions, so no misleading "clean 400" pre-check; `invalid_selected_index` from the RPC maps to 400).
  - `SubmitSchema`: `z.object({})` (empty body tolerated).
- Unit tests `src/lib/sessions/validation.test.ts`: U-S1 valid StartSession/Answer/Submit · U-S2 non-UUID quizId/questionId rejected · U-S3 negative/non-int selectedIndex rejected · U-S4 SubmitSchema accepts `{}` (boundary) — the empty-body/invalid-JSON behavior is additionally pinned by route tests.

### Step 3 — Route handlers
All: `export const dynamic = "force-dynamic";`, `params: Promise<…>` awaited (Next 16), `requireStudent` **first**, `isUuid` on path params, `checkSameOrigin(request)` on every state-changing route (AI-route precedent — answer/submit/start are exactly the JSON-POST surface CSRF protects), typed errors only, never raw DB messages. **No `requireSessionStudent` guard is needed**: the RPCs are authoritative (they return `not_owner`/`session_not_active`); routes only map. This removes a second source of truth and a per-answer extra round trip.

- **`POST /api/sessions`** (`src/app/api/sessions/route.ts`):
  - `requireStudent` → `checkSameOrigin` → rate limit `start:${userId}` (limit 10 / 60s) → body parse (invalid JSON → 400) → `StartSessionSchema` (400) → `rpc("start_quiz_session", { p_quiz_id })`.
  - Map RPC typed results: `not_student` → 403 `forbidden`; `quiz_not_live`/`not_enrolled` → **404 `not_found`** (no oracle); `already_attempted` → **409** `{ error: "already_attempted", session_id }` (E5 clean message); transport `error` → 503.
  - Success → **201** `{ session }`.
- **`POST /api/sessions/[id]/answer`** (`src/app/api/sessions/[id]/answer/route.ts`):
  - `requireStudent` → `isUuid(id)` → `checkSameOrigin` → rate limit `answer:${userId}` (limit 120 / 60s) → body parse → `AnswerSchema` → `rpc("answer_question", { p_session_id: id, p_question_id, p_selected_index })`.
  - Map RPC: `not_owner` → 404; `session_not_active` → **409** `{ error: "session_not_active" }` (I9b — paused/flagged/completed all map here, single code); `quiz_not_live` → 409; `time_expired` → **403** `{ error: "time_expired" }` (I9); `already_answered` → **409** `{ error: "already_answered", ...isCorrect }` (**payload passed through, key-mapped only** — `is_correct`→`isCorrect`; the route never synthesizes `correctIndex`/`explanation` and never branches on mode; I10 pins the 409 body); `invalid_question`/`invalid_selected_index` → 400 (I11/I-S14); else 503.
  - Success → 200 with the **RPC payload passed through verbatim** after mechanical key mapping (`is_correct`→`isCorrect`; practice adds `correct_index`→`correctIndex`, `explanation`). The route **never decides** practice vs assessment — the RPC does (I7/I8 pin the shapes; a route test asserts the body is exactly the RPC payload re-keyed, for both 200 and 409 `already_answered`).
- **`POST /api/sessions/[id]/submit`** (`src/app/api/sessions/[id]/submit/route.ts`):
  - `requireStudent` → `isUuid` → `checkSameOrigin` → rate limit `submit:${userId}` (limit 10 / 60s) → `rpc("submit_session", { p_session_id: id })`. **No timer check — deviation, see §2** (a maintainer must not re-add one).
  - Map: `not_owner` → 404; `session_not_active` → 409; `already_submitted` → **409** `{ error: "already_submitted", session, score, total }` (I13); else 503.
  - Success → 200 `{ session, score, total }`.
- **Quiz-DELETE guard** (`src/app/api/quizzes/[id]/route.ts` DELETE):
  - After `requireQuizOwner`, before delete: `supabase.from("quiz_sessions").select("id", { count: "exact", head: true }).eq("quiz_id", id)` → count > 0 → **409** `{ error: "quiz_has_sessions", message: "This quiz has student attempts. Close or reset them before deleting." }`. DB error → 503. **Advisory** (TOCTOU documented in §5).
- Route-handler tests (extend `FakeSupabase` + `makeOwnerContext`):
  - **`FakeSupabase` additions (G3-style, enumerated):** `seedSession(session)` / `seedAnswer(answer)` helpers; `rpc("start_quiz_session", …)` branch modeling real semantics (practice rejoin-or-insert; assessment unique check → `{error:'already_attempted', session_id}`); `rpc("answer_question", …)` branch (assessment conflict → `{error:'already_answered', is_correct}`; practice upsert; **seeded `{error:'time_expired'}` via the `rpcResult` seam for I9** — the fake must NOT re-implement the SQL timer); `rpc("submit_session", …)` branch (idempotent `already_submitted`; score from answers); `rpcResult`/`rpcError` seams for error-mapping branches. Add a header comment to `fake-supabase.ts`: *"Session RPC branches are route-mapping stubs only — they must stay in lockstep with migration `0008_sessions.sql`; the authoritative RPC-semantics checks are `scripts/verify-sessions.mjs` (D-tests)."* (mirrors the existing embedded-join guard comment).
  - **I7** assessment answer happy → `{ isCorrect }` and **no** `correctIndex`/`explanation` in body · **I8** practice answer → `isCorrect` + `correctIndex` (+ `explanation`) · **I9** RPC returns `{error:'time_expired'}` (seeded) → 403 `time_expired` · **I9b** RPC returns `{error:'session_not_active'}` (seeded status) → 409 `session_not_active` · **I10** assessment re-answer → 409 `{ error: 'already_answered', isCorrect }` (payload passed through, no key); practice re-answer → 200 upsert with full practice payload · **I11** RPC `{error:'invalid_question'}` → 400 · **I12** submit happy → 200 `{session, score, total}`, status `completed`, `submitted_at` set · **I13** submit already submitted → 409 `already_submitted`, score unchanged.
  - **I-S1** start student happy → 201 `{ session }` (mode copied) · **I-S2** start assessment already attempted → 409 `already_attempted` + `session_id` · **I-S3** start not-live / not-enrolled → 404 (no oracle) · **I-S4** start as lecturer → 403 · **I-S5** answer as lecturer → 403 · **I-S6** RPC `{error:'not_owner'}` (session not theirs) → 404 · **I-S7** answer invalid body (non-int `selectedIndex`) → 400 · **I-S8** cross-origin answer/start/submit → 403 `invalid_origin` · **I-S9** answer rate limit → 429 (`_seedRateLimit`) · **I-S10** submit as lecturer → 403 · **I-S11** submit RPC `{error:'not_owner'}` → 404 · **I-S12** quiz DELETE with a seeded session → 409 `quiz_has_sessions`; without → 200 · **I-S14** RPC `{error:'invalid_selected_index'}` → 400 · **I-S15** submit with no answers → 200 `{ score: 0, total }`. *(Resume `initialIndex` is owned by unit U-T6 + E2E E4 — not a route test.)*
  - Test-file pattern: follow `ai-routes.test.ts` (static imports, **no `vi.resetModules()`** — the rate-limiter singleton caveat), and **reset `rpcResult`/`rpcError` to `{ data: null, error: null }` in `beforeEach`** (a stale `time_expired` seed from I9 would otherwise leak into I7/I8's happy paths).

### Step 4 — Play page + components
- **`src/app/play/[sessionId]/page.tsx`** (server component, `dynamic = "force-dynamic"`):
  1. Auth: `getUser()` → no user → `redirect("/login")`; profile role must be `student` (lecturer → `redirect("/lecturer/classes")`).
  2. `isUuid(sessionId)` → `notFound()`.
  3. **Four queries with per-query error capture** (`Promise.allSettled` or a small helper returning `{ data, error }` — **not bare `Promise.all`**, so one DB hiccup renders the friendly error panel, not a raw 500):
     - own session: `.from("quiz_sessions").select("id, quiz_id, student_id, mode, status, started_at, submitted_at, score, last_activity_at").eq("id", sessionId).eq("student_id", user.id).maybeSingle()` → missing/not-owned → `notFound()` (no oracle).
     - quiz metadata: `.from("student_quiz_view").select("id, title, mode, status, time_limit_sec").eq("id", session.quiz_id).maybeSingle()` → missing → `notFound()` (quiz not live / not enrolled; covers closed-quiz edge — §5).
     - questions: `.from("student_question_view").select("id, order_index, type, prompt, options, created_at").eq("quiz_id", session.quiz_id).order("order_index", { ascending: true }).order("created_at", { ascending: true })`.
     - own answers (resume, **skipped when `status === 'completed'`** — EndScreen doesn't need them): `.from("session_answers").select("question_id, selected_index, is_correct").eq("session_id", sessionId)`.
  4. Guard: `session.mode !== quiz.mode` → `notFound()` (defensive; the RPC copies mode, direct service-role writes are trusted but this closes drift).
  5. **Degenerate guard:** `questions.length === 0` → render an error panel (should be impossible for a live quiz; prevents a divide-by-zero in the client HUD).
  6. Compute server-side: `initialIndex = firstUnansweredIndex(questions, answeredIds)`, `initialRemainingMs = remainingMs({ startedAt, timeLimitSec, serverNow: Date.now() })`.
  7. Render: `status === 'completed'` → `<EndScreen session={…} quiz={…} />`; else → `<PlayClient sessionId={…} quiz={{ title, mode, timeLimitSec }} questions={…} initialAnswers={…} initialIndex={…} initialRemainingMs={…} />`.
- **`src/components/quiz/play-client.tsx`** (`"use client"`) — the engine:
  - State: `index` (seeded from `initialIndex`), `answers` (`questionId → { selectedIndex, isCorrect, correctIndex?, explanation? }` seeded from `initialAnswers` — note: seeded rows carry only `selectedIndex`/`isCorrect`, no key), `phase: 'question' | 'locked' | 'feedback' | 'submitting' | 'submitted' | 'timeUp'`, `error`/`notice`, `remainingMs` (seeded from `initialRemainingMs`, decremented on a 1Hz interval — **monotonic, no `Date.now()` re-read, never paused during `feedback`/`locked`**, stopped at ≤0 or when untimed).
  - **Answer flow (click-first):** user clicks `OptionCard` → `submitLock.current` guard → POST `/api/sessions/${sessionId}/answer` wrapped in an `AbortController` (~15s) → 409 `already_answered` → render feedback from the payload (`isCorrect` + practice `correctIndex`/`explanation`) then advance; 403 `time_expired` → `timeUp` phase (auto-submit below); 409 `session_not_active` (paused/flagged — P7) → overlay notice; success → store feedback → `phase='feedback'`. **`submitLock.current = false` in `finally`**; on abort/network error, surface a retry (endpoints are idempotent: assessment `already_answered`, practice upsert) or `router.refresh()` to resync.
  - **Next:** "Next" button (practice: show correct/incorrect + `correctIndex` + `explanation`; assessment: quiet "answered" chip only) → advance; after last question → Finish → submit.
  - **Timer (UX only):** when `remainingMs` hits 0 → `timeUp`: **block new answers, `await` any in-flight answer fetch (handle its result), then** POST submit (so the student's last answer isn't silently dropped by the client racing itself). **If the awaited in-flight answer returns 403 `time_expired`, treat it as confirmation** (the client is already in `timeUp` — do not re-enter `timeUp` or show the generic retry overlay); proceed to submit. Server remains authoritative (I9/E10).
  - **Submit:** POST `/api/sessions/${sessionId}/submit` (AbortController ~15s) → 200 or 409 `already_submitted` are both terminal → **render the end state immediately from the response payload** (`{ session, score, total }`) as a fallback, then `router.refresh()` to reconcile with the DB (single source of truth when it lands).
  - Resume: `initialAnswers` pre-fills answered questions (assessment: neutral "answered" chip; practice: correct/incorrect chip — **without** the key/explanation, which are only shown for questions answered in the current page session); engine starts at `initialIndex`.
  - Accessibility fallback stays primary in P5: everything clickable/keystroke-accessible (PLAN §5 — click-first is the phase goal).
- **`src/components/quiz/question-card.tsx`** — prompt + ordered `OptionCard`s (A/B/C/D/E + finger badge placeholder for P6). **`option-card.tsx`** — glassmorphic card, click handler, selected/disabled/feedback states, `role="button"`, keyboard-focusable. **`progress-hud.tsx`** — "Question n/N" + time remaining (reuses the `OcrProgress` hand-rolled bar pattern; no shadcn progress exists). **`end-screen.tsx`** — score (`score / total`), mode-aware message, "Back to quizzes" link (`/student/quizzes`); practice shows "Try again" (start creates a new session — D2); a `role="status"`/`role="alert"` pattern for notices.
- **`src/app/(student)/student/quizzes/student-quizzes-client.tsx`** — add a **Start** button on each live card:
  - POST `/api/sessions` `{ quizId }` → 201 → `router.push(\`/play/${session.id}\`)` — **note: for practice this may be an existing non-terminal session id (rejoin); that is expected, not a bug**; 409 `already_attempted` → if the payload session is still `active`/`paused`, show a **"Resume"** action → `/play/${session_id}` (a student who navigated away mid-assessment can get back in); if `completed`, show "You've already taken this assessment" (E5); 404 → "This quiz is no longer available"; network → error notice. `submitLock` ref + busy state per the house pattern (released in `finally`).
  - **Practice resume nuance:** previously-answered questions on a rejoin render with correct/incorrect chips but **without** the key/explanation (resume feedback loss is accepted — the key is never stored on `session_answers`); questions answered in the current page session get full practice feedback. Document this in the component so nobody "fixes" it into a leak.

### Step 5 — Tests (gate) + fixtures
- Unit + integration per Steps 2–3 (U-T1–U-T3/U-T5–U-T6, U-S1–U-S4, I7–I13, I-S1–I-S12, I-S14–I-S15).
- **`scripts/verify-sessions.mjs`** (live local Supabase; real anon-token clients + service-role admin; extends the proven harness). **This harness — not FakeSupabase — is the sole authoritative check for RPC semantics** (timer, ownership, grading, unique-index behavior). FakeSupabase branches are route-mapping stubs kept in lockstep with 0008:
  - **D1** two **parallel** `rpc('start_quiz_session', …)` calls via `Promise.all` on one student client (the D16/D32/D39 pattern) for an assessment → exactly one row; the other returns `{error:'already_attempted', session_id}`.
  - **D1b** assessment re-answer → `{error:'already_answered'}`; first answer unchanged (verify `is_correct`/`selected_index` intact).
  - **D2** practice → two sequential starts → two distinct sessions; a start while an `active` practice session exists returns the **same** session id (advisory-lock rejoin).
  - **D3** start on a non-live quiz (draft/closed) → `{error:'quiz_not_live'}`.
  - **D4** start on a live quiz in a class the student is not enrolled in → `{error:'not_enrolled'}`.
  - **D7** student A SELECT `quiz_sessions`/`session_answers` → only their own rows; student B's → 0 rows; lecturer reads own quiz's sessions/answers → visible.
  - **D9** practice duplicate answer → upsert (updated `selected_index`/`is_correct`/`answered_at`), one row.
  - **D42 (non-vacuous)** student reads `student_question_view` for a live quiz → **`rows.length === seededCount`** (count derived from the seeded set, e.g. the D19 3-question pattern — not a hard-coded literal) AND **`!('correct_index' in rows[0]) && !('explanation' in rows[0])`** (key-absence checked on the returned object keys, so a `select(*)` regression can't silently leak); owner lecturer reads `questions` → `correct_index` present (D6 stays green).
  - **D43** `answer_question` with `p_selected_index` ≥ options length → `{error:'invalid_selected_index'}` (also cover `NULL` — direct-RPC edge).
  - **D44 (grading pinned against the real DB)** answer Q1 correctly + Q2 incorrectly → assert stored `session_answers.is_correct` per row, `submit_session` returns `score=1, total=N`, and the per-mode jsonb shapes (`{is_correct}` vs `{is_correct, correct_index, explanation}`).
  - **D44b** `answer_question` with a question id from a **different** quiz → `{error:'invalid_question'}`.
  - **D45** **sleep at least `time_limit_sec + 5s + 1s`** (e.g. 6s limit → 12s) before the late `answer_question` call → `{error:'time_expired'}` (absorbs `now()`-vs-`clock_timestamp()` skew and transport); **then submit past deadline → succeeds** (deviation pin; assert the rejected answer did **not** create a `session_answers` row).
  - **D46** lecturer reads own quiz's sessions + answers (P8 prep); a second student cannot read another student's answers; **submit the session first, then call `answer_question` on the same session id** → `{error:'session_not_active'}` (the row-lock serialization, ordering explicit).
  - **D47** raw-anon PostgREST call to `start_quiz_session`/`answer_question`/`submit_session` → denied (execute revoked from anon); **anon SELECT on `quiz_sessions`/`session_answers` → 0 rows (RLS/grants: anon was revoked and holds no select)**. **Note in the harness:** an *authenticated* student can call the RPCs directly and bypass the route-level rate limits — documented acceptance (see §5); the harness asserts the RPCs themselves still enforce role/ownership/timer (D1–D46).
  - **D41 is deliberately NOT in the harness** — a Node Supabase client cannot invoke Next.js route handlers, and at the DB layer the FK is `on delete cascade` (delete succeeds). The quiz-DELETE guard is owned entirely by route test **I-S12** (with/without sessions). Add a one-line comment in the harness explaining this so nobody adds a vacuous D41.
- **E2E (Playwright, real local Supabase, no AI):** **every new spec derives emails from `Date.now()`** (existing pattern — avoids `already registered` on re-runs). Add small helpers to `e2e/helpers.ts` (`createClass`, `joinClass`, `createQuizWithQuestions` — **extracted** from the inlined E1b/E2 patterns; a deliberate refactor to cut duplication; built in this Step before the specs use them).
  - **E4** `e2e/e4-play-practice.spec.ts`: lecturer creates class + **practice** quiz (3 questions, untimed) + publishes; student registers/joins; Start → play page; answers all via clicks (practice shows feedback + `correctIndex`); submits → end screen shows score; **resume sub-case**: **assert Q1's feedback chip is visible (proving the answer POST completed and the client advanced) BEFORE `page.reload()`** → engine resumes at Q2 (not stuck on Q1 `already_answered`); then finishes. **Replay sub-case:** navigate directly to the completed session URL → EndScreen renders (not the quiz).
  - **E5** `e2e/e5-assessment-lock.spec.ts`: **untimed** assessment quiz (so it can't race the client auto-submit); student starts, answers, submits; clicks Start again → clean "already taken" message (no 500); a **second student** in the same class can still start (one-attempt is per student) — and that second student's **own** one-attempt is then also locked (optional next assertion).
  - **E10** `e2e/e10-timer-expiry.spec.ts` — **split into two halves that cannot race** (separate sessions):
    - (a) **API contract half** (deterministic): student starts an assessment with `time_limit_sec=5`; read `started_at` from the **start-session response**; wait until **`started_at + 10s + 2s`** (deadline = `limit + grace` = 10s, plus ≥2s to absorb `now()`→`clock_timestamp()` skew and `page.request` transport — never measured from page load); via Playwright `page.request` POST an answer → assert **403 `time_expired`**; then POST submit → assert **200 `{ session, score: 0, total }`** (the rejected answer was not recorded, so the score is explicitly `0` — late-submit acceptance + late-answer rejection both pinned).
    - (b) **UI half**: a separate short assessment; the client countdown (deadline = `timeLimitSec` only) hits 0 → auto-submit → lands on the EndScreen. **Recommended stance: use `time_limit_sec=10` and assert the student answered ≥1 question before expiry** (EndScreen shows the **answered** score — stronger coverage of the answer→auto-submit path than a zero-answer auto-submit).
  - **E11** `e2e/e11-answer-secrecy.spec.ts` (**assessment only**): `page.on("response")` collect **same-origin text responses filtered by content-type** (`document`, `text/x-component`, `application/json`) **and by URL** (the play page + `/api/sessions/…`) **and only `response.ok()` responses** (error bodies must also be asserted separately — a 409 body that lacks the key would trivially "pass" otherwise); assert **`correct_index` and `explanation` are absent across the entire flow, including the answer response**; assert the assessment answer response contains `isCorrect` but **not** `correctIndex`. (Practice disclosure assertions live in E4, not E11.)
- Update `docs/TESTING.md` (exact, row-level edits):
  - §2.5 (Timer & scoring helpers): add U-T5 (boundary), U-T6 (`firstUnansweredIndex` + `remainingMs`).
  - §2 new subsection **§2.6 Session validation (`lib/sessions`)**: add U-S1–U-S4.
  - §4 (API / Integration): add I-S1–I-S12, I-S14–I-S15 (note I-S12 lives in the existing quiz-route test file, not a new sessions test file).
  - §3 (DB/RLS): add D42–D47 (no D41 — the quiz-delete guard is route-owned; add a **note row, visually distinct from the numbered D-tests**, e.g. "quiz-delete guard → route test I-S12 (DB layer cascades by design)").
  - §5 (E2E): extend the E4 row with the resume + replay sub-cases; add E5/E10/E11 rows (E10 split API/UI).
  - §9 P5 gate row: the gate row gains `U-T5–U-T6, U-S1–U-S4, I-S1–I-S12, I-S14–I-S15, D42–D47` (D-tests are harness-only; the gate row lists them for traceability, matching P4's pattern of wiring new tests into the row).
  - §8 traceability: add rows — one-attempt race (D1/E5), resume (U-T6/E4), timer-authoritative-in-RPC (D45/E10), submit-after-deadline deviation (D45/E10), grading against real DB (D44), answer secrecy end-to-end (D42/I7/E11).
  - Add an explicit line: **U-T4 (abandoned derived state) is a P8 gate; P5 does not implement or test it — `last_activity_at` is schema completeness only.**

### Step 6 — CI + coverage
- `package.json`: `"verify:sessions": "node scripts/verify-sessions.mjs"`.
- `.github/workflows/ci.yml`: add `npm run verify:sessions` after `verify:ai`. **No env-writer change** (`TIMER_GRACE_SEC` already written). **Add a `vitest run --coverage` step** (or document that coverage is a pre-merge local gate) so per-file threshold regressions are caught in CI, not just locally.
- `vitest.config.ts`:
  - Extend `coverage.include` with `"src/lib/sessions/**"` and `"src/app/api/sessions/**"` (include supports globs).
  - Add per-file thresholds using **literal file paths** (v8 per-file keys do **not** support `**` globs — the existing config uses literal keys): `"src/lib/sessions/timer.ts": { lines: 80, statements: 80, functions: 80, branches: 70 }`, `"src/lib/sessions/validation.ts": { lines: 80, statements: 80, functions: 80, branches: 70 }`, `"src/app/api/sessions/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 }`, `"src/app/api/sessions/[id]/answer/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 }`, `"src/app/api/sessions/[id]/submit/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 }`.
  - **Browser-only UI components are excluded from `coverage.include` entirely** (E2E-covered per the P4 precedent comment) — `play-client.tsx`, `question-card.tsx`, `option-card.tsx`, `progress-hud.tsx`, `end-screen.tsx`, and the modified `student-quizzes-client.tsx` get **no per-file keys** (they aren't in the report, so no 0-threshold keys are needed). The existing quiz-DELETE `"src/app/api/quizzes/[id]/route.ts": { lines: 0, ... }` key is **preserved** (I-S12 covers the guard behavior).

### Step 7 — Verification & graph refresh
- `npm run lint` · `typecheck` · `build` · `vitest run` · `vitest run --coverage` · `playwright test` · `verify-security` + `verify-classes` + `verify-quizzes` + `verify-ai` + `verify-sessions` (Docker up).
- `graphify update .` — confirm no new import cycles (expected: `lib/sessions/timer.ts` + `validation.ts` are pure leaves, server/test-only; `play-client.tsx` imports only UI components + `lib/http`-free helpers; nothing client-side imports `lib/sessions`).

### Step 8 — Handoff + master-plan sync
- After execution + audit loop: update `docs/HANDOFF.md` — retitle to **"Phase 5 DONE"**, replace the "How to start Phase 5" section with **"How to start Phase 6"** (gestures, depends on P5), refresh the verified-baseline command list (add `npm run verify:sessions`), refresh the gate list (P5 gates now include U-T5–U-T6/U-S/I-S/D42–D47), and append the P5 commit log. Matches the P4 handoff pattern (`12420d7`).
- **Sync `docs/PLAN.md`** (the master plan is the source of truth and currently contradicts the executed behavior):
  - §2 API table `/api/sessions/[id]/submit` row: drop **"Rejects if past time limit"** — submit is allowed past the deadline (deviation, pinned by D45/E10).
  - §2 enforcement bullet: note the RPC enforces the timer with a **SQL constant grace (`interval '5 seconds'`)**; `TIMER_GRACE_SEC` mirrors it for the client/JS layer only (not an enforcement knob).
  - §1 data-model note: `session_answers` deliberately does **not** store `correct_index`/`explanation` (avoids leaking the key via the own-session SELECT policy in assessment).

---

## 4. Robustness / edge-case matrix

| Area | Guard |
|---|---|
| One-attempt race | Partial unique index `one_assessment_attempt` + RPC `unique_violation` catch → typed `already_attempted` (D1/E5); practice rejoin under a per-(quiz,student) advisory lock (D2). |
| Answer idempotency | `UNIQUE(session_id, question_id)`; assessment `ON CONFLICT DO NOTHING` + `GET DIAGNOSTICS` → `already_answered` (returns existing `is_correct`), first answer unchanged (D1b/I10); practice upsert (D9). |
| Answer/submit race | `select … for update` on the session row in both RPCs (consistent lock order: session first, never cross-locked) → per-session serialization; a late answer after submit → `session_not_active` 409 (D46). |
| Server timer | Authoritative in `answer_question` (SQL constant 5s grace, **not** caller-supplied; `clock_timestamp()` so lock-wait counts) → 403 via route (I9/E10); submit past deadline allowed (deviation pinned D45/E10); client countdown is UX-only, seeded server-side (no laptop clock skew), never paused mid-question. |
| Answer secrecy | `student_question_view` omits `correct_index` + `explanation` (D42 asserts row count + key-absence on object keys); assessment answer returns `isCorrect` only (I7/E11); `correct_index`/`explanation` never stored on `session_answers` (no leak via own-session SELECT); no client question-fetch API (RSC payload is the only channel, view guarantees columns don't exist). |
| Forged answers | RPC-only writes (no INSERT/UPDATE policy on `session_answers`; `select`-only grant after `revoke all`); `is_correct` computed server-side from `correct_index` (D44); `selected_index` bounds-checked incl. NULL (D43/I-S14). |
| Forged session writes | No UPDATE policy on `quiz_sessions`; `select`-only grant (after `revoke all`); all writes via RPCs that re-check `auth.uid()` + ownership (lock + ownership in one query — a guessed foreign session id is never row-locked). |
| Direct PostgREST RPC abuse | Every RPC re-validates role/ownership/status/timer/enrollment; execute revoked from anon/public (D47); grace never an argument; NULL `selected_index` handled (D43). **Accepted limitation:** authenticated direct RPC calls bypass the route-level rate limits (in-memory, per-process) — documented in §5; DB-backed throttling is post-demo. |
| AuthZ | `requireStudent` first on all session routes (lecturer → 403, I-S4/I-S5/I-S10); no-oracle single `not_owner` → 404 (I-S6/I-S11); quiz delete blocked when sessions exist (I-S12). |
| CSRF / abuse | `checkSameOrigin` on start/answer/submit (I-S8); per-user rate limits (start 10/min, answer 120/min, submit 10/min — I-S9). |
| Resume after refresh | Play page fetches own answers → server computes `initialIndex`; client starts at first unanswered; `already_answered` returns the existing payload so the client renders feedback and advances (E4 resume sub-case). |
| Mid-quiz close / removal | `answer_question` rejects `quiz_not_live` once the quiz leaves `live` or the student is no longer enrolled (`can_student_view_quiz`); play-page quiz fetch uses `student_quiz_view` (live-only) → refresh 404s — documented edge, P8 "abandoned" covers it. |
| Empty/deleted quiz mid-session | FK cascade deletes sessions when the quiz is deleted (guarded by the route-level delete-block when sessions exist — advisory TOCTOU accepted); publish guard guarantees ≥1 question; play page guards 0 questions defensively. |
| Mode drift | Play page asserts `session.mode === quiz.mode` (defensive `notFound()`); RPC copies mode at start (only insert path). |
| Duplicate submit | `submit_session` idempotent; route maps re-submit → 409 `already_submitted` with existing score (I13); client renders end state from payload + `router.refresh()` reconcile (no refresh-only dead-end). |
| In-flight answer at deadline | Client `timeUp` blocks new answers and **awaits** the in-flight answer before submitting — the student's last answer is not silently dropped; a 403 `time_expired` from the awaited answer is treated as confirmation, not an error. |
| Hung fetch | answer/submit wrapped in ~15s `AbortController`; `submitLock` released in `finally`; idempotent endpoints make retry safe. |
| Input handling | Zod at the boundary (UUIDs, int ≥ 0, `{}` submit); invalid JSON → 400; non-UUID path params → 404; DB/RPC errors → 503 typed, never raw. |
| RLS cross-student | `quiz_sessions` SELECT self-or-lecturer; `session_answers` SELECT via `is_session_owner_or_lecturer` (D7). |
| Performance | Play page: 4 parallel RLS queries with per-query error capture; `last_activity_at` per answer is one cheap indexed write inside the already-open transaction; answer rate limit 120/min covers 30 questions with retries. |
| `security_barrier` per-row helper cost | `can_student_view_quiz` runs per row under the barrier (filter can't be pushed) — two covered index lookups per row; trivial at demo scale, comment in migration records the assumption. |

---

## 5. Risks / open items

- **Grace dual-source (SQL constant vs env):** `answer_question` hardcodes `interval '5 seconds'`; `TIMER_GRACE_SEC` (env, default 5) already exists but only mirrors it for the JS layer (which is not a production enforcement point). Changing grace requires a migration. Accepted for demo scale; documented in the RPC comment and **PLAN.md is updated in Step 8 so the master doc no longer implies env is the enforcement knob.**
- **Mid-quiz close → play-page 404 on refresh:** `student_quiz_view` is live-only, so a student refreshing after the lecturer closes a quiz gets `notFound()` (their session becomes "abandoned" in P8). The running client continues and the answer RPC returns `quiz_not_live` 409. Accepted; revisit in P8 if a softer screen is needed.
- **Quiz-DELETE guard is advisory (TOCTOU):** count-then-delete is two round trips; a session started in between cascade-deletes. Narrow window at demo scale. A `before delete on quizzes` trigger would close it but **would also block class deletion via cascade** (a class with a taken quiz becomes undeletable) — deliberately deferred; revisit with P8's session-reset flows. **Class deletion still cascades sessions** (orphans attendance) — a P8 item, out of P5 scope (the P5 prerequisite only covers quiz delete).
- **Mid-session removal / un-enrollment:** `answer_question` re-checks `can_student_view_quiz` (enrolled + live), so a student removed from the class mid-session cannot keep answering from client-cached questions; their running client gets `quiz_not_live` 409 and a refresh 404s. Accepted (documented; a lecturer who wants to stop an in-flight attempt can also close the quiz).
- **Per-question `isCorrect` in assessment** is returned per PLAN §2 (student sees right/wrong live). Not an answer-key leak (the correct index is never returned), but noted as a deliberate product decision.
- **Direct PostgREST RPC abuse is unthrottled:** authenticated students can call `start_quiz_session`/`answer_question`/`submit_session` directly, bypassing the route-level in-memory rate limits. The RPCs still enforce role/ownership/status/timer (D1–D46), so this is abuse-surface (spam), not integrity. Accepted at demo scale; DB-backed throttling is post-demo (noted in SECURITY_AUDIT future-work).
- **In-memory rate limiter is per-process** (P2 caveat): session-route budgets multiply by instance count. Accepted at demo scale; documented.
- **`verify_nonce`/`face_fail_streak`/`face_exempt` columns** are created now (locked schema) but consumed in P7; P5 never reads/writes them beyond defaults. No dead code — schema completeness, not logic.
- **`student_quiz_view` vs `quiz_sessions` mode consistency** relies on the RPC copy; direct service-role inserts could drift (trusted). Play page asserts equality defensively.
- **Resume feedback loss:** on refresh, previously-answered questions show correct/incorrect without the key/explanation (not stored on answers to avoid leaking the key in assessment). Accepted UX trade-off; fresh answers in the current page session get full feedback. Practice Start rejoin returns the existing non-terminal session id — expected, not a bug (documented in the Start button).
- **E2E timing:** E10's API half waits ~12s past start but is deterministic (anchored to `started_at`, driven via `page.request`); the UI half uses 10s with a guaranteed answered question. Kept in a dedicated spec so fast E4/E5 don't slow.
- **Plan drift:** none — stack/env align with PLAN.md (Next 16.3.0, Supabase, no new deps, no env changes).

---

## 6. Gate traceability

| Gate | Proven by |
|---|---|
| U-T1–U-T3 (timer/score) | `src/lib/sessions/timer.test.ts` (+ U-T5–U-T6) |
| D1 / D1b / D2–D4 / D7 / D9 | `scripts/verify-sessions.mjs` (live DB, real tokens; D1 via `Promise.all`) |
| I7–I13 (answer/submit routes) | `src/app/api/sessions/**/__tests__/*.test.ts` (+ I-S1–I-S12, I-S14–I-S15; I-S12 is the quiz-delete guard in the quiz-route test file) |
| E4 (practice click-first + resume + replay) | `e2e/e4-play-practice.spec.ts` |
| E5 (assessment one-attempt lock) | `e2e/e5-assessment-lock.spec.ts` |
| E10 (timer expiry) | `e2e/e10-timer-expiry.spec.ts` (API half: 403 + late-submit 200 with `score: 0`; UI half: auto-submit → EndScreen) |
| E11 (answer secrecy) | `e2e/e11-answer-secrecy.spec.ts` |
| D6 / D5 (owner reads key; answer secrecy on read) | existing verify-quizzes D5/D6 stay green; D42 extends |
| Earlier gates stay green | CI re-runs verify:security/classes/quizzes/ai + full vitest + Playwright |
| New: D42–D47, I-S1–I-S12, I-S14–I-S15, U-T5–U-T6, U-S1–U-S4 | `verify-sessions.mjs`, route tests, unit tests, E2E; quiz-delete guard owned by I-S12; resume `initialIndex` owned by U-T6 + E4 |

---

## 7. Review findings incorporated (audit trail)

> Audit scope: four generic-explorer subagents (security / testing / robustness-efficiency / clean-code) reviewed this plan in iteration 1, then a focused security + testing + clean-code re-audit in iteration 2. Populated below; see §8 for the final state.

**Iteration 1 findings incorporated (grouped):**

1. **Timer module env trap (High, robustness)** — `lib/sessions/timer.ts` must be 100% pure (`graceSec` always an argument, **no `process.env`**); the client must never import it. Server computes `initialIndex`/`initialRemainingMs` and passes them as props. *(Fixed: §2, Step 2, Step 4.)*
2. **E10 untestable through the UI (High, testing/robustness)** — the client auto-submits at `timeLimitSec`, so the server's 403 `time_expired` is unreachable via the UI (and the auto-submit raced the grace window). Split E10 into a deterministic API half (`page.request`, anchored to `started_at`) + a UI half (auto-submit → EndScreen). E5 uses an **untimed** assessment. *(Fixed: Step 5 E10, E5.)*
3. **Client auto-submit races an in-flight answer (High, robustness)** — `timeUp` must block new answers and **await** the in-flight answer before submitting. *(Fixed: Step 4.)*
4. **No client timeout / `submitLock` release (High, robustness)** — answer/submit wrapped in ~15s `AbortController`; lock released in `finally`; idempotent retry. *(Fixed: Step 4.)*
5. **Play page bare `Promise.all` → raw 500 (High, robustness)** — per-query error capture + friendly panel; 0-question guard. *(Fixed: Step 4.)*
6. **FakeSupabase vs real RPC fidelity never declared (High, testing)** — `verify-sessions.mjs` is the sole authority for RPC semantics; fake branches are route-mapping stubs with a lockstep header comment. *(Fixed: Step 3, Step 5.)*
7. **D41 unverifiable in a Node harness (High, testing)** — a Supabase client can't hit route handlers; at the DB layer delete cascades. D41 removed from the harness; the guard is owned by route test I-S12. *(Fixed: Step 5.)*
8. **Coverage gate vacuous for P5 (High, testing)** — vitest coverage `include` lacks `lib/sessions/**` + `app/api/sessions/**`; thresholds added; browser UI components E2E-covered (P4 precedent). *(Fixed: Step 6.)*
9. **Quiz-DELETE TOCTOU (Med, security/robustness)** — advisory route guard + documented acceptance; trigger deferred due to class-delete cascade side effect. *(Fixed: §2, Step 3, §5.)*
10. **Answer response re-shaped by the route (Med, security)** — removed `requireSessionStudent` from routes; the RPC is the sole practice-vs-assessment decider; route passes the payload through (snake→camel). *(Fixed: §2, Step 3.)*
11. **Direct PostgREST RPC rate-limit bypass (Med, security)** — documented acceptance; RPCs still enforce integrity; D47 + §5 note. *(Fixed: §5, Step 5 D47.)*
12. **Broad grants would grant writes (Med, security)** — `select`-only for `authenticated` (with `revoke all` first) + full `service_role`. *(Fixed: Step 1.)*
13. **`now()` vs `clock_timestamp()` (Low, security)** — use `clock_timestamp()` so row-lock wait counts against the deadline. *(Fixed: Step 1.)*
14. **`created_at` missing from `student_question_view` (Low→Med, clean/testing)** — added to the view so `.order("created_at")` works. *(Fixed: Step 1, Step 4.)*
15. **D42 vacuous (Med, testing)** — assert row count + key-absence on object keys. *(Fixed: Step 5 D42.)*
16. **Real-DB grading unverified (Med, testing)** — D44 answers a known correct+wrong mix and asserts stored `is_correct` + score + per-mode shapes; D44b `invalid_question`. *(Fixed: Step 5.)*
17. **Missing negatives (Med, testing)** — I-S15 (submit with 0 answers → score 0), replay-completed → EndScreen (E4), answer-after-submit → `session_not_active` (D46). *(Fixed: Step 3/4/5.)*
18. **E11 brittle (Med, testing)** — filter by content-type + URL + `response.ok()`, assert across the whole assessment flow (incl. answer response); practice disclosure stays in E4. *(Fixed: Step 5 E11.)*
19. **`already_answered` carries no payload (Med, robustness)** — RPC returns the existing row's payload (`is_correct` + practice key/explanation). *(Fixed: Step 1.)*
20. **Practice double-click double-insert (Med, robustness)** — per-(quiz,student) advisory lock in `start_quiz_session` + client submitLock/busy. *(Fixed: Step 1, Step 4.)*
21. **Clock skew (Med, robustness)** — server-computed `initialRemainingMs`, monotonic client countdown, never paused mid-question, stopped at ≤0/untimed. *(Fixed: Step 2/4.)*
22. **Submit refresh-only dead-end (Low, robustness)** — render end state from the submit payload immediately, then `router.refresh()`. *(Fixed: Step 4.)*
23. **Env drift: `TIMER_GRACE_SEC` already exists (High, clean)** — removed all "add to env/CI" instructions. *(Fixed: §1, §2, Step 0, Step 6.)*
24. **Route error map had dead `session_not_found` (Med, clean)** — removed; single `not_owner`. *(Fixed: Step 3.)*
25. **Two 409 codes for completed-answer (Med, clean)** — single `session_not_active` for answer; `already_submitted` reserved for submit re-submit. *(Fixed: §2, Step 3.)*
26. **§2 "both the RPC and the route enforce" stale (Med, clean)** — reworded: RPC enforces, route maps. *(Fixed: §2.)*
27. **Submit deviation missing cross-ref in Step 3 (Med, clean)** — added "no timer check — deviation, see §2". *(Fixed: Step 3.)*
28. **`requireSessionStudent` under-specified + extra round trip (Med, clean/robustness)** — removed entirely; RPCs authoritative. *(Fixed: §2, Step 3.)*
29. **RLS policy names not enumerated (Low, clean)** — named (`"Student can view own session or lecturer of quiz"`, etc.). *(Fixed: Step 1.)*
30. **TESTING.md updates vague (Med, clean)** — made row-level exact (incl. new §2.6, I-S12 file placement, P5 gate row content). *(Fixed: Step 5.)*
31. **HANDOFF update missing (Med/High, clean)** — added Step 8. *(Fixed: Step 8.)*
32. **U-T6 "assert callers" doc-as-test (Low, testing)** — dropped; D45 is the deviation pin; U-T6 is now `firstUnansweredIndex`/`remainingMs`. *(Fixed: Step 2.)*
33. **U-T4 (abandoned) deferral (Low, testing)** — explicit "P8 gate, not P5; `last_activity_at` is schema completeness". *(Fixed: Step 5.)*
34. **D1 concurrency mechanism (Low, testing)** — explicit `Promise.all` (D16/D32/D39 pattern). *(Fixed: Step 5.)*
35. **I9 timer reimplementation in fake (Low, testing)** — seed `{error:'time_expired'}` via the seam; the SQL timer is D45's job. *(Fixed: Step 3.)*
36. **snake→camel mapping not explicit (Med, clean)** — made explicit in Step 3. *(Fixed: Step 3.)*
37. **`explanation` null handling (Low, clean)** — omitted when null. *(Fixed: Step 1.)*
38. **Skip answers fetch when completed (Low, robustness)** — added. *(Fixed: Step 4.)*

**Iteration 2 re-audit (focused security + testing + clean-code):** all previously-raised High/Med items were verified present in the body; no new Critical/High findings. New Low/Med items from this pass were folded in: `already_answered` payload passthrough (assessment returns `isCorrect`; route never synthesizes the key — I10 pins the 409 body) · practice re-answer is a 200 upsert (`already_answered` is assessment-only) · privilege-layer grants (`revoke all` before `grant select`) · lock+ownership in one query (no foreign-id row-lock contention) · enrollment re-check in `answer_question` · NULL `selected_index` handling · `started_at`/`clock_timestamp` skew margins in E10(a) + D45 (sleep `limit+grace+1s`) · E10(a) explicit `score: 0` · E10(b) explicit 10s-and-answer stance · E11 `response.ok()` filtering · E4 feedback-chip-before-reload · D42 seeded-count + key-absence on object keys · `rpcResult`/`rpcError` reset in `beforeEach` · literal per-file threshold paths (v8 has no `**` in per-file keys) · UI components excluded from coverage include (no 0-threshold keys) · CI coverage step · I-S13 removed (resume owned by U-T6 + E4) · D41 note-row not a numbered D-test · `already_attempted` Resume action for active assessments · `PLAN.md` §2 submit/grace sync + `session_answers` non-storage note (Step 8) · HANDOFF §6 cross-ref fixed.

---

## 8. Execution & audit-fix log (post-approval)

> This section records what was actually built and the audit→fix cycles that hardened it. Populated after approval + execution, matching the P3/P4 pattern.

### 8.1 Executed (as approved)

- **Migration `0008_sessions.sql`** — exact house style (idempotent enum guard, `create table if not exists`, FKs `on delete cascade`, inline CHECKs, named RLS policies, security-definer `set search_path = public` RPCs, revoke/grant on every RPC). `session_status` enum; `quiz_sessions` + `session_answers` (no `correct_index`/`explanation`); partial unique index `one_assessment_attempt`; helpers `can_student_view_quiz` / `is_session_owner_or_lecturer`; `student_question_view` (security_barrier, no key); RPCs `start_quiz_session` / `answer_question` / `submit_session`; `revoke all` → `select`-only for `authenticated` + full `service_role`.
- **`src/lib/sessions/`** — `timer.ts` (100% pure, no `process.env`; `isWithinTimeLimit`/`computeScore`/`firstUnansweredIndex`/`remainingMs`) + `validation.ts` (Zod). Unit tests U-T1–U-T6, U-S1–U-S4 (24 tests).
- **Routes** — `POST /api/sessions`, `POST /api/sessions/[id]/answer`, `POST /api/sessions/[id]/submit`, quiz-DELETE guard. Route tests I7–I13, I-S1–I-S12, I-S14–I-S15 (35 tests). `FakeSupabase` gained session RPC stubs (route-mapping only) + `seedSession`/`seedAnswer` + lockstep header comment.
- **Play screen** — `src/app/play/[sessionId]/page.tsx` + `src/components/quiz/` (`play-client`, `question-card`, `option-card`, `progress-hud`, `end-screen`). Start button in `student-quizzes-client.tsx`.
- **`scripts/verify-sessions.mjs`** — 18 checks (D1/D1b/D2–D4/D7/D9/D42–D47). **`verify:sessions`** npm script + CI step + `vitest run --coverage` step.
- **`vitest.config.ts`** — coverage include + literal per-file thresholds for `lib/sessions/**` + `app/api/sessions/**`.
- **E2E** — `e4-play-practice.spec.ts` (resume + replay), `e5-assessment-lock.spec.ts`, `e10-timer-expiry.spec.ts` (API + UI halves, separate students/lecturers so they can't race), `e11-answer-secrecy.spec.ts`. Helpers `createClass`/`joinClass`/`createQuizWithQuestions` extracted.
- **Docs** — `TESTING.md` (U-T5/U-T6, §2.6 U-S1–U-S4, D42–D47 + route-owned note, I-S1–I-S12/I-S14–I-S15, E4/E5/E10/E11 rows, P5 gate row, traceability, U-T4 P8 note), `PLAN.md` (submit deviation, SQL-constant grace, session_answers non-storage), `HANDOFF.md` retitled Phase 5 DONE.

### 8.2 Gate results (pre-audit)

`lint` 0/0 · `typecheck` clean · `vitest run` 303/303 (24 files) · `vitest run --coverage` thresholds pass · `verify:security` 3/3 · `verify:classes` 21/21 · `verify:quizzes` 42/42 · `verify:ai` 16/16 · `verify:sessions` 18/18 · `playwright test` 13/13 · `build` succeeds.

### 8.3 Audit → fix cycles

> Audit scope: graphify graph refresh + four focused explorer subagents (code style / security / efficiency-robustness / test coverage). Findings below; each cycle re-runs graphify + gates.

**Cycle 1 findings incorporated (see §8.5 for final state):**

Security:
1. **No CSRF on quiz/classes write routes (Medium)** — `checkSameOrigin` was added to ALL state-changing quiz routes (PATCH/DELETE, publish, reorder, questions POST/PATCH/DELETE) and the classes routes (create, rename, delete, quiz-create, join) — matching the AI/session-route precedent, placed after the ownership guard and before any body parse/state change. *(Fixed.)*
2. **`verify_nonce` readable by the student via own-session SELECT (Medium→assessed OK)** — the SELECT policy exposes the student's own row incl. `verify_nonce`. Assessed: self-knowledge of one's OWN current nonce does NOT defeat P7's anti-replay (the nonce rotates on every successful verify; a replay carries the OLD nonce and is rejected; a student can't forge another's session_id+nonce). No schema change at P5; documented for P7 defense-in-depth (`student_session_view` projection).
3. **Quiz-DELETE TOCTOU (Low)** — accepted at demo scale (plan §5); the route comment documents it. Optionally closable with a conditional-DELETE CTE.
4. **Assessment `already_answered` returns `is_correct` (assessed OK)** — first-answer-wins means a student can't benefit from the oracle; `is_correct` is the designed assessment feedback (D45/E11 pin "no key/explanation").
5. **Rate limiter per-process / direct-RPC bypass (Low)** — accepted (plan §5), RPCs still enforce integrity (D1–D46).
6. **Dead `isWithinTimeLimit`/`computeScore` mirrors + `graceSec` magic (Low)** — documented in `timer.ts` as test fixtures only; the SQL constant is authoritative.
7. **`created_at` in `student_question_view` (verified OK)** — deliberate ordering column, leaks nothing.

Robustness/efficiency:
8. **`submitNow()` double-submit could strand the UI (High)** — added `if (submitLock.current) return;` at the top of `submitNow()`; a double-click Finish now bails instead of firing two POSTs and overwriting `submitted` with `question`.
9. **403 `time_expired` during `handleTimeUp` double-submitted (Low)** — the 403 branch now captures `alreadyTimeUp = phaseRef.current === "timeUp"` before re-entering and only calls `submitNow()` when not already in timeUp; `handleTimeUp`'s own submit runs after the awaited promise.
10. **`timeUp` auto-submit failure stranded the student (Medium)** — `timeUp` phase now renders an enabled **"Retry submit"** button; `session_not_active`/`quiz_not_live` render a `dead` phase with a "Back to quizzes" CTA instead of a non-actionable interactive question.
11. **Non-JSON 200 misread as `{}` → fabricated isCorrect=false / score 0 (Medium)** — answer + submit now shape-validate the success body (`typeof body.isCorrect === "boolean"` / `typeof body.score === "number" && typeof body.total === "number"`) and surface an error instead of fabricating feedback.
12. **Completed-replay 404 after quiz close (Medium)** — `student_quiz_view` is live-only, so a completed session's EndScreen 404s once the quiz is closed. Accepted edge documented for P8 (when the results dashboard exists); P5's §4 matrix already lists it.
13. **Client crash on empty questions (Low)** — added a defensive render guard after all hooks (rules-of-hooks safe).
14. **Countdown drift under tab throttling (Low)** — graceful (server authoritative; stale answer → 403 → auto-submit). Left as-is.
15. **`progress-hud` 30s magic literal (Low)** — named `WARNING_THRESHOLD_MS`.

Test coverage:
16. **`not_owner` route tests false-green (High→verified)** — the fake DOES enforce ownership via `student_id`, so I-S6/I-S11 genuinely drive the `not_owner` branch. Confirmed by coverage (answer route now 100%).
17. **E11 error bodies never asserted (High)** — E11 now captures error bodies separately, forces a REAL 409 `already_answered` via `page.request` (using Q1's real id captured from the UI's own answer POST body), and asserts the 409 body has `isCorrect` but NO `correctIndex`/`correct_index`/`explanation`; all captured error bodies are key-free.
18. **D42 `select(*)` regression (Medium)** — added a `select("*")` key-absence check (explicit-column selects would mask a view-column regression).
19. **Uncovered branches: `quiz_not_live` 409, submit `session_not_active` 409, unknown-payload 503 (answer+submit), start/submit 429, start invalid JSON, start `not_enrolled` 404, practice rejoin (Medium/Low)** — added route tests for all; `app/api/sessions` coverage now **100% stmts / 95.8% branches / 100% funcs / 100% lines**.
20. **Coverage gate not printing `lib/sessions` (High→assessed OK)** — the files ARE in the v8 HTML/JSON reports at 100% and the per-file thresholds are enforced by vitest; the console table truncation is cosmetic (verified by the re-audit subagent).

Style:
21. **Mojibake + BOM in play-client/e2e specs/vitest.config (Low)** — re-encoded all files to clean UTF-8 (no BOM), replacing the double-encoded em-dashes/arrows (user-visible "Time's up — submitting your answers." is now correct).
22. **Dead-but-plan-mandated exports (`SubmitSchema`, `isWithinTimeLimit`, `computeScore`)** — documented in header comments as test-only by design.
23. **Duplicate nullable-view row types (Low)** — added the "generated view types are nullable" comment in `play/page.tsx` (matching `student-quizzes/page.tsx`).
24. **`AnswerState` exported from a client component (Low)** — accepted (type-only import, tree-shaken); noted for a shared types module if it grows.
25. **Quiz-card raw-seconds display (Low)** — optional polish; left as-is.

### 8.4 Verification matrix (re-run after any change)

```bash
npm run lint && npm run typecheck && npx vitest run && npx vitest run --coverage
node scripts/verify-security.mjs && node scripts/verify-classes.mjs && node scripts/verify-quizzes.mjs
node scripts/verify-ai.mjs && node scripts/verify-sessions.mjs
npx playwright test && npm run build
graphify update .
```

### 8.5 Final state

Audit loop converged after **1 full cycle + 1 focused re-audit** (security + test verification). No Critical/High findings remain.

Final gate results:
- `lint` 0/0 · `typecheck` clean · `vitest run` **313/313** (22 files) · `vitest run --coverage` thresholds pass (`app/api/sessions` 100% stmts/95.8% branches/100% lines; `lib/sessions` 100%)
- `verify:security` 3/3 · `verify:classes` 21/21 · `verify:quizzes` 42/42 · `verify:ai` 16/16 · `verify:sessions` **19/19**
- `playwright test` **13/13** (E1a/E1/E1b/E2/E2b/E2c + E4/E5/E10a/E10b/E11) · `build` succeeds · `graphify update` clean (943 nodes, no import cycles)

Accepted/documented (plan §5 + §8.3): submit-after-deadline deviation (D45/E10), quiz-DELETE TOCTOU, per-process rate limiter + direct-RPC bypass, resume feedback loss, `verify_nonce` self-read (P7 rotation design), completed-replay-404-after-close (P8), E2E timing (E10 API half sleeps ~12s).

# PLAN — Gesture Toggle OFF + `short_text` (AI-marked) — v5.0 SHIPPED

> **Status: IMPLEMENTED AND VERIFIED.** This document describes the system as
> built. It was originally drafted (v4.9) with a second new question type,
> `ordering` (drag-sort), which was **cut before implementation** — it did not
> make the cut. Every trace of it is removed from this text so the spec matches
> the code; the historical critic rounds that produced the surviving design are
> summarised in §10, where the tag IDs the migration headers cite are preserved.
>
> **Scope shipped:** quiz-level `gestures_enabled` toggle + `short_text`
> (AI-marked) + the two-phase AI marking pipeline + lecturer override + skip
> affordance + the practice oracle guard. Multi-select cap stays 4 (finger 5 is
> palm-commit).
>
> **Verification (all green at handover):** 2350 unit tests / 126 files;
> `tsc --noEmit` clean; `eslint` clean; 6 pgTAP suites / 150 assertions
> (repeatable and order-independent); Playwright 176 tests, 174 passed + 2
> skipped, 0 failed, 0 flaky; `check:i18n` 1373/1373 parity; `next build` clean.
>
> **Bugs this plan's verification found and fixed** (worth knowing, because each
> was invisible to the type system): an AB-BA deadlock between `sweep_ai_marks`
> and `finalize_ai_mark`; `PATCH /api/quizzes/[id]` silently dropping
> `gesturesEnabled`; the builder sending `options: [""]` for `short_text`; five
> routes writing `questions` on the user client after 0054 revoked it; the
> EndScreen pending banner rendering on mobile only; and practice-mode
> `short_text` showing a red ✗ for an answer that was never graded.

## 0. Decisions (non-negotiable)

| # | Decision | Why |
|---|----------|-----|
| D1 | Multi cap stays 4. Zod per-type: mcq 2..5, multi 2..4, TF exactly 2, short_text 0 options. DB CHECK keeps the legacy arms byte-identical and adds only the short_text arm. The builder blocks a 5th multi option always. | Finger 5 = palm-commit/next. A 5th option breaks the gesture bijection. |
| D2 | REVOKE the table SELECT first, then grant explicit columns. `answer_key` and every mark column are reachable ONLY through barrier views, never a base-table grant. | A column REVOKE under a table grant is a no-op (the 0048 lesson: `ACLMASK_ANY` satisfies every column read). |
| D3 | Pending = `is_correct=false` + `mark_status TEXT + CHECK`. TEXT+CHECK rather than an enum because workflow state churns; the house enums are stable domain values. | Avoids a split-migration per state addition. |
| D4 | Submit-with-exclusion + recompute. Override suppresses notifications: the only trigger side effect it can cause is the reveal transition, and `app.mark_overridden` is read by the `quiz_reveal_once` replacement (§5) to permit a non-null→NULL re-publish. Override never stamps `submitted_at`/`last_activity_at`. | Override is adjudication, not submission. |
| D5 | Exact DROP arity, then re-REVOKE/GRANT (a fresh function body defaults to PUBLIC EXECUTE), plus `NOTIFY pgrst, 'reload schema'`. | A missing GRANT is a silent 401; a stale PostgREST cache is a 404 on the new args. |
| D6 | `enabled=false` = prop-drill + in-effect gates, with no early return before a `useEffect`. The quiz flag wins over any user setting. | Hooks order, plus camera/token leaks. |
| D7 | `questions.max_score NUMERIC DEFAULT 1 CHECK (max_score = 1)` — the structure is reserved, the value is locked. `quiz_sessions.score` becomes NUMERIC, with `coerceScore` at every consumer. | One NUMERIC column plus a helper beats forked INT and partial columns. |
| D8 | `0051_enum_growth.sql` contains ONLY the `ADD VALUE` and zero uses. Every consumer lives in `0052`. | Supabase applies one file per transaction, and Postgres forbids USING an enum value added in the same transaction. |
| D9 | `gestures_enabled` is draft-frozen like `shuffle_questions` (`hasNonWindowFields` → a live PATCH is a 409). The create route maps `?? true`, NOT `?? false`. | Prevents a mid-live modality desync. The `true` default is deliberate: gestures have been ON for every quiz since the feature shipped, so defaulting them off would silently strip the modality from every new quiz (whereas shuffle's `false` is correct because enabling it *changes* what a student sees). |
| D10 | EVERY score recompute (submit, seal, override, the `already_submitted` re-read) uses `SUM(COALESCE(mark_score, CASE WHEN is_correct THEN 1 ELSE 0 END))` filtered by `mark_status <> 'pending'`. | A bare `count(*) WHERE is_correct` awards 1 to a 0.5 mark (since `is_correct = p_mark >= 0.5`), so the two arithmetics diverge after ANY half mark. One arithmetic everywhere. |
| D11 | Practice mode keeps the scalar types only: `student_questions_no_new_types CHECK (type IN ('mcq','true_false'))`. Practice `short_text` is out of scope for v1, and there is NO AI spend path in practice. | Practice has instant feedback and no spend budget. The CHECK is deliberately redundant with the pre-existing `student_quiz_questions_no_multi_select` — the redundancy is the point, because the student authoring RPCs cast to the shared enum and a direct RPC call must not mint a row the player cannot answer. |
| D12 | The sweep is TWO-PHASE: `sweep_ai_marks()` (SQL, cron) CLAIMS under `FOR UPDATE SKIP LOCKED`, sets `status='marking'`, and COMMITS (releasing locks). `marking-worker.ts` (server-only TS) processes ONLY the rows its `claim_token` matches, does the model HTTP call and Zod parse OUTSIDE any transaction holding answer/session locks, then calls `finalize_ai_mark(...)`, which re-checks the epoch and claim token and writes the marks plus the score recompute in ONE short transaction. Escalation of exhausted rows is a SEPARATE RPC, `escalate_stale_marks()`. | plpgsql can neither call HTTP nor run Zod, and holding row locks across a 45s model call would stall every student answer and submit (both take `quiz_sessions FOR UPDATE`). A single-function design is incoherent; a mid-body COMMIT is impossible, so escalation cannot share the claim's transaction or its locks. |
| D13 | **All three ledger writers share one advisory leaf lock**, `hashtext('ai_mark_sweep')`. | The sweep locks `quizzes` before its ledger rows while the finalizer writes ledger rows before its `quizzes` locks, so the pair is AB-BA and Postgres kills one caller. This was reproduced live; the shared lock serialises them instead. |

Stable testids (frozen — grep `e2e/` before renaming any): `gestures-toggle`
(builder Switch — E-57), `skip-question` (question-phase action zone — E-56),
`short-text-input` (QuestionCard textarea — E-54), `pending-banner` (EndScreen —
E-55), `needs-review-row` (EndScreen row — E-55), `override-mark-dialog`
(lecturer override dialog — D-30).

## 1. Baselines (ground truth)

| Object | File:line |
|---|---|
| `question_type` birth | `supabase/migrations/0004_quizzes.sql:22-28` |
| `questions` table + options CHECK 2..5 | `0004:51-62` (a CHECK cannot subquery `0004:49-50` → trigger pattern) |
| `is_lecturer_of_quiz(uuid)` | `0004:70-85` |
| `append_question` v1 | `0004:432-493` |
| `quiz_sessions.score INT` | `0008:39` |
| `session_answers` birth | `0008:62-70` |
| `answer_question(uuid,uuid,int)` | `0008:302-450` |
| `submit_session(uuid)` | `0008:458-551` (`count WHERE is_correct` at `:517-519`) |
| `clone_quiz(uuid,uuid)` | `0046:444` (last live revision; the 0035 body was superseded) |
| enum growth precedent (multi_select) | `0036` — a whole single-`ADD VALUE` file |
| multi consumers, DROP 3-arg `:403`, DROP append `:477` | `0037` (guard `:69`, answer `:173`, save `:486`, results `:696`, clone `:782`) |
| `ai_generation_usage` precedent (RLS deny-all + service-role) | `0028:148-157` |
| crons: retention `0019:812`, notifications `0022:779`, autoclose `0030:126`, silence/prune `0042:295,305` | — |
| `assign_seal_score()` + WHEN `(new.score IS NULL)` | `0045:1122-1152` |
| `submit_session` re-live | `0045:1263` |
| lock-order guard | `0048:953-955` (completed_all BEFORE reveal) |
| column-privilege fix; `resume_grace_until` deliberately omitted | `0048:1039-1101`, `:1081-1083` |
| NUMERIC coercion sites | `gradebook.ts`, `export.ts`, `export-workbook.ts` (raw `s.score` cell write), `end-screen.tsx`, `play-client.tsx`, `src/app/api/classes/[id]/gradebook-export/route.ts`. `insights.ts` has NO score code (a pure delegator to the export model) and is covered transitively. |
| Live RPC signatures (0055 drops these exact arities) | `answer_question(uuid,uuid,int,int[])` (sole live body **0037:173** — 0045 never redefines it, so do not copy a body lacking the 0030 window gates + the 0037 multi branch), `append_question(uuid,question_type,text,text[],int,text,int[])` (0045:1463), `clone_quiz(uuid,uuid)` (0046:444), `submit_session(uuid)` (0045 re-live) |
| `questions_correct_shape` CHECK (rejects new-type inserts today) | `0037:49-55`; `questions_multi_option_cap` `0037:59-61` (subsumed by the new options CHECK) |
| Views selecting `s.score` (block ALTER TYPE) | `student_session_view` 0012:88-99, `lecturer_session_view` (last redefined 0044) |
| `results_revealed_at` + `quiz_reveal_once` | column on `quizzes` (0012:20); one-way trigger 0012:56-70 |
| Reveal sites | submit `v_all_done` arm 0045:1391-1403; `quiz_autoclose` reveal arm 0048:842-857; digest arm 0048:873-903; `notify_session_terminal` completed-count 0048:990-1006 |
| `student_results` practice branch `count(is_correct)` | `0046:1181-1183` (D10 applies) |
| shuffle / rate-limit / http | `src/lib/sessions/shuffle.ts` (pure, client-safe), `src/lib/classes/rate-limit.ts`, `src/lib/http.ts` (`rateLimited()`, `checkSameOrigin`), health `EXPECTED_JOBS` = **7** (`src/app/api/health/route.ts`) |
| E-ID registry | `e52-qr-join.spec.ts` was the last pre-existing spec; the new specs use the hyphenated `E-53`..`E-58` style |

## 2. Migrations (numeric order, one concern each)

**FS-1: filenames MUST be `NNNN_name.sql`.** The Supabase CLI accepts only
`^([0-9]+)_(.*)\.sql$` and SKIPS non-matching files with a warning and exit 0 —
so a `0054a_...` style name would apply nothing while `db push` reported
success. Verified against the pinned CLI.

File plan: 0051 enum growth · 0052 question shape · 0053 views + score type ·
0054 privileges · 0055 RPC reshape · 0056 lifecycle · 0057 ledger + sweep ·
0058 override · 0059 cron · 0060 views + lecturer view. D8's split requirement
(the enum `ADD VALUE` in its own file/transaction) is satisfied by 0051/0052.

- **`0051_enum_growth.sql`** — ONLY:
```sql
ALTER TYPE public.question_type ADD VALUE IF NOT EXISTS 'short_text';
```

- **`0052_question_shape.sql`** — columns, then CHECKs (legacy arms verbatim,
  new arms only):
```sql
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS gestures_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS answer_key TEXT;
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS max_score NUMERIC NOT NULL DEFAULT 1 CHECK (max_score = 1);
ALTER TABLE public.questions
  ALTER COLUMN options SET DEFAULT '{}'::text[];
ALTER TABLE public.session_answers
  ADD COLUMN IF NOT EXISTS answer_text TEXT CHECK (char_length(answer_text) <= 500);
ALTER TABLE public.session_answers
  ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.session_answers
  ADD COLUMN IF NOT EXISTS mark_status TEXT NOT NULL DEFAULT 'marked'
  CHECK (mark_status IN ('pending','marked','needs_review','failed'));
ALTER TABLE public.session_answers
  ADD COLUMN IF NOT EXISTS mark_score NUMERIC
  CHECK (mark_score IS NULL OR mark_score IN (0, 0.5, 1));  -- defense-in-depth
ALTER TABLE public.session_answers
  ADD COLUMN IF NOT EXISTS marked_at TIMESTAMPTZ;
ALTER TABLE public.session_answers
  ADD COLUMN IF NOT EXISTS attempt_version INT NOT NULL DEFAULT 1;
ALTER TABLE public.session_answers
  ADD COLUMN IF NOT EXISTS mark_metadata JSONB; -- AI rationale (plain text) + confidence
```
```sql
ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_options_check;
ALTER TABLE public.questions ADD CONSTRAINT questions_options_check CHECK (
    (type = 'mcq' AND cardinality(options) BETWEEN 2 AND 5)
    OR (type = 'true_false' AND cardinality(options) = 2)
    OR (type = 'multi_select' AND cardinality(options) BETWEEN 2 AND 4)
    OR (type = 'short_text' AND cardinality(options) = 0));
-- C1: 0037:49-55 questions_correct_shape requires correct_index IS NOT NULL on
-- every non-multi row, so a short_text insert fails on the FIRST row. DROP +
-- recreate three-way; questions_multi_option_cap (0037:59-61) is subsumed by
-- the multi arm above and therefore dropped.
ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_correct_shape;
ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_multi_option_cap;
ALTER TABLE public.questions ADD CONSTRAINT questions_correct_shape CHECK (
    (type = 'multi_select' AND correct_index IS NULL AND correct_indices IS NOT NULL)
    OR (type IN ('mcq','true_false') AND correct_index IS NOT NULL AND correct_indices IS NULL)
    OR (type = 'short_text' AND correct_index IS NULL AND correct_indices IS NULL));
ALTER TABLE public.questions ADD CONSTRAINT questions_short_text_shape CHECK (
  type <> 'short_text' OR cardinality(options) = 0);
ALTER TABLE public.questions ADD CONSTRAINT questions_answer_key_shape CHECK (
  type <> 'short_text' OR (answer_key IS NOT NULL
  AND char_length(trim(answer_key)) BETWEEN 1 AND 500));
ALTER TABLE public.session_answers ADD CONSTRAINT session_answers_pending_shape CHECK (
  mark_status <> 'pending' OR (is_correct = false AND mark_score IS NULL));
ALTER TABLE public.session_answers ADD CONSTRAINT session_answers_skip_shape CHECK (
  skipped = false OR (selected_index IS NULL AND selected_indices IS NULL
  AND answer_text IS NULL));
ALTER TABLE public.student_quiz_questions ADD CONSTRAINT student_questions_no_new_types
  CHECK (type IN ('mcq','true_false'));  -- D11
```

  **`options` stays `NOT NULL`.** The 0004 column is `text[] NOT NULL` with a
  2..5 CHECK. Only the CHECK has to give (it is type-blind); the NOT NULL does
  NOT — the convention for `short_text` is the EMPTY ARRAY, and
  `SET DEFAULT '{}'` plus the `cardinality(options) = 0` arm ENFORCES that
  convention rather than merely documenting it. The alternative (dropping NOT
  NULL) would type every reader as `string[] | null` and push a null branch
  into ~50 call sites for a case that cannot legitimately occur.
  `selected_index`/`selected_indices` are already nullable (0008:66), so skip
  needs no ALTER. Also: extend `questions_correct_indices_guard` for
  short_text's NULL keys, and have `clone_quiz` copy `gestures_enabled`,
  `answer_key` and `max_score`.

- **`0053_views_score.sql`** — C2: `ALTER TYPE` on a view-referenced column is
  42P16, and both session views select `s.score`. In THIS file: DROP
  `student_session_view` + `lecturer_session_view` → **FS-2: also DROP TRIGGER
  `quiz_sessions_seal_score`** (0045:1145-1152 declares `BEFORE UPDATE OF
  status, score ... WHEN (new.score is null)`, and Postgres rejects
  `ALTER COLUMN ... TYPE` when the column appears in a trigger's UPDATE-OF list
  or WHEN expression — dropping only the views aborts the migration) →
  `ALTER COLUMN score TYPE NUMERIC USING score::numeric` → re-CREATE both views
  verbatim (same column order, `security_barrier`, every appended column
  preserved) → re-GRANT both to `authenticated`. The seal trigger is recreated
  in 0056 immediately after the recreated `assign_seal_score()` (FS-2: a bare
  `DROP FUNCTION assign_seal_score()` in 0055 fails under the trigger's NORMAL
  dependency, and CASCADE would silently destroy seal scoring, the
  `app.session_sealing` GUC and seal-mail suppression).

- **`0054_privileges.sql`** — the §3 SQL verbatim (base tables only — the
  `ai_marking_ledger` GRANT lives in 0057 where the table is created, C3) plus
  `NOTIFY pgrst, 'reload schema'`.

- **`0055_rpc_reshape.sql`** — DROP the exact LIVE arities (C5: an earlier draft's
  list was stale; every enumerated creation was verified — `answer_question`
  0008→0012→0030 3-arg then 0037 4-arg [0037 drops the 3-arg]; `append_question`
  0004/0016 6-arg then 0037:408/0045:1463 7-arg [0037 drops the 6-arg];
  `clone_quiz` always `(uuid,uuid)`; `submit_session` always `(uuid)`;
  `student_results` 0012/0028/0037/0046 always `(uuid)` — no stray overloads):
```sql
DROP FUNCTION IF EXISTS public.answer_question(uuid, uuid, int, int[]);        -- live: 0037:173
DROP FUNCTION IF EXISTS public.append_question(uuid, public.question_type, text, text[], int, text, int[]); -- live: 0045:1463
DROP FUNCTION IF EXISTS public.clone_quiz(uuid, uuid);
DROP FUNCTION IF EXISTS public.submit_session(uuid);
DROP FUNCTION IF EXISTS public.student_results(uuid);   -- S5: rebuild carries the new-type/pending fields
DROP FUNCTION IF EXISTS public.assign_seal_score();     -- D10 rewrite + NUMERIC v_score
-- D2-5: wrapped as DO $$ BEGIN IF EXISTS(...) THEN RAISE EXCEPTION 'stale arity'; END IF; END $$;
-- AFTER the DROPs and BEFORE the CREATEs.
CREATE OR REPLACE FUNCTION public.answer_question(
  p_session_id uuid, p_question_id uuid, p_selected_index int DEFAULT NULL,
  p_selected_indices int[] DEFAULT NULL, p_answer_text text DEFAULT NULL,
  p_skipped boolean DEFAULT false)
RETURNS jsonb ...
-- 6-arg. Grading per type: mcq/TF/multi unchanged; short_text:
--   mark_status='pending', is_correct=false, mark_score NULL (pending_shape holds),
--   and a ledger row queued with idempotency_key '{session}:{question}:1' (epoch 1).
--   skip (p_skipped): skipped=true, every answer field NULL (skip_shape), graded
--   mark 0 with mark_status='marked'; terminal in assessment (S11); ALL existing
--   gates verbatim (ownership 0008:333-339, liveness/timer, first-answer-wins).
--   A5-5: the PRACTICE upsert branch (live body 0037:173, practice upserts at
--   0037:305-309/370-374) must reset skipped=false, answer_text=NULL,
--   mark_score=NULL, mark_status='marked' in its ON CONFLICT DO UPDATE — it
--   previously wrote only selected_index/is_correct/answered_at, so a practice
--   re-answer after a skip would raise session_answers_skip_shape (23514).
CREATE OR REPLACE FUNCTION public.append_question(
  p_quiz_id uuid, p_type public.question_type, p_prompt text, p_options text[],
  p_correct_index int DEFAULT NULL, p_explanation text DEFAULT NULL,
  p_correct_indices int[] DEFAULT NULL, p_answer_key text DEFAULT NULL,
  p_max_score numeric DEFAULT 1)
RETURNS public.questions ...
-- student_results(uuid), submit_session(uuid), clone_quiz(uuid,uuid): same arity as live.
-- D5: EVERY recreated function is re-REVOKEd from public/anon and re-GRANTed —
-- FIVE to authenticated (answer_question 0037:405, append_question 0045:1546,
-- clone_quiz 0035:163, submit_session 0045:1455, student_results 0037:777) and
-- assign_seal_score to service_role only; a fresh body defaults to PUBLIC EXECUTE.
```
  The recreations carry window/seal/locks verbatim. Per D10 every scoring line
  becomes the pending-filtered mark_score SUM. `submit_session` changes:
  the `v_all_done` predicate (0045:1391) additionally requires zero pending
  answers quiz-wide (L4), and the `already_submitted` branch (0045:1311-1345
  returns the STORED score today — C5-7: no recompute exists, so this plan ADDS
  one) recomputes with the D10 SUM while keeping the unrevealed → `score:null`
  arm verbatim (L10). `student_results`' JSON gains the per-row
  `mark_status`/`mark_score`/`skipped`/`answer_text`/`attempt_version` keys
  (reveal-gated exactly as today's keys are) plus a quiz-level `pending_count`
  (L6/S5). **A7-3: `v_score` is declared NUMERIC in ALL THREE recreated
  bodies** — the live bodies declare `v_score int` (0045:1271 submit,
  0046:1141 student_results, 0045:1131 seal). D10's SUM is NUMERIC and a
  numeric→int4 assignment cast ROUNDS (0.5 + 1.0 → 2), silently corrupting
  exactly the recompute paths D10 exists to protect.

- **`0056_lifecycle.sql`** (D2-2) — `CREATE OR REPLACE` (NOT drop)
  `quiz_autoclose()` and `notify_session_terminal()` with the pending terms,
  bodies otherwise verbatim (FS-2: both have NORMAL trigger dependencies from
  0022/0030/0048, so a DROP fails RESTRICT or CASCADE-destroys the triggers):
  the `quiz_autoclose` reveal arm (0048:842-857) and digest arm (0048:873-903)
  each gain the zero-pending term (L4/L5); `notify_session_terminal`'s
  completed-count (0048:990-1006) excludes sessions with pending answers (L5).
  Plus the recreated `assign_seal_score()` (D10 SUM body + `v_score NUMERIC`),
  the re-CREATE of trigger `quiz_sessions_seal_score` (FS-2) with the
  0045:1145-1152 body verbatim, and FS-8: `quiz_status_transition`'s
  `quiz_not_draft_edit` freeze list (0034:97) gains
  `NEW.gestures_enabled IS DISTINCT FROM OLD.gestures_enabled`.

- **`0057_ledger.sql`** — the `ai_marking_ledger` DDL, `check_mark_spend()`,
  `sweep_ai_marks()`, `escalate_stale_marks()`, `finalize_ai_mark()`,
  `recheck_quiz_completion()`, `student_pending_count()`, and the pg_net guarded
  DO block (§6).

- **`0058_override.sql`** — the §5 override RPC, its audit row, the GUC wiring,
  and the `quiz_reveal_once` replacement (C6/L1).

- **`0059_cron.sql`** — TWO guarded schedules: sweep 1-min + escalate 5-min
  (A7-1), sharing the `ai_mark_sweep` leaf lock. That namespace is NEW and LEAF
  — the sweep additionally acquires `quiz_completed_all:<quiz>` for the digest
  re-check, in the same order as the trigger, so "disjoint" would be the wrong
  word; the escalate job shares the leaf lock and is therefore serialised
  against the sweep, never concurrent with it.

- **`0060_views_rich.sql`** — S5: `CREATE OR REPLACE` (append columns LAST,
  never reorder or drop) for **`student_quiz_view` +
  `student_closed_revealed_quiz_view`** (+`gestures_enabled` — FC-1),
  **`student_answers_view`** (+`answer_text` and `skipped` UNGATED; `mark_status`
  and `mark_score` reveal-gated; `attempt_version`), **`lecturer_answers_view`**
  (owner predicate, every new column full), **`student_question_view`**
  (`has_image` preserved; NO keys of any kind), **NEW
  `lecturer_questions_view`** (S3/D2-16: predicate
  `public.is_lecturer_of_quiz(quiz_id)` — `quizzes` has NO `lecturer_id` column,
  ownership is `classes.lecturer_id` via the 0004:70-85 helper; FULL columns
  including `correct_index, correct_indices, explanation, image_path,
  answer_key`), and **`lecturer_session_view`** (+`pending_count` appended LAST —
  A5-11). Re-GRANT each after the replace.

  **FS-12 is the subtle gating call:** `answer_text` is UNGATED in
  `student_answers_view`. It is the student's OWN answer, not an oracle (unlike
  `mark_score`, whose `>= 0.5` equivalence to `is_correct` makes it a verbatim
  pre-reveal answer key). Gating it would break pre-reveal resume of an answered
  `short_text`. `skipped` is ungated for the same reason: it records that the
  student pressed Skip, not what the right answer was.

View rule: append new columns LAST via `CREATE OR REPLACE` (+re-GRANT), never
reorder or drop. `clone_quiz` copies every new question column.

## 3. Privileges (REVOKE first — order matters)

```sql
REVOKE SELECT ON public.questions FROM authenticated;
GRANT SELECT (id, quiz_id, order_index, type, prompt, options, created_at, max_score)
  ON public.questions TO authenticated;
-- answer_key is NEVER base-granted: it is the rubric, so a student who could
-- read it could write a perfect answer with no understanding.
-- C7/S3: lecturer-only columns go through the NEW owner-predicated view, not
-- the base grant — students have RLS deny on questions today, but the column
-- grant is the seal; do not widen it.
REVOKE SELECT ON public.session_answers FROM authenticated;
GRANT SELECT (id, session_id, question_id, selected_index, selected_indices,
  skipped, answered_at)
  ON public.session_answers TO authenticated;
-- S1 BLOCKER: mark_score/mark_status/marked_at/answer_text/attempt_version are
-- NEVER base-granted. Students own RLS SELECT on session_answers (0008:155-158),
-- and `mark_score >= 0.5` ⇔ is_correct is a verbatim pre-reveal answer-key
-- oracle — the exact leak 0048:1039-1101 closed.
REVOKE SELECT ON public.quiz_sessions FROM authenticated;
GRANT SELECT (id, quiz_id, student_id, mode, started_at, submitted_at, status,
  face_fail_streak, face_exempt, verify_nonce, last_activity_at,
  face_unavailable_at, paused_at, focus_pause_count, fullscreen_pause_count,
  face_fail_count, hand_pause_count, last_pause_reason,
  face_verify_attempted_at, attempt)
  ON public.quiz_sessions TO authenticated;
GRANT ALL ON public.questions TO service_role;
GRANT ALL ON public.session_answers TO service_role;
GRANT ALL ON public.quiz_sessions TO service_role;
NOTIFY pgrst, 'reload schema';
```
- `resume_grace_until` stays omitted (0048:1081-1083 — no client reads it).
- **NEW `lecturer_questions_view`** (0060, S3/D2-16): owner-predicated via
  `public.is_lecturer_of_quiz(quiz_id)`, with FULL columns including
  `correct_index, correct_indices, explanation, image_path, answer_key`.
  Migrate every lecturer surface that reads base `questions` today (else 403):
  builder `page.tsx`, results `page.tsx` (both files), insights
  `load-insights.tsx`, export `export/route.ts`, quiz-delete `quizzes/[id]/route.ts`,
  the question image/delete routes, the question update/delete route's reads and
  RETURNING, `import-questions/route.ts`, `results/[sessionId]/page.tsx`,
  `gradebook/page.tsx`, `classes/[id]/gradebook-export/route.ts` (selects
  correct_index/correct_indices/explanation — the CSV export breaks otherwise;
  R3-M1), and `quizzes/[id]/duplicate/route.ts` (selects `image_path`; the
  fail-closed branch would otherwise null every cloned image silently — R3-M1).
  **Writes stay on the base table** (the view is read-only) and run on
  `createAdminClient()` — the AI routes (`generate-quiz`,
  `regenerate-question`), the duplicate image phase, the question
  image attach/remove, and the question PATCH/DELETE all write `questions`
  and therefore need the service-role client once 0054 revokes the table.
  This was the single most error-prone part of the migration: six call sites
  failed at runtime with 42501 until each was moved, and only E2E caught them.
- `answer_key/answer_text/mark_score/mark_status/marked_at/attempt_version/
  mark_metadata` are NEVER base-granted — barrier views only:
  `lecturer_answers_view` (owner predicate, full), `student_answers_view`
  (owner; `answer_text`/`skipped` ungated, `mark_status`/`mark_score`
  reveal-gated — S1), `student_question_view` (explicit columns + `has_image`,
  never keys), `student_results()` (definer JSON, reveal-gated per §2),
  `student_pending_count()` (definer, own-session, NOT reveal-gated — FS-4).
- **Audit gate (E-60):** a `select *` scan over `src/**` must return zero hits
  on these tables, and every migrated lecturer surface must select from
  `lecturer_questions_view` — diff the column lists, not just `*` (S3). Scope
  the gate to USER-scoped clients; a service-role read is not a leak.
  Verified clean at handover.

## 4. Scores (NUMERIC + coerce, pending excluded, ONE arithmetic)

- Helper in `src/lib/results/derive.ts`:
```ts
export function coerceScore(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
```
  `quiz_sessions.score` became NUMERIC in 0053, and PostgREST serialises NUMERIC
  as a STRING — so a bare `typeof v === "number"` reads every score as null.
  `null`/`undefined` → null; non-finite or unparseable → null (never NaN, which
  would propagate into a percent and render "NaN%").
- Coerce at every consumer: gradebook, export, export-workbook (the coerced
  value into the raw cell write), EndScreen, play-client, gradebook-export
  route. `insights` is covered transitively.
- Aggregation: D10 — every scoring function uses
  `SUM(COALESCE(mark_score, CASE WHEN is_correct THEN 1 ELSE 0 END))`
  `WHERE mark_status <> 'pending'`. Sites: `submit_session` (including the
  `v_all_done` and `already_submitted` recomputes), `assign_seal_score`,
  `student_results` (BOTH mode branches — the practice branch also switches to
  the SUM so a legacy 0.5 override survives), `lecturer_session_view`,
  gradebook/export/EndScreen. Pending contributes 0; `pending_count` is exposed
  through `student_results` and rendered in EndScreen and the export.
- **Denominator rule (L9/X2-6):** the EndScreen percent divides by
  `total - pending_count` (the RESOLVED denominator); the ring label shows
  `score / resolved`; a skipped question counts as resolved with 0; and
  `resolved = 0 → percent null`. The gradebook uses the SAME resolved
  denominator per representative session — `buildGradebookModel` gains
  `pendingCount`, percent = `score / (questionCount - pendingCount)`, and the
  cross-quiz cumulative sums resolved denominators. Pending cells render a
  neutral "pending" chip, never 0. Export cells: pending → a neutral "pending"
  label, skipped → the `play.skip.skipped` label (via the `tFor` absolute key —
  X2-9), never blank or red (L11/L6).
- The `already_submitted` recompute keeps the
  `mode='assessment' AND NOT v_revealed → score:null` arm verbatim (L10 — the
  recompute must not leak a provisional score).
- **Reveal gating (L4):** `v_all_done` (0045:1391) requires zero pending
  quiz-wide, and the `quiz_autoclose` reveal arm gains the same term — a quiz
  with unresolved pending marks is never auto-revealed. `notify_session_terminal`'s
  completed-count and the `quiz_autoclose` digest arm exclude sessions with
  pending answers; the sweep's finalize step re-runs BOTH the digest check and
  the `v_all_done` reveal check per quiz after resolving marks, so a
  pending-only-last-completion fires later (L5/X2-7) and the reveal completes
  once the whole class resolves.

## 5. Override (full spec)

```sql
CREATE OR REPLACE FUNCTION public.override_answer_mark(
  p_session_id UUID, p_question_id UUID, p_mark NUMERIC, p_reason TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_quiz uuid; v_max numeric; v_count int;
BEGIN
  SELECT quiz_id INTO v_quiz FROM public.quiz_sessions WHERE id = p_session_id;
  IF NOT FOUND OR NOT public.is_lecturer_of_quiz(v_quiz) THEN
    RETURN jsonb_build_object('error','not_owner'); END IF;
  IF p_mark IS NULL OR p_mark NOT IN (0, 0.5, 1) THEN
    RETURN jsonb_build_object('error','invalid_mark'); END IF;      -- C9: NULL bypasses NOT IN
  IF p_reason IS NULL OR char_length(trim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RETURN jsonb_build_object('error','reason_required'); END IF;
  PERFORM set_config('app.mark_overridden','on',true);
  -- C8/D2-6: lock SESSIONS first, then answers — the same order submit/answer
  -- use (0008:480-483, 0045:1288-1292). An earlier draft locked `sa` via
  -- FOR UPDATE OF in the membership check BEFORE the session lock, which left
  -- the AB-BA in place; fixed by moving the membership check BELOW the lock.
  PERFORM 1 FROM public.quiz_sessions WHERE id=p_session_id FOR UPDATE;
  -- C10: the question must belong to THIS quiz AND have an answer row here;
  -- otherwise a foreign UUID is an oracle and a miss is a silent ok:true no-op.
  SELECT q.max_score INTO v_max FROM public.questions q
    JOIN public.session_answers sa ON sa.question_id = q.id
   WHERE q.id = p_question_id AND q.quiz_id = v_quiz
     AND sa.session_id = p_session_id
   FOR UPDATE OF sa;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;
  IF p_mark > v_max THEN RETURN jsonb_build_object('error','mark_exceeds_max'); END IF;
  UPDATE public.session_answers SET mark_score=p_mark, mark_status='marked',
    is_correct=(p_mark >= 0.5), marked_at=clock_timestamp(),
    attempt_version=attempt_version+1
    WHERE session_id=p_session_id AND question_id=p_question_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN RETURN jsonb_build_object('error','not_found'); END IF;  -- C10
  UPDATE public.quiz_sessions s SET score=(
    SELECT COALESCE(SUM(COALESCE(mark_score, CASE WHEN is_correct THEN 1 ELSE 0 END)),0)
    FROM public.session_answers WHERE session_id=s.id AND mark_status <> 'pending')
    WHERE id=p_session_id;
  -- D2-7/D2-8: re-publish INSIDE the same txn while the GUC is live (the GUC is
  -- transaction-local; a second call would throw reveal_once_only).
  UPDATE public.quizzes SET results_revealed_at=NULL
   WHERE id=v_quiz AND results_revealed_at IS NOT NULL;
  INSERT INTO public.audit_events(actor_id,subject_id,action,metadata) VALUES
    (auth.uid(), p_session_id, 'override_answer_mark',
     jsonb_build_object('quiz_id',v_quiz,'question_id',p_question_id,'mark',p_mark,
                        'reason',left(trim(p_reason),500)));
  RETURN jsonb_build_object('ok',true);
END; $$;
REVOKE EXECUTE ON FUNCTION public.override_answer_mark(uuid,uuid,numeric,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.override_answer_mark(uuid,uuid,numeric,text) TO authenticated;
```
- No `submitted_at`/`last_activity_at` stamp. **Re-publish path (C6/L1):**
  `results_revealed_at` lives on **quizzes** (0012:20) and `quiz_reveal_once`
  (0012:56-70) rejects ANY change from non-null — including →NULL. 0058 replaces
  the trigger with a version that permits the non-null→NULL transition ONLY when
  `current_setting('app.mark_overridden', true) = 'on'` (the D4 consumer); the
  override RPC performs the NULL write in the same transaction while the GUC is
  live (D2-7). The UI surfaces "re-publish required", and the lecturer then
  re-reveals through the existing reveal route, which only ever writes
  null → value — safe.
- Last-writer-wins on a concurrent fresh reveal is accepted and documented; the
  notify trigger re-fires safely on a re-publish (0022's unique-nulls-not-distinct
  dedupe key).
- An idempotent 60s replay digest
  `override:<session>:<question>:<mark>:<reason_hash>` lives in the per-process
  rate-limit map (S10: a replay across pods is benign — the recompute is
  deterministic and `attempt_version` is the override epoch, L8).
- The gradebook keeps its representative-session read (`started_at DESC, id DESC`).

## 6. AI worker + ledger + cron

`src/lib/ai/marking-worker.ts` is NEW, `import "server-only"`, service-role only,
never imported by an island; RSC reads go through views/RPCs; no `after()`.

```sql
CREATE TABLE IF NOT EXISTS public.ai_marking_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.quiz_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  attempt_version int NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL UNIQUE,
  tokens int NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  usd NUMERIC NOT NULL DEFAULT 0 CHECK (usd >= 0),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  claimed_at TIMESTAMPTZ,   -- FS-3 lease: crashed-worker recovery (re-claim >5min)
  claim_token uuid,         -- A5-1: the worker processes ONLY its own claim's rows
  day date NOT NULL DEFAULT CURRENT_DATE,  -- the CLAIM sets day=CURRENT_DATE (A7-5)
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','marking','marked','needs_review','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ai_marking_ledger_sweep_idx
  ON public.ai_marking_ledger (status, created_at)
  WHERE status IN ('queued','failed','marking');  -- A5-10/A6-3: covers the lease arm
ALTER TABLE public.ai_marking_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_marking_ledger FROM anon, authenticated;
GRANT ALL ON public.ai_marking_ledger TO service_role;  -- C3: HERE, not in 0054
```
- `idempotency_key` = `'{session_id}:{question_id}:{attempt_version}'` (S10/L8:
  `attempt_version` is the override epoch, so a retry within an epoch reuses the key).
- **`check_mark_spend(p_quiz uuid)`** (C15 — definer, ledger read): returns
  `{ok:true}` or `{error:'mark_rate_limited'}`, reading `SUM(tokens), SUM(usd)`
  from the ledger for `day = CURRENT_DATE` against caps of 50k tokens / $5, and
  failing CLOSED on any exception. The read is race-free because every caller
  holds the `quizzes` row `FOR UPDATE`; the cap is nonetheless a **bounded
  overrun**, not exact, because tokens are known only after the model call
  (S12/D2-15/FS-9: concurrent claims can overshoot by up to `LIMIT 10` calls).
- **Phase 1 — claim (`sweep_ai_marks()`, 0057):** `SECURITY DEFINER`, service-role
  execute only. Advisory leaf lock `ai_mark_sweep`; then the per-quiz `quizzes
  FOR UPDATE` locks (spend re-check) BEFORE the ledger rows, so the claim matches
  the pinned order `quizzes → quiz_sessions → session_answers → ledger`
  (A7-6/FINAL-audit). The claim predicate has THREE arms — `queued AND attempts < 3`,
  `failed AND attempts < 3`, and `marking AND claimed_at < now() - 5 min AND
  attempts < 3` — ordered by `created_at` with `FOR UPDATE SKIP LOCKED LIMIT 10`.
  A `queued`-only predicate would finalize a transient failure at 0 forever, and
  a `failed AND attempts < 3`-only predicate would leave `attempts >= 3` rows
  unreachable (R3-M2/A5-2/C5-3/A6-1). **The `attempts >= 3` rows are deliberately
  NOT claimed here** — they are escalation-only and belong to
  `escalate_stale_marks()`, because a plpgsql function cannot COMMIT mid-body, so
  an escalation write inside this transaction would share the claim's locks and
  roll back with it (A6-1/A6-2). Every claimed row gets `status='marking'`,
  `attempts = attempts + 1`, `claimed_at = now()`, `day = CURRENT_DATE` (A7-5) and
  the batch's `claim_token` (A5-1 — a bare `status='marking'` read is not a claim,
  since the 1-min cadence plus the 5-min lease would double-process a
  45s-per-row batch). Spend-exceeded quizzes get their rows set to `failed` with
  `attempts + 1` (R3-MIN2: a concrete mechanism, not "left queued"), and the
  escalation write happens later in its own RPC. Finally the claim COMMITS, and
  **only then** does `net.http_post` run to the worker route — wrapped in its own
  exception subtransaction, so an absent pg_net still leaves the claim committed
  and `attempts` advancing instead of rolling every tick back (A5-3).
- **Phase 1b — escalate (`escalate_stale_marks()`, own RPC/transaction):**
  `SECURITY DEFINER`, service-role execute only. Selects rows at `attempts >= 3`
  in `failed` OR stale `marking`, writes `session_answers.mark_status='needs_review'`
  (the score 0 stands) under the lock order `quiz_sessions → session_answers`,
  closes the ledger rows, and re-runs the `quiz_completed_all` digest and the
  `v_all_done` reveal checks for each affected quiz (A6-9 — otherwise a
  pending-only-last-completion resolved by escalation waits for the next 5-min
  autoclose tick). Its return value counts the LEDGER rows it closed, so a row
  whose answer was already adjudicated is still reported (and stops being
  re-examined every tick).
- **Phase 2 — mark (TS):** reads ONLY the rows the POST handed it. The body is
  `{claim_token, rows:[{ledger_id, session_id, question_id, attempt_version}]}`
  and every row is re-verified against `ai_marking_ledger.claim_token` before any
  model call (A6-4). It fetches `answer_key` plus the fenced prompt, calls the
  model with a 45s abort (NO open transaction, NO held row locks), and parses the
  output with `z.object({score: 0|0.5|1, confidence: 0..1, rationale: 1..300}).strict()`.
  **Invocation (FS-3):** the repo has no scheduler besides pg_cron, so 0057's own
  guarded DO block creates `pg_net` (A6-6: bundling it with the cron schedule
  would let an unavailable pg_net roll the schedule back inside the EXCEPTION
  subtransaction while the notice blamed pg_cron — the repo's own 0042 comment
  warns against exactly this), and the sweep posts to the service-role route
  `/api/internal/ai-mark-sweep` (bearer read from Vault / `app.settings`, NEVER
  committed in a migration; 401 fail-closed on a missing or mismatched bearer;
  `checkSameOrigin` EXEMPT for server-to-server; rate-limited 60/min). Where
  pg_net cannot be created, the fallback is an OPERATOR-invoked call to the same
  route, documented in `docs/DEPLOY_VPS.md` (C5-10). **Lease (FS-3):**
  `claimed_at` + `claim_token` make a crashed worker recoverable — the claim
  predicate re-claims `status='marking'` rows older than 5 minutes, and `attempts`
  increments on every claim so the ≤3 cap holds.
- **Phase 3 — finalize (`finalize_ai_mark(p_rows jsonb)`, 0057):** ONE short
  transaction per batch, and it takes the same `ai_mark_sweep` lock as the sweep
  and the escalate job (D13 — see the deadlock note in §0). Per row, a
  conditional epoch-guarded write:
  `... WHERE session_id=... AND question_id=... AND mark_status IN
  ('pending','failed') AND attempt_version = p_attempt_version` — 0 rows means
  discard (an override won; no retry). The guard ALSO requires the row's
  `claim_token` to match the POST's token, so a superseded worker's finalize
  cannot write (A6-4). **The SET list includes `is_correct = (score >= 0.5)`**
  (A7-4) — the override RPC sets it, and without it here an AI-correct answer
  would render the red ✗ and count wrong in insights and export despite scoring
  correctly through `mark_score`. Locks are taken `quiz_sessions FOR UPDATE`
  first, then the answers (D2-12). `confidence < 0.55 → needs_review` with the
  score standing. Then the `quiz_sessions.score` recompute uses the D10 SUM, and
  both the digest check and the `v_all_done` reveal check re-run (L5/X2-7); the
  ledger row is closed as `marked`/`needs_review`. A model, Zod or abort error
  makes the worker call finalize with failure rows → `failed` (the scores stay 0
  via `pending_shape`), the claim predicate re-claims `failed` rows until
  `attempts >= 3`, and at that point phase 1b escalates the answer to
  `needs_review`. A row discarded by the epoch guard is still closed as `marked`
  with a `discarded` note, so nothing lingers in `marking` (R3-MIN3 — its tokens
  were already booked by the spend accounting).
- **Prompt fence (S6/FS-7/A6-5):** escape BOTH U+0060 and U+201B in `answer_text`
  by mapping them to **U+02BB** — NEVER to U+201B. Mapping a student backtick TO
  the fence character would let a typed backtick close the UNTRUSTED block and
  inject rubric text, and the strict-Zod output parse constrains SHAPE only, so
  an injected "score 1" parses as valid. The fence stays `‛‛‛`-style (U+201B), and
  the rubric hierarchy is system rules > answer_key > prompt text. Input is capped
  at 500 chars by both the DB CHECK (0052) and Zod, so a single oversized answer
  cannot monopolize the quiz's daily budget. Output injection is neutralised by
  the strict parse (invalid → `failed`, never echoed).
- **`pending_count` surface (FS-4/FC-3):** a NEW `SECURITY DEFINER` RPC
  `student_pending_count(p_session_id uuid)` returns
  `{pending_count, failed_count, revealed}` for the caller's OWN session only
  (a foreign session → `not_found`, no oracle), and it is NOT reveal-gated
  because it is a count rather than an oracle. The `/api/sessions/[id]` GET
  envelope carries it, the play RSC passes it to the EndScreen, and the 15s poll
  hits the same route. On the lecturer side, `lecturer_answers_view.mark_status`
  drives the gradebook pending chips, and `lecturer_session_view` gains an
  appended `pending_count`. `student_results` still carries `pending_count` for
  the revealed view (L6).
- Rationale persistence: `session_answers.mark_metadata` JSONB, rendered in the
  override dialog as PLAIN TEXT only — never HTML, never
  `dangerouslySetInnerHTML` (S7).
- **FS-6: `finalize_ai_mark` and `check_mark_spend` get the full D5 treatment** —
  `SECURITY DEFINER SET search_path = public`, plus
  `REVOKE EXECUTE ... FROM public, anon, authenticated; GRANT EXECUTE ... TO
  service_role`. A definer `finalize_ai_mark` with the default PUBLIC EXECUTE is
  a mark-forgery surface: any authenticated student could write `mark_score=1`
  on their own answers and recompute the session score. The same applies to
  `sweep_ai_marks`, `escalate_stale_marks` and `recheck_quiz_completion`.
- **FS-5:** the cron count moves 5 → **7**, so `/api/health`'s `EXPECTED_JOBS`
  and `deploy/sync-migrations.sh`'s `EXPECTED_CRON_JOBS` move to 7 in the same
  commit, along with the `docs/DEPLOY_VPS.md` prose (its `die` at the end of the
  sync script fails a deploy AFTER the schema push has already landed).
- 1-minute cadence justified: the pending banner promises "usually under a
  minute", and the sweep is cheap (an index-only claim plus a gate
  short-circuit). Autoclose stays at 5 minutes.

## 7. API / Zod / UI

- Zod static literals (never dynamic): `StudentQuestionInputSchema` rejects the
  new type with `invalid_body`.
- **Flag plumbing (9 touchpoints):** validation; the create route's `?? true`;
  `updates.ts`'s `QUIZ_FIELD_DEFAULTS` + `hasNonWindowFields`; the
  `quizzes/[id]/route.ts` live-409 guard (`liveManageableOnly`); the response
  selects; the builder's `QuizInfo` + Switch; the e2e helper's opt-out;
  **FC-1: `gestures_enabled` appended to BOTH `student_quiz_view` definitions
  (the live one and the closed-revealed twin) and selected in BOTH play-RSC quiz
  selects** — the fallback path serves a non-completed session on a closed quiz,
  so omitting it there would render `enabled === undefined` → falsy → the OFF
  branch for a quiz whose gestures are ON. Students have owner-only RLS on base
  `quizzes`, so the view is the ONLY read path; and **FS-8: the
  `quiz_status_transition` freeze list**, assigned to 0056.
- **Authoring path:** extend `QuestionInputSchema` with `short_text` plus
  `answerKey`, and MOVE the schema-level `options.min(2)/max(5)` bounds into the
  per-type arms — a global `min(2)` rejects `short_text` (0 options) before any
  `superRefine` runs, which is what made the type unauthorable. The builder's
  type Select gains the type and swaps the options editor for a rubric textarea;
  the questions POST maps `answerKey`/`maxScore` into the 9-arg
  `append_question`, and the PATCH route maps `answer_key` (it writes base
  columns directly and would otherwise silently drop the key). `AiQuizSchema` and
  the import parser stay CLOSED — AI and import do not generate the new type in
  v1, a documented limitation. The builder blocks a 5th multi option always (D1).
- **GestureLayer disabled state (R1 + FC-4):** `useState<GestureStatus>(enabled ?
  "booting" : "off")` with an explicit branch order
  `enabled === false ? bare children : <existing status==="off" branch>`.
  FC-4: `"off"` is ALSO the user-skip state, and the existing off branch renders
  the "Gestures unavailable — click to answer" chip plus a hidden video node that
  `e9c-calibration-skip` and `m2-mobile-play-chrome` assert — replacing the
  branch outright would fail both specs and lose the skip affordance. Only TWO
  effect bodies get the `enabled` gate: the boot effect INCLUDING its fake-seam
  branch (R18 — gating only the real path would leave the seam live, which is
  exactly what E-53 asserts); every other effect self-gates on `status`/`trackerRef`
  (R2). Invariant: gestures off ⇒ `holdProgress` is never set ⇒ `isHandActive` is
  false. The face pipeline's gate on `quiz.mode === "assessment" && Boolean(face)`
  is untouched, and the camera refcount drops to face-only.
- **Gesture input must not latch on the new type (R6):**
  `armed={phase === "question" && !answered && TYPE_HAS_FINGER_INPUT.has(question.type)}`
  where the set is `mcq|true_false|multi_select` — `short_text` never arms the
  AnswerPad. **B6-7/B7-5:** `nextArmed` is gated on
  `optionCount < MAX_ANSWER_FINGERS`, so a 0-option `short_text` would silently
  lose palm-next; the guard therefore applies only when the type HAS finger
  input. (`optionCount = 0` is otherwise safe by construction —
  `mapFingersToOption` guards `optionCount <= 0` and QuestionCard maps empty
  options harmlessly. State this, don't "fix" it.)
- **Type unions + badge map (R8):** extend the closed `Question.type` unions
  (`play-client.tsx`, `question-card.tsx`, the play page) with `short_text`, and
  turn QuestionCard's 3-way badge ternary into an explicit MAP — a ternary chain
  mislabels every type added after it, and a map fails loudly instead of lying.
  The new type gets `play.shortText.label`. **The builder's EDIT surface is the
  second half of the authoring path:** `edit-question-dialog.tsx`'s closed union
  and 3-item SelectContent must accept `short_text`, and the shared draft reducer
  must handle 0 options and the `answerKey` key — otherwise editing a new-type
  question mangles or breaks it.
- **Short-text input UI (B5-1/C5-1 BLOCKER):** `QuestionCard` gains a
  `short-text-input` textarea (`maxLength=500`, `play.shortText.placeholder`)
  rendered when `question.type === 'short_text'`; play-client gains `pendingText`
  state mirroring `pendingMulti`, a Confirm branch in `actionZoneButtons` gated on
  non-empty trimmed text, an `answer(text)` overload POSTing `{answerText}`, the
  answered/resume render (seeded from the ungated `answer_text`), and a
  `hasActionButtons` arm so the action zone renders for the type. Without the
  widget a student could only SKIP the question — every other layer (schema arm,
  route, RPC, pending display, i18n key, QuestionCard's empty-options no-crash)
  was already specified, which is how the gap survived several review rounds.
- **Skip (R13/S11/FC-5/FC-8):** `AnswerSchema` gains shape-exclusivity arms —
  exactly one of `selectedIndex | selectedIndices | answerText | skipped`. The
  shared schema cannot see the question type, so the arm is SHAPE EXCLUSIVITY
  ONLY and the `answerText ⇒ short_text` coupling is enforced by the definer
  RPC (`answer_question` reads the question row itself and rejects every
  cross-type payload fail-closed; audit-4 W2 corrected the earlier
  "route-side" wording — the route passes fields through and the RPC is the
  sole authority, which is strictly stronger: no TOCTOU, no extra read).
  **FC-5 context: a route-side `type` read through `student_question_view`
  was considered** — students
  have NO RLS SELECT policy on base `questions`, so a user-client
  `.from("questions").select("type")` returns null and every new-type or skip
  answer would 400 or fail open. The route passes the fields to the 6-arg
  `answer_question`, which inherits EVERY existing gate verbatim and pins: skip
  is terminal in assessment (a `p_skipped` on an already-graded row →
  `already_answered`), and skip WRITES an answer row (mark 0, graded) so
  `answers[question.id]`/`allAnswered` and `goNext` work unchanged. In practice
  a skipped row renders a dedicated "Skipped" chip, never the Incorrect badge.
  **Resume-seed plumbing covers `skipped` AND `answer_text`:** add both to the
  play RSC's answers select, `SeedAnswer`, `AnswerState` and the
  `presentedAnswers` mapper, and to the `already_answered` replay arm — otherwise
  a resumed skip seeds `isCorrect:false` and renders "Incorrect", and a resumed
  `short_text` renders empty. The skip button (`skip-question`) shows in the
  question phase only, never in `locked`/terminal states (R15).
- **Pending UX (R16/L2/L6/X2-7):** the EndScreen gains a `pending-banner` with
  TWO states — (a) `pending_count > 0` → "your answers are being marked" plus a
  15s poll; (b) `pending_count = 0` but assessment and `score == null` and not
  revealed → "marks finalised — waiting for results to be revealed" and the poll
  CONTINUES. Stopping the poll on resolution would be wrong: the student's own
  marks resolving is not the quiz being revealed (that needs the whole class, via
  `v_all_done` or autoclose), so the poll stops only on `revealed` or a non-null
  score. The banner renders at the TOP LEVEL of the component, not inside one of
  the mobile/desktop layouts — nesting it in one silently hides it on the other
  (found by E-55). `ResultsBreakdownRow` and the EndScreen row renderers extend
  for the new type: `short_text` shows the answer text plus a
  pending/marked/needs_review state (pending is NEUTRAL, not the red ✗ from
  `is_correct=false`), and skipped rows show the Skipped chip. Export cells match
  (§4).
- Routes keep the house order `requireUser → checkSameOrigin → rateLimit →
  readCappedJson → Zod → RPC`; budgets live in the route files and
  `rate-limit.ts` (never `http.ts`). ANSWER is 60/min keyed per USER with a
  per-session secondary check; SUBMIT 10/min; AUTHOR 30/min per lecturer;
  OVERRIDE 30/min per lecturer; HEALTH 30/min per IP. Several of these are
  deliberate TIGHTENINGS against the live constants (which were 120/min and
  120/hour) — stated as such so an implementer changes the constant rather than
  assuming it already matches. There is no separate text-guess budget: `short_text`
  answers ride the ANSWER budget.
- **Practice oracle (E-58):** practice reveals correctness instantly, which is
  what makes it unfit for rehearsal. The warning attaches to the EXISTING
  practice correctness-reveal, and the limit is NET-NEW — a localStorage attempt
  counter per (quiz, question), client-side and ADVISORY by design (see
  `src/lib/sessions/practice-oracle.ts` for why an enforced server-side table
  would be the wrong trade). It renders for any practice answer and adds the
  limit line at 3 attempts. No AI marking in practice, so no spend path.

## 8. i18n (en+ms in the same commit, gated by `check:i18n`)

Namespaced per repo convention (`src/messages/{en,ms}.json`; flat keys fail the
code-scan gate, and `t()` resolves against the component's own namespace prefix):
- `play.*`: `shortText.label/placeholder/confirm/pendingNote/pending/needsReview/failed`,
  `skip.action/skipped`, `oracle.warning/limit`,
  `end.pendingBanner/pendingCount/pendingResolved/needsReviewRow/skippedRow/pendingCell`
- `lecturer.builder.*`: `gesturesToggle/gesturesHint`,
  `shortTextLabel/answerKeyLabel/answerKeyPlaceholder/answerKeyHint`
- `lecturer.results.override.*`: `title/reason/reasonPlaceholder/saved/republish/…`
  — FC-10: the override dialog lives on the session-detail surface whose
  translator is `useTranslations("lecturer.results")`, so the keys belong there
- `common.aria.yourAnswer` for the EndScreen's answer block
- Export cells use `tFor` ABSOLUTE keys: `play.skip.skipped`,
  `play.shortText.pending` (X2-9 — the route's translator is not namespaced)
- The EndScreen's translator is `useTranslations("play.end")`, so
  `pendingResolved` lives UNDER `play.end` for `t("pendingResolved")` to resolve.

## 9. Test matrix

| ID | Case | Owner |
|---|---|---|
| U-58 | practice oracle counter: increment, per-quiz/per-question keying, the limit threshold, null/throwing/corrupt store degradation, clear | `src/lib/sessions/practice-oracle.test.ts` |
| U-60 | `QuestionInputSchema` short_text authoring: empty options accepted, options rejected, rubric required + capped at 500, index keys rejected, `answerKey` rejected on every other type, legacy per-type bounds intact, student schema rejects it | `src/lib/quizzes/validation.test.ts` |
| U-61 | `buildQuizUpdates` `?? true` default for `gesturesEnabled`; `hasNonWindowFields` treats it as FROZEN (live 409); window/retake patches stay unfrozen | `src/lib/quizzes/updates.test.ts` |
| U-63 | D10 SUM pending-excluded; a 0.5 override survives recompute; skipped = 0; the resolved denominator in gradebook AND export; `resolved = 0 → percent null` | `gradebook.test.ts`, `export.test.ts` |
| U-SHORT | `AnswerSchema` shape exclusivity for `answerText` + `skipped` | `src/lib/sessions/validation.test.ts` |
| U-65 | HoldConfirm mid-hold reset; HandLoss never fires when disabled; gestures-off ⇒ `holdProgress` never set ⇒ `isHandActive` false; the new type never arms the AnswerPad | `hold-confirm.test.ts`, `hand-loss.test.ts` |
| D-30 | override: NULL mark, bad reason, over-max, foreign question → `not_found`, no-answer-row → `not_found`, idempotent replay | `src/app/api/sessions/__tests__/override-route.test.ts` |
| D-31 | student `invalid_body` for the new type (`unsupported_type` does not exist in this codebase) | `src/app/api/student-quizzes/__tests__/student-quizzes-routes.test.ts` |
| I-20 | submit + pending → provisional score, `v_all_done` gated, no auto-reveal, excluded from the completed count, and the NUMERIC 1.5 recompute | `supabase/tests/0055_submit_pending.sql` |
| I-21 | override suppresses the submit mail, recomputes, writes the audit row, no stamp, re-publishes by NULLing the reveal | `supabase/tests/0058_override.sql` |
| I-22 | cron: the TWO schedules (1-min sweep + 5-min escalate), the pinned commands, exactly SEVEN jobs, `cron_health()` | `supabase/tests/0059_cron.sql` |
| I-23 | direct PostgREST access to `answer_text`/`mark_score`/`mark_status`/`answer_key`/pre-reveal `is_correct` denied, and the definer RPCs denied to `authenticated` | `supabase/tests/0054_privs.sql` |
| I-24 | the sweep lifecycle: claim → mark → finalize, retry until attempts=3, escalation, the epoch and claim-token guards discarding overridden/superseded rows, the score recompute, the digest + `v_all_done` re-fire, and the shared-lock deadlock guard | `supabase/tests/0057_sweep.sql` |
| I-25 | the 3-way `questions_correct_shape`, per-type option bounds, the short_text shape/rubric CHECKs, the pending/skip shapes, and the practice scope guard | `supabase/tests/0052_question_shape.sql` |
| E-53 | gestures off: zero tracker boot (fake seam INCLUDED), keyboard-only completion, plus a flag-ON counter-case | `e2e/e53-gestures-off.spec.ts` |
| E-54 | short_text authoring → typed answer → wire shape → skip → resume | `e2e/e54-short-text.spec.ts` |
| E-55 | pending banner in both states → AI finalize → the 1.5 NUMERIC proof → needs-review row | `e2e/e55-ai-marking.spec.ts` |
| E-56 | skip flow, the Skipped chip, and the EndScreen denominator | `e2e/e56-skip.spec.ts` |
| E-57 | clone carries the flag + the rubric; a LIVE flag flip is a 409 | `e2e/e57-clone-and-flag.spec.ts` |
| E-58 | practice oracle warning on every answer + the limit line; absent on assessment | `e2e/e58-practice-oracle.spec.ts` |
| E-60 | `select *` audit + lecturer-view migration diff + `NOTIFY pgrst` + health = 7 jobs | CI gate (verified clean) |

Gates per phase: migrate → `gen:types` → unit → integration → e2e (invite-gated
`LECTURER_INVITE_CODE`, live Supabase) → clone-required-for-live (never edit a
live quiz in tests).

## 10. Critic history (historical record)

The design above survived a long critic→fix loop. The tags below are preserved
because the migration headers cite them; several were found during the rounds
that also carried the (later cut) `ordering` type, so a tag may reference a
finding whose subject no longer exists — the ones that still apply are marked.

- **v1**: 23 issues (create-path flag drop, baselines, privileges, RPC arity,
  Zod trust, flip guard, skip, worker runtime, ledger, pending NOT NULL,
  reveal/submit, DnD, `enabled=false`, completed-immutable, NUMERIC, student
  enum window, oracle, injection, guards, i18n, tests, phasing).
- **v2 re-audit**: 7 blockers + 14 majors, including the palm-commit collision
  that fixed the multi cap at 4, the column-REVOKE lesson, the pending filter,
  the ledger-same-txn impossibility, the override underspec, the cron shape, the
  enum split, `?? true`, the i18n/ID registry, the `after()` ban and the skip
  column.
- **v3 final audit**: 5 gaps — the cron nested `$$`, the missing
  `answer_key`/`answer_text` DDL, the missing `gestures_enabled` DDL, the missing
  REVOKE/GRANT for override/sweep, and `presented_order` readability. All patched.
- **v4.2** (5 parallel domain critics: SQL, baseline, client, security,
  lifecycle): **C1** `questions_correct_shape` had to be dropped and recreated
  3-way (the 0037 two-way rejected every new-type insert); **C2** `ALTER TYPE` on
  a view-referenced column is 42P16; **C3** the ledger GRANT belongs in 0057;
  **C4** `sweep_ai_marks()` needed full specification; **C5** the DROPs had to
  name the LIVE arities; **C6/L1** the re-publish needed a `quiz_reveal_once`
  replacement with a GUC arm; **S1** the mark columns had to come off the base
  grant (they are a pre-reveal oracle); **R1** the GestureLayer needed an
  `enabled=false` render branch; **C7/S3** the new owner-predicated
  `lecturer_questions_view`; **C8** the override lock order; **C9** the NULL-mark
  guard; **C10** the question-in-quiz and answer-row EXISTS checks; **R2** only
  the boot effect is body-gated; **R3** the `isHandActive` invariant; **R6** the
  type-gated `armed`; **R8** the badge map; **R13/S11** the skip arm and its
  terminality; **R16/L6** the pending banner; **L3** one arithmetic everywhere;
  **L4** the reveal pending term; **L5** the digest exclusion; **S6** the
  backtick-escape definition; **S7** the rationale as plain text.
- **v4.3** (2 adversarial re-auditors): **D2-1** the `options` convention;
  **D2-2/FS-2** the seal trigger blocking `ALTER COLUMN`, hence the separate
  0056; **D2-6** the override lock order REALLY fixed (the v4.2 patch had left
  the AB-BA in place); **D2-10/D2-11** the two-phase sweep; **D2-16** the
  lecturer-view predicate; **D2-19** the AI routes on the admin client;
  **X2-7** the two-state banner with a continuing poll.
- **v4.4** (3 final-scan auditors): **FS-1** the migration filenames (a
  letter-suffixed name is SKIPPED silently by the CLI); **FS-2** the seal trigger;
  **FS-3** the phase-2 invocation path and the lease; **FS-4/FC-3** the
  non-reveal-gated `pending_count`; **FC-1** the flag's view append;
  **FC-2** the authoring path; **FS-6** the definer RPC REVOKEs; **FC-4** the
  `"off"` branch order; **FC-5** the route loading `type` via the view;
  **FS-7** escaping BOTH fence characters; **FS-9** the bounded-overrun honesty;
  **FS-12** `answer_text` ungated in the student view.
- **v4.5**: **B5-1/C5-1** the missing short_text input widget (the blocker that
  made the type answerable only by skipping); **A5-1** the per-claim
  `claim_token`; **A5-2** the escalation-only claim arms; **A5-3** the post-commit
  `net.http_post`; **A5-4** the service-role key source; **A5-5** the practice
  upsert reset (otherwise a re-answer after a skip raised 23514);
  **B5-3/C5-4** the edit surface; **B7-3** the `hasActionButtons` arms.
- **v4.6**: **A6-1** the fifth claim arm for crashed `marking` rows at
  `attempts >= 3`, and **A6-2** escalation as a separate RPC (plpgsql cannot
  COMMIT mid-body); **A6-4** the claim token wired end-to-end; **A6-5** the fence
  mapping corrected to U+02BB; **A6-6** pg_net in its own guarded block;
  **B6-7/B7-5** the palm-next gate.
- **v4.7/v4.8/v4.9**: convergence. The round-7 client half, the round-8 holistic
  and the round-9 verdict all returned **0 blockers, 0 majors**; **A7-1** pinned
  the escalation invoker as a second cron schedule; **A7-2** added
  `authenticated` to the sweep/escalate REVOKEs; **A7-3** pinned `v_score
  NUMERIC` in all three recreated bodies; **A7-4** added
  `is_correct = (score >= 0.5)` to the finalizer.
- **v5.0 (implementation)**: the `ordering` type was cut, and implementing the
  plan against a real database surfaced six defects no amount of document review
  had caught — the AB-BA deadlock (D13), the `gesturesEnabled` PATCH drop, the
  builder's `options: [""]`, five routes writing `questions` on the user client
  after 0054, the mobile-only pending banner, and practice-mode `short_text`
  showing a red ✗. All are fixed and covered by the tests in §9.

## 11. Reviewer checklist

1. Verify the SQL compiles in numeric file order (0051 → 0060): `npx supabase db reset --local`.
2. Verify the D10 SUM covers every scoring site: `submit_session`, `assign_seal_score`,
   `student_results` (both branches), `lecturer_session_view`, and the TS
   gradebook/export.
3. Verify the reveal-gating pending term is present in `v_all_done`,
   `quiz_autoclose`'s reveal arm, both digest paths, and
   `recheck_quiz_completion`.
4. Verify the lock order actually shipped: the SWEEP is quizzes-first
   (`quizzes → ledger`), while escalate/finalize/override are sessions-first
   with the quizzes lock last (matching `submit_session`). The pair is safe
   because all three ledger writers share the `ai_mark_sweep` advisory leaf
   lock (D13) and serialize; verify that lock is present in all three. (The
   original "quizzes → quiz_sessions → session_answers → ledger everywhere"
   wording was aspirational — audit-4 V4 refuted the deadlock risk and
   corrected the text.)
5. Verify the privilege seal with `has_column_privilege`, and confirm the
   barrier views re-expose exactly what they claim (S1/FS-12).
6. Verify the prompt fence maps BOTH U+0060 and U+201B to U+02BB.
7. Verify `EXPECTED_JOBS` (7) matches `cron.job`, and that the migrate →
   `gen:types` → unit → integration → e2e gates all pass.

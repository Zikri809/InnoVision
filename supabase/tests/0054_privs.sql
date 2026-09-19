-- ═══════════════════════════════════════════════════════════════════════
-- I-23 — Direct PostgREST privilege denial (migration 0054)
--
-- The column-privilege seal. These assertions are what make the
-- reveal-gating in the VIEWS meaningful: without them a student could read
-- the revoked columns straight off the base table and bypass every RPC gate.
--
-- The 0048 lesson is the reason this file asserts PRIVILEGES rather than
-- query results: a column-level REVOKE is a NO-OP while a table-level SELECT
-- grant exists (ACLMASK_ANY satisfies every column read), so the only honest
-- check is "does the authenticated role hold SELECT on this column at all".
--
-- S1  mark_score/mark_status/marked_at/answer_text/attempt_version are
--     NEVER base-granted: `mark_score >= 0.5` is exactly is_correct, i.e. a
--     verbatim pre-reveal answer-key oracle.
-- The short_text answer_key is the rubric, so it is never base-granted
--     either — a student who read it could write a perfect answer.
-- FS-6 finalize_ai_mark / check_mark_spend are service-role only — a definer
--     finalizer with default PUBLIC EXECUTE is a mark-forgery surface.
--
-- Run: npx supabase test db
-- ═══════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgtap;

select plan(40);

-- ── §1 session_answers: the S1 withheld columns ───────────────────────
select ok(
  not has_column_privilege('authenticated', 'public.session_answers', 'is_correct', 'SELECT'),
  'S1: session_answers.is_correct is NOT base-granted (the original 0048 seal)');

select ok(
  not has_column_privilege('authenticated', 'public.session_answers', 'mark_score', 'SELECT'),
  'S1: session_answers.mark_score is NOT base-granted (it IS is_correct)');

select ok(
  not has_column_privilege('authenticated', 'public.session_answers', 'mark_status', 'SELECT'),
  'S1: session_answers.mark_status is NOT base-granted');

select ok(
  not has_column_privilege('authenticated', 'public.session_answers', 'marked_at', 'SELECT'),
  'S1: session_answers.marked_at is NOT base-granted');

select ok(
  not has_column_privilege('authenticated', 'public.session_answers', 'answer_text', 'SELECT'),
  'S1: session_answers.answer_text is NOT base-granted (view-only)');

select ok(
  not has_column_privilege('authenticated', 'public.session_answers', 'attempt_version', 'SELECT'),
  'S1: session_answers.attempt_version is NOT base-granted');

select ok(
  not has_column_privilege('authenticated', 'public.session_answers', 'mark_metadata', 'SELECT'),
  'S1: session_answers.mark_metadata is NOT base-granted');

-- The OWN-answer columns the student legitimately needs for resume.
select ok(
  has_column_privilege('authenticated', 'public.session_answers', 'selected_index', 'SELECT'),
  'the student keeps selected_index (resume)');

select ok(
  has_column_privilege('authenticated', 'public.session_answers', 'selected_indices', 'SELECT'),
  'the student keeps selected_indices (QT-1 resume)');

select ok(
  has_column_privilege('authenticated', 'public.session_answers', 'skipped', 'SELECT'),
  'skipped IS granted — it is the student''s own action, not an oracle');

-- No table-level SELECT may remain (a table grant would re-open every column).
select ok(
  not has_table_privilege('authenticated', 'public.session_answers', 'SELECT'),
  'the TABLE-level SELECT on session_answers is revoked (0048 order: REVOKE table first)');

-- ── §2 questions: the answer keys ─────────────────────────────────────
select ok(
  not has_column_privilege('authenticated', 'public.questions', 'answer_key', 'SELECT'),
  'the short_text rubric is NOT base-granted');

select ok(
  not has_column_privilege('authenticated', 'public.questions', 'correct_index', 'SELECT'),
  'the pre-existing scalar key stays revoked');

select ok(
  not has_column_privilege('authenticated', 'public.questions', 'correct_indices', 'SELECT'),
  'the pre-existing set key stays revoked');

select ok(
  not has_column_privilege('authenticated', 'public.questions', 'image_path', 'SELECT'),
  'image_path stays revoked (0028 exposes presence only, via has_image)');

select ok(
  has_column_privilege('authenticated', 'public.questions', 'max_score', 'SELECT'),
  'max_score IS granted (a scale factor, always 1 — not an answer)');

select ok(
  not has_table_privilege('authenticated', 'public.questions', 'SELECT'),
  'the TABLE-level SELECT on questions is revoked');

-- ── §3 quiz_sessions: score stays withheld ────────────────────────────
select ok(
  not has_column_privilege('authenticated', 'public.quiz_sessions', 'score', 'SELECT'),
  'quiz_sessions.score is NOT base-granted (reveal-gated via student_session_view)');

select ok(
  not has_table_privilege('authenticated', 'public.quiz_sessions', 'SELECT'),
  'the TABLE-level SELECT on quiz_sessions is revoked');

select ok(
  has_column_privilege('authenticated', 'public.quiz_sessions', 'attempt', 'SELECT'),
  'the 0048 column list is preserved (attempt)');

-- ── §4 The ledger is service-role only (0028 precedent) ───────────────
select ok(
  not has_table_privilege('authenticated', 'public.ai_marking_ledger', 'SELECT'),
  'authenticated cannot SELECT the AI marking ledger');

select ok(
  not has_table_privilege('anon', 'public.ai_marking_ledger', 'SELECT'),
  'anon cannot SELECT the AI marking ledger');

select ok(
  has_table_privilege('service_role', 'public.ai_marking_ledger', 'SELECT'),
  'service_role CAN read the ledger (the worker + sweep need it)');

-- ── §5 FS-6: the definer RPCs are not student-callable ────────────────
select ok(
  not has_function_privilege('authenticated', 'public.finalize_ai_mark(jsonb)', 'EXECUTE'),
  'FS-6: finalize_ai_mark is NOT executable by authenticated (mark-forgery surface)');

select ok(
  not has_function_privilege('anon', 'public.finalize_ai_mark(jsonb)', 'EXECUTE'),
  'FS-6: finalize_ai_mark is NOT executable by anon');

select ok(
  has_function_privilege('service_role', 'public.finalize_ai_mark(jsonb)', 'EXECUTE'),
  'FS-6: finalize_ai_mark IS executable by service_role');

select ok(
  not has_function_privilege('authenticated', 'public.check_mark_spend(uuid)', 'EXECUTE'),
  'FS-6: check_mark_spend is NOT executable by authenticated');

select ok(
  not has_function_privilege('authenticated', 'public.sweep_ai_marks()', 'EXECUTE'),
  'A7-2: sweep_ai_marks is NOT executable by authenticated');

select ok(
  not has_function_privilege('authenticated', 'public.escalate_stale_marks()', 'EXECUTE'),
  'A7-2: escalate_stale_marks is NOT executable by authenticated');

select ok(
  not has_function_privilege('authenticated', 'public.recheck_quiz_completion(uuid)', 'EXECUTE'),
  'recheck_quiz_completion is NOT executable by authenticated');

-- audit-4 n5: the anon half of the same seal. Only finalize had an anon check;
-- a bare `revoke ... from public` leaves anon denied but that is not what the
-- migration says — it revokes from `public, anon, authenticated` explicitly,
-- and an anon EXECUTE on a definer sweep/finalizer is a mark-forgery surface.
select ok(
  not has_function_privilege('anon', 'public.sweep_ai_marks()', 'EXECUTE'),
  'A7-2: sweep_ai_marks is NOT executable by anon');

select ok(
  not has_function_privilege('anon', 'public.escalate_stale_marks()', 'EXECUTE'),
  'A7-2: escalate_stale_marks is NOT executable by anon');

select ok(
  not has_function_privilege('anon', 'public.recheck_quiz_completion(uuid)', 'EXECUTE'),
  'recheck_quiz_completion is NOT executable by anon');

select ok(
  not has_function_privilege('anon', 'public.check_mark_spend(uuid)', 'EXECUTE'),
  'FS-9: check_mark_spend is NOT executable by anon');

-- ── §7 Barrier-view projection (§11.5 "re-expose exactly what they claim") ─
-- The views are the ONLY student read path (base tables are sealed), so what
-- they expose IS the contract. `has_column_privilege` cannot see a view's
-- columns, so the assertions read the stored definition (`pg_get_viewdef`
-- normalises it, hence the regex-style LIKE patterns).
select ok(
  (select pg_get_viewdef('public.student_answers_view'::regclass))
    similar to '%(sa\.answer_text)%'
  and (select pg_get_viewdef('public.student_answers_view'::regclass))
    similar to '%(sa\.skipped)%',
  'student_answers_view exposes answer_text + skipped (resume needs them, ungated)');

-- Both mark columns must sit behind the reveal CASE. The definition renders
-- `WHEN is_student_reveal_allowed(qs.quiz_id) THEN sa.mark_status` (and the
-- mark_score twin), so the predicate name AND the column must co-occur.
select ok(
  (select pg_get_viewdef('public.student_answers_view'::regclass))
    similar to '%is_student_reveal_allowed%'
  and (select pg_get_viewdef('public.student_answers_view'::regclass))
    similar to '%THEN sa\.mark_status%'
  and (select pg_get_viewdef('public.student_answers_view'::regclass))
    similar to '%THEN sa\.mark_score%',
  'student_answers_view gates mark_status AND mark_score behind the reveal predicate');

-- lecturer_questions_view is the owner-predicated replacement for the revoked
-- base reads: it MUST carry the keys a lecturer needs to author.
select ok(
  (select pg_get_viewdef('public.lecturer_questions_view'::regclass))
    similar to '%answer_key%'
  and (select pg_get_viewdef('public.lecturer_questions_view'::regclass))
    similar to '%is_lecturer_of_quiz%',
  'lecturer_questions_view exposes answer_key behind is_lecturer_of_quiz');

-- ── §6 The student-facing RPCs remain callable ────────────────────────
select ok(
  has_function_privilege('authenticated', 'public.answer_question(uuid,uuid,int,int[],text,boolean)', 'EXECUTE'),
  'the 6-arg answer_question is executable by authenticated');

select ok(
  has_function_privilege('authenticated', 'public.student_pending_count(uuid)', 'EXECUTE'),
  'student_pending_count is executable by authenticated (the pending banner)');

select ok(
  has_function_privilege('authenticated', 'public.override_answer_mark(uuid,uuid,numeric,text)', 'EXECUTE'),
  'override_answer_mark is executable by authenticated (the RPC gates by lecturer)');

select * from finish();
rollback;

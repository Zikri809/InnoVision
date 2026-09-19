-- ═══════════════════════════════════════════════════════════════════════
-- 0053 — quiz_sessions.score INT → NUMERIC (PLAN_GESTURE_OFF_RICH_TYPES)
--
-- Why NUMERIC: D10's single scoring arithmetic is
--   SUM(COALESCE(mark_score, CASE WHEN is_correct THEN 1 ELSE 0 END))
-- where mark_score ∈ {0, 0.5, 1}. An int4 target ROUNDS a 0.5 total
-- (0.5 + 1.0 → 2), silently corrupting exactly the recompute paths the
-- half-mark ladder exists to serve. The column must widen before any
-- recompute body lands (0055/0056).
--
-- FS-2 — TWO blocking dependencies, both must be dropped FIRST:
--   (a) C2: `student_session_view` (0012) and `lecturer_session_view`
--       (0044) both SELECT s.score. Postgres rejects ALTER COLUMN TYPE with
--       42P16 "cannot alter type of a column used by a view or rule".
--   (b) The `quiz_sessions_seal_score` trigger (0045:1144-1152) declares
--       `BEFORE UPDATE OF status, score ... WHEN (new.score is null)`.
--       Postgres rejects ALTER COLUMN TYPE when the column appears in a
--       trigger's UPDATE-OF list or WHEN expression. Dropping only the
--       views aborts the whole migration here.
--
-- The trigger's FUNCTION is untouched (assign_seal_score is redefined in
-- 0056 with the D10 body + a NUMERIC v_score); only the trigger DDL is
-- dropped here and re-created in 0056. Dropping the trigger does NOT drop
-- the function — but note the reverse is fatal: a bare `DROP FUNCTION
-- assign_seal_score()` would fail RESTRICT (NORMAL dependency from the
-- trigger) or, under CASCADE, silently destroy seal scoring + the
-- `app.session_sealing` GUC + seal-mail suppression.
--
-- View recreations below are VERBATIM in column order, security_barrier, and
-- grants. Nothing is appended here — the rich columns land in 0060, so this
-- file stays a pure type change (one concern per file).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Drop the two score-referencing views ──────────────────────────
drop view if exists public.student_session_view;
drop view if exists public.lecturer_session_view;

-- ─── 2. Drop the seal trigger (its UPDATE-OF/WHEN reference the column) ─
drop trigger if exists quiz_sessions_seal_score on public.quiz_sessions;

-- ─── 3. Widen the column ──────────────────────────────────────────────
-- USING score::numeric is an explicit widening cast (int4 → numeric is
-- lossless), and the existing `quiz_sessions_score_check` (score IS NULL OR
-- score >= 0) is re-validated by Postgres as part of the rewrite.
alter table public.quiz_sessions
  alter column score type numeric using score::numeric;

-- ─── 4. Re-create student_session_view (0012 body, cast now numeric) ──
-- Student session envelope: full row EXCEPT score is reveal-gated.
-- `selected` via OWN-student filter (never another student's session).
create or replace view public.student_session_view
with (security_barrier = true)
as
select s.id, s.quiz_id, s.student_id, s.mode, s.status,
       s.started_at, s.submitted_at, s.last_activity_at,
       s.face_exempt, s.face_fail_streak, s.face_unavailable_at, s.verify_nonce,
       case when public.is_student_reveal_allowed(s.quiz_id)
            then s.score else null end as score,
       s.attempt
from public.quiz_sessions s
where s.student_id = auth.uid();

grant select on public.student_session_view to authenticated;

-- ─── 5. Re-create lecturer_session_view (0044 body, verbatim) ─────────
-- Lecturer session envelope: full row including score (lecturer of the quiz).
-- BASELINE: the LIVE 0044 revision (focus/attempt/fullscreen counters +
-- face_fail_count + hand_pause_count).
create or replace view public.lecturer_session_view
with (security_barrier = true)
as
select s.id, s.quiz_id, s.student_id, s.mode, s.status,
       s.started_at, s.submitted_at, s.last_activity_at,
       s.face_exempt, s.face_fail_streak, s.face_unavailable_at,
       s.score,
       s.focus_pause_count,
       s.attempt,
       s.fullscreen_pause_count,
       s.face_fail_count,
       s.hand_pause_count
from public.quiz_sessions s
where public.is_lecturer_of_quiz(s.quiz_id);

grant select on public.lecturer_session_view to authenticated;

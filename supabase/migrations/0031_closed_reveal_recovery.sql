-- ═══════════════════════════════════════════════════════════════════════
-- 0031 — Closed-before-reveal recovery surface (PLAN_R_QUIZ_LIFECYCLE QC-2)
--
-- The reveal route now allows revealing a CLOSED quiz (QC-2 half 1). But the
-- play RSC + session GET derive quiz metadata from the LIVE-ONLY
-- student_quiz_view, so a closed+revealed quiz still 404s for students —
-- results stranded behind the recovery reveal. This adds the student-facing
-- metadata surface for exactly that state:
--
--   student_closed_revealed_quiz_view — security_barrier view, columns
--   identical to student_quiz_view, predicate:
--     status='closed' AND is_student_reveal_allowed(q.id)
--     AND class NOT archived (parity with 0017/0028).
--
-- Secrecy model unchanged: reveal-gated ONLY (closed+unrevealed stays fully
-- opaque — is_student_reveal_allowed is false without a reveal); the
-- column-secrecy/barrier model is untouched.
--
-- Depends on: 0012 (is_student_reveal_allowed), 0017 (archiving), 0030.
-- ═══════════════════════════════════════════════════════════════════════

create or replace view public.student_closed_revealed_quiz_view
with (security_barrier = true)
as
select q.id, q.class_id, q.title, q.mode, q.status, q.time_limit_sec,
       q.created_at, q.results_revealed_at, q.opens_at, q.closes_at
from public.quizzes q
join public.classes c on c.id = q.class_id
where q.status = 'closed'
  and public.is_student_reveal_allowed(q.id)
  and c.archived_at is null;

revoke all on public.student_closed_revealed_quiz_view from anon, public;
grant select on public.student_closed_revealed_quiz_view to authenticated;
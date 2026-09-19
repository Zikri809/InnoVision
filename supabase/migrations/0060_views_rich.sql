-- ═══════════════════════════════════════════════════════════════════════
-- 0060 — Barrier views for the rich types (PLAN_GESTURE_OFF_RICH_TYPES)
--
-- Rule (0021 R4): CREATE OR REPLACE VIEW can only APPEND columns. Every
-- redefinition below appends LAST and never reorders or drops, and each is
-- re-GRANTed after the replace.
--
-- §1 student_quiz_view + student_closed_revealed_quiz_view  (+gestures_enabled)
-- §2 student_answers_view    (+skipped, mark_status, mark_score,
--                             answer_text, attempt_version)
-- §3 lecturer_answers_view   (owner predicate, all new columns full)
-- §4 student_question_view   (+has_image preserved; NO keys)
-- §5 lecturer_questions_view (NEW — S3/D2-16)
-- §6 lecturer_session_view   (+pending_count appended LAST)
--
-- ── Gating decisions (each is load-bearing) ───────────────────────────
-- student_answers_view:
--   answer_text, skipped — UNGATED. These are the student's OWN
--     answer/action record, needed to RESUME a session: gating answer_text
--     would break pre-reveal resume of an answered short_text (FS-12/A5-6),
--     and skipped is not an oracle (it says the student pressed Skip, not
--     what the right answer was).
--   mark_status, mark_score — REVEAL-GATED (S1). `mark_score >= 0.5` is
--     exactly equivalent to is_correct, so an ungated mark_score is a
--     verbatim pre-reveal answer-key oracle — the leak 0048:1039-1101 closed.
--
-- ── Why lecturer_questions_view exists at all (C7/S3/D2-16) ───────────
-- 0054 revokes the answer-key columns from `authenticated`. The lecturer
-- surfaces that read base `questions` with a USER-scoped client would 403
-- on the revoked columns, and widening the base grant would re-expose them
-- to students (who have RLS deny on `questions`, but the COLUMN grant is the
-- seal — 0037:10-16). So lecturer reads go through an owner-predicated view
-- instead. `quizzes` has NO lecturer_id column: ownership is
-- classes.lecturer_id via the 0004:70-85 helper.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Student quiz views gain gestures_enabled ──────────────────────
-- FC-1/B5-10: students have OWNER-ONLY RLS on base `quizzes` (0006:20-24),
-- so these views are the ONLY read path for the flag. BOTH definitions get
-- it: the live view serves the normal play path, and the closed+revealed
-- twin serves a non-completed session on a closed quiz — without the append
-- there, `enabled` would be `undefined` → falsy → the gesture layer would
-- silently render its OFF branch for a quiz that has gestures ON.
create or replace view public.student_quiz_view
with (security_barrier = true)
as
select q.id, q.class_id, q.title, q.mode, q.status, q.time_limit_sec,
       q.created_at, q.results_revealed_at, q.opens_at, q.closes_at,
       q.allow_retake, q.max_attempts,
       q.shuffle_questions,
       q.gestures_enabled
from public.quizzes q
join public.classes c on c.id = q.class_id
where public.is_enrolled_in_class(q.class_id)
  and q.status = 'live'
  and c.archived_at is null;

grant select on public.student_quiz_view to authenticated;

create or replace view public.student_closed_revealed_quiz_view
with (security_barrier = true)
as
select q.id, q.class_id, q.title, q.mode, q.status, q.time_limit_sec,
       q.created_at, q.results_revealed_at, q.opens_at, q.closes_at,
       q.shuffle_questions,
       q.gestures_enabled
from public.quizzes q
join public.classes c on c.id = q.class_id
where q.status = 'closed'
  and public.is_student_reveal_allowed(q.id)
  and c.archived_at is null;

revoke all on public.student_closed_revealed_quiz_view from anon, public;
grant select on public.student_closed_revealed_quiz_view to authenticated;

-- ─── 2. student_answers_view ──────────────────────────────────────────
-- BASELINE: the LIVE 0037:145 revision (selected_indices appended).
create or replace view public.student_answers_view
with (security_barrier = true)
as
select sa.id, sa.session_id, sa.question_id, sa.selected_index, sa.answered_at,
       case when public.is_student_reveal_allowed(qs.quiz_id)
            then sa.is_correct else null end as is_correct,
       sa.selected_indices,
       -- Appended (UNGATED — own answer, needed for resume; FS-12).
       sa.answer_text,
       sa.skipped,
       -- Appended (REVEAL-GATED — mark_score ⇔ is_correct is an oracle; S1).
       case when public.is_student_reveal_allowed(qs.quiz_id)
            then sa.mark_status else null end as mark_status,
       case when public.is_student_reveal_allowed(qs.quiz_id)
            then sa.mark_score else null end as mark_score,
       sa.attempt_version
from public.session_answers sa
join public.quiz_sessions qs on qs.id = sa.session_id
where qs.student_id = auth.uid();

grant select on public.student_answers_view to authenticated;

-- ─── 3. lecturer_answers_view ─────────────────────────────────────────
-- BASELINE: the LIVE 0037:158 revision. All new columns full — the owner
-- predicate is the gate, and a lecturer adjudicating a mark needs the mark.
create or replace view public.lecturer_answers_view
with (security_barrier = true)
as
select sa.id, sa.session_id, sa.question_id, sa.selected_index, sa.is_correct,
       sa.answered_at,
       sa.selected_indices,
       sa.answer_text,
       sa.skipped,
       sa.mark_status,
       sa.mark_score,
       sa.mark_metadata,
       sa.marked_at,
       sa.attempt_version
from public.session_answers sa
join public.quiz_sessions qs on qs.id = sa.session_id
where public.is_lecturer_of_quiz(qs.quiz_id);

grant select on public.lecturer_answers_view to authenticated;

-- ─── 4. student_question_view ─────────────────────────────────────────
-- BASELINE: the LIVE 0028:162 revision. UNCHANGED in content — restated here
-- so the file is the complete manifest of student-facing question
-- projections and an auditor can see, in one place, that this view exposes
-- NO answer key of any kind: no correct_index, no correct_indices, no
-- answer_key. has_image is preserved.
create or replace view public.student_question_view
with (security_barrier = true)
as
select q.id, q.quiz_id, q.order_index, q.type, q.prompt, q.options, q.created_at,
       (q.image_path is not null) as has_image
from public.questions q
where public.can_student_view_quiz(q.quiz_id);

grant select on public.student_question_view to authenticated;

-- ─── 5. lecturer_questions_view (NEW) ─────────────────────────────────
-- S3/D2-16: the owner-predicated replacement for every lecturer read of base
-- `questions`. FULL columns including the answer keys, because the whole
-- point is that a lecturer CAN see and edit them — the predicate, not the
-- column list, is what keeps them from students.
create or replace view public.lecturer_questions_view
with (security_barrier = true)
as
select q.id, q.quiz_id, q.order_index, q.type, q.prompt, q.options,
       q.correct_index, q.correct_indices, q.explanation, q.image_path,
       q.created_at, q.answer_key, q.max_score,
       q.generation_id
from public.questions q
where public.is_lecturer_of_quiz(q.quiz_id);

revoke all on public.lecturer_questions_view from anon, public;
grant select on public.lecturer_questions_view to authenticated;

-- ─── 6. lecturer_session_view gains pending_count ─────────────────────
-- A5-11/H-5: appended LAST (CREATE OR REPLACE VIEW can only append). The
-- gradebook renders a neutral "pending" chip per cell from this, so a
-- partially-marked quiz is never read as "scored 0".
-- BASELINE: the LIVE 0044:1008 revision.
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
       s.hand_pause_count,
       (select count(*) from public.session_answers sa
         where sa.session_id = s.id
           and sa.mark_status = 'pending') as pending_count
from public.quiz_sessions s
where public.is_lecturer_of_quiz(s.quiz_id);

grant select on public.lecturer_session_view to authenticated;

-- audit-4 D11 / plan D5: terminal republish for this migration batch. The six
-- barrier views above are the rich-type read surface; on self-hosted PostgREST
-- a stale schema cache serves their PRE-0060 column lists (or 404s the new
-- `lecturer_questions_view`) until reload. Exactly one NOTIFY, at the very end
-- after the last GRANT.
notify pgrst, 'reload schema';

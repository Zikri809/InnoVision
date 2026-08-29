-- ═══════════════════════════════════════════════════════════════════════
-- 0034 — Per-student question/option shuffling (QT-3, PLAN_R_QUESTION_TYPES)
--
-- Adds a quiz-level opt-in flag. The permutation itself is NEVER stored:
-- it is derived deterministically at read time from (quiz_sessions.id,
-- question id, count) by src/lib/sessions/shuffle.ts (envelope build +
-- client translation), so every load of the same session sees the same
-- order and retakes (new session id) reshuffle.
--
-- Secrecy model: the flag is presentation metadata (same sensitivity class
-- as allow_retake/max_attempts). No view uses select *, so the column only
-- becomes student-visible where 0034 explicitly adds it — the two
-- student-facing quiz-metadata views the play RSC reads (live path +
-- closed+revealed fallback).
--
-- Freeze policy: shuffle_questions joins the quiz_not_draft_edit freeze.
-- Persisted answers CANNOT desync (they are canonical and translations are
-- plan-relative); the real reasons are presented-space client snapshots
-- (multi-tab / reload straddling a flip) and assessment fairness (students
-- answering different orderings of the same instrument). Same class as
-- mode/time_limit (frozen), NOT windows/retake (live-quiz management).
--
-- Depends on: 0030 (windows/view chain), 0031 (closed-revealed view), 0032.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Quiz-level flag ────────────────────────────────────────────────
alter table public.quizzes
  add column if not exists shuffle_questions boolean not null default false;

-- ─── 2. Student-facing quiz-metadata views (column APPENDED LAST —
--        Postgres forbids reorder on create or replace view) ─────────────
create or replace view public.student_quiz_view
with (security_barrier = true)
as
select q.id, q.class_id, q.title, q.mode, q.status, q.time_limit_sec,
       q.created_at, q.results_revealed_at, q.opens_at, q.closes_at,
       q.allow_retake, q.max_attempts,
       q.shuffle_questions
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
       q.shuffle_questions
from public.quizzes q
join public.classes c on c.id = q.class_id
where q.status = 'closed'
  and public.is_student_reveal_allowed(q.id)
  and c.archived_at is null;

revoke all on public.student_closed_revealed_quiz_view from anon, public;
grant select on public.student_closed_revealed_quiz_view to authenticated;

-- ─── 3. quiz_status_transition: full 0032 carry-forward + shuffle pin ──
-- shuffle_questions joins the frozen metadata set (see rationale above).
-- opens_at/closes_at (QC-3) and allow_retake/max_attempts (QC-4) remain
-- deliberately NOT frozen — live-quiz management (PLAN_R_QUIZ_LIFECYCLE).
-- Everything else is the verbatim 0032 body (incl. the same-status
-- advisory-lock close check).
create or replace function public.quiz_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_question_count int;
begin
  if TG_OP = 'INSERT' then
    if NEW.status is distinct from 'draft' then
      raise exception 'quiz_must_start_draft'
        using errcode = 'P0001';
    end if;
    return NEW;
  end if;

  -- Metadata edit-lock: title/mode/time_limit/sources fields AND
  -- shuffle_questions (QT-3) are frozen once a quiz leaves draft. NOTE:
  -- opens_at/closes_at (QC-3) and allow_retake/max_attempts (QC-4) are
  -- deliberately NOT frozen — availability windows and retake config are
  -- live-quiz management (PLAN_R_QUIZ_LIFECYCLE).
  if OLD.status <> 'draft'
     and (NEW.title is distinct from OLD.title
          or NEW.mode is distinct from OLD.mode
          or NEW.time_limit_sec is distinct from OLD.time_limit_sec
          or NEW.source_file_url is distinct from OLD.source_file_url
          or NEW.source_text is distinct from OLD.source_text
          or NEW.sources is distinct from OLD.sources
          or NEW.shuffle_questions is distinct from OLD.shuffle_questions) then
    raise exception 'quiz_not_draft_edit'
      using errcode = 'P0001';
  end if;

  if NEW.status = OLD.status then
    if OLD.status = 'live' then
      perform pg_advisory_xact_lock(hashtext('quiz_publish:' || OLD.id::text));
      if exists (
        select 1 from public.quizzes q
        where q.id = OLD.id and q.status = 'closed'
      ) then
        raise exception 'closed_quiz_cannot_transition'
          using errcode = 'P0001';
      end if;
    end if;
    return NEW;
  end if;

  if OLD.status = 'closed' then
    raise exception 'closed_quiz_cannot_transition'
      using errcode = 'P0001';
  end if;

  if OLD.status = 'live' and NEW.status = 'draft' then
    raise exception 'live_quiz_cannot_reopen'
      using errcode = 'P0001';
  end if;

  if NEW.status = 'live' then
    select count(*) into v_question_count
      from public.questions
     where quiz_id = NEW.id;
    if v_question_count = 0 then
      raise exception 'cannot_publish_empty_quiz'
        using errcode = 'P0001';
    end if;
  end if;

  return NEW;
end;
$$;

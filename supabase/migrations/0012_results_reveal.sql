-- InnoVision — Phase 13: Reveal Results (PLAN_REVEAL_RESULTS.md v4)
-- Depends on: 0008_sessions.sql (quiz_sessions, session_answers, answer_question,
-- submit_session, helpers), 0009_face.sql (redefined submit_session),
-- 0006_quiz_and_roster_secrecy.sql (student_quiz_view, student_question_view).
--
-- SUMMARY (all decisions pinned in docs/PLAN_REVEAL_RESULTS.md v4):
--  1. quizzes.results_revealed_at  → reveal = state on the quiz (one-way).
--  2. quizzes.auto_reveal_on_complete → auto-reveal intent stored on the quiz.
--  3. is_student_reveal_allowed()  → helper: enrolled + (practice OR revealed).
--  4. reveal_once_only trigger     → ONE-WAY reveal enforced by the DB, not UI.
--  5. Column-level secrecy leak fix: REVOKE is_correct (session_answers) and
--     score (quiz_sessions) from authenticated; OWNER-privilege views re-expose
--     them ONLY where allowed (students: reveal-gated; lecturers: always).
--  6. answer_question  → keyless ack for assessment (no is_correct pre-reveal).
--  7. submit_session   → score/total null for hidden assessment + auto-reveal.
--  8. student_results  → security-definer student breakdown (D10-safe).

-- ─── 1. quiz reveal columns ────────────────────────────────────────
alter table public.quizzes
  add column if not exists results_revealed_at      timestamptz,
  add column if not exists auto_reveal_on_complete boolean not null default false;

-- ─── 2. reveal-rule helper (student side) ──────────────────────────
-- Practice is ALWAYS revealed; assessment is revealed only once
-- results_revealed_at is set. Enrollment is required in both cases.
create or replace function public.is_student_reveal_allowed(p_quiz_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.quizzes q
    where q.id = p_quiz_id
      and (q.mode = 'practice' or q.results_revealed_at is not null)
      and public.is_enrolled_in_class(q.class_id)
      and exists (select 1 from public.class_enrollments ce
                   where ce.class_id = q.class_id and ce.student_id = auth.uid())
  );
$$;

revoke execute on function public.is_student_reveal_allowed(uuid) from public, anon;
grant execute on function public.is_student_reveal_allowed(uuid) to authenticated;

-- ─── 3. one-way reveal trigger ─────────────────────────────────────
-- Result: reveal is one-way enforced at the DB. Mechanisms that make it safe:
--  - only transitions FROM non-null results_revealed_at are rejected
--    (NULL→non-NULL, i.e. the reveal itself, is the ALLOWED direction),
--  - a same-value no-op (idempotent auto-reveal / re-click) passes untouched.
create or replace function public.quiz_reveal_once()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if OLD.results_revealed_at is not null
     and NEW.results_revealed_at is distinct from OLD.results_revealed_at then
    raise exception 'reveal_once_only'
      using errcode = 'P0001';
  end if;
  return NEW;
end;
$$;

drop trigger if exists quiz_reveal_once on public.quizzes;
create trigger quiz_reveal_once
  before update of results_revealed_at on public.quizzes
  for each row execute function public.quiz_reveal_once();

-- ─── 4. column-level secrecy (leak fix) ────────────────────────────
-- A student can POST a direct PostgREST `select * from session_answers` /
-- `quiz_sessions` and read is_correct / score, defeating any reveal gate at
-- the RPC/route layer. Hide the sensitive COLUMN at the privilege layer from
-- `authenticated`; every authorized read goes through an owner-privilege view
-- (below) that re-exposes the column under the correct predicate.
revoke select (is_correct) on public.session_answers from anon, authenticated;
revoke select (score)       on public.quiz_sessions    from anon, authenticated;

-- ─── 5. student-safe views (owner-privilege: read through them) ─────
-- Views run with the DEFINER's (table owner's) privileges, so they can select
-- the columns just revoked from `authenticated` and expose exactly the right
-- projection. security_barrier stops PostgREST pushing filters under them.

-- Student session envelope: full row EXCEPT score is reveal-gated.
-- `selected` via OWN-student filter (never another student's session).
create or replace view public.student_session_view
with (security_barrier = true)
as
select s.id, s.quiz_id, s.student_id, s.mode, s.status,
       s.started_at, s.submitted_at, s.last_activity_at,
       s.face_exempt, s.face_fail_streak, s.face_unavailable_at, s.verify_nonce,
       case when public.is_student_reveal_allowed(s.quiz_id)
            then s.score else null end as score
from public.quiz_sessions s
where s.student_id = auth.uid();

grant select on public.student_session_view to authenticated;

-- Student answers: selected_index always (resume); is_correct reveal-gated.
create or replace view public.student_answers_view
with (security_barrier = true)
as
select sa.id, sa.session_id, sa.question_id, sa.selected_index, sa.answered_at,
       case when public.is_student_reveal_allowed(qs.quiz_id)
            then sa.is_correct else null end as is_correct
from public.session_answers sa
join public.quiz_sessions qs on qs.id = sa.session_id
where qs.student_id = auth.uid();

grant select on public.student_answers_view to authenticated;

-- Lecturer session envelope: full row including score (lecturer of the quiz).
create or replace view public.lecturer_session_view
with (security_barrier = true)
as
select s.id, s.quiz_id, s.student_id, s.mode, s.status,
       s.started_at, s.submitted_at, s.last_activity_at,
       s.face_exempt, s.face_fail_streak, s.face_unavailable_at,
       s.score
from public.quiz_sessions s
where public.is_lecturer_of_quiz(s.quiz_id);

grant select on public.lecturer_session_view to authenticated;

-- Lecturer answers: full answer rows incl. is_correct (lecturer of the quiz).
create or replace view public.lecturer_answers_view
with (security_barrier = true)
as
select sa.id, sa.session_id, sa.question_id, sa.selected_index, sa.is_correct,
       sa.answered_at
from public.session_answers sa
join public.quiz_sessions qs on qs.id = sa.session_id
where public.is_lecturer_of_quiz(qs.quiz_id);

grant select on public.lecturer_answers_view to authenticated;

-- student_quiz_view must expose results_revealed_at so the play RSC can
-- compute `revealed`. Auto-reveal intent is lecturer-only and deliberately NOT
-- exposed here.
create or replace view public.student_quiz_view
with (security_barrier = true)
as
select q.id, q.class_id, q.title, q.mode, q.status, q.time_limit_sec,
       q.created_at, q.results_revealed_at
from public.quizzes q
where public.is_enrolled_in_class(q.class_id) and q.status = 'live';

grant select on public.student_quiz_view to authenticated;

-- ─── 6. REDEFINED answer_question: keyless assessment ack ───────────
-- Assessment success no longer reports is_correct (a student would learn their
-- running correctness mid-session = results leak). Practice is unchanged
-- (is_correct/correct_index/explanation — practice is always revealed).
create or replace function public.answer_question(
  p_session_id      uuid,
  p_question_id     uuid,
  p_selected_index  int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session   public.quiz_sessions;
  v_time_limit int;
  v_options    text[];
  v_correct    int;
  v_explanation text;
  v_is_correct boolean;
  v_rows       int;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'student'
  ) then
    return jsonb_build_object('error', 'not_student');
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.status <> 'active' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  if not exists (
    select 1 from public.quizzes q
    where q.id = v_session.quiz_id and q.status = 'live'
  ) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  if not public.can_student_view_quiz(v_session.quiz_id) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  select q.time_limit_sec into v_time_limit
    from public.quizzes q
   where q.id = v_session.quiz_id;

  if v_time_limit is not null
     and clock_timestamp() > v_session.started_at
         + (v_time_limit * interval '1 second')
         + interval '5 seconds' then
    return jsonb_build_object('error', 'time_expired');
  end if;

  select q.options, q.correct_index, q.explanation
    into v_options, v_correct, v_explanation
    from public.questions q
   where q.id = p_question_id and q.quiz_id = v_session.quiz_id;

  if not found then
    return jsonb_build_object('error', 'invalid_question');
  end if;

  if p_selected_index is null
     or p_selected_index < 0
     or p_selected_index >= cardinality(v_options) then
    return jsonb_build_object('error', 'invalid_selected_index');
  end if;

  v_is_correct := (p_selected_index = v_correct);

  if v_session.mode = 'assessment' then
    -- First answer wins; a re-answer returns `already_answered` WITHOUT any
    -- correctness signal (reveal-gated; leaking is_correct mid-session would
    -- defeat the whole feature).
    insert into public.session_answers (session_id, question_id, selected_index, is_correct)
    values (v_session.id, p_question_id, p_selected_index, v_is_correct)
    on conflict (session_id, question_id) do nothing;

    get diagnostics v_rows = row_count;

    if v_rows = 0 then
      update public.quiz_sessions
         set last_activity_at = now()
       where id = v_session.id;
      return jsonb_build_object('error', 'already_answered');
    end if;
  else
    -- Practice re-answer is always a 200 upsert (never already_answered).
    insert into public.session_answers (session_id, question_id, selected_index, is_correct)
    values (v_session.id, p_question_id, p_selected_index, v_is_correct)
    on conflict (session_id, question_id) do update
      set selected_index = excluded.selected_index,
          is_correct = excluded.is_correct,
          answered_at = now();
  end if;

  update public.quiz_sessions
     set last_activity_at = now()
   where id = v_session.id;

  -- Keyless ack for assessment (no is_correct, no key — reveal-gated).
  if v_session.mode = 'assessment' then
    return jsonb_build_object('recorded', true);
  end if;

  if v_explanation is null then
    return jsonb_build_object(
      'is_correct', v_is_correct,
      'correct_index', v_correct
    );
  end if;
  return jsonb_build_object(
    'is_correct', v_is_correct,
    'correct_index', v_correct,
    'explanation', v_explanation
  );
end;
$$;

revoke execute on function public.answer_question(uuid, uuid, int) from public, anon;
grant execute on function public.answer_question(uuid, uuid, int) to authenticated;

-- ─── 7. REDEFINED submit_session: score gating + auto-reveal ────────
-- Adds to the 0009 semantics:
--  - assessment score/total are NULL until reveal (submitted = awaiting).
--  - when auto_reveal_on_complete and this is the LAST active/paused/flagged
--    assessment session (2h staleness, per ABANDON_STALE_MS), the reveal flips
--    atomically in the SAME transaction (quiz advisory lock + guarded WHERE).
-- Lock ordering (PLAN v4 §8): session row for update → quiz_reveal advisory
-- lock → mark completed → count → guarded reveal. Skipped on already_submitted.
create or replace function public.submit_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_score   int;
  v_total   int;
  v_revealed boolean;
  v_all_done boolean;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'student'
  ) then
    return jsonb_build_object('error', 'not_student');
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  select count(*) into v_total
    from public.questions q
   where q.quiz_id = v_session.quiz_id;

  -- Reveal state derived from the CURRENT rule (practice always reveals).
  v_revealed := public.is_student_reveal_allowed(v_session.quiz_id);

  -- Re-submit idempotency: return the stored result — score reveal-gated.
  if v_session.status = 'completed' then
    if v_session.mode = 'assessment' and not v_revealed then
      return jsonb_build_object(
        'session', jsonb_build_object(
          'id', v_session.id,
          'quiz_id', v_session.quiz_id,
          'student_id', v_session.student_id,
          'mode', v_session.mode,
          'status', v_session.status,
          'started_at', v_session.started_at,
          'submitted_at', v_session.submitted_at,
          'score', null,
          'last_activity_at', v_session.last_activity_at
        ),
        'score', null,
        'total', null,
        'already_submitted', true
      );
    end if;
    return jsonb_build_object(
      'session', jsonb_build_object(
        'id', v_session.id,
        'quiz_id', v_session.quiz_id,
        'student_id', v_session.student_id,
        'mode', v_session.mode,
        'status', v_session.status,
        'started_at', v_session.started_at,
        'submitted_at', v_session.submitted_at,
        'score', v_session.score,
        'last_activity_at', v_session.last_activity_at
      ),
      'score', v_session.score,
      'total', v_total,
      'already_submitted', true
    );
  end if;

  if v_session.status not in ('active', 'paused') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  select count(*) into v_score
    from public.session_answers sa
   where sa.session_id = v_session.id and sa.is_correct;

  update public.quiz_sessions
     set status = 'completed',
         score = v_score,
         submitted_at = clock_timestamp(),
         last_activity_at = clock_timestamp()
   where id = v_session.id;

  -- ── Auto-reveal (assessment only, single transaction) ─────────────
  if v_session.mode = 'assessment' then
    -- Serialize count-then-reveal across concurrent last-submits.
    perform pg_advisory_xact_lock(hashtext('quiz_reveal:' || v_session.quiz_id::text));

    -- "All done" = no fresh (≤2h) active/paused/flagged assessment sessions.
    -- Stale sessions read as done; `flagged` blocks (lecturer decision first).
    select not exists (
      select 1 from public.quiz_sessions s
      where s.quiz_id = v_session.quiz_id
        and s.mode = 'assessment'
        and s.status in ('active', 'paused', 'flagged')
        and s.last_activity_at >= now() - interval '2 hours'
    ) into v_all_done;

    if v_all_done then
      update public.quizzes
         set results_revealed_at = clock_timestamp()
       where id = v_session.quiz_id
         and auto_reveal_on_complete
         and results_revealed_at is null
         and status = 'live';
      -- row_count 0 = not the flipper (idempotent; no side effect to re-run).
    end if;

    -- Re-read reveal state AFTER the guarded flip (same transaction sees it).
    v_revealed := public.is_student_reveal_allowed(v_session.quiz_id);
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id;

  if v_session.mode = 'assessment' and not v_revealed then
    return jsonb_build_object(
      'session', jsonb_build_object(
        'id', v_session.id,
        'quiz_id', v_session.quiz_id,
        'student_id', v_session.student_id,
        'mode', v_session.mode,
        'status', v_session.status,
        'started_at', v_session.started_at,
        'submitted_at', v_session.submitted_at,
        'score', null,
        'last_activity_at', v_session.last_activity_at
      ),
      'score', null,
      'total', null
    );
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_session.id,
      'quiz_id', v_session.quiz_id,
      'student_id', v_session.student_id,
      'mode', v_session.mode,
      'status', v_session.status,
      'started_at', v_session.started_at,
      'submitted_at', v_session.submitted_at,
      'score', v_session.score,
      'last_activity_at', v_session.last_activity_at
    ),
    'score', v_score,
    'total', v_total
  );
end;
$$;

revoke execute on function public.submit_session(uuid) from public, anon;
grant execute on function public.submit_session(uuid) to authenticated;

-- ─── 8. student_results RPC (D10-safe student breakdown) ────────────
-- security definer: re-validates role + enrollment + reveal inside. Single
-- no-oracle error `not_revealed` folds not-enrolled / no-such-quiz /
-- not-revealed. Session scoped to the CALLER (auth.uid()).
-- Practice: most recent COMPLETED session (practice creates many sessions).
-- Assessment: the unique session.
create or replace function public.student_results(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_score   int;
  v_total   int;
  v_questions jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'student'
  ) then
    return jsonb_build_object('error', 'not_student');
  end if;

  -- Single no-oracle gate: not enrolled / quiz gone / not revealed → same error.
  if not public.is_student_reveal_allowed(p_quiz_id) then
    return jsonb_build_object('error', 'not_revealed');
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid() and s.status = 'completed'
   order by s.started_at desc
   limit 1;

  if not found then
    return jsonb_build_object('error', 'not_revealed');
  end if;

  select count(*) into v_total
    from public.questions q
   where q.quiz_id = p_quiz_id;

  if v_session.mode = 'assessment' then
    v_score := coalesce(v_session.score, 0);
  else
    select count(*) into v_score
      from public.session_answers sa
     where sa.session_id = v_session.id and sa.is_correct;
  end if;

  select coalesce(jsonb_agg(js order by (js->>'order_index')::int), '[]'::jsonb) into v_questions
  from (
    select jsonb_build_object(
      'question_id', q.id,
      'order_index', q.order_index,
      'type', q.type,
      'prompt', q.prompt,
      'options', q.options,
      'selected_index', sa.selected_index,
      'is_correct', sa.is_correct,
      'correct_index', q.correct_index,
      'explanation', q.explanation
    ) as js
    from public.questions q
    left join public.session_answers sa
      on sa.question_id = q.id and sa.session_id = v_session.id
    where q.quiz_id = p_quiz_id
  ) t;

  return jsonb_build_object(
    'score', v_score,
    'total', v_total,
    'questions', v_questions
  );
end;
$$;

revoke execute on function public.student_results(uuid) from public, anon;
grant execute on function public.student_results(uuid) to authenticated;
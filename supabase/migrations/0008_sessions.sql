-- InnoVision — Phase 5: quiz sessions, answers, one-attempt, server timer
-- Depends on: 0004_quizzes.sql (quizzes/questions/quiz_mode/quiz_status,
-- is_lecturer_of_quiz), 0002_classes.sql (class_enrollments, is_enrolled_in_class),
-- 0006_quiz_and_roster_secrecy.sql (student_quiz_view).
--
-- Adds:
--  1. `session_status` enum + `quiz_sessions` + `session_answers` tables.
--  2. Partial unique index `one_assessment_attempt` — the atomic one-attempt
--     guard (closes the concurrent-start race, D1).
--  3. `student_question_view` (security barrier, NO `correct_index`/
--     `explanation`) gated by `can_student_view_quiz` — students can now read
--     questions, but never the key or the explanation text that identifies it.
--  4. Security-definer RPCs `start_quiz_session` / `answer_question` /
--     `submit_session` — the ONLY write paths (no direct INSERT/UPDATE policies).
--  5. Privilege-layer grants: `revoke all` then `select`-only for
--     `authenticated`; full `service_role`. RLS is the backstop; the grants
--     match intent (D47's anon denial asserts RLS/rows, not privilege absence).

-- ─── Enum (idempotent) ─────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'session_status') then
    create type public.session_status as enum ('active', 'paused', 'flagged', 'completed');
  end if;
end
$$;

-- ─── quiz_sessions ─────────────────────────────────────────────────
-- mode is COPIED from the quiz by start_quiz_session (the only insert path);
-- there is no direct INSERT policy, so a mismatched direct insert is
-- impossible for authenticated users (service_role is trusted).
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

-- The real one-attempt race guard: at most ONE assessment session per
-- (quiz, student). Concurrent starts → exactly one row; the RPC catches the
-- unique_violation and returns a typed `already_attempted` (D1).
create unique index if not exists one_assessment_attempt
  on public.quiz_sessions (quiz_id, student_id) where mode = 'assessment';

-- ─── session_answers ───────────────────────────────────────────────
-- Deliberately NO `correct_index`/`explanation` columns: storing them would
-- leak the answer key through the own-session SELECT policy in assessment.
-- `unique (session_id, question_id)` makes answers idempotent (no
-- double-count) and doubles as the session-scoped lookup index.
create table if not exists public.session_answers (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.quiz_sessions (id) on delete cascade,
  question_id    uuid not null references public.questions (id) on delete cascade,
  selected_index int check (selected_index is null or selected_index >= 0),
  is_correct     boolean not null,
  answered_at    timestamptz not null default now(),
  unique (session_id, question_id)
);

-- ─── Privilege-layer grants (intent, not just RLS) ─────────────────
-- New tables inherit broad default privileges; explicitly revoke then grant
-- `select`-only to `authenticated` so a student can never write via
-- PostgREST even if an RLS policy is later misconfigured. service_role gets
-- full access (trusted server-side client).
revoke all on public.quiz_sessions, public.session_answers from anon, authenticated;
grant select on public.quiz_sessions  to authenticated;
grant select on public.session_answers to authenticated;
grant all on public.quiz_sessions, public.session_answers to service_role;

-- ─── RLS helper: can the current student view this quiz's questions? ─
-- security definer + pinned search_path (breaks policy recursion). Enrolled
-- AND live only — a draft/closed quiz or a removed student gets false.
create or replace function public.can_student_view_quiz(p_quiz_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.quizzes q
    join public.class_enrollments ce on ce.class_id = q.class_id
    where q.id = p_quiz_id and ce.student_id = auth.uid() and q.status = 'live'
  );
$$;

revoke execute on function public.can_student_view_quiz(uuid) from public, anon;
grant execute on function public.can_student_view_quiz(uuid) to authenticated;

-- ─── RLS helper: is the caller the session's student or quiz's lecturer? ─
create or replace function public.is_session_owner_or_lecturer(p_session_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.quiz_sessions s
    where s.id = p_session_id
      and (s.student_id = auth.uid() or public.is_lecturer_of_quiz(s.quiz_id))
  );
$$;

revoke execute on function public.is_session_owner_or_lecturer(uuid) from public, anon;
grant execute on function public.is_session_owner_or_lecturer(uuid) to authenticated;

-- ─── student_question_view — no correct_index, no explanation ──────
-- Explanation text identifies the correct option; showing it before
-- answering defeats the quiz. `created_at` is exposed deliberately so the
-- play page can ORDER BY order_index, created_at (P3 convention) — it leaks
-- nothing. security_barrier prevents PostgREST from pushing `.eq("quiz_id")`
-- under the barrier, so can_student_view_quiz runs per row — two covered
-- index lookups (quizzes PK, class_enrollments PK) — trivial at demo scale.
create or replace view public.student_question_view
with (security_barrier = true)
as
select q.id, q.quiz_id, q.order_index, q.type, q.prompt, q.options, q.created_at
from public.questions q
where public.can_student_view_quiz(q.quiz_id);

grant select on public.student_question_view to authenticated;

-- ─── RLS on quiz_sessions ──────────────────────────────────────────
alter table public.quiz_sessions enable row level security;

-- Own sessions (play page) + lecturer (P8 results; D7 cross-student denial).
drop policy if exists "Student can view own session or lecturer of quiz" on public.quiz_sessions;
create policy "Student can view own session or lecturer of quiz"
  on public.quiz_sessions for select
  using (student_id = auth.uid() or is_lecturer_of_quiz(quiz_id));

-- NO INSERT / UPDATE policy — writes are RPC-only.
-- P8 session-reset: lecturers may delete a session (harmless now).
drop policy if exists "Lecturer can delete session" on public.quiz_sessions;
create policy "Lecturer can delete session"
  on public.quiz_sessions for delete
  using (is_lecturer_of_quiz(quiz_id));

-- ─── RLS on session_answers ────────────────────────────────────────
alter table public.session_answers enable row level security;

-- Own answers (resume) + lecturer (P8). No INSERT/UPDATE/DELETE policy —
-- RPC-only writes; students cannot forge answers.
drop policy if exists "Student can view own answers or lecturer of quiz" on public.session_answers;
create policy "Student can view own answers or lecturer of quiz"
  on public.session_answers for select
  using (is_session_owner_or_lecturer(session_id));

-- ─── start_quiz_session RPC ────────────────────────────────────────
-- security definer: bypasses RLS, so it MUST re-validate auth.uid() + role +
-- live + enrollment. Returns typed errors (join_class template); never raises
-- for business rules. Practice rejoins a non-terminal session under a
-- per-(quiz,student) advisory lock; assessment is one-attempt (unique index).
create or replace function public.start_quiz_session(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode  public.quiz_mode;
  v_status public.quiz_status;
  v_session public.quiz_sessions;
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

  -- Single no-oracle error for missing/draft/closed: a student must not be
  -- able to distinguish a nonexistent quiz from an unopened one.
  select q.mode, q.status into v_mode, v_status
    from public.quizzes q
   where q.id = p_quiz_id;

  if v_status is null or v_status <> 'live' then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  if not exists (
    select 1 from public.class_enrollments ce
    join public.quizzes q on q.class_id = ce.class_id
    where q.id = p_quiz_id and ce.student_id = auth.uid()
  ) then
    return jsonb_build_object('error', 'not_enrolled');
  end if;

  if v_mode = 'practice' then
    -- Serialize concurrent double-clicks / two-tab starts per (quiz, student)
    -- so "refresh resumes the same session" is real, not soft.
    perform pg_advisory_xact_lock(hashtext(
      'quiz_start:' || p_quiz_id::text || ':' || auth.uid()::text
    ));

    select s.* into v_session
      from public.quiz_sessions s
     where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
       and s.mode = 'practice' and s.status in ('active', 'paused')
     order by s.started_at desc
     limit 1;

    if found then
      return jsonb_build_object('session', jsonb_build_object(
        'id', v_session.id,
        'quiz_id', v_session.quiz_id,
        'student_id', v_session.student_id,
        'mode', v_session.mode,
        'status', v_session.status,
        'started_at', v_session.started_at,
        'submitted_at', v_session.submitted_at,
        'score', v_session.score,
        'last_activity_at', v_session.last_activity_at
      ));
    end if;

    insert into public.quiz_sessions (quiz_id, student_id, mode, status)
    values (p_quiz_id, auth.uid(), 'practice', 'active')
    returning * into v_session;

    return jsonb_build_object('session', jsonb_build_object(
      'id', v_session.id,
      'quiz_id', v_session.quiz_id,
      'student_id', v_session.student_id,
      'mode', v_session.mode,
      'status', v_session.status,
      'started_at', v_session.started_at,
      'submitted_at', v_session.submitted_at,
      'score', v_session.score,
      'last_activity_at', v_session.last_activity_at
    ));
  end if;

  -- Assessment: pre-check, then insert; the partial unique index closes the
  -- concurrent-start race (D1). unique_violation → typed already_attempted.
  select s.* into v_session
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
     and s.mode = 'assessment';

  if found then
    return jsonb_build_object('error', 'already_attempted', 'session_id', v_session.id);
  end if;

  begin
    insert into public.quiz_sessions (quiz_id, student_id, mode, status)
    values (p_quiz_id, auth.uid(), 'assessment', 'active')
    returning * into v_session;
  exception when unique_violation then
    select s.* into v_session
      from public.quiz_sessions s
     where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
       and s.mode = 'assessment';
    if not found then
      return jsonb_build_object('error', 'already_attempted');
    end if;
    return jsonb_build_object('error', 'already_attempted', 'session_id', v_session.id);
  end;

  return jsonb_build_object('session', jsonb_build_object(
    'id', v_session.id,
    'quiz_id', v_session.quiz_id,
    'student_id', v_session.student_id,
    'mode', v_session.mode,
    'status', v_session.status,
    'started_at', v_session.started_at,
    'submitted_at', v_session.submitted_at,
    'score', v_session.score,
    'last_activity_at', v_session.last_activity_at
  ));
end;
$$;

revoke execute on function public.start_quiz_session(uuid) from public, anon;
grant execute on function public.start_quiz_session(uuid) to authenticated;

-- ─── answer_question RPC ───────────────────────────────────────────
-- security definer: re-validates auth.uid() + role + ownership (lock +
-- ownership in ONE query — a guessed foreign session id is never row-locked,
-- so it can't contend on the victim's lock), status, live + enrollment,
-- timer (clock_timestamp() + SQL-constant 5s grace — never caller-supplied),
-- question membership, and selected_index bounds incl. NULL.
-- The RPC is the SOLE decider of practice vs assessment response shape.
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

  -- Lock + ownership in one query: missing OR non-owned → not_owner (single
  -- no-oracle 404; a foreign id is never row-locked).
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  -- paused/flagged/completed all map here (single 409 session_not_active).
  if v_session.status <> 'active' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- Quiz must still be live (lecturer closed mid-session) and the student
  -- still enrolled (removed mid-session cannot keep answering from cached
  -- questions) — both map to the SAME single error, no oracle.
  if not exists (
    select 1 from public.quizzes q
    where q.id = v_session.quiz_id and q.status = 'live'
  ) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  if not public.can_student_view_quiz(v_session.quiz_id) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  -- Authoritative timer. clock_timestamp() (not now()) so time spent waiting
  -- on the session row-lock counts against the deadline. Grace is a SQL
  -- constant `interval '5 seconds'` — never an argument, so a caller cannot
  -- pass a larger grace. NOTE: the quiz-live existence check above is
  -- separate from this read so an UNTIMED live quiz (time_limit_sec = null)
  -- is not mistaken for a missing quiz.
  select q.time_limit_sec into v_time_limit
    from public.quizzes q
   where q.id = v_session.quiz_id;

  if v_time_limit is not null
     and clock_timestamp() > v_session.started_at
         + (v_time_limit * interval '1 second')
         + interval '5 seconds' then
    return jsonb_build_object('error', 'time_expired');
  end if;

  -- Question must belong to THIS quiz.
  select q.options, q.correct_index, q.explanation
    into v_options, v_correct, v_explanation
    from public.questions q
   where q.id = p_question_id and q.quiz_id = v_session.quiz_id;

  if not found then
    return jsonb_build_object('error', 'invalid_question');
  end if;

  -- Bounds-check explicitly including NULL (SQL NULL < 0 is NULL and would
  -- slip a naive guard).
  if p_selected_index is null
     or p_selected_index < 0
     or p_selected_index >= cardinality(v_options) then
    return jsonb_build_object('error', 'invalid_selected_index');
  end if;

  v_is_correct := (p_selected_index = v_correct);

  if v_session.mode = 'assessment' then
    -- First answer wins; a re-answer returns the EXISTING row's is_correct.
    insert into public.session_answers (session_id, question_id, selected_index, is_correct)
    values (v_session.id, p_question_id, p_selected_index, v_is_correct)
    on conflict (session_id, question_id) do nothing;

    get diagnostics v_rows = row_count;

    if v_rows = 0 then
      select sa.is_correct into v_is_correct
        from public.session_answers sa
       where sa.session_id = v_session.id and sa.question_id = p_question_id;
      update public.quiz_sessions
         set last_activity_at = now()
       where id = v_session.id;
      return jsonb_build_object('error', 'already_answered', 'is_correct', v_is_correct);
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

  -- The RPC is the sole decider of mode; NEVER correct_index in assessment.
  if v_session.mode = 'assessment' then
    return jsonb_build_object('is_correct', v_is_correct);
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

-- ─── submit_session RPC ────────────────────────────────────────────
-- security definer. Lock + ownership in one query (as answer_question).
-- Re-submit is idempotent (returns existing score + already_submitted).
-- NO timer rejection: submit past the deadline is ALLOWED (documented
-- deviation — rejecting would strand a student whose auto-submit arrives
-- >grace late; the timer's job is stopping ANSWERS, pinned by D45).
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

  -- Re-submit idempotency: return the stored result, no recompute.
  if v_session.status = 'completed' then
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

  if v_session.status <> 'active' then
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

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id;

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

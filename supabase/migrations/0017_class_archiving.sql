-- InnoVision — Class Soft Delete / Archiving
-- Adds archived_at to public.classes, updates student_class_view, student_quiz_view,
-- can_student_view_quiz, start_quiz_session, and join_class RPC.

-- 1. Add archived_at column to classes if not exists
alter table public.classes
  add column if not exists archived_at timestamptz default null;

create index if not exists classes_archived_at_idx
  on public.classes (archived_at);

-- Partial index for fast active class lookup
create index if not exists classes_active_idx
  on public.classes (id)
  where archived_at is null;

-- Partial index for lecturer dashboard active classes sorting
create index if not exists classes_lecturer_active_idx
  on public.classes (lecturer_id, created_at desc)
  where archived_at is null;

-- 2. Update student_class_view to only expose non-archived classes
drop view if exists public.student_class_view;
create or replace view public.student_class_view
with (security_barrier = true)
as
select c.id, c.title, c.created_at
from public.classes c
where public.is_enrolled_in_class(c.id)
  and c.archived_at is null;

revoke all on public.student_class_view from anon, public;
grant select on public.student_class_view to authenticated;

-- 3. Update student_quiz_view to exclude quizzes from archived classes
drop view if exists public.student_quiz_view;
create or replace view public.student_quiz_view
with (security_barrier = true)
as
select q.id, q.class_id, q.title, q.mode, q.status, q.time_limit_sec,
       q.created_at, q.results_revealed_at
from public.quizzes q
join public.classes c on c.id = q.class_id
where public.is_enrolled_in_class(q.class_id)
  and q.status = 'live'
  and c.archived_at is null;

revoke all on public.student_quiz_view from anon, public;
grant select on public.student_quiz_view to authenticated;

-- 4. Update can_student_view_quiz helper to reject archived classes
create or replace function public.can_student_view_quiz(p_quiz_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    join public.class_enrollments ce on ce.class_id = q.class_id
    where q.id = p_quiz_id
      and ce.student_id = auth.uid()
      and q.status = 'live'
      and c.archived_at is null
  );
$$;

revoke execute on function public.can_student_view_quiz(uuid) from public, anon;
grant execute on function public.can_student_view_quiz(uuid) to authenticated;

-- 5. Update start_quiz_session RPC to reject archived classes
create or replace function public.start_quiz_session(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode        public.quiz_mode;
  v_status      public.quiz_status;
  v_archived_at timestamptz;
  v_session     public.quiz_sessions;
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

  -- Single no-oracle error for missing/draft/closed/archived
  select q.mode, q.status, c.archived_at
    into v_mode, v_status, v_archived_at
    from public.quizzes q
    join public.classes c on c.id = q.class_id
   where q.id = p_quiz_id;

  if v_status is null or v_status <> 'live' or v_archived_at is not null then
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

  -- Assessment: pre-check, then insert
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

-- 6. Update join_class RPC to disallow enrolling in archived classes
create or replace function public.join_class(code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id    uuid;
  v_title       text;
  v_archived_at timestamptz;
  v_rows        int;
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

  select c.id, c.title, c.archived_at
    into v_class_id, v_title, v_archived_at
    from public.classes c
   where c.join_code = upper(trim(code));

  if v_class_id is null then
    return jsonb_build_object('error', 'invalid_code');
  end if;

  if v_archived_at is not null then
    return jsonb_build_object('error', 'class_archived');
  end if;

  insert into public.class_enrollments (class_id, student_id)
  values (v_class_id, auth.uid())
  on conflict (class_id, student_id) do nothing;

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return jsonb_build_object('error', 'already_enrolled');
  end if;

  return jsonb_build_object('class', jsonb_build_object(
    'id', v_class_id,
    'title', v_title
  ));
end;
$$;

revoke execute on function public.join_class(text) from public, anon;
grant execute on function public.join_class(text) to authenticated;

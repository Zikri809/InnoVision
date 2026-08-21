-- InnoVision — Migration 0019: Robustness Hardening Fixes
-- Addresses M2, M3, M10, and storage bloat protections.

-- ─── 1. Session Timer Extension on Pause/Resume (M3) ───────────────
alter table public.quiz_sessions add column if not exists paused_at timestamptz;

-- Redefine pause_session to record paused_at
create or replace function public.pause_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.mode <> 'assessment' then
    return jsonb_build_object('error', 'not_assessment');
  end if;

  if v_session.status in ('completed', 'flagged') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  if v_session.status = 'active' then
    update public.quiz_sessions
       set status = 'paused',
           paused_at = coalesce(paused_at, clock_timestamp()),
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  end if;

  return jsonb_build_object('sessionStatus', 'paused');
end;
$$;

-- Redefine self_recover_session to extend started_at by the paused duration
create or replace function public.self_recover_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_next_nonce uuid;
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

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  if v_session.status = 'flagged' then
    return jsonb_build_object('error', 'flagged');
  end if;

  if v_session.status = 'active' then
    return jsonb_build_object('sessionStatus', 'active');
  end if;

  if v_session.paused_at is not null then
    update public.quiz_sessions
       set status = 'active',
           started_at = started_at + (clock_timestamp() - v_session.paused_at),
           paused_at = null,
           face_fail_streak = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  else
    update public.quiz_sessions
       set status = 'active',
           face_fail_streak = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  end if;

  insert into public.audit_events (actor_id, subject_id, action)
  values (auth.uid(), auth.uid(), 'self_recover');

  return jsonb_build_object(
    'sessionStatus', 'active',
    'nextNonce', v_next_nonce
  );
end;
$$;

-- Redefine unlock_session to extend started_at by the paused duration
create or replace function public.unlock_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_next_nonce uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'lecturer'
  ) then
    return jsonb_build_object('error', 'not_lecturer');
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id
     and public.is_lecturer_of_quiz(s.quiz_id)
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  if v_session.paused_at is not null then
    update public.quiz_sessions
       set status = 'active',
           started_at = started_at + (clock_timestamp() - v_session.paused_at),
           paused_at = null,
           face_fail_streak = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  else
    update public.quiz_sessions
       set status = 'active',
           face_fail_streak = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  end if;

  insert into public.audit_events (actor_id, subject_id, action)
  values (auth.uid(), v_session.student_id, 'unlock');

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

-- Redefine record_face_check to record paused_at on transition to paused
create or replace function public.record_face_check(
  p_session_id       uuid,
  p_frame            text,
  p_trigger          public.face_check_trigger default 'periodic',
  p_client_nonce     uuid default null,
  p_claimed_distance float8 default null,
  p_claimed_matched  boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session       public.quiz_sessions;
  -- `face_enrollment_status` is a TEXT column (0010), not an enum type.
  v_enrolled      text;
  v_student_id    uuid;
  v_quiz_id       uuid;
  v_matched       boolean;
  v_distance      float8;
  v_fails         int;
  v_new_status    public.session_status;
  v_new_streak    int;
  v_next_nonce    uuid;
  v_recent        boolean[];
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

  if p_claimed_matched is null or p_claimed_distance is null then
    return jsonb_build_object('error', 'missing_claimed_verdict');
  end if;

  if p_claimed_distance is not null and (p_claimed_distance < 0 or p_claimed_distance > 2) then
    return jsonb_build_object('error', 'invalid_distance');
  end if;

  if p_frame is null or length(p_frame) > 200000 then
    return jsonb_build_object('error', 'invalid_frame');
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.status in ('paused', 'flagged') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_completed');
  end if;

  if v_session.verify_nonce is not null then
    if p_client_nonce is null or p_client_nonce <> v_session.verify_nonce then
      return jsonb_build_object('error', 'stale_nonce');
    end if;
  end if;

  v_student_id := v_session.student_id;
  v_quiz_id := v_session.quiz_id;

  select p.face_enrollment_status into v_enrolled
    from public.profiles p
   where p.id = v_student_id;

  if v_enrolled is null or v_enrolled <> 'enrolled' then
    return jsonb_build_object('error', 'not_enrolled');
  end if;

  v_matched := p_claimed_matched;
  v_distance := p_claimed_distance;

  insert into public.face_checks (
    session_id,
    student_id,
    quiz_id,
    matched,
    distance,
    trigger
  )
  values (
    v_session.id,
    v_student_id,
    v_quiz_id,
    v_matched,
    v_distance,
    p_trigger
  );

  select array_agg(t.matched order by t.created_at desc)
    into v_recent
    from (
      select fc.matched, fc.created_at
        from public.face_checks fc
       where fc.session_id = v_session.id
       order by fc.created_at desc
       limit 5
    ) t;

  if v_matched then
    v_new_status := 'active';
    v_new_streak := 0;
  else
    v_fails := 0;
    for i in 1..cardinality(v_recent) loop
      if not v_recent[i] then
        v_fails := v_fails + 1;
      end if;
    end loop;
    if v_fails >= 3 then
      v_new_status := 'flagged';
    else
      v_new_status := 'paused';
    end if;
    v_new_streak := v_fails;
  end if;

  update public.quiz_sessions
     set status = v_new_status,
         paused_at = case
           when v_new_status = 'paused' then coalesce(paused_at, clock_timestamp())
           when v_new_status = 'active' then null
           else paused_at
         end,
         face_fail_streak = v_new_streak,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_next_nonce;

  return jsonb_build_object(
    'matched', v_matched,
    'distance', v_distance,
    'sessionStatus', v_new_status,
    'nextNonce', v_next_nonce,
    'streak', v_new_streak
  );
end;
$$;


-- ─── 2. Profiles Update Policy Fix & Sensitive Column Protection (M10) ───
-- Fix policy: allow lecturers (and students) to update their own profile
drop policy if exists "Users update own profile" on public.profiles;

create policy "Users update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Prevent clients from directly changing role or consent_given_at via PostgREST
create or replace function public.protect_profile_restricted_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Sanctioned consent flows opt in by setting app.consent_write='on'
  -- in-transaction (grant_face_consent / revoke_face_consent). Everyone else
  -- is blocked — including SECURITY DEFINER callers that did not opt in,
  -- because auth.role() reads the JWT claim, not the function owner.
  if auth.role() = 'authenticated'
     and coalesce(current_setting('app.consent_write', true), '') <> 'on' then
    if NEW.role is distinct from OLD.role then
      raise exception 'cannot_change_role_directly' using errcode = '42501';
    end if;
    if NEW.consent_given_at is distinct from OLD.consent_given_at then
      raise exception 'cannot_change_consent_directly' using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tr_protect_profile_restricted_columns on public.profiles;
create trigger tr_protect_profile_restricted_columns
  before update on public.profiles
  for each row execute function public.protect_profile_restricted_columns();


-- ─── 3. Storage Bloat Guard on save_quiz_questions ────────────────────
-- This redefinition changes the return type (setof questions → void), which
-- Postgres forbids via CREATE OR REPLACE — drop the 0016 signature first.
drop function if exists public.save_quiz_questions(
  p_quiz_id         uuid,
  p_title           text,
  p_source_file_url text,
  p_source_text     text,
  p_questions       jsonb,
  p_mode            text
);
create or replace function public.save_quiz_questions(
  p_quiz_id         uuid,
  p_title           text,
  p_source_file_url text,
  p_source_text     text,
  p_questions       jsonb,
  p_mode            text default 'replace'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count          int;
  v_i              int;
  v_q              jsonb;
  v_type           text;
  v_prompt         text;
  v_options        text[];
  v_correct        int;
  v_expl           text;
  v_source_entry   jsonb;
  v_existing_count int;
  v_start_index    int;
  v_max_quiz_cap   int := 30;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  if not public.is_lecturer_of_quiz(p_quiz_id) then
    raise exception 'not_quiz_owner' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.quizzes q
    where q.id = p_quiz_id and q.status = 'draft'
  ) then
    raise exception 'quiz_not_draft' using errcode = 'P0001';
  end if;

  if p_mode not in ('replace', 'append') then
    raise exception 'invalid_mode' using errcode = 'P0001';
  end if;

  -- Bounded source_text cap to prevent storage bloat
  if p_source_text is not null and char_length(p_source_text) > 400000 then
    raise exception 'source_text_too_large' using errcode = 'P0001';
  end if;

  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    raise exception 'invalid_questions_json' using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_questions);
  if (p_mode = 'replace' and v_count < 3) or (p_mode = 'append' and v_count < 1) or v_count > 30 then
    raise exception 'invalid_questions_json' using errcode = 'P0001';
  end if;

  if p_title is not null and (char_length(trim(p_title)) < 1 or char_length(p_title) > 200) then
    raise exception 'invalid_title' using errcode = 'P0001';
  end if;

  if p_mode = 'replace' then
    delete from public.questions where quiz_id = p_quiz_id;
    v_start_index := 0;
  else
    select count(*), coalesce(max(order_index), -1) + 1
      into v_existing_count, v_start_index
      from public.questions
     where quiz_id = p_quiz_id;

    if (v_existing_count + v_count) > v_max_quiz_cap then
      raise exception 'quiz_question_limit_exceeded' using errcode = 'P0001';
    end if;
  end if;

  for v_i in 0 .. v_count - 1 loop
    v_q := p_questions -> v_i;
    if jsonb_typeof(v_q) <> 'object' then
      raise exception 'invalid_questions_json' using errcode = 'P0001';
    end if;

    v_type    := v_q ->> 'type';
    v_prompt  := v_q ->> 'prompt';
    v_options := coalesce((
      select array_agg(elem::text)
      from jsonb_array_elements_text(v_q -> 'options') as elem
    ), '{}'::text[]);
    v_correct := (v_q ->> 'correct_index')::int;
    v_expl    := v_q ->> 'explanation';

    if v_type is null or v_prompt is null
       or (v_q -> 'options') is null or jsonb_typeof(v_q -> 'options') <> 'array'
       or v_correct is null or v_correct < 0 then
      raise exception 'invalid_question_fields' using errcode = 'P0001';
    end if;

    insert into public.questions (
      quiz_id,
      order_index,
      type,
      prompt,
      options,
      correct_index,
      explanation
    )
    values (
      p_quiz_id,
      v_start_index + v_i,
      v_type::public.question_type,
      trim(v_prompt),
      v_options,
      v_correct,
      case when v_expl is null or length(trim(v_expl)) = 0 then null else trim(v_expl) end
    );
  end loop;

  if p_source_file_url is not null and p_source_file_url <> '' then
    v_source_entry := jsonb_build_object(
      'id', gen_random_uuid(),
      'filename', substring(p_source_file_url from '[^/]+$'),
      'storage_path', p_source_file_url,
      'added_at', clock_timestamp(),
      'mode', p_mode
    );
  else
    v_source_entry := null;
  end if;

  if p_mode = 'replace' then
    update public.quizzes
       set title = coalesce(p_title, title),
           source_file_url = p_source_file_url,
           source_text = p_source_text,
           sources = case
             when v_source_entry is not null then jsonb_build_array(v_source_entry)
             else '[]'::jsonb
           end
     where id = p_quiz_id;
  else
    update public.quizzes
       set title = coalesce(title, p_title),
           source_file_url = coalesce(p_source_file_url, source_file_url),
           source_text = case
             when source_text is null or source_text = '' then p_source_text
             when p_source_text is null or p_source_text = '' then source_text
             else source_text || E'\n\n--- [Additional Source Material] ---\n\n' || p_source_text
           end,
           sources = case
             when v_source_entry is not null then coalesce(sources, '[]'::jsonb) || jsonb_build_array(v_source_entry)
             else coalesce(sources, '[]'::jsonb)
           end
      where id = p_quiz_id;
   end if;
 end;
 $$;

-- ─── 4. Sanctioned consent write paths (companion to the trigger above) ──
-- The restricted-columns trigger blocks EVERY authenticated write to
-- consent_given_at — including the legitimate ones, because auth.role()
-- reads the JWT claim even inside SECURITY DEFINER functions. Both consent
-- flows therefore opt in via the app.consent_write GUC.

-- Grant: replaces the API route's direct `update({ consent_given_at })`,
-- which the trigger would now reject with cannot_change_consent_directly.
create or replace function public.grant_face_consent()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'student'
  ) then
    return jsonb_build_object('error', 'not_student');
  end if;

  perform set_config('app.consent_write', 'on', true);

  update public.profiles
     set consent_given_at = clock_timestamp()
   where id = v_actor;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (v_actor, v_actor, 'consent_granted', '{}'::jsonb);

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.grant_face_consent() from public, anon;
grant execute on function public.grant_face_consent() to authenticated;

-- Revoke: same body as 0010 with one addition — set app.consent_write='on'
-- so its own profiles update passes the new restricted-columns trigger.
create or replace function public.revoke_face_consent()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_flagged jsonb;
begin
  if v_actor is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'student'
  ) then
    return jsonb_build_object('error', 'not_student');
  end if;

  perform set_config('app.face_enroll', 'on', true);
  perform set_config('app.face_enroll_actor', v_actor::text, true);
  perform set_config('app.consent_write', 'on', true);

  update public.profiles
     set consent_given_at = null,
         face_enrollment_status = null,
         face_deletion_pending = true
   where id = v_actor;

  select coalesce(jsonb_agg(id), '[]'::jsonb)
    into v_flagged
    from (
      select id
        from public.quiz_sessions
       where student_id = v_actor and mode = 'assessment'
         and status in ('active', 'paused')
         for update
    ) s;

  update public.quiz_sessions
     set status = 'flagged'
   where student_id = v_actor and mode = 'assessment'
     and status in ('active', 'paused');

  -- Privacy cleanup for COMPLETED sessions only — in-progress fail history
  -- must not be wiped (a revoke cannot launder a live investigation).
  delete from public.face_checks fc
    using public.quiz_sessions s
   where fc.session_id = s.id
     and s.student_id = v_actor
     and s.status = 'completed';

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    v_actor,
    v_actor,
    'consent_revoked',
    jsonb_build_object('flagged_sessions', v_flagged)
  );

  return jsonb_build_object('ok', true, 'flagged_sessions', v_flagged);
end;
$$;

-- ─── 5. Join-code brute-force throttle (M2) ─────────────────────────────
-- DB-level lockout: the API-route limiter is in-memory per-process and is
-- fully bypassed when join_class() is called via direct PostgREST. Failures
-- are counted per student in a dedicated table (RLS-on, zero policies →
-- reachable only through this SECURITY DEFINER function). 5 bad codes in a
-- 10-minute window locks joins for that student for 15 minutes; any outcome
-- that proves code knowledge clears the counter.
create table if not exists public.class_join_attempts (
  student_id        uuid primary key references public.profiles (id) on delete cascade,
  fail_count        int not null default 0 check (fail_count >= 0),
  window_started_at timestamptz not null default now(),
  locked_until      timestamptz
);

alter table public.class_join_attempts enable row level security;
revoke all on public.class_join_attempts from anon, authenticated;

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

  -- Throttle bookkeeping: create/refresh the attempt row first.
  insert into public.class_join_attempts as a (student_id)
  values (auth.uid())
  on conflict (student_id) do nothing;

  update public.class_join_attempts a
     set fail_count        = case when a.window_started_at < clock_timestamp() - interval '10 minutes'
                                then 0 else a.fail_count end,
         window_started_at = case when a.window_started_at < clock_timestamp() - interval '10 minutes'
                                  then clock_timestamp() else a.window_started_at end
   where a.student_id = auth.uid();

  if exists (
    select 1 from public.class_join_attempts
     where student_id = auth.uid()
       and locked_until is not null
       and locked_until > clock_timestamp()
  ) then
    return jsonb_build_object('error', 'join_locked');
  end if;

  select c.id, c.title, c.archived_at
    into v_class_id, v_title, v_archived_at
    from public.classes c
   where c.join_code = upper(trim(code));

  if v_class_id is null then
    update public.class_join_attempts a
       set fail_count   = a.fail_count + 1,
           locked_until = case when a.fail_count + 1 >= 5
                               then clock_timestamp() + interval '15 minutes'
                               else a.locked_until end
     where a.student_id = auth.uid();
    return jsonb_build_object('error', 'invalid_code');
  end if;

  -- Code was valid — clear any failure state before proceeding.
  delete from public.class_join_attempts where student_id = auth.uid();

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

-- ─── 6. Retention pruning (unbounded growth) ─────────────────────────────
-- practice-mode sessions are scratch work (no assessment record value);
-- face_checks are biometric-adjacent metadata. Neither was ever pruned.
-- Assessment sessions are NEVER pruned here (permanent academic records).
create or replace function public.prune_expired_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sessions bigint;
  v_checks   bigint;
begin
  delete from public.quiz_sessions
   where mode = 'practice'
     and last_activity_at < clock_timestamp() - interval '90 days';
  get diagnostics v_sessions = row_count;

  delete from public.face_checks
   where checked_at < clock_timestamp() - interval '30 days';
  get diagnostics v_checks = row_count;

  return jsonb_build_object(
    'pruned_practice_sessions', v_sessions,
    'pruned_face_checks', v_checks
  );
end;
$$;

revoke all on function public.prune_expired_data() from public, anon;
grant execute on function public.prune_expired_data() to service_role;

-- Best-effort daily schedule. If pg_cron is unavailable in this environment,
-- invoke `select public.prune_expired_data();` from your scheduler instead.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('innovision-retention', '17 3 * * *',
    'select public.prune_expired_data()');
exception when others then
  raise notice 'pg_cron scheduling skipped (%); schedule prune_expired_data manually', sqlerrm;
end $$;

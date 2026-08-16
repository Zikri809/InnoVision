-- InnoVision — Phase 7: face pipeline (enroll → gate → continuous verify)
-- Depends on: 0008_sessions.sql (quiz_sessions, session_status, verify_nonce,
-- face_fail_streak, face_exempt, is_session_owner_or_lecturer, can_student_view_quiz),
-- 0001_profiles.sql (profiles.consent_given_at, profiles.face_embedding vector(192)).
--
-- Adds:
--  1. `face_check_trigger` enum + `face_checks` + `audit_events` tables.
--  2. `quiz_sessions.face_unavailable_at`.
--  3. Actor-bound guard trigger on `profiles.face_embedding` (service-role
--     writes intentionally blocked: auth.uid() is NULL in the service role).
--  4. Security-definer RPCs `enroll_face` / `revoke_face_consent` /
--     `record_face_check` / `self_recover_session` / `pause_session` /
--     `unlock_session` / `exempt_face_session` / `report_face_unavailable`,
--     plus a REDEFINED `submit_session` (`active`/`paused` submit; `flagged`
--     → `session_not_active` — a flagged outcome is a lecturer decision).
--  5. Privilege-layer grants: `revoke all` then `select`-only for
--     `authenticated` on `face_checks`; no authenticated grants on
--     `audit_events` (service_role only — P8 adds a lecturer view).
--
-- Key invariants (PLAN_PHASE7 §2):
--  - The server NEVER trusts a client verdict: `record_face_check` computes
--    `matched` from the stored embedding vs the submitted raw embedding;
--    thresholds (0.4) + 5s grace are SQL constants, never caller-supplied.
--  - `record_face_check` is ONE atomic RPC: `for update` serializes concurrent
--    verifies; the FLAT last-5 window is computed inside the same transaction.
--  - `face_checks` is RPC-write + select-only (RLS owner/lecturer).

-- ─── Enum (idempotent) ─────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'face_check_trigger') then
    create type public.face_check_trigger as enum ('start', 'question', 'periodic');
  end if;
end
$$;

-- ─── face_checks ───────────────────────────────────────────────────
-- Advisory flags only (`suspected_replay`/`too_frequent` never change the
-- status decision — they surface an honesty signal for the P8 lecturer view).
-- No embedding is stored here: only float arrays cross the wire; the RPC
-- compares the submitted embedding against the stored profile embedding.
create table if not exists public.face_checks (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.quiz_sessions (id) on delete cascade,
  checked_at      timestamptz not null default now(),
  matched         boolean not null,
  distance        float4,
  trigger         public.face_check_trigger not null,
  suspected_replay boolean not null default false,
  too_frequent    boolean not null default false
);

create index if not exists face_checks_session_idx
  on public.face_checks (session_id, checked_at);

-- RLS: owner (student) or lecturer of the quiz can read. Writes are RPC-only.
alter table public.face_checks enable row level security;

drop policy if exists "owner or lecturer reads face checks" on public.face_checks;
create policy "owner or lecturer reads face checks"
  on public.face_checks for select
  using (public.is_session_owner_or_lecturer(session_id));

-- ─── audit_events ──────────────────────────────────────────────────
-- Service-role only (P8 adds a lecturer view). Every biometric-sensitive
-- action (enroll/reenroll/revoke/unlock/exempt/self-recover) is audited.
create table if not exists public.audit_events (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references public.profiles (id) on delete set null,
  subject_id uuid not null,
  action     text not null,
  metadata   jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_subject_idx on public.audit_events (subject_id);
create index if not exists audit_events_actor_idx on public.audit_events (actor_id, created_at);

alter table public.audit_events enable row level security;

-- ─── quiz_sessions.face_unavailable_at ─────────────────────────────
alter table public.quiz_sessions
  add column if not exists face_unavailable_at timestamptz;

-- ─── Privilege-layer grants (intent, not just RLS) ─────────────────
revoke all on public.face_checks from anon, authenticated;
grant select on public.face_checks to authenticated;
grant all on public.face_checks to service_role;

revoke all on public.audit_events from anon, authenticated;
grant all on public.audit_events to service_role;

-- ─── Actor-bound guard trigger on face_embedding ───────────────────
-- A plain self-UPDATE policy on profiles would be an un-audited embedding
-- write hole. Only `enroll_face` (which sets both GUCs in-transaction) may
-- write `face_embedding`. Service-role writes are INTENTIONALLY blocked:
-- `auth.uid()` is NULL, so `auth.uid()::text = current_setting(...)` is NULL
-- (not true) and the guard raises `not_authorized`.
--
-- NOTE: uses `coalesce(..., '')` — SQL three-valued logic means a bare
-- `current_setting('app.face_enroll', true) <> 'on'` is NULL when unset, and
-- `IF NULL THEN` in plpgsql is treated as false (the guard would never fire).
-- The coalesce makes an unset GUC compare as `'' <> 'on'` → true → raised.
create or replace function public.profiles_face_embedding_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
     or coalesce(current_setting('app.face_enroll', true), '') <> 'on'
     or coalesce(current_setting('app.face_enroll_actor', true), '') <> auth.uid()::text then
    raise exception 'not_authorized';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_face_embedding_guard on public.profiles;
create trigger profiles_face_embedding_guard
  before update of face_embedding on public.profiles
  for each row execute function public.profiles_face_embedding_guard();

-- ─── enroll_face RPC ───────────────────────────────────────────────
-- security definer. (1) auth + student; (2) consent gate; (3) ever-enrolled
-- live-session gate — a revoke→re-enroll face swap mid-assessment is blocked,
-- but a GENUINE first-time enrollment stays allowed mid-session (breaks the
-- start-before-enrolling deadlock); (4) set GUCs + write the embedding;
-- (5) audit.
create or replace function public.enroll_face(p_embedding text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ever_enrolled boolean;
  v_has_live_session boolean;
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

  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.consent_given_at is not null
  ) then
    return jsonb_build_object('error', 'consent_required');
  end if;

  -- Ever-enrolled marker survives revocation (audit row is never deleted),
  -- so a revoke→re-enroll face swap is blocked while an assessment is live.
  select
    (p.face_embedding is not null
       or exists (
         select 1 from public.audit_events ae
         where ae.actor_id = v_actor and ae.action in ('face_enroll', 'face_reenroll')
       )
    ),
    exists (
      select 1 from public.quiz_sessions s
      where s.student_id = v_actor and s.mode = 'assessment'
        and s.status in ('active', 'paused', 'flagged')
    )
  into v_ever_enrolled, v_has_live_session;

  if v_has_live_session and v_ever_enrolled then
    return jsonb_build_object('error', 'live_assessment');
  end if;

  -- Invalid vector (wrong dims / non-numeric) → typed error (route → 400).
  begin
    perform p_embedding::vector(192);
  exception when others then
    return jsonb_build_object('error', 'invalid_embedding');
  end;

  perform set_config('app.face_enroll', 'on', true);
  perform set_config('app.face_enroll_actor', v_actor::text, true);

  update public.profiles
     set face_embedding = p_embedding::vector(192)
   where id = v_actor;

  if not found then
    return jsonb_build_object('error', 'not_student');
  end if;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    v_actor,
    v_actor,
    case when v_ever_enrolled then 'face_reenroll' else 'face_enroll' end,
    jsonb_build_object('has_live_session', v_has_live_session)
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.enroll_face(text) from public, anon;
grant execute on function public.enroll_face(text) to authenticated;

-- ─── revoke_face_consent RPC ───────────────────────────────────────
-- Session-coupled revocation: clears consent + embedding (both GUCs in-
-- transaction), flags every in-progress assessment session (answers AND
-- submits rejected until a lecturer unlocks/exempts/resets), deletes
-- face_checks ONLY for own completed sessions (privacy cleanup; NO
-- in-progress fail-history wipe), and audits. Re-consent restores
-- consent_given_at only — it does NOT clear `flagged` (lecturer decision).
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

  update public.profiles
     set consent_given_at = null,
         face_embedding = null
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

revoke execute on function public.revoke_face_consent() from public, anon;
grant execute on function public.revoke_face_consent() to authenticated;

-- ─── record_face_check RPC (the verify path) ───────────────────────
-- 14 steps, pinned ordering (PLAN_PHASE7 §2). One atomic transaction:
-- `for update` serializes concurrent verifies; the FLAT window is computed
-- inside the same lock.
create or replace function public.record_face_check(
  p_session_id uuid,
  p_embedding  text,
  p_trigger    public.face_check_trigger,
  p_nonce      uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session      public.quiz_sessions;
  v_stored_embedding public.profiles.face_embedding%type;
  v_distance     float4;
  v_matched      boolean;
  v_recent       boolean[];
  v_fails        int;
  v_new_status   public.session_status;
  v_new_streak   int;
  v_next_nonce   uuid;
  v_suspected_replay boolean := false;
  v_too_frequent boolean := false;
  v_prev_checked_at timestamptz;
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

  -- (1) Lock + ownership in one query (never row-lock a foreign id).
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  -- (2) Consent re-check (mid-session revocation blocks verify).
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.consent_given_at is not null
  ) then
    return jsonb_build_object('error', 'consent_required');
  end if;

  -- (3) Mode gate — practice/lecturer sessions never verify.
  if v_session.mode <> 'assessment' then
    return jsonb_build_object('error', 'not_assessment');
  end if;

  -- (4) Quiz still live + student still enrolled (parity with answer_question).
  if not public.can_student_view_quiz(v_session.quiz_id) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  -- (5) Completed → session_not_active (score already final).
  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- (6) face_exempt short-circuit: no row, no nonce rotation. The exempt
  -- student verifies trivially until a lecturer lifts the exemption.
  if v_session.face_exempt then
    return jsonb_build_object(
      'matched', true,
      'distance', null,
      'sessionStatus', v_session.status,
      'nextNonce', v_session.verify_nonce,
      'faceFailStreak', v_session.face_fail_streak
    );
  end if;

  -- (7) paused/flagged → session_not_active (verify cannot resurrect a
  -- paused session — only self_recover/blink can).
  if v_session.status in ('paused', 'flagged') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- (8) Stored embedding must exist (enrollment required).
  select p.face_embedding into v_stored_embedding
    from public.profiles p
   where p.id = auth.uid();

  if v_stored_embedding is null then
    return jsonb_build_object('error', 'not_enrolled');
  end if;

  -- (8b) NULL params: a direct RPC caller must not bypass the nonce check via
  -- SQL NULL comparison (`x <> NULL` is NULL, not true) nor hit an uncaught
  -- NOT NULL violation on the insert. Reject explicitly with typed errors.
  if p_nonce is null then
    return jsonb_build_object('error', 'nonce_mismatch');
  end if;
  if p_embedding is null then
    return jsonb_build_object('error', 'invalid_embedding');
  end if;
  if p_trigger is null then
    return jsonb_build_object('error', 'invalid_trigger');
  end if;

  -- (9) Nonce check + rotate. A stale nonce → nonce_mismatch (no row, no
  -- rotation); the client refetches via GET and retries ONCE.
  if v_session.verify_nonce <> p_nonce then
    return jsonb_build_object('error', 'nonce_mismatch');
  end if;

  -- (10) Server-computed verdict — NEVER caller-supplied. Threshold 0.4 is a
  -- SQL constant.
  begin
    v_distance := v_stored_embedding <=> p_embedding::vector(192);
  exception when others then
    return jsonb_build_object('error', 'invalid_embedding');
  end;
  v_matched := v_distance <= 0.4;

  -- Advisory flags (no status impact).
  v_suspected_replay := (p_embedding = v_stored_embedding::text);
  select checked_at into v_prev_checked_at
    from public.face_checks
   where session_id = v_session.id
   order by checked_at desc, id desc
   limit 1;
  v_too_frequent := v_prev_checked_at is not null
    and clock_timestamp() < v_prev_checked_at + interval '2 seconds';

  -- (11) Insert the check row (RPC-only write).
  insert into public.face_checks
    (session_id, matched, distance, trigger, suspected_replay, too_frequent)
  values
    (v_session.id, v_matched, v_distance, p_trigger, v_suspected_replay, v_too_frequent);

  -- (12) FLAT last-5 window (ordering pinned: checked_at DESC, id DESC —
  -- uuid is unordered). A pass never flags the current check.
  select coalesce(array_agg(matched order by checked_at desc, id desc), '{}'::boolean[])
    into v_recent
    from (
      select matched, checked_at, id
        from public.face_checks
       where session_id = v_session.id
       order by checked_at desc, id desc
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

  -- (13) Rotate nonce + touch last_activity_at in the same locked txn.
  update public.quiz_sessions
     set status = v_new_status,
         face_fail_streak = v_new_streak,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_next_nonce;

  -- (14) Return the verdict + rotated nonce.
  return jsonb_build_object(
    'matched', v_matched,
    'distance', v_distance,
    'sessionStatus', v_new_status,
    'nextNonce', v_next_nonce,
    'faceFailStreak', v_new_streak
  );
end;
$$;

revoke execute on function public.record_face_check(uuid, text, public.face_check_trigger, uuid)
  from public, anon;
grant execute on function public.record_face_check(uuid, text, public.face_check_trigger, uuid)
  to authenticated;

-- ─── self_recover_session RPC ──────────────────────────────────────
-- Owner, `paused` → `active` (blink-recovery path). `flagged` → 403 (lecturer
-- decision only). `active` → idempotent no-op. `completed` → session_not_active.
create or replace function public.self_recover_session(p_session_id uuid)
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

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  if v_session.status = 'flagged' then
    return jsonb_build_object('error', 'flagged');
  end if;

  if v_session.status = 'active' then
    return jsonb_build_object('sessionStatus', 'active');
  end if;

  update public.quiz_sessions
     set status = 'active',
         face_fail_streak = 0,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_session.verify_nonce;

  insert into public.audit_events (actor_id, subject_id, action)
  values (auth.uid(), auth.uid(), 'self_recover');

  return jsonb_build_object(
    'sessionStatus', 'active',
    'nextNonce', v_session.verify_nonce
  );
end;
$$;

revoke execute on function public.self_recover_session(uuid) from public, anon;
grant execute on function public.self_recover_session(uuid) to authenticated;

-- ─── pause_session RPC (server-side hand-loss pause, P7) ───────────
-- Owner, assessment, `active` → `paused` (idempotent). `completed`/`flagged`
-- → session_not_active. No audit (transient); touched last_activity_at.
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
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  end if;

  return jsonb_build_object('sessionStatus', 'paused');
end;
$$;

revoke execute on function public.pause_session(uuid) from public, anon;
grant execute on function public.pause_session(uuid) to authenticated;

-- ─── unlock_session RPC (lecturer-only) ────────────────────────────
-- Lecturer-only (in-RPC is_lecturer_of_quiz). `completed` → session_not_active
-- (no post-submit score inflation); else `active` + streak 0 + rotate nonce +
-- audit. A lecturer decision is the ONLY path out of `flagged`.
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

  -- Lock + lecturer-ownership in ONE query (0008 "never row-lock a foreign id"
  -- pattern): a guessed foreign session id is never row-locked — the join to
  -- is_lecturer_of_quiz runs before the lock is taken.
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

  update public.quiz_sessions
     set status = 'active',
         face_fail_streak = 0,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_next_nonce;

  insert into public.audit_events (actor_id, subject_id, action)
  values (auth.uid(), v_session.student_id, 'unlock');

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.unlock_session(uuid) from public, anon;
grant execute on function public.unlock_session(uuid) to authenticated;

-- ─── exempt_face_session RPC (lecturer-only) ───────────────────────
-- Sets face_exempt=true; if not completed also `active` + streak 0 + rotate
-- nonce. `completed` → session_not_active. Reason recorded in audit metadata.
create or replace function public.exempt_face_session(p_session_id uuid, p_reason text)
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

  -- Lock + lecturer-ownership in ONE query (never row-lock a foreign id).
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id
     and public.is_lecturer_of_quiz(s.quiz_id)
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  -- Bound the reason at the SQL layer too (the route's ExemptSchema caps at
  -- 500; a direct RPC caller must not bloat audit_events.metadata).
  if p_reason is null or length(p_reason) > 500 then
    return jsonb_build_object('error', 'invalid_reason');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  update public.quiz_sessions
     set face_exempt = true,
         status = 'active',
         face_fail_streak = 0,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_next_nonce;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'exempt_face',
    jsonb_build_object('reason', p_reason)
  );

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.exempt_face_session(uuid, text) from public, anon;
grant execute on function public.exempt_face_session(uuid, text) to authenticated;

-- ─── report_face_unavailable RPC ───────────────────────────────────
-- Owner, assessment, set-if-null, idempotent. The risk-7 gap (camera/models
-- offline) is lecturer-visible via `face_unavailable_at` on GET.
create or replace function public.report_face_unavailable(p_session_id uuid)
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

  update public.quiz_sessions
     set face_unavailable_at = coalesce(face_unavailable_at, clock_timestamp()),
         last_activity_at = clock_timestamp()
   where id = v_session.id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.report_face_unavailable(uuid) from public, anon;
grant execute on function public.report_face_unavailable(uuid) to authenticated;

-- ─── REDEFINED submit_session ──────────────────────────────────────
-- P7 semantics (PLAN_PHASE7 §2): `active`/`paused` submit; `flagged` submit
-- REJECTED (`session_not_active` — the flag survives until a lecturer
-- decision; no score is banked). `completed` stays idempotent
-- (`already_submitted`). No timer rejection (unchanged from 0008 — the timer
-- stops ANSWERS, not submits).
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

  -- Re-submit idempotency (unchanged).
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

  -- P7: `flagged` rejects submit (lecturer decision precedes score finalization).
  -- `paused` submits (the timer's timeUp auto-submit must work while paused).
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

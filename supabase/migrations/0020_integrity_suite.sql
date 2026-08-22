-- InnoVision — Migration 0020: Integrity suite.
--
-- Four features, dependency-ordered:
--   A. Focus-loss pause: `quiz_sessions.focus_pause_count`; pause_session
--      gains a reason ('hand_loss' | 'focus_lost') and auto-flags at the
--      FOCUS_LOSS_FLAG_THRESHOLD (3rd confirmed blur).
--   B. Multi-frame 1:1 voting verify: record_face_check is REDEFINED to take
--      per-frame similarities (p_similarities real[]) + the raw frames
--      (p_frames text[]) and compute `matched` as a STRICT MAJORITY of
--      frames ≥ FACE_SIMILARITY_MIN. Upstream, the route runs CompreFace
--      /recognize per frame and extracts the CALLER'S OWN subject similarity
--      (selfSimilarity) — a 1:1-by-lookup: any nonzero similarity IS a self-
--      similarity by construction. The fragile top1−top2 margin rule is GONE
--      (a lookalike classmate ranking above you no longer fails the check).
--      The broken 0019 record_face_check variant (client-supplied verdict,
--      references nonexistent face_checks.student_id/quiz_id/created_at
--      columns) is DROPPED — it was dead code reachable by direct RPC.
--   C. Session advisories: `session_advisories` (second_face / looked_away /
--      voice_activity / headset_active) — lecturer-visible review hints,
--      NEVER status changes. Writes are RPC-only; reads owner-or-lecturer
--      (mirrors face_checks RLS).
--   D. Incident clips metadata: `incident_clips` rows point at private
--      Storage objects (bucket created below, no client policies → route-
--      mediated service-role access only).
--
-- Key invariants preserved from 0009/0010:
--  - The server NEVER trusts a client verdict: matched is computed from SQL
--    constants over server-fetched CompreFace results. No `p_matched`.
--  - ONE atomic RPC: `for update` serializes concurrent verifies; the FLAT
--    last-5 window is computed inside the same lock.
--  - Frames are never stored — only their server-computed sha256.

-- ═══ A. Focus-loss pause ═══════════════════════════════════════════════
alter table public.quiz_sessions
  add column if not exists focus_pause_count int not null default 0;

-- Redefine pause_session (0019 signature + reason). 'focus_lost' increments
-- the cumulative counter and FLAGS at >= 3 (audited); 'hand_loss' keeps the
-- old transient behavior exactly.
create or replace function public.pause_session(
  p_session_id uuid,
  p_reason     text default 'hand_loss'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_flag boolean := false;
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

  if p_reason is null or p_reason not in ('hand_loss', 'focus_lost') then
    return jsonb_build_object('error', 'invalid_reason');
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

  if p_reason = 'focus_lost' then
    v_session.focus_pause_count := coalesce(v_session.focus_pause_count, 0) + 1;
    v_flag := v_session.focus_pause_count >= 3;
  end if;

  if v_session.status = 'active' or v_flag then
    update public.quiz_sessions
       set status = case when v_flag then 'flagged' else 'paused' end,
           paused_at = case when v_flag then paused_at
                            else coalesce(paused_at, clock_timestamp()) end,
           focus_pause_count = v_session.focus_pause_count,
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  else
    -- Already paused (e.g. a second blur while recovering): persist the new
    -- count without touching the timer state.
    update public.quiz_sessions
       set focus_pause_count = v_session.focus_pause_count,
           last_activity_at = clock_timestamp()
     where id = v_session.id;
  end if;

  if v_flag then
    insert into public.audit_events (actor_id, subject_id, action, metadata)
    values (
      auth.uid(),
      auth.uid(),
      'auto_flag_focus_loss',
      jsonb_build_object('focus_pause_count', v_session.focus_pause_count)
    );
    return jsonb_build_object('sessionStatus', 'flagged');
  end if;

  return jsonb_build_object('sessionStatus', 'paused');
end;
$$;

revoke execute on function public.pause_session(uuid) from public, anon;
drop function if exists public.pause_session(uuid);
revoke execute on function public.pause_session(uuid, text) from public, anon;
grant execute on function public.pause_session(uuid, text) to authenticated;

-- ═══ B. Multi-frame 1:1 voting verify ══════════════════════════════════
-- Drop BOTH prior signatures: 0009's embedding version, 0010's margin-rule
-- version, and 0019's client-verdict variant (a live security hole — it
-- trusted p_claimed_matched AND referenced columns that do not exist).
drop function if exists public.record_face_check(uuid, text, public.face_check_trigger, uuid);
drop function if exists public.record_face_check(uuid, text, real, text, real, public.face_check_trigger, uuid, text);
drop function if exists public.record_face_check(uuid, text, public.face_check_trigger, uuid, float8, boolean);

create or replace function public.record_face_check(
  p_session_id   uuid,
  p_subject      text,
  p_similarities real[],
  p_trigger      public.face_check_trigger,
  p_nonce        uuid,
  p_frames       text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  FACE_SIMILARITY_MIN constant real := 0.5;
  v_session      public.quiz_sessions;
  v_matched      boolean;
  v_distance     float4;
  v_frame_hash   text;
  v_recent       boolean[];
  v_fails        int;
  v_new_status   public.session_status;
  v_new_streak   int;
  v_next_nonce   uuid;
  v_suspected_replay boolean := false;
  v_too_frequent boolean := false;
  v_prev_hash text;
  v_prev_checked_at timestamptz;
  v_hits int := 0;
  v_max_sim real := 0;
  v_i int;
  v_concat text := '';
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

  -- (6) face_exempt short-circuit: no row, no nonce rotation.
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

  -- (8) Enrollment required.
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.face_enrollment_status is not null
      and p.face_enrollment_status <> 'pending_review'
  ) then
    return jsonb_build_object('error', 'not_enrolled');
  end if;

  -- (8b) Typed param validation (NaN compares GREATER than every non-NaN in
  -- Postgres, so the range gate is REQUIRED — mirrors 0010 §8b).
  if p_nonce is null then
    return jsonb_build_object('error', 'nonce_mismatch');
  end if;
  if p_trigger is null then
    return jsonb_build_object('error', 'invalid_trigger');
  end if;
  if p_similarities is null
     or array_length(p_similarities, 1) is null
     or cardinality(p_similarities) not between 1 and 3
     or cardinality(coalesce(p_frames, '{}'::text[])) <> cardinality(p_similarities) then
    return jsonb_build_object('error', 'invalid_frame');
  end if;
  for v_i in 1 .. cardinality(p_similarities) loop
    if p_similarities[v_i] is null
       or p_similarities[v_i] < 0 or p_similarities[v_i] > 1 then
      return jsonb_build_object('error', 'invalid_frame');
    end if;
    if p_frames[v_i] is null or length(p_frames[v_i]) > 200000 then
      return jsonb_build_object('error', 'invalid_frame');
    end if;
  end loop;

  -- (9) Nonce check + rotate.
  if v_session.verify_nonce <> p_nonce then
    return jsonb_build_object('error', 'nonce_mismatch');
  end if;

  -- (10) Server-computed verdict — strict majority of frames ≥ threshold,
  -- against the caller's OWN subject only (1:1; the route verified each
  -- frame via CompreFace /subjects/{uid}/verify so any nonzero similarity IS
  -- a self-similarity). NULL similarities count as FAIL votes.
  for v_i in 1 .. cardinality(p_similarities) loop
    if p_similarities[v_i] >= FACE_SIMILARITY_MIN then
      v_hits := v_hits + 1;
    end if;
    if p_similarities[v_i] > v_max_sim then
      v_max_sim := p_similarities[v_i];
    end if;
    v_concat := v_concat || '|' || coalesce(p_frames[v_i], '');
  end loop;

  v_matched := (
    coalesce(p_subject, '') = auth.uid()::text
    and v_hits * 2 > cardinality(p_similarities)
  );
  v_distance := 1.0 - v_max_sim;
  v_frame_hash := encode(extensions.digest(v_concat, 'sha256'), 'hex');

  -- Advisory flags (single latest-row lookup, ordering pinned).
  select fc.frame_hash, fc.checked_at
    into v_prev_hash, v_prev_checked_at
    from public.face_checks fc
   where fc.session_id = v_session.id
   order by fc.checked_at desc, fc.id desc
   limit 1;
  v_suspected_replay := v_prev_hash is not null and v_frame_hash = v_prev_hash;
  v_too_frequent := v_prev_checked_at is not null
    and clock_timestamp() < v_prev_checked_at + interval '2 seconds';

  -- (11) Insert ONE check row for the whole vote.
  insert into public.face_checks
    (session_id, checked_at, matched, distance, trigger, suspected_replay, too_frequent, frame_hash)
  values
    (v_session.id, clock_timestamp(), v_matched, v_distance, p_trigger, v_suspected_replay, v_too_frequent, v_frame_hash);

  -- (12) FLAT last-5 window (ordering pinned: checked_at DESC, id DESC).
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

  -- (13) Rotate nonce + timer bookkeeping (paused_at mirrors 0019 semantics:
  -- set on entering paused, cleared on active — self_recover/unlock extend
  -- started_at by the paused duration).
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

revoke execute on function public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[])
  from public, anon;
grant execute on function public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[])
  to authenticated;

-- ═══ C. Session advisories ═════════════════════════════════════════════
create table if not exists public.session_advisories (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.quiz_sessions (id) on delete cascade,
  adv_type      text not null check (adv_type in (
                  'second_face', 'looked_away', 'voice_activity', 'headset_active')),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  occurrences   int not null default 1,
  unique (session_id, adv_type)
);

create index if not exists session_advisories_session_idx
  on public.session_advisories (session_id);

alter table public.session_advisories enable row level security;

drop policy if exists "owner or lecturer reads advisories" on public.session_advisories;
create policy "owner or lecturer reads advisories"
  on public.session_advisories for select
  using (public.is_session_owner_or_lecturer(session_id));

-- Writes are RPC-only (privilege layer + zero policies).
revoke all on public.session_advisories from anon, authenticated;
grant select on public.session_advisories to authenticated;
grant all on public.session_advisories to service_role;

create or replace function public.report_session_advisory(
  p_session_id uuid,
  p_type       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  if p_type not in ('second_face', 'looked_away', 'voice_activity', 'headset_active') then
    return jsonb_build_object('error', 'invalid_type');
  end if;

  -- Owner + assessment + still meaningful (active/paused; a flagged/completed
  -- session stops collecting).
  update public.quiz_sessions s
     set last_activity_at = clock_timestamp()
   where s.id = p_session_id
     and s.student_id = auth.uid()
     and s.mode = 'assessment'
     and s.status in ('active', 'paused');

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  insert into public.session_advisories as a (session_id, adv_type)
  values (p_session_id, p_type)
  on conflict (session_id, adv_type) do update
    set occurrences = a.occurrences + 1,
        last_seen_at = clock_timestamp();

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.report_session_advisory(uuid, text) from public, anon;
grant execute on function public.report_session_advisory(uuid, text) to authenticated;

-- ═══ D. Incident clips ═════════════════════════════════════════════════
create table if not exists public.incident_clips (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.quiz_sessions (id) on delete cascade,
  storage_path text not null unique,
  reason       text not null,
  duration_ms  int not null default 0,
  recorded_from timestamptz not null default now(),
  recorded_to  timestamptz not null default now()
);

create index if not exists incident_clips_session_idx
  on public.incident_clips (session_id, recorded_from);

alter table public.incident_clips enable row level security;

drop policy if exists "lecturer of quiz reads incident clips" on public.incident_clips;
create policy "lecturer of quiz reads incident clips"
  on public.incident_clips for select
  using (public.is_session_owner_or_lecturer(session_id));

-- No client writes, students cannot list (footage access is route-mediated).
revoke all on public.incident_clips from anon, authenticated;
grant select on public.incident_clips to authenticated;
grant all on public.incident_clips to service_role;

-- Private bucket: NO storage.objects policies are created, so clients have no
-- direct access — uploads/signing happen through the API routes with the
-- service-role key only.
insert into storage.buckets (id, name, public)
values ('incident-footage', 'incident-footage', false)
on conflict (id) do nothing;

-- ═══ Retention: prune incident clips older than 30 days ════════════════
-- Storage objects are removed first (the row cascade would leave orphans in
-- the objects table when S3-backed).
create or replace function public.prune_expired_incident_clips()
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_objects bigint;
  v_rows bigint;
begin
  select count(*) into v_objects
    from storage.objects
   where bucket_id = 'incident-footage'
     and created_at < now() - interval '30 days';
  delete from storage.objects
   where bucket_id = 'incident-footage'
     and created_at < now() - interval '30 days';
  get diagnostics v_rows = row_count;
  return jsonb_build_object('pruned_storage_objects', coalesce(v_objects, 0), 'pruned_rows', v_rows);
end;
$$;

revoke all on function public.prune_expired_incident_clips() from public, anon;
grant execute on function public.prune_expired_incident_clips() to service_role;

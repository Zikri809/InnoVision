-- InnoVision — Migration 0022: in-app notifications.
-- Spec: docs/PLAN_NOTIFICATIONS.md (reviewed; D1–D12 pinned decisions).
--
-- Adds:
--   1. `notification_type` enum + `notifications` table (seq identity cursor,
--      type-prefixed dedupe keys, NO FKs to business tables so payload history
--      survives source deletion).
--   2. RLS (recipient-only SELECT) + privilege-layer grants (0008 pattern:
--      writes are trigger/RPC-only, no INSERT/UPDATE policies).
--   3. Realtime publication membership (guarded; RLS is the boundary, the
--      client filter is only a perf predicate).
--   4. `notify_*` security-definer trigger functions — set-based fan-outs,
--      whitelisted jsonb_build_object payloads (to_jsonb(NEW) is BANNED: one
--      lazy row-dump on quiz_sessions would leak verify_nonce + pre-reveal
--      score; on quizzes it would leak source_file_url/created_by, MED-1),
--      narrow exception handlers (WHEN OTHERS THEN NULL is banned — it
--      silently zeroes the integrity-alert channel).
--   5. Inline notification inserts re-defined into `reset_session` (0011) and
--      `report_face_unavailable` (0009) — DELETE triggers on quiz_sessions
--      would misfire on cascade deletes/prunes, so reset is inline in its RPC.
--   6. `mark_notifications_read` / `mark_notifications_read_before` RPCs —
--      ownership INSIDE the mutating WHERE (0011 pattern), 200-id cap.
--   7. `prune_expired_notifications()` + best-effort pg_cron (0019 pattern).
--      The hard cap touches READ rows only — retention can never destroy an
--      unseen integrity alert (D11).
--   8. `backfill_notification_state()` — run-once prod state snapshot,
--      idempotent via the same dedupe keys as the live triggers.

-- ─── 1. Enum + table ────────────────────────────────────────────────
do $$
begin
  create type public.notification_type as enum (
    'quiz_live','results_revealed','session_reset','removed_from_class',
    'class_archived','student_joined','session_submitted','session_flagged',
    'quiz_completed_all','incident_clip_recorded','face_unavailable_reported',
    'face_enrollment_held'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  type         public.notification_type not null,
  payload      jsonb not null default '{}'::jsonb,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  dedupe_key   text not null,
  constraint notifications_recipient_dedupe_key
    unique nulls not distinct (recipient_id, dedupe_key)
);

-- Re-run hardening: an earlier draft of this table without the constraint
-- (UNIQUE NULLS NOT DISTINCT has no IF NOT EXISTS form).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'notifications_recipient_dedupe_key'
       and conrelid = 'public.notifications'::regclass
  ) then
    alter table public.notifications
      add constraint notifications_recipient_dedupe_key
      unique nulls not distinct (recipient_id, dedupe_key);
  end if;
end $$;

create index if not exists notifications_recipient_seq_idx
  on public.notifications (recipient_id, seq desc);
create index if not exists notifications_recipient_unread_idx
  on public.notifications (recipient_id, seq desc) where read_at is null;

-- ─── 2. RLS + privilege-layer grants ────────────────────────────────
alter table public.notifications enable row level security;

drop policy if exists "Recipient reads own notifications" on public.notifications;
create policy "Recipient reads own notifications"
  on public.notifications for select
  using (recipient_id = auth.uid());
-- NO insert/update/delete policies: writes are trigger/RPC-only.
-- Bare recipient predicate (no helper calls) keeps the Realtime per-subscriber
-- RLS re-check O(1) and recursion-proof.

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant all     on public.notifications to service_role;

-- ─── 3. Realtime publication membership ─────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
exception
  when undefined_object then
    -- Fresh self-host with no publication at all: notifications is the only
    -- realtime table in the app today, so a minimal publication is complete.
    create publication supabase_realtime for table public.notifications;
  when insufficient_privilege then
    -- supabase_admin-owned publication on some topologies: do NOT abort the
    -- migration — notifications degrade to polling (the consistency backbone).
    raise notice 'cannot alter supabase_realtime; notifications fall back to polling';
end $$;

-- ─── 4. Trigger functions ───────────────────────────────────────────
-- House rules (PLAN_NOTIFICATIONS §3.0): security definer + pinned
-- search_path; recipients derived from row data, NEVER auth.uid(); set-based
-- bodies; ON CONFLICT (recipient_id, dedupe_key) DO NOTHING for dedupe;
-- narrow exception handlers only.

create or replace function public.notify_quiz_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Fan-out snapshots enrollment at publish time (D7). Joins classes and
  -- skips archived ones: the publish route does NOT gate on archived classes
  -- (unlike start_quiz_session), and student_quiz_view hides archived-class
  -- quizzes (0017) — notifying those students would dead-end them.
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select ce.student_id,
         'quiz_live',
         jsonb_build_object(
           'quiz_id', q.id,
           'quiz_title', q.title,
           'class_id', q.class_id,
           'class_title', c.title,
           'mode', q.mode
         ),
         'quiz_live:' || new.id::text
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    join public.class_enrollments ce on ce.class_id = q.class_id
   where q.id = new.id
     and c.archived_at is null
  on conflict (recipient_id, dedupe_key) do nothing;
  return null;
end;
$$;

create or replace function public.notify_results_revealed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Scoped to students with a COMPLETED ASSESSMENT session: a zero-submission
  -- manual reveal (the reveal route allows it) must not tell every enrolled
  -- student "results ready" and then land them in not_revealed (D8). Practice
  -- is always revealed — no notice needed. Payload never carries score.
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select s.student_id,
         'results_revealed',
         jsonb_build_object(
           'quiz_id', q.id,
           'quiz_title', q.title,
           'class_id', q.class_id
         ),
         'results_revealed:' || new.id::text
    from public.quizzes q
    join public.quiz_sessions s
      on s.quiz_id = q.id and s.status = 'completed' and s.mode = 'assessment'
   where q.id = new.id
  on conflict (recipient_id, dedupe_key) do nothing;
  return null;
end;
$$;

create or replace function public.notify_session_terminal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id  uuid;
  v_enrolled  int;
  v_completed int;
begin
  if new.status = 'completed' then
    -- Lecturer digest row (assessment only — the mode term is in the trigger
    -- WHEN; practice submits never reach this function).
    insert into public.notifications (recipient_id, type, payload, dedupe_key)
    select c.lecturer_id,
           'session_submitted',
           jsonb_build_object(
             'quiz_id', q.id,
             'quiz_title', q.title,
             'session_id', s.id,
             'student_id', s.student_id
           ),
           'session_submitted:' || s.id::text
      from public.quiz_sessions s
      join public.quizzes q on q.id = s.quiz_id
      join public.classes c on c.id = q.class_id
     where s.id = new.id
    on conflict (recipient_id, dedupe_key) do nothing;

    -- quiz_completed_all: completed ASSESSMENT sessions >= CURRENT enrollment
    -- count (D9: suppressed across reset+retake cycles by the dedupe key).
    select q.class_id into v_class_id
      from public.quizzes q where q.id = new.quiz_id;

    select count(*) into v_enrolled
      from public.class_enrollments ce
     where ce.class_id = v_class_id;

    select count(*) into v_completed
      from public.quiz_sessions x
     where x.quiz_id = new.quiz_id
       and x.status = 'completed'
       and x.mode = 'assessment';

    if v_enrolled > 0 and v_completed >= v_enrolled then
      insert into public.notifications (recipient_id, type, payload, dedupe_key)
      select c.lecturer_id,
             'quiz_completed_all',
             jsonb_build_object('quiz_id', q.id, 'quiz_title', q.title),
             'quiz_completed_all:' || q.id::text
        from public.quizzes q
        join public.classes c on c.id = q.class_id
       where q.id = new.quiz_id
      on conflict (recipient_id, dedupe_key) do nothing;
    end if;

  elsif new.status = 'flagged' then
    -- Covers all three flag writers: face-fail streak (record_face_check),
    -- focus-loss 3rd strike (pause_session), revoke_face_consent bulk-flag.
    -- Day-bucket key: flag→unlock→re-flag is a real repeat offense; same-day
    -- storms collapse (UTC day — DB clock).
    insert into public.notifications (recipient_id, type, payload, dedupe_key)
    select c.lecturer_id,
           'session_flagged',
           jsonb_build_object(
             'quiz_id', q.id,
             'quiz_title', q.title,
             'session_id', s.id,
             'student_id', s.student_id,
             'student_name', left(btrim(coalesce(p.full_name, '')), 80)
           ),
           'session_flagged:' || s.id::text || ':'
             || to_char(clock_timestamp(), 'YYYYMMDD')
      from public.quiz_sessions s
      join public.quizzes q on q.id = s.quiz_id
      join public.classes c on c.id = q.class_id
      join public.profiles p on p.id = s.student_id
     where s.id = new.id
    on conflict (recipient_id, dedupe_key) do nothing;
  end if;

  return null;
end;
$$;

create or replace function public.notify_student_joined()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- join_class's ON CONFLICT DO NOTHING inserts no row on re-join, so this
  -- fires exactly once per real enrollment. Epoch of enrolled_at in the key:
  -- join→remove→rejoin re-notifies.
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select c.lecturer_id,
         'student_joined',
         jsonb_build_object(
           'class_id', c.id,
           'class_title', c.title,
           'student_id', p.id,
           'student_name', left(btrim(coalesce(p.full_name, '')), 80)
         ),
         'student_joined:' || new.class_id::text || ':'
           || new.student_id::text || ':'
           || extract(epoch from new.enrolled_at)::bigint::text
    from public.classes c
    join public.profiles p on p.id = new.student_id
   where c.id = new.class_id
  on conflict (recipient_id, dedupe_key) do nothing;
  return null;
end;
$$;

create or replace function public.notify_enrollment_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_alive   boolean;
  v_student_alive boolean;
begin
  -- Four causes share this trigger: self-unenroll (PostgREST-reachable today
  -- via the 0002 DELETE policy), lecturer/service removal, class hard-delete
  -- cascade, account-deletion cascade. FK cascades run child triggers after
  -- the parent row is already gone (0004:259-266 precedent), so liveness
  -- probes absorb both cascade shapes.
  select exists (select 1 from public.classes  c where c.id  = old.class_id),
         exists (select 1 from public.profiles p where p.id  = old.student_id)
    into v_class_alive, v_student_alive;

  -- Class row already deleted ⇒ class_title payload unbuildable; students
  -- discover the loss via their class list.
  if not v_class_alive then
    return null;
  end if;

  -- Account deletion: recipient is gone.
  if not v_student_alive then
    return null;
  end if;

  -- Self-unenroll: never notify self. (auth.uid() is NULL under service_role,
  -- so service removals correctly fall through to the notification.)
  if auth.uid() = old.student_id then
    return null;
  end if;

  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  values (
    old.student_id,
    'removed_from_class',
    jsonb_build_object(
      'class_id', old.class_id,
      'class_title', (select c.title from public.classes c where c.id = old.class_id)
    ),
    'removed_from_class:' || old.class_id::text || ':'
      || old.student_id::text || ':'
      || extract(epoch from old.enrolled_at)::bigint::text
  )
  on conflict (recipient_id, dedupe_key) do nothing;

  return null;
end;
$$;

create or replace function public.notify_class_archived()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Unarchive→re-archive re-fires (epoch of archived_at in the key).
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select ce.student_id,
         'class_archived',
         jsonb_build_object(
           'class_id', new.id,
           'class_title', new.title,
           'live_quiz_count', (
             select count(*) from public.quizzes q
              where q.class_id = new.id and q.status = 'live'
           )
         ),
         'class_archived:' || new.id::text || ':'
           || extract(epoch from new.archived_at)::bigint::text
    from public.class_enrollments ce
   where ce.class_id = new.id
  on conflict (recipient_id, dedupe_key) do nothing;
  return null;
end;
$$;

create or replace function public.notify_face_enrollment_held()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Recipients = lecturers of classes the student is enrolled in (row-data
  -- traversal, never auth.uid()). Per-transition epoch key: every
  -- reject→retry cycle is a real event; same-second double-transitions
  -- collapse (accepted, tiny volume). A student in zero classes yields zero
  -- recipients (accepted).
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select distinct c.lecturer_id,
         'face_enrollment_held',
         jsonb_build_object('student_id', new.id),
         'face_enrollment_held:' || new.id::text || ':'
           || extract(epoch from clock_timestamp())::bigint::text
    from public.class_enrollments ce
    join public.classes c on c.id = ce.class_id
   where ce.student_id = new.id
  on conflict (recipient_id, dedupe_key) do nothing;
  return null;
end;
$$;

create or replace function public.notify_incident_clip()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Digest tier: clips are recorded by the client only around pause/flag
  -- transitions (rate-limited route), so volume is a handful per problematic
  -- session and zero for clean ones.
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select c.lecturer_id,
         'incident_clip_recorded',
         jsonb_build_object(
           'quiz_id', q.id,
           'quiz_title', q.title,
           'session_id', s.id,
           'clip_id', new.id
         ),
         'incident_clip_recorded:' || new.id::text
    from public.quiz_sessions s
    join public.quizzes q on q.id = s.quiz_id
    join public.classes c on c.id = q.class_id
   where s.id = new.session_id
  on conflict (recipient_id, dedupe_key) do nothing;
  return null;
end;
$$;

-- ─── 5. Triggers ────────────────────────────────────────────────────
-- The WHEN clauses are load-bearing: record_face_check rewrites status on
-- EVERY verify cycle (active↔paused↔flagged flap), and reveal-settings
-- patches live quizzes without touching status.

drop trigger if exists notify_quiz_live on public.quizzes;
create trigger notify_quiz_live
  after update of status on public.quizzes
  for each row
  when (old.status is distinct from new.status and new.status = 'live')
  execute function public.notify_quiz_live();

drop trigger if exists notify_results_revealed on public.quizzes;
create trigger notify_results_revealed
  after update of results_revealed_at on public.quizzes
  for each row
  when (old.results_revealed_at is null and new.results_revealed_at is not null
        and new.status = 'live')
  execute function public.notify_results_revealed();

drop trigger if exists notify_session_terminal on public.quiz_sessions;
create trigger notify_session_terminal
  after update of status on public.quiz_sessions
  for each row
  when (old.status is distinct from new.status
        and new.status in ('completed','flagged')
        and new.mode = 'assessment')
  execute function public.notify_session_terminal();

drop trigger if exists notify_student_joined on public.class_enrollments;
create trigger notify_student_joined
  after insert on public.class_enrollments
  for each row
  execute function public.notify_student_joined();

drop trigger if exists notify_enrollment_deleted on public.class_enrollments;
create trigger notify_enrollment_deleted
  after delete on public.class_enrollments
  for each row
  execute function public.notify_enrollment_deleted();

drop trigger if exists notify_class_archived on public.classes;
create trigger notify_class_archived
  after update of archived_at on public.classes
  for each row
  when (old.archived_at is null and new.archived_at is not null)
  execute function public.notify_class_archived();

drop trigger if exists notify_face_enrollment_held on public.profiles;
create trigger notify_face_enrollment_held
  after update of face_enrollment_status on public.profiles
  for each row
  when (old.face_enrollment_status is distinct from new.face_enrollment_status
        and new.face_enrollment_status = 'pending_review')
  execute function public.notify_face_enrollment_held();

drop trigger if exists notify_incident_clip on public.incident_clips;
create trigger notify_incident_clip
  after insert on public.incident_clips
  for each row
  execute function public.notify_incident_clip();

-- ─── 6. Inline inserts in RPCs (never DELETE triggers) ──────────────
-- reset_session (0011) redefined: same semantics + session_reset insert
-- AFTER the ownership lock, mode gate, delete, and audit row. A DELETE
-- trigger on quiz_sessions would misfire on quiz/class/profile cascades and
-- practice prunes (0019) — the RPC is the only place that knows intent.
create or replace function public.reset_session(p_session_id uuid)
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
    where p.id = auth.uid() and p.role = 'lecturer'
  ) then
    return jsonb_build_object('error', 'not_lecturer');
  end if;

  -- Lock + lecturer-ownership in ONE query (0011 pattern). Non-existent and
  -- not-owned fold into the same `not_owner` (no oracle).
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id
     and public.is_lecturer_of_quiz(s.quiz_id)
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  if v_session.mode <> 'assessment' then
    return jsonb_build_object('error', 'not_assessment');
  end if;

  delete from public.quiz_sessions where id = v_session.id;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'session_reset',
    jsonb_build_object('session_id', v_session.id, 'quiz_id', v_session.quiz_id)
  );

  -- Notification (D4: inline in the RPC). Double-reset race is already safe:
  -- the second caller's lock re-check finds nothing and returns not_owner
  -- before reaching this insert.
  begin
    insert into public.notifications (recipient_id, type, payload, dedupe_key)
    values (
      v_session.student_id,
      'session_reset',
      jsonb_build_object(
        'quiz_id', v_session.quiz_id,
        'quiz_title', (select q.title from public.quizzes q where q.id = v_session.quiz_id),
        'session_id', v_session.id
      ),
      'session_reset:' || v_session.id::text
    )
    on conflict (recipient_id, dedupe_key) do nothing;
  exception
    when unique_violation then null;
    when foreign_key_violation then null;
  end;

  return jsonb_build_object(
    'ok', true,
    'deleted_session_id', v_session.id,
    'student_id', v_session.student_id,
    'quiz_id', v_session.quiz_id
  );
end;
$$;

revoke execute on function public.reset_session(uuid) from public, anon;
grant execute on function public.reset_session(uuid) to authenticated;

-- report_face_unavailable (0009) redefined: same semantics +
-- face_unavailable_reported insert keyed per session (the RPC is
-- set-if-null but re-called on every camera retry; the dedupe key collapses
-- the retry storm to one notification per session).
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

  begin
    insert into public.notifications (recipient_id, type, payload, dedupe_key)
    select c.lecturer_id,
           'face_unavailable_reported',
           jsonb_build_object(
             'quiz_id', q.id,
             'quiz_title', q.title,
             'session_id', s.id,
             'student_id', s.student_id
           ),
           'face_unavailable_reported:' || s.id::text
      from public.quiz_sessions s
      join public.quizzes q on q.id = s.quiz_id
      join public.classes c on c.id = q.class_id
     where s.id = v_session.id
    on conflict (recipient_id, dedupe_key) do nothing;
  exception
    when unique_violation then null;
    when foreign_key_violation then null;
  end;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.report_face_unavailable(uuid) from public, anon;
grant execute on function public.report_face_unavailable(uuid) to authenticated;

-- ─── 7. Read-state RPCs ─────────────────────────────────────────────
-- Ownership lives INSIDE the mutating WHERE (0011 pattern) — a definer RPC
-- without it is an alert-suppression primitive against lecturers' integrity
-- alerts. Batch cap mirrors the SQL-layer bound style of 0009.

create or replace function public.mark_notifications_read(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 200 then
    return jsonb_build_object('error', 'invalid_ids');
  end if;

  update public.notifications
     set read_at = clock_timestamp()
   where id = any(p_ids)
     and recipient_id = auth.uid()
     and read_at is null;

  get diagnostics v_updated = row_count;
  return jsonb_build_object('updated', v_updated);
end;
$$;

-- mark-ALL takes the caller's highest SEEN seq so a notification arriving
-- mid-click is NOT silently marked read before being rendered.
create or replace function public.mark_notifications_read_before(p_seq bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if p_seq is null then
    return jsonb_build_object('error', 'invalid_seq');
  end if;

  update public.notifications
     set read_at = clock_timestamp()
   where recipient_id = auth.uid()
     and read_at is null
     and seq <= p_seq;

  get diagnostics v_updated = row_count;
  return jsonb_build_object('updated', v_updated);
end;
$$;

revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
revoke execute on function public.mark_notifications_read_before(bigint) from public, anon;
grant execute on function public.mark_notifications_read_before(bigint) to authenticated;

-- ─── 8. Retention (prune_expired_* family; 0019/0020 precedent) ─────
create or replace function public.prune_expired_notifications()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_read     bigint;
  v_unread   bigint;
  v_urgent   bigint;
  v_capped   bigint;
  v_urgent_const public.notification_type[] :=
    array['session_flagged','session_reset','removed_from_class',
          'results_revealed','face_unavailable_reported',
          'face_enrollment_held']::public.notification_type[];
begin
  delete from public.notifications
   where read_at is not null
     and created_at < clock_timestamp() - interval '30 days';
  get diagnostics v_read = row_count;

  delete from public.notifications
   where read_at is null
     and created_at < clock_timestamp() - interval '180 days'
     and type <> all (v_urgent_const);
  get diagnostics v_unread = row_count;

  delete from public.notifications
   where read_at is null
     and created_at < clock_timestamp() - interval '365 days'
     and type = any (v_urgent_const);
  get diagnostics v_urgent = row_count;

  -- Hard cap: 500 READ rows per user (unread volume is bounded by real event
  -- rate; scoping the cap to read rows means retention can NEVER destroy an
  -- unseen integrity alert — D11).
  delete from public.notifications n
   where n.read_at is not null
     and n.seq <= (
       select x.seq from public.notifications x
        where x.recipient_id = n.recipient_id
          and x.read_at is not null
        order by x.seq desc
        offset 500 limit 1
     );
  get diagnostics v_capped = row_count;

  return jsonb_build_object(
    'pruned_read', v_read,
    'pruned_unread', v_unread,
    'pruned_unread_urgent', v_urgent,
    'pruned_over_cap', v_capped
  );
end;
$$;

revoke all on function public.prune_expired_notifications() from public, anon;
grant execute on function public.prune_expired_notifications() to service_role;

-- Best-effort weekly schedule (the cap is the expensive one; age-prune could
-- join the daily innovision-retention job later).
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('innovision-notifications', '43 3 * * 6',
    'select public.prune_expired_notifications()');
exception when others then
  raise notice 'pg_cron scheduling skipped (%); schedule prune_expired_notifications manually', sqlerrm;
end $$;

-- ─── 9. Backfill (prod state snapshot; run-once, idempotent) ────────
-- `db reset` hides rollout divergence: on a populated DB, quizzes already
-- live / already revealed before this migration would never fire their
-- triggers. This function snapshots current state into notifications using
-- the SAME dedupe keys as the live triggers, so it composes safely whether
-- it runs before or after real events.
create or replace function public.backfill_notification_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live    bigint;
  v_revealed bigint;
begin
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select ce.student_id,
         'quiz_live',
         jsonb_build_object(
           'quiz_id', q.id,
           'quiz_title', q.title,
           'class_id', q.class_id,
           'class_title', c.title,
           'mode', q.mode
         ),
         'quiz_live:' || q.id::text
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    join public.class_enrollments ce on ce.class_id = q.class_id
   where q.status = 'live'
     and c.archived_at is null
  on conflict (recipient_id, dedupe_key) do nothing;
  get diagnostics v_live = row_count;

  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select s.student_id,
         'results_revealed',
         jsonb_build_object(
           'quiz_id', q.id,
           'quiz_title', q.title,
           'class_id', q.class_id
         ),
         'results_revealed:' || q.id::text
    from public.quizzes q
    join public.quiz_sessions s
      on s.quiz_id = q.id and s.status = 'completed' and s.mode = 'assessment'
   where q.status = 'live'
     and q.results_revealed_at is not null
  on conflict (recipient_id, dedupe_key) do nothing;
  get diagnostics v_revealed = row_count;

  return jsonb_build_object('backfilled_quiz_live', v_live, 'backfilled_results_revealed', v_revealed);
end;
$$;

revoke all on function public.backfill_notification_state() from public, anon;
grant execute on function public.backfill_notification_state() to service_role;

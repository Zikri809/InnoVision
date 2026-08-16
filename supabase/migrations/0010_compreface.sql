-- InnoVision — Phase 7 CompreFace migration: move face matching server-side.
-- Depends on: 0009_face.sql (face_checks, audit_events, face_check_trigger,
-- enroll_face, record_face_check, revoke_face_consent, self_recover_session,
-- pause_session, unlock_session, exempt_face_session, report_face_unavailable,
-- submit_session), 0008_sessions.sql (quiz_sessions, is_session_owner_or_lecturer,
-- can_student_view_quiz), 0001_profiles.sql (profiles, consent_given_at).
--
-- Migration (dependency-pinned order):
--  1. `pgcrypto` extension (before the redefined RPC uses `digest()`).
--  2. `profiles`: ADD `face_enrollment_status` + `face_deletion_pending`;
--     DROP `face_embedding` column; DROP the old embedding guard trigger +
--     function; ADD a new guard trigger on `face_enrollment_status`;
--     REVOKE column-level UPDATE from authenticated (the RLS self-update
--     policy still allows updating `full_name` etc., but NOT this column).
--  3. `face_checks`: ADD `frame_hash` (server-computed sha256 of the frame;
--     feeds the `suspected_replay` advisory).
--  4. Redefine `enroll_face` — no embedding param; the RPC derives the status
--     (`enrolled` / `pending_review`) from CompreFace duplicate-check METADATA
--     (p_duplicate_subject / p_duplicate_similarity), NOT a caller-supplied
--     verdict. The GUC guard allows the write.
--  5. Redefine `record_face_check` — no embedding param; the RPC computes
--     `matched` itself from CompreFace metadata (p_subject / p_similarity /
--     p_second_*) against SQL constants. No `p_matched` parameter exists.
--     Step 8 enrollment check now reads `face_enrollment_status IS NULL`
--     (the old `face_embedding` column is gone).
--  6. Redefine `revoke_face_consent` — clears consent + `face_enrollment_status`
--     + sets `face_deletion_pending = true` (CompreFace subject deletion is a
--     retriable route-side step), flags in-progress assessments, deletes
--     `face_checks` for own completed sessions, audits.
--  7. New `reject_face_enrollment` RPC (lecturer-only) — clears a
--     `pending_review` status so the student can re-enroll.
--  8. Drop the `pgvector` extension LAST (all column/function references gone).
--
-- Key invariants (PLAN_PHASE7 §2):
--  - The server NEVER trusts a client verdict: `record_face_check` computes
--    `matched` from CompreFace metadata + SQL constants (0.5 / 0.15). No
--    `matched` parameter exists.
--  - `record_face_check` is ONE atomic RPC: `for update` serializes concurrent
--    verifies; the FLAT last-5 window is computed inside the same transaction.
--  - `face_enrollment_status` is GUC-guarded + column-level restricted — a
--    direct PostgREST PATCH cannot set it (only the security-definer RPCs,
--    which set the GUC in-transaction, can write it).

-- ─── pgcrypto (for digest(), used by record_face_check's frame hash) ───
-- `with schema extensions` pins the install target so the schema-qualified
-- `extensions.digest` below resolves identically on plain Postgres and Supabase.
create extension if not exists pgcrypto with schema extensions;

-- ─── Schema hardening ────────────────────────────────────────────────────
-- Revoke CREATE on schema `public` from public/anon/authenticated (Supabase's
-- default grants CREATE to PUBLIC). Combined with the schema-qualified
-- `extensions.digest()` below, this closes the search_path-hijack vector on the
-- SECURITY DEFINER `record_face_check` — the ONLY function with `extensions` on
-- its path. Migrations still run as the schema owner (CREATE preserved); this
-- only stops an authenticated/anon role from planting a shadowing object.
revoke create on schema public from public, anon, authenticated;

-- ─── profiles: enrollment-status columns ─────────────────────────────
alter table public.profiles
  add column if not exists face_enrollment_status text,
  add column if not exists face_deletion_pending boolean not null default false;

-- ─── face_checks: frame_hash ─────────────────────────────────────────
-- NOT indexed — it is only read from the latest row (via the existing
-- (session_id, checked_at) index). The frame itself is never stored.
alter table public.face_checks
  add column if not exists frame_hash text;

-- ─── Drop the OLD face_embedding guard (column is dropped below) ─────
drop trigger if exists profiles_face_embedding_guard on public.profiles;
drop function if exists public.profiles_face_embedding_guard();

-- ─── Drop the OLD RPC signatures (CREATE OR REPLACE with a different
--      parameter list creates a NEW function; the old ones must be removed) ───
drop function if exists public.enroll_face(text);
drop function if exists public.record_face_check(uuid, text, public.face_check_trigger, uuid);

-- ─── Guard trigger on face_enrollment_status ─────────────────────────
-- Mirrors the old `profiles_face_embedding_guard` pattern (0009): only an
-- RPC that sets BOTH GUCs in-transaction (`app.face_enroll='on'` +
-- `app.face_enroll_actor=auth.uid()::text`) may write the status. Service-role
-- writes are INTENTIONALLY blocked (`auth.uid()` is NULL).
--
-- NOTE: uses `coalesce(..., '')` — SQL three-valued logic means a bare
-- `current_setting('app.face_enroll', true) <> 'on'` is NULL when unset, and
-- `IF NULL THEN` in plpgsql is treated as false (the guard would never fire).
create or replace function public.profiles_face_enrollment_guard()
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

drop trigger if exists profiles_face_enrollment_guard on public.profiles;
create trigger profiles_face_enrollment_guard
  before update of face_enrollment_status on public.profiles
  for each row execute function public.profiles_face_enrollment_guard();

-- Column-level privilege: the RLS self-update policy (0001) still allows a
-- student to UPDATE their own row, but NOT this column — a direct
-- `PATCH /rest/v1/profiles` with `face_enrollment_status` is denied at the
-- privilege layer BEFORE RLS is consulted (Postgres checks column grants
-- first). Only the security-definer RPCs (running as the owner, which has
-- implicit privileges AND sets the GUC) write it.
revoke update (face_enrollment_status) on public.profiles from authenticated, anon;

-- ─── enroll_face RPC (redefined — no embedding) ─────────────────────
-- security definer. (1) auth + student; (2) consent gate; (3) ever-enrolled
-- live-session gate — a revoke→re-enroll face swap mid-assessment is blocked,
-- but a GENUINE first-time enrollment stays allowed mid-session (breaks the
-- start-before-enrolling deadlock); (4) derive status from CompreFace
-- duplicate-check METADATA (NOT a caller-supplied verdict); (5) set GUCs +
-- write the status; (6) audit.
--
-- p_duplicate_subject / p_duplicate_similarity come from the ROUTE (which ran
-- CompreFace `/recognize` against all subjects before enrolling). A similarity
-- above FACE_SUSPICION_MIN (0.45, SQL constant) against a subject that is NOT
-- the caller's own uid → `pending_review`. A direct PostgREST call with
-- `p_duplicate_similarity=0` gets `'enrolled'` (residual risk — the route is
-- the only caller that runs the CompreFace duplicate check; see
-- PLAN_PHASE7_COMPREFACE_MIGRATION §7).
create or replace function public.enroll_face(
  p_duplicate_subject text,
  p_duplicate_similarity float4
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status      text;
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
    exists (
      select 1 from public.profiles p
      where p.id = v_actor
        and (p.face_enrollment_status is not null
             or exists (
               select 1 from public.audit_events ae
               where ae.actor_id = v_actor and ae.action in ('face_enroll', 'face_reenroll')
             )
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

  -- Derive status from CompreFace duplicate-check metadata (SQL constants).
  if p_duplicate_similarity is not null
     and p_duplicate_similarity >= 0.45
     and coalesce(p_duplicate_subject, '') <> v_actor::text then
    v_status := 'pending_review';
  else
    v_status := 'enrolled';
  end if;

  perform set_config('app.face_enroll', 'on', true);
  perform set_config('app.face_enroll_actor', v_actor::text, true);

  -- Successful enrollment also clears ANY leftover `face_deletion_pending`
  -- (a consent-revoke whose CompreFace subject deletion was never run). The
  -- enroll route deletes the old subject before adding samples; clearing the
  -- flag here stops the `compreface:cleanup` script from deleting the freshly
  -- re-enrolled subject.
  update public.profiles
     set face_enrollment_status = v_status,
         face_deletion_pending = false
   where id = v_actor;

  if not found then
    return jsonb_build_object('error', 'not_student');
  end if;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    v_actor,
    v_actor,
    case when v_ever_enrolled then 'face_reenroll' else 'face_enroll' end,
    jsonb_build_object('status', v_status)
  );

  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

revoke execute on function public.enroll_face(text, real) from public, anon;
grant execute on function public.enroll_face(text, real) to authenticated;

-- ─── record_face_check RPC (redefined — matching via CompreFace metadata) ───
-- 14 steps, pinned ordering. One atomic transaction: `for update` serializes
-- concurrent verifies; the FLAT window is computed inside the same lock.
--
-- The ROUTE calls CompreFace `/recognize` and passes the RAW metadata
-- (p_subject / p_similarity / p_second_subject / p_second_similarity) PLUS the
-- raw frame (p_frame, which the RPC hashes itself — the frame is never
-- stored). The RPC computes `matched` from SQL constants (FACE_SIMILARITY_MIN
-- = 0.5, FACE_MARGIN_MIN = 0.15). No `p_matched` parameter exists.
create or replace function public.record_face_check(
  p_session_id       uuid,
  p_subject          text,
  p_similarity       real,
  p_second_subject   text,
  p_second_similarity real,
  p_trigger          public.face_check_trigger,
  p_nonce            uuid,
  p_frame            text
)
returns jsonb
language plpgsql
security definer
-- `extensions` is on the path as a fallback; `digest()` is schema-qualified
-- (`extensions.digest`) below so a public-schema shadow cannot hijack it.
set search_path = public, extensions
as $$
declare
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

  -- (8) Enrollment required (the OLD check read `profiles.face_embedding`,
  -- which is DROPPED — now read `face_enrollment_status`).
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.face_enrollment_status is not null
      and p.face_enrollment_status <> 'pending_review'
  ) then
    return jsonb_build_object('error', 'not_enrolled');
  end if;

  -- (8b) NULL / malformed params: reject explicitly with typed errors.
  -- Numeric gates are REQUIRED: without them `'NaN'::real >= 0.5` is TRUE in
  -- PostgreSQL (NaN compares GREATER than every non-NaN number), which would
  -- defeat BOTH the 0.5 floor AND the 0.15 margin rule. NaN is therefore
  -- caught by `p_similarity > 1` (likewise ±Infinity: `> 1` / `< 0`). No
  -- `isfinite()` is used — Supabase Postgres does not ship the float8/float4
  -- variants (only date/timestamp/interval).
  -- `p_frame` is capped here (the route caps too) so the sha256 digest below
  -- never runs under the session row-lock on an attacker-supplied giant body.
  if p_nonce is null then
    return jsonb_build_object('error', 'nonce_mismatch');
  end if;
  if p_frame is null or length(p_frame) > 200000 then
    return jsonb_build_object('error', 'invalid_frame');
  end if;
  if p_trigger is null then
    return jsonb_build_object('error', 'invalid_trigger');
  end if;
  if p_similarity is null
     or p_similarity < 0 or p_similarity > 1 then
    return jsonb_build_object('error', 'invalid_frame');
  end if;
  if p_second_similarity is not null
     and (p_second_similarity < 0 or p_second_similarity > 1) then
    return jsonb_build_object('error', 'invalid_frame');
  end if;

  -- (9) Nonce check + rotate. A stale nonce → nonce_mismatch (no row, no
  -- rotation); the client refetches via GET and retries ONCE.
  if v_session.verify_nonce <> p_nonce then
    return jsonb_build_object('error', 'nonce_mismatch');
  end if;

  -- (10) Server-computed verdict from CompreFace metadata — NEVER a caller-
  -- supplied `matched`. SQL constants: similarity ≥ 0.5 AND (top − second) ≥
  -- 0.15 (margin rule kills lookalike misidentifications). The subject must
  -- be the caller's own uid (a student can only pass as themselves).
  -- `coalesce(p_subject,'')` (NOT a bare NULL check): a NULL subject — the
  -- no-face sentinel, or a CompreFace recognize with no top subject — must
  -- yield `matched=false` (a clean FAIL row), never `v_matched = NULL` (which
  -- would trip the `matched boolean not null` insert → unhandled 500).
  v_matched := (
    coalesce(p_subject, '') = auth.uid()::text
    and p_similarity >= 0.5
    and (p_second_similarity is null
         or (p_similarity - p_second_similarity) >= 0.15)
  );
  v_distance := 1.0 - p_similarity;
  -- RPC-computed frame hash (never caller-supplied) — feeds the advisory.
  -- Schema-qualified (`extensions.digest`): pgcrypto installs into the
  -- `extensions` schema, and an unqualified `digest()` inside a SECURITY
  -- DEFINER function with `public` on its search_path would resolve an
  -- attacker's shadowing `public.digest()` (search_path hijack → definer
  -- execution as the function owner).
  v_frame_hash := encode(extensions.digest(p_frame, 'sha256'), 'hex');

  -- Advisory flags (no status impact). Single latest-row lookup (the order is
  -- pinned: checked_at DESC, id DESC — uuid is unordered).
  select fc.frame_hash, fc.checked_at
    into v_prev_hash, v_prev_checked_at
    from public.face_checks fc
   where fc.session_id = v_session.id
   order by fc.checked_at desc, fc.id desc
   limit 1;
  -- `v_prev_hash is not null AND` (not coalesce): the equality needs the prev
  -- row to exist — a first-ever check yields false, never NULL.
  v_suspected_replay := v_prev_hash is not null and v_frame_hash = v_prev_hash;
  v_too_frequent := v_prev_checked_at is not null
    and clock_timestamp() < v_prev_checked_at + interval '2 seconds';

  -- (11) Insert the check row (RPC-only write). checked_at = clock_timestamp()
  -- (NOT the column default `now()`): a verify that queued behind the row lock
  -- must not carry a pre-lock timestamp — the lecturer timeline reflects true
  -- execution order.
  insert into public.face_checks
    (session_id, checked_at, matched, distance, trigger, suspected_replay, too_frequent, frame_hash)
  values
    (v_session.id, clock_timestamp(), v_matched, v_distance, p_trigger, v_suspected_replay, v_too_frequent, v_frame_hash);

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

revoke execute on function public.record_face_check(uuid, text, real, text, real, public.face_check_trigger, uuid, text)
  from public, anon;
grant execute on function public.record_face_check(uuid, text, real, text, real, public.face_check_trigger, uuid, text)
  to authenticated;

-- ─── revoke_face_consent RPC (updated) ───────────────────────────────
-- Session-coupled revocation: clears consent + face_enrollment_status (both
-- GUCs in-transaction to pass the new guard), flags every in-progress
-- assessment session, deletes face_checks ONLY for own completed sessions
-- (privacy cleanup; NO in-progress fail-history wipe), and audits. Re-consent
-- restores consent_given_at only — it does NOT clear `flagged` (lecturer
-- decision). CompreFace subject deletion is a RETRIABLE route-side step
-- (face_deletion_pending = true; see PLAN_PHASE7_COMPREFACE_MIGRATION L17).
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

revoke execute on function public.revoke_face_consent() from public, anon;
grant execute on function public.revoke_face_consent() to authenticated;

-- ─── DROP the face_embedding column (all function refs removed above) ───
alter table public.profiles drop column if exists face_embedding;

-- ─── NEW reject_face_enrollment RPC (lecturer-only) ──────────────────
-- A `pending_review` (duplicate-detected) student cannot enroll mid-session
-- (ever-enrolled gate). If the lecturer REJECTS the pending review, this
-- clears the status so the student can re-enroll as a fresh enrollment.
-- Lecturer must teach a class the student belongs to (no-oracle 404).
create or replace function public.reject_face_enrollment(p_student_id uuid)
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
    where p.id = v_actor and p.role = 'lecturer'
  ) then
    return jsonb_build_object('error', 'not_lecturer');
  end if;

  -- The lecturer must teach a class the target student is enrolled in
  -- (single no-oracle error — a foreign student id is never revealed).
  if not exists (
    select 1 from public.classes c
    join public.class_enrollments ce on ce.class_id = c.id
    where ce.student_id = p_student_id and c.lecturer_id = v_actor
  ) then
    return jsonb_build_object('error', 'not_owner');
  end if;

  perform set_config('app.face_enroll', 'on', true);
  perform set_config('app.face_enroll_actor', v_actor::text, true);

  update public.profiles
     set face_enrollment_status = null
   where id = p_student_id;

  insert into public.audit_events (actor_id, subject_id, action)
  values (v_actor, p_student_id, 'face_enroll_rejected');

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.reject_face_enrollment(uuid) from public, anon;
grant execute on function public.reject_face_enrollment(uuid) to authenticated;

-- ─── Drop the pgvector extension (LAST — no dependents remain) ───────
-- Plain DROP (no CASCADE) — every column/function using `vector(192)` was
-- removed above. Re-running 0001 re-creates it idempotently (`create extension
-- if not exists`) if a future phase needs it.
drop extension if exists vector;
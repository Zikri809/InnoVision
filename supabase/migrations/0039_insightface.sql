-- InnoVision — Migration 0039: Direct InsightFace migration (replaces CompreFace).
--
-- Replaces the CompreFace-internal biometric store with Supabase-native
-- storage: enrolled embeddings live in `profile_face_samples` (pgvector 512),
-- reachable ONLY through security-definer RPCs. The verify RPC
-- `record_face_check` (0020/0021) is UNTOUCHED — the route sources per-frame
-- similarities from the student's OWN baseline via `compare_face_baseline`
-- and clamps to [0,1] before `record_face_check` (0021's validator rejects
-- values outside that range; raw cosine can be negative).
--
-- Sections (dependency-pinned):
--   A. pgvector extension guard + `profile_face_samples` (RLS on, zero
--      policies — deny-by-default; zero grants to anon/authenticated).
--   B. `enroll_face` REWRITTEN: takes the 3 validated samples (jsonb), runs
--      the duplicate check INTERNALLY (no cross-student search primitive
--      from authenticated; 1-bit probing throttled attempt-based), stores
--      delete-then-insert atomically behind a row lock (no orphaned samples
--      on RPC rejection — the route-side addSubjectExample + rollback dance
--      is gone).
--   C. `compare_face_baseline`: caller-own max cosine, {present, similarity}.
--   D. `face_baseline_status`: pre-start gate helper ({present, sample_count}).
--   E. `revoke_face_consent` REWRITTEN: in-transaction biometric purge —
--      the two-phase deletion queue (`face_deletion_pending` +
--      `confirm_face_subject_deleted` + cleanup cron) is retired.
--   F. Drops: `confirm_face_subject_deleted`, the old `enroll_face(text,
--      real)` overload (leaving it granted = a status-write oracle that
--      stores no biometrics), and `profiles.face_deletion_pending` — every
--      RPC referencing the column is rewritten ABOVE the drop.
--
-- Cutover: NO profiles rows are touched by this migration. Existing enrolled
-- students have empty baselines (raw frames were never stored — backfill is
-- impossible by design). The pre-start gate (`face_baseline_status`,
-- consumed by the play + student-quizzes pages) blocks quiz start, and the
-- verify route maps an empty baseline to 403 `not_enrolled` (belt-and-braces
-- for in-flight sessions in the deploy window). Deploy outside quiz hours.
--
-- ═══ A. pgvector + biometric samples table ═════════════════════════════
--
-- Extension guard: 0001 installed `vector` UNQUALIFIED and 0010 dropped it,
-- so the linear replay re-creates it here — but a dev DB that re-added the
-- extension in another schema would make `extensions.vector(512)` below
-- hard-fail mid-file. Guard explicitly.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'vector') then
    create extension vector with schema extensions;
  elsif not exists (
    select 1 from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector' and n.nspname = 'extensions'
  ) then
    raise exception 'pgvector extension must live in schema extensions (found elsewhere); drop and reinstall before migrating';
  end if;
end $$;

create table if not exists public.profile_face_samples (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  angle       text not null check (angle in ('front', 'left', 'right')),
  embedding   extensions.vector(512) not null,
  created_at  timestamptz not null default now(),
  constraint uq_profile_angle unique (profile_id, angle)
);

-- Deny-by-default: RLS enabled with ZERO policies, and privileges revoked —
-- the privilege layer rejects non-definer access before RLS is consulted.
alter table public.profile_face_samples enable row level security;
revoke all on public.profile_face_samples from public, anon, authenticated;
grant all on public.profile_face_samples to service_role;

-- No ivfflat/hnsw index: classroom-scale (students × 3 rows ≈ thousands) is
-- faster as an exact scan, and a `max(1 - dist)` aggregate cannot use an ANN
-- index anyway. Revisit HNSW only if rosters grow orders of magnitude.

-- ═══ B. enroll_face — rewritten (p_samples jsonb, internal dup check) ═══
--
-- The route pre-checks consent + pose before calling; the RPC re-checks
-- consent authoritatively. The old `enroll_face(text, real)` overload is
-- dropped FIRST (section F note: create-or-replace with a different arg list
-- creates a SECOND function — the old one would stay granted and let any
-- authenticated caller claim `enrolled` with zero biometric samples).
--
-- Probe throttle: each call reaching the duplicate check answers 1 bit about
-- other students' gallery membership (pending_review vs enrolled). The route
-- limiter is bypassable via direct PostgREST, so the RPC counts ATTEMPTS
-- (not outcomes — counting only `pending_review` would clear on every
-- negative probe) via the caller's own audit rows. 3 per 10 minutes is far
-- above legitimate cadence (students enroll a handful of times ever) and far
-- below useful probing. The counter is composed of ADMITTED attempts only
-- (a rate_limited return happens before the dup check and writes no audit
-- row); admitted attempts each write exactly one face_enroll/face_reenroll
-- audit row, so legitimate use is never throttled and probing past the
-- window caps itself.
drop function if exists public.enroll_face(text, real);
create or replace function public.enroll_face(p_samples jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  DUP_SIMILARITY_MIN constant real := 0.45;
  THROTTLE_WINDOW    constant interval := interval '10 minutes';
  THROTTLE_MAX       constant int := 3;
  MAX_EMB_MAGNITUDE  constant double precision := 1000;
  MIN_EMB_NORM_SQ    constant double precision := 1e-12;
  v_actor            uuid := auth.uid();
  v_ever_enrolled    boolean;
  v_has_live_session boolean;
  v_throttle_count   int;
  v_dup_sim          real;
  v_dup_profile      uuid;
  v_status           text;
  v_sample           jsonb;
  v_angle            text;
  v_x                double precision;
  v_norm_sq          double precision;
  v_emb1             text;
  v_emb2             text;
  v_emb3             text;
  v_a1               text;
  v_a2               text;
  v_a3               text;
  v_i                int;
  v_j                int;
begin
  if v_actor is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  -- (0) Lock the caller's own profile row FIRST: serializes concurrent
  -- enroll_face calls for the same student (double-submit → the second
  -- blocks on the row lock, not a raw 23505 on uq_profile_angle).
  perform 1 from public.profiles p
    where p.id = v_actor and p.role = 'student'
    for update;
  if not found then
    return jsonb_build_object('error', 'not_student');
  end if;

  -- (1) Consent re-check (authoritative; the route pre-check is advisory).
  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.consent_given_at is not null
  ) then
    return jsonb_build_object('error', 'consent_required');
  end if;

  -- (2) Strict jsonb validation — every malformed shape is a TYPED error,
  -- never an uncaught 500 (vector casts raise uncaught on wrong dims or
  -- non-numeric elements; same rationale as 0021's ndims gate).
  -- Exact shape: a 3-array of {angle: string, embedding: 512-array of
  -- finite numbers, |x| ≤ 1000, L2 norm > 0} with 3 DISTINCT known angles.
  if p_samples is null or jsonb_typeof(p_samples) <> 'array'
     or jsonb_array_length(p_samples) <> 3 then
    return jsonb_build_object('error', 'invalid_samples');
  end if;

  begin
    for v_i in 1 .. 3 loop
      v_sample := p_samples -> (v_i - 1);
      if jsonb_typeof(v_sample) <> 'object'
         or (select count(*) from jsonb_object_keys(v_sample)) <> 2
         or coalesce(jsonb_typeof(v_sample -> 'angle'), '') <> 'string'
         or coalesce(jsonb_typeof(v_sample -> 'embedding'), '') <> 'array'
         or jsonb_array_length(v_sample -> 'embedding') <> 512 then
        return jsonb_build_object('error', 'invalid_samples');
      end if;

      v_angle := v_sample ->> 'angle';
      if v_angle not in ('front', 'left', 'right') then
        return jsonb_build_object('error', 'invalid_samples');
      end if;

      v_norm_sq := 0;
      for v_j in 1 .. 512 loop
        v_x := null;
        begin
          v_x := ((v_sample -> 'embedding' -> (v_j - 1))::text)::double precision;
        exception
          when others then
            return jsonb_build_object('error', 'invalid_samples');
        end;
        if v_x is null or v_x::text = 'NaN' or abs(v_x) > MAX_EMB_MAGNITUDE then
          return jsonb_build_object('error', 'invalid_samples');
        end if;
        -- Bound the literal's text size: a 100k-digit `0.000…1` passes the
        -- magnitude gate but forces megabyte-scale numeric→text→vector
        -- parsing inside this definer RPC. Real embeddings are ~17 chars.
        if length((v_sample -> 'embedding' -> (v_j - 1))::text) > 64 then
          return jsonb_build_object('error', 'invalid_samples');
        end if;
        v_norm_sq := v_norm_sq + v_x * v_x;
      end loop;
      if v_norm_sq < MIN_EMB_NORM_SQ then
        -- A zero(-ish) vector makes `<=>` NaN → the dup check would silently
        -- pass and every later verify would read 0. Reject at the gate.
        return jsonb_build_object('error', 'invalid_samples');
      end if;

      case v_i
        when 1 then v_emb1 := v_sample ->> 'embedding'; v_a1 := v_angle;
        when 2 then v_emb2 := v_sample ->> 'embedding'; v_a2 := v_angle;
        else        v_emb3 := v_sample ->> 'embedding'; v_a3 := v_angle;
      end case;
    end loop;
  exception
    when others then
      -- jsonb_array_length on a non-array, weird nesting, etc.
      return jsonb_build_object('error', 'invalid_samples');
  end;

  if v_a1 = v_a2 or v_a1 = v_a3 or v_a2 = v_a3 then
    return jsonb_build_object('error', 'invalid_samples');
  end if;

  -- (3) Ever-enrolled + live-assessment gate (0010 semantics). The marker is
  -- samples OR audit rows: audit rows survive consent revocation (the
  -- revoke→re-enroll face-swap block, 0010) AND survive the cutover — so a
  -- pre-migration enrollee re-enrolling mid-session still gets
  -- live_assessment. The cutover deadlock is broken by the PRE-START gate
  -- (play/quizzes pages block quiz start without a baseline), not here.
  select exists (
           select 1 from public.profile_face_samples s where s.profile_id = v_actor
         )
         or exists (
           select 1 from public.audit_events ae
            where ae.actor_id = v_actor
              and ae.action in ('face_enroll', 'face_reenroll')
         )
    into v_ever_enrolled;
  select exists (
           select 1 from public.quiz_sessions s
            where s.student_id = v_actor and s.mode = 'assessment'
              and s.status in ('active', 'paused', 'flagged')
         )
    into v_has_live_session;
  if v_has_live_session and v_ever_enrolled then
    return jsonb_build_object('error', 'live_assessment');
  end if;

  -- (4) Attempt-based probe throttle (see header). Prior attempts within the
  -- window = the caller's own enroll audit rows in that window.
  select count(*) into v_throttle_count
    from public.audit_events ae
   where ae.actor_id = v_actor
     and ae.action in ('face_enroll', 'face_reenroll')
     and ae.created_at > now() - THROTTLE_WINDOW;
  if v_throttle_count >= THROTTLE_MAX then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  -- (5) INTERNAL duplicate check: max clamped cosine against OTHER students'
  -- samples. `greatest(0, …)` clamps negatives; the NaN guard handles the
  -- degenerate zero-vector case (validation already rejects zero vectors —
  -- belt-and-braces for stored legacy rows).
  select max(1.0::real - (s.embedding OPERATOR(extensions.<=>) q.emb)),
         (array_agg(s.profile_id order by 1.0::real - (s.embedding OPERATOR(extensions.<=>) q.emb) desc))[1]
    into v_dup_sim, v_dup_profile
    from public.profile_face_samples s
    join (
      values (v_emb1::extensions.vector(512)),
             (v_emb2::extensions.vector(512)),
             (v_emb3::extensions.vector(512))
    ) as q(emb) on s.profile_id <> v_actor;
  if v_dup_sim is null or v_dup_sim::text = 'NaN' then
    v_dup_sim := 0;
  end if;
  v_dup_sim := greatest(0::real, v_dup_sim);
  v_status := case when v_dup_sim >= DUP_SIMILARITY_MIN then 'pending_review' else 'enrolled' end;

  -- (6) Atomic sample storage: delete-then-insert inside the same
  -- transaction (re-enroll idempotent; a later gate failure can no longer
  -- orphan vectors — everything above already returned).
  delete from public.profile_face_samples where profile_id = v_actor;
  insert into public.profile_face_samples (profile_id, angle, embedding)
  values (v_actor, v_a1, v_emb1::extensions.vector(512)),
         (v_actor, v_a2, v_emb2::extensions.vector(512)),
         (v_actor, v_a3, v_emb3::extensions.vector(512));

  -- (7) GUC-guarded status write (the trigger requires BOTH GUCs and
  -- `app.face_enroll_actor = auth.uid()::text` — see 0010).
  perform set_config('app.face_enroll', 'on', true);
  perform set_config('app.face_enroll_actor', v_actor::text, true);
  update public.profiles
     set face_enrollment_status = v_status
   where id = v_actor;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    v_actor,
    v_actor,
    case when v_ever_enrolled then 'face_reenroll' else 'face_enroll' end,
    jsonb_build_object(
      'status', v_status,
      'duplicate_profile', v_dup_profile,
      'duplicate_similarity', v_dup_sim
    )
  );

  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

revoke execute on function public.enroll_face(jsonb) from public, anon;
grant execute on function public.enroll_face(jsonb) to authenticated;

-- ═══ C. compare_face_baseline — verify-side similarity (caller-own) ═════
--
-- Returns ONLY a scalar similarity against the CALLER's OWN samples (never
-- the vectors, never another student's rows) — the verify route feeds the
-- value (clamped to [0,1]) into `record_face_check` per frame. `present`
-- distinguishes "no samples" (cutover / not enrolled) from a genuine 0.
create or replace function public.compare_face_baseline(p_embedding extensions.vector(512))
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sim real;
begin
  if auth.uid() is null then
    return jsonb_build_object('present', false, 'similarity', 0);
  end if;

  select max(1.0::real - (s.embedding OPERATOR(extensions.<=>) p_embedding))
    into v_sim
    from public.profile_face_samples s
   where s.profile_id = auth.uid();

  if v_sim is null then
    return jsonb_build_object('present', false, 'similarity', 0);
  end if;
  -- NaN guard: a zero stored vector makes `<=>` NaN (NaN <> NaN is TRUE).
  if v_sim::text = 'NaN' then
    v_sim := 0;
  end if;
  -- Clamp to [0,1]: record_face_check's validator rejects values < 0 (raw
  -- cosine of non-matching ArcFace pairs is routinely negative).
  v_sim := greatest(0::real, least(1::real, v_sim));
  return jsonb_build_object('present', true, 'similarity', v_sim);
end;
$$;

revoke execute on function public.compare_face_baseline(extensions.vector(512)) from public, anon;
grant execute on function public.compare_face_baseline(extensions.vector(512)) to authenticated;

-- ═══ D. face_baseline_status — pre-start gate helper ════════════════════
--
-- The play + student-quizzes pages gate on `face_enrollment_status =
-- 'enrolled'`, which a cutover student still satisfies with zero samples.
-- Both pages additionally require `present` so students can only START a
-- quiz with a real biometric baseline under the new regime.
create or replace function public.face_baseline_status()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count int;
begin
  if auth.uid() is null then
    return jsonb_build_object('present', false, 'sample_count', 0);
  end if;
  select count(*) into v_count
    from public.profile_face_samples s
   where s.profile_id = auth.uid();
  return jsonb_build_object('present', v_count > 0, 'sample_count', v_count);
end;
$$;

revoke execute on function public.face_baseline_status() from public, anon;
grant execute on function public.face_baseline_status() to authenticated;

-- ═══ E. revoke_face_consent — atomic biometric purge ════════════════════
--
-- 0024 F1 body carried forward (all three GUCs — the profiles UPDATE touches
-- BOTH guarded columns; paused_at reset; completed-session check purge; the
-- `for update` session lock) MINUS face_deletion_pending PLUS the in-
-- transaction sample purge and its count in the audit metadata. One
-- transaction = a revoke can never leave biometric vectors of a
-- non-consenting student behind (the old retriable queue is retired).
create or replace function public.revoke_face_consent()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor  uuid := auth.uid();
  v_flagged jsonb;
  v_samples int;
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
         face_enrollment_status = null
   where id = v_actor;

  delete from public.profile_face_samples
   where profile_id = v_actor;
  get diagnostics v_samples = row_count;

  select coalesce(jsonb_agg(id), '[]'::jsonb)
    into v_flagged
    from (
      select id
        from public.quiz_sessions
       where student_id = v_actor and mode = 'assessment'
         and status in ('active', 'paused')
         for update
    ) s;

  -- F1 (0024): clear paused_at alongside the flag — a later unlock must NOT
  -- credit the flagged period as exam time.
  update public.quiz_sessions
     set status = 'flagged',
         paused_at = null
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
    jsonb_build_object('flagged_sessions', v_flagged, 'samples_deleted', v_samples)
  );

  return jsonb_build_object('ok', true, 'flagged_sessions', v_flagged);
end;
$$;

revoke execute on function public.revoke_face_consent() from public, anon;
grant execute on function public.revoke_face_consent() to authenticated;

-- ═══ F. Drops (after every rewrite above) ═══════════════════════════════
drop function if exists public.confirm_face_subject_deleted();
alter table public.profiles drop column if exists face_deletion_pending;

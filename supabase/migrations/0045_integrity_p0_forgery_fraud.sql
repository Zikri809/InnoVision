-- InnoVision — Migration 0045: P0 integrity fixes from the 2026-09-12
-- production-readiness audit (docs/audit/audit-1.md, 8 rounds, §9 final
-- ledger). One migration per finding family, all CREATE-OR-REPLACE safe:
--
--   P0-1  Direct-RPC similarity forgery + unlimited forge loop. The verdict
--         was a pure function of caller-supplied p_similarities, and the
--         verify nonce is owner-SELECTable, so any authenticated student
--         could loop `record_face_check([1,1])` straight through PostgREST
--         (the route's in-memory limiter does not bind direct PostgREST).
--         Fix (audit §9 binding correction — a service-role-only RPC was
--         REJECTED because the six auth.uid() gates would brick every
--         honest verify): route-minted HMAC proof over (session, nonce,
--         frame bytes) verified inside the RPC + a SQL-side per-session
--         attempt throttle (60 / 10 min — honest cadence is ~13-20/10 min
--         including question-transition checks; 3/10 min would self-DoS
--         long exams). The secret lives in the non-exposed app_private
--         schema; the route reads it through a service_role-only RPC.
--         `p_proof` defaults NULL so a stale caller gets a clean JSON
--         error instead of a PGRST202 (migration grace).
--   P0-2  Frozen-frame presence fraud via video.pause() / srcObject-swap
--         (server arm): the 3rd CONSECUTIVE identical frame_hash on a
--         MATCHED verdict now pauses the session. Honest
--         captures never hash-collide 3× (JPEG noise + luminance resample);
--         the only legitimate identical-hash producers are the E2E mock
--         marker frames (carved out below) and at most a nonce-retry
--         resend pair (2 rows, below the 3× threshold). Fail rows are out
--         of scope — the fail streak already escalates them. The client
--         arm (paused/seeking/srcObject capture guards) lives in
--         face-tracker.ts.
--   P0-3  face_unavailable_at was write-once and never cleared: one
--         report_face_unavailable call permanently silenced the silence
--         cron (self-granted kill-switch). Fix, three arms:
--           (a) record_face_check clears the stamp on a streak-2 matched
--               commit (two consecutive passes — one marginal pass must
--               not re-arm the exemption, audit F3);
--           (b) report_face_unavailable gains the status/live gates it
--               lacked, refreshes (not set-if-null) the stamp, throttles
--               writes to one per 5-min re-arm window, and re-keys the
--               lecturer notice hourly so sustained claims stay visible;
--           (c) the silence cron no longer trusts a STALE stamp (>10 min
--               old): a suppressed session that keeps answering flows into
--               the normal silence predicates. The client re-arms a real
--               outage every 5 min (use-face-pipeline), so honest outages
--               keep their exemption; an abandoned claim expires.
--   P0-4  Retake stale-seal banked a permanent NULL score + sent the
--         lecturer a bogus "session_submitted" mail. Fix: a BEFORE UPDATE
--         trigger materializes score = count(is_correct) for any
--         assessment completion that arrives scoreless (the seal — submit
--         always writes its score, so it never fires there), and marks a
--         transaction-local GUC that notify_session_terminal honours to
--         suppress the submit-flavoured notification for seals.
--   P0-5  submit_session on a closed quiz / removed student must stay
--         PERMISSIVE (seal-with-score — stranding honest close-mid-exam
--         evidence was rejected), but it must not participate in the
--         irreversible global auto-reveal: the reveal block now runs only
--         when the submitter is still enrolled + the quiz still live.
--   Chain-2 (§4.2) timer arms: exempt_face_session clears the stale
--         paused_at it left behind (re-pause used to inherit it through
--         coalesce) and unlock_session now caps its timer credit at the
--         same 120 s the self-recover cap enforces.
--   §2.13 timer honest-surprise: self_recover_session returns
--         creditedSeconds + remainingMs so the client ADDS the credited
--         time instead of freezing the full pause (mid-answer 403 fix).
--   §2.2  append_question (manual single-add) enforces the same 30-question
--         cap as bulk save — uncapped single adds past 30 bricked AI
--         append forever (422 loop).
--   §2.11 advisory-lock namespace split: save_quiz_questions,
--         append_question and reorder_questions now all serialize on ONE
--         `quiz_write:` namespace (was quiz_replace: vs quiz_append: vs
--         no lock at all — reorder could interleave with either).

-- ─── 1. app_private: HMAC secret + verify-attempt ledger ───────────────
-- app_private is NOT in the PostgREST-exposed schema list (public/storage/
-- graphql_public), so no anon/authenticated/service path can SELECT the
-- secret directly; the route reads it through the service_role-only getter
-- below. The secret is generated at migration time (gen_random_bytes) —
-- no operator plumbing, survives `db reset` (the route fetches it fresh
-- per verify, so a regenerated secret is picked up on the next call).
create schema if not exists app_private;

revoke all on schema app_private from public, anon, authenticated;

create table if not exists app_private.verify_proof_secret (
  id         int primary key default 1 check (id = 1),
  secret     text not null,
  rotated_at timestamptz not null default clock_timestamp()
);

insert into app_private.verify_proof_secret (secret)
select encode(extensions.gen_random_bytes(32), 'hex')
where not exists (select 1 from app_private.verify_proof_secret);

revoke all on app_private.verify_proof_secret from public, anon, authenticated;

-- One row per record_face_check attempt that passed the nonce gate —
-- SUCCESS OR PROOF-FAILURE (a forgery loop must burn the budget even
-- though it never inserts a face_checks row). Pruned opportunistically.
create table if not exists app_private.face_verify_attempts (
  session_id   uuid not null references public.quiz_sessions (id) on delete cascade,
  attempted_at timestamptz not null default clock_timestamp()
);

create index if not exists face_verify_attempts_session_idx
  on app_private.face_verify_attempts (session_id, attempted_at desc);
create index if not exists face_verify_attempts_prune_idx
  on app_private.face_verify_attempts (attempted_at);

revoke all on app_private.face_verify_attempts from public, anon, authenticated;

-- Route-side secret reader. service_role ONLY (revoke the default PUBLIC
-- EXECUTE first): a grant to authenticated would hand every student the
-- HMAC key and undo P0-1 entirely.
create or replace function public.get_verify_proof_secret()
returns text
language sql
security definer
set search_path = public, app_private
as $$
  select secret from app_private.verify_proof_secret where id = 1
$$;

revoke execute on function public.get_verify_proof_secret() from public, anon, authenticated;
grant execute on function public.get_verify_proof_secret() to service_role;

-- ─── 2. record_face_check: HMAC proof + throttle + replay→paused + ─────
--                        face_unavailable_at clearing
-- BASELINE: the LIVE 0044 revision. Changes from it:
--   * NEW signature: trailing `p_proof text default null` (drop the 6-arg
--     overload first — with a defaulted 7th arg kept alongside, PostgREST
--     could resolve a 6-arg call to the UNGUARDED overload).
--   * (9b) per-session attempt throttle BEFORE the proof check, so a forge
--     loop (valid nonce — the nonce is owner-readable — but fabricated
--     similarities) burns budget even though it never commits a check row.
--     Honest cadence (30-45s periodic + question-transition checks) sits
--     far below the limit; the 0044 2-second advisory stays as-is.
--   * (9c) HMAC-SHA256 proof over session_id|nonce|frame-concat, verified
--     with a double-HMAC comparison (both sides re-masked by the secret —
--     a plain equality compare on an HMAC output leaks match-prefix
--     timing to a caller probing digests). Proof is minted by the verify
--     route AFTER the sidecar compare; proofs never leave the server, so
--     binding the similarities themselves is unnecessary — a valid proof
--     for (session, nonce, frames) can only originate from the route.
--   * (10b) 3rd consecutive identical frame_hash on a MATCHED verdict →
--     status 'paused' (frozen-frame fraud; P0-2 server arm). Mock marker
--     frames (E2E seam) are carved out — in production a marker-prefixed
--     frame extracts zero faces and fails the majority anyway, so the
--     carve-out buys an attacker nothing.
--   * (13) face_unavailable_at cleared on a streak-2 matched commit
--     (P0-3a: two consecutive passes prove the feed is live again; one
--     marginal pass must not re-arm the silence-cron exemption).
create or replace function public.record_face_check(
  p_session_id   uuid,
  p_subject      text,
  p_similarities real[],
  p_trigger      public.face_check_trigger,
  p_nonce        uuid,
  p_frames       text[],
  p_proof        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, app_private
as $$
declare
  FACE_SIMILARITY_MIN constant real := 0.5;
  -- §9 binding correction: 40-60 attempts / 10 min per session. Honest
  -- cadence is ~13-20/10 min; 3/10 min would self-DoS honest 100+-verify
  -- exams (question-transition checks count against the same budget).
  MAX_VERIFY_ATTEMPTS constant int := 60;
  ATTEMPT_WINDOW      constant interval := interval '10 minutes';
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
  v_prev1_hash   text;
  v_prev2_hash   text;
  v_prev1_matched boolean;
  v_prev_checked_at timestamptz;
  v_hits int := 0;
  v_max_sim real := 0;
  v_i int;
  v_concat text := '';
  v_secret text;
  v_expected_proof text;
  v_proof_given text;
  v_attempts int;
  v_mock_seam boolean := false;
  v_replay_pause boolean := false;
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

  -- (6) face_exempt short-circuit: no row, no nonce rotation. Runs BEFORE
  -- the throttle/proof so an exempted session's probe stays free (pinned
  -- order: exempt → gates → nonce → throttle → proof → verdict).
  if v_session.face_exempt then
    return jsonb_build_object(
      'matched', true,
      'distance', null,
      'sessionStatus', v_session.status,
      'nextNonce', v_session.verify_nonce,
      'faceFailStreak', v_session.face_fail_streak
    );
  end if;

  -- (7) paused/flagged → session_not_active.
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

  -- (8b) Typed param validation. NaN compares GREATER than every non-NaN in
  -- Postgres, so the per-element range gate is REQUIRED (mirrors 0010 §8b);
  -- the ndims gate rejects multidimensional JSON arrays whose cardinality
  -- would pass 1..3 and whose subscripting would raise an uncaught 500.
  if p_nonce is null then
    return jsonb_build_object('error', 'nonce_mismatch');
  end if;
  if p_trigger is null then
    return jsonb_build_object('error', 'invalid_trigger');
  end if;
  if p_similarities is null
     or array_ndims(p_similarities) <> 1
     or array_ndims(coalesce(p_frames, '{}'::text[])) <> 1
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

  -- (9b) Attempt throttle (P0-1). Counted AFTER the nonce gate so only
  -- verdict-shaped calls burn budget, and BEFORE the proof check so a
  -- forgery loop pays even though it never inserts a face_checks row.
  -- Prune keeps the ledger bounded under sustained abuse. E2E carve-out:
  -- mock marker frames (the fake-tracker seam, same markers as the
  -- replay rule) never touch the ledger — a fast E2E cadence would
  -- otherwise self-throttle. In production a marker frame extracts zero
  -- faces and fails the majority even WITH a valid proof, so the
  -- carve-out buys a real attacker nothing.
  delete from app_private.face_verify_attempts
   where attempted_at < clock_timestamp() - interval '30 minutes';
  select exists (
    select 1 from unnest(coalesce(p_frames, '{}'::text[])) f
     where position('FAKE_FRAME_' in f) > 0
  ) into v_mock_seam;
  if not v_mock_seam then
    select count(*) into v_attempts
      from app_private.face_verify_attempts
     where session_id = v_session.id
       and attempted_at > clock_timestamp() - ATTEMPT_WINDOW;
    if v_attempts >= MAX_VERIFY_ATTEMPTS then
      return jsonb_build_object('error', 'rate_limited');
    end if;
    insert into app_private.face_verify_attempts (session_id)
    values (v_session.id);
  end if;

  -- Frame concat is needed by BOTH the proof check and the frame hash.
  for v_i in 1 .. cardinality(coalesce(p_frames, '{}'::text[])) loop
    v_concat := v_concat || '|' || coalesce(p_frames[v_i], '');
  end loop;
  v_frame_hash := encode(extensions.digest(v_concat, 'sha256'), 'hex');

  -- (9c) Route-minted proof (P0-1). The route computes
  --   HMAC-SHA256(secret, session_id || ':' || nonce || ':' || frame_concat)
  -- after the sidecar compare, over the EXACT frame bytes it forwards
  -- here. Direct PostgREST callers cannot obtain a proof (the secret never
  -- leaves app_private + the service_role getter), so forged similarities
  -- die here regardless of their values. Double-HMAC compare: masking both
  -- sides with the secret keeps the comparison constant-USEFUL (a raw hex
  -- equality compare would leak match-prefix timing to a digest prober).
  select secret into v_secret
    from app_private.verify_proof_secret
   where id = 1;
  if v_secret is null then
    -- Unreachable after §1; fail closed rather than skipping the check.
    return jsonb_build_object('error', 'proof_invalid');
  end if;
  v_expected_proof := encode(
    extensions.hmac(
      v_session.id::text || ':' || p_nonce::text || ':' || v_concat,
      v_secret,
      'sha256'
    ),
    'hex'
  );
  v_proof_given := coalesce(p_proof, '');
  if v_proof_given = '' then
    return jsonb_build_object('error', 'proof_required');
  end if;
  if extensions.hmac(v_expected_proof, v_secret, 'sha256')
     <> extensions.hmac(v_proof_given, v_secret, 'sha256') then
    return jsonb_build_object('error', 'proof_invalid');
  end if;

  -- (10) Server-computed verdict — strict majority of frames ≥ threshold,
  -- against the caller's OWN subject only (1:1 by lookup upstream).
  for v_i in 1 .. cardinality(p_similarities) loop
    if p_similarities[v_i] >= FACE_SIMILARITY_MIN then
      v_hits := v_hits + 1;
    end if;
    if p_similarities[v_i] > v_max_sim then
      v_max_sim := p_similarities[v_i];
    end if;
  end loop;

  v_matched := (
    coalesce(p_subject, '') = auth.uid()::text
    and v_hits * 2 > cardinality(p_similarities)
  );
  v_distance := 1.0 - v_max_sim;

  -- Advisory flags (two latest rows: prev1 for replay/frequency/streak-2,
  -- prev2 for the 3×-identical replay rule — ordering pinned).
  select fc.frame_hash, fc.matched, fc.checked_at
    into v_prev1_hash, v_prev1_matched, v_prev_checked_at
    from public.face_checks fc
   where fc.session_id = v_session.id
   order by fc.checked_at desc, fc.id desc
   limit 1;
  select fc.frame_hash
    into v_prev2_hash
    from public.face_checks fc
   where fc.session_id = v_session.id
   order by fc.checked_at desc, fc.id desc
   limit 1
   offset 1;
  v_suspected_replay := v_prev1_hash is not null and v_frame_hash = v_prev1_hash;
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
    -- (10b) Frozen-frame replay rule (P0-2 server arm): a MATCHED verdict
    -- whose frame bytes hash identically to BOTH previous commits means a
    -- static image is being resubmitted (video.pause() / srcObject swap).
    -- Honest captures never collide 3× — JPEG re-encode noise + the
    -- luminance resample guarantee drift. Carve-outs: E2E mock marker
    -- frames (identical by design; in production a marker frame extracts
    -- no face and fails the majority, so the carve-out is worthless to an
    -- attacker) — and the nonce-retry resend pair, which tops out at TWO
    -- consecutive identical rows (the failed attempt commits nothing).
    -- Fail rows are deliberately out of scope: the fail streak already
    -- escalates them to paused. (v_mock_seam was computed at §9b.)
    v_replay_pause := not v_mock_seam
      and v_prev1_hash is not null
      and v_frame_hash = v_prev1_hash
      and v_frame_hash = coalesce(v_prev2_hash, '');
    v_new_status := case when v_replay_pause then 'paused' else 'active' end;
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

  -- (13) Rotate nonce + timer bookkeeping. paused_at is cleared on 'flagged'
  -- (R1 parity with pause_session) so unlock never converts flagged idle
  -- into exam time. face_fail_count is the LIFETIME fail counter (0044).
  -- P0-3a: face_unavailable_at clears on the SECOND consecutive matched
  -- commit — the honest sidecar/camera recovery path — so a real outage
  -- never leaves a permanent silence-cron exemption behind, while a single
  -- marginal pass cannot re-arm one.
  update public.quiz_sessions
     set status = v_new_status,
         paused_at = case
           when v_new_status = 'paused' then coalesce(paused_at, clock_timestamp())
           when v_new_status in ('active', 'flagged') then null
           else paused_at
         end,
         face_fail_streak = v_new_streak,
         face_fail_count = coalesce(face_fail_count, 0)
           + case when v_matched then 0 else 1 end,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp(),
         face_unavailable_at = case
           when v_matched and coalesce(v_prev1_matched, false) then null
           else face_unavailable_at
         end
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

-- The 6-arg UNGUARDED overload must die: alongside a defaulted 7-arg
-- version it would let a 6-arg PostgREST call resolve to it and skip the
-- proof entirely.
drop function if exists public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[]);

revoke execute on function public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[], text)
  from public, anon;
grant execute on function public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[], text)
  to authenticated;

-- ─── 3. report_face_unavailable: gates + re-armable stamp + notice ─────
-- BASELINE: the LIVE 0022 revision. Changes (P0-3b):
--   * status gate (active/paused) + quiz-live gate — parity with
--     report_session_advisory/record_face_check; a completed/foreign
--     session can no longer be marked.
--   * the stamp REFRESHES (was set-if-null write-once) but at most once
--     per 5-minute re-arm window: an honest client re-arms a real outage
--     every 5 min, so the stamp is only ever FRESH when a live client is
--     actively maintaining the claim. Direct-RPC report spam within the
--     window writes nothing (and no longer fuzzes last_activity_at).
--   * the lecturer notice re-keys on an hourly bucket (0022's
--     session-scoped key hid every repeat forever): a sustained outage —
--     or an attacker maintaining a fraudulent one — stays visible without
--     storming the inbox.
create or replace function public.report_face_unavailable(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  REARM_WINDOW constant interval := interval '5 minutes';
  v_session public.quiz_sessions;
  v_rearm boolean;
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

  -- A claim on a terminal/blocked session is meaningless — and a
  -- paused/flagged session must not launder itself back into the cron's
  -- good graces by claiming an outage.
  if v_session.status not in ('active', 'paused') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- Outage claims only make sense while the quiz is still live and the
  -- student still enrolled (parity with the verify path's gate 4).
  if not public.can_student_view_quiz(v_session.quiz_id) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  -- Re-arm throttle: only a claim older than the window refreshes. Within
  -- the window the call is an honest idempotent no-op.
  v_rearm := v_session.face_unavailable_at is null
    or v_session.face_unavailable_at < clock_timestamp() - REARM_WINDOW;

  if v_rearm then
    update public.quiz_sessions
       set face_unavailable_at = clock_timestamp(),
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
             'face_unavailable_reported:' || s.id::text || ':'
               || to_char(clock_timestamp(), 'YYYYMMDDHH24')
        from public.quiz_sessions s
        join public.quizzes q on q.id = s.quiz_id
        join public.classes c on c.id = q.class_id
       where s.id = v_session.id
      on conflict (recipient_id, dedupe_key) do nothing;
    exception
      when unique_violation then null;
      when foreign_key_violation then null;
    end;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.report_face_unavailable(uuid) from public, anon;
grant execute on function public.report_face_unavailable(uuid) to authenticated;

-- ─── 4. flag_verify_silent_sessions: stale-unavailable claims expire ───
-- BASELINE: the LIVE 0044 revision. Change: BOTH the cursor predicate and
-- the guarded UPDATE replace `face_unavailable_at is null` with a
-- FRESHNESS form — a stamp older than 10 minutes no longer exempts the
-- session (P0-3c). The client re-arms a genuine outage every 5 minutes
-- (half the staleness bound, so a single dropped re-arm never flags an
-- honest session), while a one-shot kill-switch claim — the P0-3 exploit —
-- goes stale and the session flows into the normal silence predicates.
-- The streak-2 clearing in record_face_check §2 recovers sessions whose
-- verifies resumed; this predicate covers the ones that never will.
create or replace function public.flag_verify_silent_sessions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flagged int := 0;
  v_row public.quiz_sessions;
  v_seconds_since_check int;
begin
  -- Recency is keyed to session_answers.answered_at (the true answering
  -- signal), NOT last_activity_at: report_session_advisory also touches
  -- last_activity_at (0021), and advisories fire while faceStatus==='ready'
  -- with NO phase gating — a slow reader dwelling on feedback who leans back
  -- (looked_away advisory) would otherwise satisfy freshness while the
  -- suspended verify cadence produces no rows. False-flag vector, R1 review.
  for v_row in
    select s.*
      from public.quiz_sessions s
     where s.status = 'active'
       and s.mode = 'assessment'
       and s.face_exempt = false
       and (s.face_unavailable_at is null
            or s.face_unavailable_at < clock_timestamp() - interval '10 minutes')
       and (
         select max(sa.answered_at)
           from public.session_answers sa
          where sa.session_id = s.id
       ) > clock_timestamp() - interval '90 seconds'
       and (
         -- COALESCE with started_at: a session with ZERO face_checks rows
         -- (tampered client that suppressed verifies from the very start)
         -- has max(checked_at) = NULL, and NULL < anything is NULL — without
         -- the coalesce the headline bypass case escapes the flag entirely.
         select coalesce(max(fc.checked_at), s.started_at)
           from public.face_checks fc
          where fc.session_id = s.id
       ) < clock_timestamp() - interval '300 seconds'
       -- 0044 return-from-hide grace (answer-count form). A tab-return
       -- catch-up verify takes a few seconds (capture + two spaced
       -- secondaries), so an honest returner has answered AT MOST once
       -- since her last check when the cron tick lands mid-capture — the
       -- grace SKIPS those (count <= 1 is NOT a candidate). A session whose
       -- verification is suppressed accumulates a SECOND post-check answer
       -- within the 300s silence window and is flagged from that moment;
       -- the count RESETS only when a real face_checks row commits (a
       -- verify), so a bot can pace answers but never clear the count.
       -- 0045 §4: the 0044 baseline shipped this term INVERTED (`<= 1`),
       -- which flagged the honest one-answer returner and excluded the
       -- suppressed session after its second answer — the exact opposite
       -- of the design comment. Fixed to `>= 2` (cursor + guarded UPDATE).
       and (
         select count(*) from public.session_answers sa
          where sa.session_id = s.id
            and sa.answered_at > coalesce(
              (select max(fc.checked_at) from public.face_checks fc
                where fc.session_id = s.id),
              s.started_at
            )
       ) >= 2
       -- Pause-resume guard: self_recover/unlock write NO face_checks row,
       -- the post-resume cadence fires its first verify only 30-45s later,
       -- and a quick answer lands within seconds — a session that paused
       -- >300s (its last check predates the pause) then answered would be
       -- flagged before its honest verify. Exempt sessions paused within the
       -- silence window. NOT an evasion loop: status='paused' blocks
       -- answering entirely (answer_question status gate), so entering pause
       -- buys a cheater nothing — only genuine recover/unlock flows reach
       -- this exemption, and the focus/hand 3-strike already polices pause
       -- cycling (0044).
       and (s.paused_at is null or s.paused_at > clock_timestamp() - interval '300 seconds')
       and exists (
         select 1
           from public.quizzes q
           join public.classes c on c.id = q.class_id
           join public.class_enrollments ce on ce.class_id = q.class_id
          where q.id = s.quiz_id
            and ce.student_id = s.student_id
            and q.status = 'live'
            and c.archived_at is null
       )
     order by s.last_activity_at desc
     limit 100
  loop
    v_seconds_since_check := extract(epoch from (
      clock_timestamp() - coalesce(
        (select max(fc.checked_at) from public.face_checks fc where fc.session_id = v_row.id),
        v_row.started_at
      )
    ))::int;

    -- The WHERE re-states EVERY freshness + exemption predicate (not just
    -- status): under READ COMMITTED a record_face_check that commits between
    -- the cursor snapshot and this UPDATE re-evaluates here, so a student
    -- whose verify just LANDED is never flagged on stale data.
    update public.quiz_sessions
       set status = 'flagged',
           paused_at = null,
           last_activity_at = clock_timestamp()
     where id = v_row.id
       and status = 'active'
       and mode = 'assessment'
       and face_exempt = false
       and (quiz_sessions.face_unavailable_at is null
            or quiz_sessions.face_unavailable_at < clock_timestamp() - interval '10 minutes')
       and (
         select max(sa.answered_at)
           from public.session_answers sa
          where sa.session_id = quiz_sessions.id
       ) > clock_timestamp() - interval '90 seconds'
       and (
         -- COALESCE parity with the cursor predicate (zero-check sessions).
         select coalesce(max(fc.checked_at), quiz_sessions.started_at)
           from public.face_checks fc
          where fc.session_id = quiz_sessions.id
       ) < clock_timestamp() - interval '300 seconds'
       -- 0044 grace (answer-count form), cursor parity (0045 inversion fix:
       -- flag only when the grace is exhausted, count >= 2).
       and (
         select count(*) from public.session_answers sa
          where sa.session_id = quiz_sessions.id
            and sa.answered_at > coalesce(
              (select max(fc.checked_at) from public.face_checks fc
                where fc.session_id = quiz_sessions.id),
              quiz_sessions.started_at
            )
       ) >= 2
       -- Pause-resume guard, cursor parity.
       and (quiz_sessions.paused_at is null
            or quiz_sessions.paused_at > clock_timestamp() - interval '300 seconds')
       -- Quiz-liveness restated too (a quiz that closed mid-scan is never
       -- flagged) — see header for why this is inlined, not can_student_view_quiz.
       and exists (
         select 1
           from public.quizzes q
           join public.classes c on c.id = q.class_id
           join public.class_enrollments ce on ce.class_id = q.class_id
          where q.id = quiz_sessions.quiz_id
            and ce.student_id = quiz_sessions.student_id
            and q.status = 'live'
            and c.archived_at is null
       );

    if found then
      v_flagged := v_flagged + 1;
      -- No actor_id (system flag; auth.uid() is null under cron) — subject_id
      -- carries the student; metadata carries quiz+session (R3: rows without
      -- them never surface on the session integrity timeline).
      insert into public.audit_events (actor_id, subject_id, action, metadata)
      values (
        null,
        v_row.student_id,
        'auto_flag_verify_silence',
        jsonb_build_object(
          'quiz_id', v_row.quiz_id,
          'session_id', v_row.id,
          'seconds_since_check', v_seconds_since_check
        )
      );
    end if;
  end loop;
  return v_flagged;
end;
$$;

revoke execute on function public.flag_verify_silent_sessions() from public, anon;
grant execute on function public.flag_verify_silent_sessions() to service_role;

-- ─── 5. self_recover_session: return the credited time + deadline ──────
-- BASELINE: the LIVE 0044 revision (120 s credit cap unchanged). Changes
-- (audit §2.3/§2.13): the response now carries creditedSeconds and
-- remainingMs. The client used to freeze its countdown for the FULL pause
-- while the server credited at most 120 s — the drift surfaced as a
-- mid-answer time_expired 403. The client adds the credited seconds (or
-- simply adopts remainingMs, the server's own deadline arithmetic:
-- started_at + time_limit + the 5 s answer grace − now).
create or replace function public.self_recover_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  MAX_RECOVERY_CREDIT_SECONDS constant int := 120;
  v_session public.quiz_sessions;
  v_next_nonce uuid;
  v_credited interval;
  v_time_limit int;
  v_remaining_ms int;
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
    v_credited := least(
      clock_timestamp() - v_session.paused_at,
      make_interval(secs => MAX_RECOVERY_CREDIT_SECONDS)
    );
    update public.quiz_sessions
       set status = 'active',
           started_at = started_at + v_credited,
           paused_at = null,
           face_fail_streak = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  else
    v_credited := make_interval(secs => 0);
    update public.quiz_sessions
       set status = 'active',
           face_fail_streak = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  end if;

  select q.time_limit_sec into v_time_limit
    from public.quizzes q
   where q.id = v_session.quiz_id;

  -- remainingMs mirrors the page-seeding formula (lib/sessions/timer.ts
  -- remainingMs(): started_at + time_limit − now, UNGRACED — the 5 s SQL
  -- grace stays server-side headroom so the client countdown keeps expiring
  -- just before the answer deadline). The client adopts this value after a
  -- blink recovery, so the countdown reflects the credited time instead of
  -- freezing through the whole pause (the mid-answer time_expired drift).
  if v_time_limit is null then
    v_remaining_ms := null;
  else
    v_remaining_ms := greatest(0, (
      extract(epoch from (
        (v_session.started_at + v_credited)
          + (v_time_limit * interval '1 second')
          - clock_timestamp()
      )) * 1000
    ))::int;
  end if;

  insert into public.audit_events (actor_id, subject_id, action)
  values (auth.uid(), auth.uid(), 'self_recover');

  return jsonb_build_object(
    'sessionStatus', 'active',
    'nextNonce', v_next_nonce,
    'creditedSeconds', greatest(0, extract(epoch from v_credited))::int,
    'remainingMs', v_remaining_ms
  );
end;
$$;

revoke execute on function public.self_recover_session(uuid) from public, anon;
grant execute on function public.self_recover_session(uuid) to authenticated;

-- ─── 6. unlock_session: cap the lecturer-unlock timer credit ───────────
-- BASELINE: the LIVE 0044 revision. Change: the credited duration is capped
-- at MAX_RECOVERY_CREDIT_SECONDS (120 s) — the same brake self_recover
-- wears since 0044. An unlock of a session paused for hours used to shift
-- started_at by the FULL paused duration (§4 chain 2: banked time); a
-- lecturer adjudicating a flag should never gift more exam time than a
-- self-recovery could.
create or replace function public.unlock_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  MAX_RECOVERY_CREDIT_SECONDS constant int := 120;
  v_session public.quiz_sessions;
  v_next_nonce uuid;
  v_quiz_title text;
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
           started_at = started_at + least(
             clock_timestamp() - v_session.paused_at,
             make_interval(secs => MAX_RECOVERY_CREDIT_SECONDS)
           ),
           paused_at = null,
           face_fail_streak = 0,
           focus_pause_count = 0,
           fullscreen_pause_count = 0,
           hand_pause_count = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  else
    update public.quiz_sessions
       set status = 'active',
           face_fail_streak = 0,
           focus_pause_count = 0,
           fullscreen_pause_count = 0,
           hand_pause_count = 0,
           verify_nonce = gen_random_uuid(),
           last_activity_at = clock_timestamp()
     where id = v_session.id
     returning verify_nonce into v_next_nonce;
  end if;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'unlock',
    jsonb_build_object(
      'quiz_id', v_session.quiz_id,
      'session_id', v_session.id
    )
  );

  -- IO-1: tell the student the wait is over. Recipient from ROW data (the
  -- RPC's auth.uid() is the lecturer); dedupe key carries the rotated nonce
  -- so every genuine unlock notifies once while double-fire stays deduped.
  select q.title into v_quiz_title
    from public.quizzes q
   where q.id = v_session.quiz_id;

  begin
    insert into public.notifications (recipient_id, type, payload, dedupe_key)
    values (
      v_session.student_id,
      'session_unlocked',
      jsonb_build_object(
        'session_id', v_session.id,
        'quiz_id', v_session.quiz_id,
        'quiz_title', coalesce(v_quiz_title, '')
      ),
      'session_unlocked:' || v_session.id::text || ':' || v_next_nonce::text
    )
    on conflict (recipient_id, dedupe_key) do nothing;
  exception
    when unique_violation then
      -- Dedupe race lost: another connection inserted first. Fine.
      null;
    when others then
      -- DEVIATION from 0022's WHEN OTHERS ban (documented in 0033's header):
      -- the notification is best-effort; the unlock + audit above are the
      -- authoritative record and the 8s poll is the consistency backbone.
      -- A failure here must never fail the lecturer's unlock.
      raise warning 'unlock_session: session_unlocked notification insert failed (session %)', v_session.id;
  end;

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.unlock_session(uuid) from public, anon;
grant execute on function public.unlock_session(uuid) to authenticated;

-- ─── 7. exempt_face_session: clear the stale paused_at ─────────────────
-- BASELINE: the LIVE 0044 revision. Change: the exemption UPDATE now also
-- sets paused_at = null. It was deliberately left standing in 0043/0044 on
-- the argument that the 120 s recovery cap bounded the inflation — but the
-- stale stamp kept leaking through re-pause (pause_session's
-- coalesce(paused_at, now()) preserves it) and through the silence cron's
-- pause-resume guard. Clearing it closes chain 2 (§4.2) outright: an
-- exemption is a fresh adjudication, not a timer event.
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

  -- Bound the reason at the SQL layer too (the route's ExemptSchema caps at
  -- 500; a direct RPC caller must not bloat audit_events.metadata).
  if p_reason is null or length(p_reason) > 500 then
    return jsonb_build_object('error', 'invalid_reason');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- F2 (0021): reset the pause counters so an exemption clears the flag
  -- threshold — otherwise the next genuine blur instantly re-flags. 0045
  -- adds paused_at = null: the stale stamp must not survive into re-pause
  -- (coalesce inheritance) or the cron's pause-resume guard.
  update public.quiz_sessions
     set face_exempt = true,
         status = 'active',
         paused_at = null,
         face_fail_streak = 0,
         focus_pause_count = 0,
         fullscreen_pause_count = 0,
         hand_pause_count = 0,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_next_nonce;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'exempt_face',
    jsonb_build_object(
      'reason', p_reason,
      'quiz_id', v_session.quiz_id,
      'session_id', v_session.id
    )
  );

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.exempt_face_session(uuid, text) from public, anon;
grant execute on function public.exempt_face_session(uuid, text) to authenticated;

-- ─── 8. Stale-seal scoring (P0-4) ───────────────────────────────────────
-- start_quiz_session's stale-paused seal completes a session whose window
-- passed WITHOUT computing a score; submit_session's idempotency then made
-- the NULL permanent and notify_session_terminal mailed the lecturer a
-- "submitted" that never happened. Rather than restate the whole 0032
-- start_quiz_session body, ONE BEFORE UPDATE trigger owns the invariant:
-- any ASSESSMENT completion that arrives scoreless is a seal — materialize
-- score = count(is_correct) (the exact arithmetic submit_session uses) and
-- mark the update as a seal via a transaction-local GUC. The honest submit
-- always writes its own score, so this trigger never fires for it. The GUC
-- (is_local => true: transaction-scoped, pooler-safe) is read by
-- notify_session_terminal §9 to suppress the submit-flavoured notification.
create or replace function public.assign_seal_score()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_score int;
begin
  select count(*) into v_score
    from public.session_answers sa
   where sa.session_id = new.id
     and sa.is_correct;

  new.score := v_score;

  perform set_config('app.session_sealing', 'on', true);

  return new;
end;
$$;

drop trigger if exists quiz_sessions_seal_score on public.quiz_sessions;
create trigger quiz_sessions_seal_score
  before update of status, score on public.quiz_sessions
  for each row
  when (new.status = 'completed'
        and old.status is distinct from 'completed'
        and new.mode = 'assessment'
        and new.score is null)
  execute function public.assign_seal_score();

-- ─── 9. notify_session_terminal: seals are not submits ─────────────────
-- BASELINE: the LIVE 0032 revision (DISTINCT-student completed count).
-- Change: when the seal marker GUC is set (§8), the row reached 'completed'
-- via the window-passage seal, not a submission — a session_submitted mail
-- would be bogus and the quiz_completed_all count would read a seal as a
-- finish. Skip BOTH completed-arms for seals; the lecturer sees the sealed
-- partial score in the gradebook, which is the honest artifact. The
-- flagged arm is untouched (the seal never writes 'flagged').
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
    -- 0045 §8: a sealed (window-passed) session is terminal but NOT a
    -- submission — no session_submitted mail, no quiz_completed_all vote.
    if current_setting('app.session_sealing', true) = 'on' then
      return null;
    end if;

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

    -- quiz_completed_all: DISTINCT students with a completed ASSESSMENT
    -- session >= CURRENT enrollment count (QC-4: retakes are attempts of
    -- the same student, not extra students; D9 dedupe note retained).
    select q.class_id into v_class_id
      from public.quizzes q where q.id = new.quiz_id;

    select count(*) into v_enrolled
      from public.class_enrollments ce
     where ce.class_id = v_class_id;

    select count(distinct x.student_id) into v_completed
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

-- ─── 10. submit_session: gate the reveal consequences, not the submit ──
-- BASELINE: the LIVE 0032 revision. Change (P0-5, adjudicated posture):
-- the submit itself stays permissive — a closed quiz / removed student /
-- post-archive submit still completes with its earned score (hard-blocking
-- would strand honest close-mid-exam evidence). But the IRREVERSIBLE
-- global auto-reveal now runs only when the submitter is still enrolled
-- and the quiz still live: a removed last-fresh submitter used to flip
-- results_revealed_at for the whole class (audit §8 H1 exhibit).
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
  v_allow_retake boolean;
  v_max_attempts int;
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

  -- Retake config for the auto-reveal predicate below (QC-4).
  select q.allow_retake, q.max_attempts
    into v_allow_retake, v_max_attempts
    from public.quizzes q
   where q.id = v_session.quiz_id;

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
    if public.can_student_view_quiz(v_session.quiz_id) then
      -- Serialize count-then-reveal across concurrent last-submits.
      perform pg_advisory_xact_lock(hashtext('quiz_reveal:' || v_session.quiz_id::text));

      -- "All done" = no fresh (≤2h) active/paused/flagged assessment sessions
      -- AND the CURRENT submitting student has no retake budget remaining
      -- (QC-4 pre-flight decision 1: the student who just finished deserves a
      -- quiet window to retake; OTHER students' completed attempts don't hold
      -- the quiz hostage — each submitter's own budget governs their own
      -- submit event). Stale sessions read as done; `flagged` blocks
      -- (lecturer decision first).
      select not exists (
        select 1 from public.quiz_sessions s
        where s.quiz_id = v_session.quiz_id
          and s.mode = 'assessment'
          and s.status in ('active', 'paused', 'flagged')
          and s.last_activity_at >= now() - interval '2 hours'
      ) and not (
        v_allow_retake
        and v_session.student_id is not null
        and (select count(*) from public.quiz_sessions x
             where x.quiz_id = v_session.quiz_id
               and x.student_id = v_session.student_id
               and x.mode = 'assessment'
               and x.status = 'completed') < v_max_attempts
      ) into v_all_done;

      if v_all_done then
        -- F8b: no status='live' term — the quiz may already be closed by the
        -- time the last submission lands; reveal-once semantics are carried by
        -- results_revealed_at is null alone.
        update public.quizzes
           set results_revealed_at = clock_timestamp()
         where id = v_session.quiz_id
           and auto_reveal_on_complete
           and results_revealed_at is null;
        -- row_count 0 = not the flipper (idempotent; no side effect to re-run).
      end if;

      -- Re-read reveal state AFTER the guarded flip (same transaction sees it).
      v_revealed := public.is_student_reveal_allowed(v_session.quiz_id);
    end if;
    -- else (quiz closed / submitter removed): the submit completes with its
    -- score but never triggers or participates in the global reveal — the
    -- pre-computed v_revealed stands (a removed student reads as
    -- unrevealed, exactly like every other reveal-gated read for them).
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

-- ─── 11. append_question: 30-cap under the unified lock (§2.2) ─────────
-- BASELINE: the LIVE 0037 revision. Changes: the manual single-add now
-- enforces the SAME 30-question cap as bulk save (uncapped single adds
-- pushed a quiz past the cap and bricked every subsequent AI append with a
-- permanent 422), and the lock moves to the unified `quiz_write:` namespace
-- (§2.11) so append/replace/reorder serialize against EACH OTHER.
create or replace function public.append_question(
  p_quiz_id uuid,
  p_type public.question_type,
  p_prompt text,
  p_options text[],
  p_correct_index int default null,
  p_explanation text default null,
  p_correct_indices int[] default null
)
returns public.questions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.quiz_status;
  v_next   int;
  v_row    public.questions;
  v_existing_count int;
  v_max_quiz_cap   int := 30;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    where q.id = p_quiz_id and c.lecturer_id = auth.uid()
  ) then
    raise exception 'not_owner'
      using errcode = 'P0001';
  end if;

  select q.status into v_status from public.quizzes q where q.id = p_quiz_id;
  if v_status is null then
    raise exception 'quiz_not_found'
      using errcode = 'P0001';
  end if;
  if v_status <> 'draft' then
    raise exception 'questions_locked_quiz_not_draft'
      using errcode = 'P0001';
  end if;

  -- Unified per-quiz write lock (0045 §2.11): serialize against
  -- save_quiz_questions AND reorder_questions, not just sibling appends —
  -- two writers must never both read the same MAX(order_index).
  perform pg_advisory_xact_lock(hashtext('quiz_write:' || p_quiz_id::text));

  -- Cap parity with save_quiz_questions (same error string so the route
  -- mapping keeps working): a 30th question still lands, a 31st never does.
  select count(*) into v_existing_count
    from public.questions
   where quiz_id = p_quiz_id;

  if v_existing_count + 1 > v_max_quiz_cap then
    raise exception 'quiz_question_limit_exceeded' using errcode = 'P0001';
  end if;

  select coalesce(max(order_index), -1) + 1 into v_next
    from public.questions
   where quiz_id = p_quiz_id;

  -- NULLIF normalizes an empty explanation string to NULL (Zod allows "").
  -- The multi set is NORMALIZED (sorted+distinct) on write — same posture as
  -- save_quiz_questions — so every writer lands in the trigger's canonical
  -- form and int[] grading equality stays meaningful.
  insert into public.questions (quiz_id, order_index, type, prompt, options, correct_index, correct_indices, explanation)
  values (
    p_quiz_id, v_next, p_type, p_prompt, p_options, p_correct_index,
    case when p_correct_indices is null then null
         else (select array_agg(distinct e order by e) from unnest(p_correct_indices) e) end,
    nullif(p_explanation, '')
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.append_question(uuid, public.question_type, text, text[], int, text, int[]) from public, anon;
grant execute on function public.append_question(uuid, public.question_type, text, text[], int, text, int[]) to authenticated;

-- ─── 12. save_quiz_questions: unified lock namespace ───────────────────
-- BASELINE: the LIVE 0037 revision. Change: `quiz_replace:` → `quiz_write:`
-- (§2.11). Body otherwise verbatim.
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
  v_correct_set    int[];
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

  if p_title is not null and (char_length(trim(p_title)) < 1 or char_length(trim(p_title)) > 200) then
    raise exception 'invalid_title' using errcode = 'P0001';
  end if;

  -- Unified per-quiz write lock (0045 §2.11): one namespace for
  -- replace/append/reorder (was quiz_replace: vs quiz_append: — a replace
  -- and an append could interleave and duplicate order_index values).
  perform pg_advisory_xact_lock(hashtext('quiz_write:' || p_quiz_id::text));

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
       or (v_q -> 'options') is null or jsonb_typeof(v_q -> 'options') <> 'array' then
      raise exception 'invalid_question_fields' using errcode = 'P0001';
    end if;

    if v_type = 'multi_select' then
      -- Multi rows carry the correct SET; the scalar must be absent (the
      -- insert nulls it). Normalized sorted+distinct to match the trigger's
      -- canonical form.
      -- A jsonb `null` key is NOT SQL NULL (so `is not null` passes); test
      -- the TYPE, and reject null/non-numeric elements BEFORE the int cast
      -- (a bare 22P02 would surface as an unmapped 500 for direct callers).
      if jsonb_typeof(v_q -> 'correct_indices') <> 'array'
         or v_correct is not null
         or exists (
           select 1 from jsonb_array_elements(v_q -> 'correct_indices') elem
           where elem is not distinct from 'null'::jsonb
              or (elem::text) !~ '^[0-9]+$'
         ) then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_correct_set := coalesce((
        select array_agg(distinct e order by e)
        from (select (elem::text)::int as e
              from jsonb_array_elements_text(v_q -> 'correct_indices') elem) s
      ), '{}'::int[]);
      if cardinality(v_correct_set) < 1
         or cardinality(v_correct_set) > cardinality(v_options)
         or exists (
           select 1 from unnest(v_correct_set) e
           where e < 0 or e >= cardinality(v_options)
         ) then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_correct := null;
    else
      -- jsonb null ≠ SQL null: `jsonb_typeof(...)` on a jsonb null is 'null',
      -- so only a REAL array means "set present" on a scalar row.
      if v_correct is null or v_correct < 0
         or jsonb_typeof(v_q -> 'correct_indices') = 'array' then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_correct_set := null;
    end if;

    insert into public.questions (
      quiz_id,
      order_index,
      type,
      prompt,
      options,
      correct_index,
      correct_indices,
      explanation
    )
    values (
      p_quiz_id,
      v_start_index + v_i,
      v_type::public.question_type,
      trim(v_prompt),
      v_options,
      v_correct,
      v_correct_set,
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

revoke execute on function public.save_quiz_questions(uuid, text, text, text, jsonb, text) from public, anon;
grant execute on function public.save_quiz_questions(uuid, text, text, text, jsonb, text) to authenticated;

-- ─── 13. reorder_questions: take the unified write lock ────────────────
-- BASELINE: the LIVE 0004 revision. Change: the reorder loop previously ran
-- with NO advisory lock — a reorder interleaved with a concurrent append or
-- replace could duplicate order_index values (there is no UNIQUE on
-- (quiz_id, order_index)). It now serializes on the same `quiz_write:`
-- namespace as save/append (§2.11). Body otherwise verbatim.
create or replace function public.reorder_questions(p_quiz_id uuid, p_ordered_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected int;
  v_found    int;
  v_status   public.quiz_status;
  v_i        int;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    where q.id = p_quiz_id and c.lecturer_id = auth.uid()
  ) then
    raise exception 'not_owner'
      using errcode = 'P0001';
  end if;

  select q.status into v_status from public.quizzes q where q.id = p_quiz_id;
  if v_status is null then
    raise exception 'quiz_not_found'
      using errcode = 'P0001';
  end if;
  if v_status <> 'draft' then
    raise exception 'questions_locked_quiz_not_draft'
      using errcode = 'P0001';
  end if;

  -- Unified per-quiz write lock (0045 §2.11) — see append_question §11.
  perform pg_advisory_xact_lock(hashtext('quiz_write:' || p_quiz_id::text));

  select count(*) into v_expected
    from public.questions
   where quiz_id = p_quiz_id;

  if p_ordered_ids is null or cardinality(p_ordered_ids) <> v_expected then
    raise exception 'id_count_mismatch'
      using errcode = 'P0001';
  end if;

  -- Every provided id must belong to this quiz AND be unique. Counting
  -- distinct matching ids catches both foreign ids and duplicates.
  select count(distinct provided.id) into v_found
    from unnest(p_ordered_ids) as provided(id)
   where exists (
     select 1 from public.questions q
     where q.id = provided.id and q.quiz_id = p_quiz_id
   );

  if v_found <> v_expected then
    raise exception 'foreign_question_id'
      using errcode = 'P0001';
  end if;

  for v_i in 1 .. v_expected loop
    update public.questions
       set order_index = v_i - 1
     where id = p_ordered_ids[v_i] and quiz_id = p_quiz_id;
  end loop;
end;
$$;

revoke execute on function public.reorder_questions(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_questions(uuid, uuid[]) to authenticated;

-- ─── 14. student_quizzes: creator-only table SELECT (§2.1 share fix) ───
-- The "Creator or shared-visible" policy let ANY authenticated student dump
-- the whole practice corpus (titles, prompts, options, keys, image paths,
-- share codes) straight off the table without ever holding a code —
-- `is_shared_student_quiz(id)` is one lookup, and the table grant is a bare
-- SELECT on ALL columns. Every in-app reader of this table is creator-scoped
-- (my-quizzes pages, student-quizzes routes, requireStudentQuizOwner, the
-- play page all filter `created_by = auth.uid()`), and shared READS have
-- proper code-gated paths: the resolve RPC (security definer, code check)
-- and student_quiz_player_question_view (code-less, key-less). So the
-- shared arm of the SELECT policy buys the app nothing and hands
-- enumerators everything — drop it. Shared-play behavior is unchanged; the
-- SQ-D2c harness pin inverts from "B sees SHARED quiz" to "B sees ZERO rows
-- from the table; the resolve RPC/view remain the shared-read paths".
drop policy if exists "Creator or shared-visible" on public.student_quizzes;
drop policy if exists "Creator only (shared reads are code-gated RPC/view paths)" on public.student_quizzes;
create policy "Creator only (shared reads are code-gated RPC/view paths)"
  on public.student_quizzes for select
  using (created_by = auth.uid());

-- ─── 15. quiz_autoclose: auto-reveal livelock sweeper (§2.6) ───────────
-- submit_session's "all done" predicate holds the global reveal while the
-- CURRENT submitter has retake budget remaining (QC-4 decision 1 — a quiet
-- retake window). But a student who never exercises that budget never fires
-- another submit event, so an allow_retake + auto_reveal quiz could sit
-- unrevealed FOREVER: no event re-evaluates after the last submit (audit-1
-- P1-6). This sweeper rides the existing 5-minute cron and re-evaluates the
-- reveal rule: flip when the quiz opted in, is still unrevealed, has at
-- least one completed attempt, and has had NO assessment activity of any
-- status for 2 hours — the same quiet window submit_session honours, now
-- enforced REGARDLESS of residual budget. A quiz whose last submitter
-- already triggered the reveal is untouched (results_revealed_at not null);
-- an in-flight attempt (active/paused/flagged fresh) keeps holding.
create or replace function public.quiz_autoclose()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed   int;
  v_revealed int;
begin
  update public.quizzes
     set status = 'closed'
   where status = 'live'
     and closes_at is not null
     and closes_at <= clock_timestamp();
  get diagnostics v_closed = row_count;

  -- audit-1 P1-6 (see section header). The 2h inactivity term covers ALL
  -- assessment session statuses: a fresh completed attempt = a student who
  -- may still retake (quiet window holds); a fresh active/paused/flagged
  -- session = someone mid-attempt (never reveal under them).
  update public.quizzes q
     set results_revealed_at = clock_timestamp()
   where q.auto_reveal_on_complete
     and q.results_revealed_at is null
     and exists (
       select 1 from public.quiz_sessions done
        where done.quiz_id = q.id
          and done.mode = 'assessment'
          and done.status = 'completed'
     )
     and not exists (
       select 1 from public.quiz_sessions s2
        where s2.quiz_id = q.id
          and s2.mode = 'assessment'
          and s2.last_activity_at >= clock_timestamp() - interval '2 hours'
     );
  get diagnostics v_revealed = row_count;

  return v_closed + v_revealed;
end;
$$;

revoke execute on function public.quiz_autoclose() from public, anon;
grant execute on function public.quiz_autoclose() to service_role;

-- ─── 16. student-append idempotency key (audit-1 P1-10) ────────────────
-- The student AI generate flow appends rows via save_student_quiz_questions.
-- When the client aborts AFTER the RPC committed (stream death / cancel
-- race), the response never lands and the user's retry runs a SECOND append
-- — duplicating every question. A per-RUN generation id breaks the loop:
-- the client keeps one UUID across retries of the same run; the RPC (under
-- its existing advisory lock) detects the tag and returns the ALREADY-SAVED
-- rows instead of appending again. Deliberate re-generations mint a fresh
-- id, so the intended duplicate-append workflow is unchanged.
alter table public.student_quiz_questions
  add column if not exists generation_id uuid;

create index if not exists student_quiz_questions_generation_idx
  on public.student_quiz_questions (quiz_id, generation_id)
  where generation_id is not null;

create or replace function public.save_student_quiz_questions(
  p_quiz_id  uuid,
  p_questions jsonb,
  p_mode     text default 'replace',
  p_generation_id uuid default null
)
returns setof public.student_quiz_questions
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
  v_existing_count int;
  v_start_index    int;
  v_row            public.student_quiz_questions;
  v_already_saved  boolean := false;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Authoring-tier re-enforcement (D-SQ6): authoring is student-only even via
  -- direct RPC — a user demoted after creating the quiz cannot bulk-save.
  if not public.is_student() then
    raise exception 'not_student' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.student_quizzes s
    where s.id = p_quiz_id and s.created_by = auth.uid()
  ) then
    raise exception 'not_owner' using errcode = 'P0001';
  end if;

  if p_mode not in ('replace', 'append') then
    raise exception 'invalid_mode' using errcode = 'P0001';
  end if;

  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    raise exception 'invalid_questions_json' using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_questions);
  if v_count < 1 or v_count > 50 then
    raise exception 'invalid_questions_json' using errcode = 'P0001';
  end if;

  -- Serialize against single appends + the cap trigger BEFORE counting or
  -- deleting (0025 R2 ordering). Same key as append_student_question /
  -- enforce_student_question_cap → session already holding it re-acquires as
  -- a no-op; no lock-order inversion exists.
  perform pg_advisory_xact_lock(hashtext('student_quiz_append:' || p_quiz_id::text));

  -- audit-1 P1-10: an APPEND retry carrying a generation id that already
  -- tagged rows on this quiz is a post-commit retry of the SAME run —
  -- return the saved rows untouched instead of duplicating them.
  if p_mode = 'append' and p_generation_id is not null then
    if exists (
      select 1 from public.student_quiz_questions sqq
       where sqq.quiz_id = p_quiz_id
         and sqq.generation_id = p_generation_id
    ) then
      v_already_saved := true;
    end if;
  end if;

  if v_already_saved then
    return query
      select sqq.*
        from public.student_quiz_questions sqq
       where sqq.quiz_id = p_quiz_id
       order by sqq.order_index;
    return;
  end if;

  if p_mode = 'replace' then
    delete from public.student_quiz_questions where quiz_id = p_quiz_id;
    v_start_index := 0;
  else
    select count(*), coalesce(max(order_index), -1) + 1
      into v_existing_count, v_start_index
      from public.student_quiz_questions
     where quiz_id = p_quiz_id;

    if (v_existing_count + v_count) > 50 then
      raise exception 'question_cap_reached' using errcode = 'P0001';
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

    insert into public.student_quiz_questions (
      quiz_id,
      order_index,
      type,
      prompt,
      options,
      correct_index,
      explanation,
      generation_id
    )
    values (
      p_quiz_id,
      v_start_index + v_i,
      v_type::public.question_type,
      trim(v_prompt),
      v_options,
      v_correct,
      case when v_expl is null or length(trim(v_expl)) = 0 then null else trim(v_expl) end,
      case when p_mode = 'append' then p_generation_id else null end
    )
    returning * into v_row;

    -- setof semantics: emit EVERY inserted row, not just the last.
    return next v_row;
  end loop;
end;
$$;

-- New 4-arg signature (old 3-arg overload must die — a defaulted param
-- makes PostgREST resolve old-shaped calls onto the guarded version).
drop function if exists public.save_student_quiz_questions(uuid, jsonb, text);
revoke execute on function public.save_student_quiz_questions(uuid, jsonb, text, uuid) from public, anon;
grant execute on function public.save_student_quiz_questions(uuid, jsonb, text, uuid) to authenticated;

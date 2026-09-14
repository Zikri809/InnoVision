-- ═══════════════════════════════════════════════════════════════════════
-- 0047 — audit-3: face trust boundary (Chunk E + R2-FACE + H3-RACE)
-- ═══════════════════════════════════════════════════════════════════════
-- Findings closed here (see docs/audit/audit-3-ledger.md):
--
--   E-F1   attach_frame_poses referenced a face_checks.nonce column that has
--          never existed (0009/0010/0046), so the RPC raised 42703 on every
--          verify and face_checks.frame_poses stayed NULL forever — the C-01
--          record-only audit trail had zero evidentiary value. The pose
--          attach is FOLDED INTO record_face_check, which already runs inside
--          the verify's own transaction and already knows the nonce.
--
--   E-F3   attach_frame_poses was granted to `authenticated` and matched on a
--          client-known nonce (owner-readable verify_nonce), so any student
--          could backfill forged poses for their own checks (first-writer-wins
--          on `frame_poses is null`). Dropped outright — the folded path
--          leaves no client-callable writer.
--
--   R2-FACE-F1 (High)  The silence cron's C-02 corroboration was written as
--          OR-disjuncts of the CANDIDACY clause, i.e. INVERTED: a fresh
--          outage claim with ZERO corroboration (the exact audit-2 C-02
--          attack: block verify POSTs, keep re-arming the claim) satisfied the
--          clause and stayed exempt forever, while a corroborated honest
--          outage was evaluated as a candidate. Restated as a single
--          EXEMPTION predicate: a fresh claim suppresses the flag only while
--          corroborated.
--
--   E-F2-ORDER  The verify route stamped face_verify_attempted_at BEFORE any
--          sidecar work, so a verify that failed before reaching a verdict
--          still corroborated the outage claim. The stamp moved after the
--          frame loop (route change); this migration's predicate now trusts it.
--
--   H3-RACE-F1  The pause-resume guard (`paused_at is null or paused_at >
--          now()-300s`) was a TAUTOLOGY: the cursor admits only status='active'
--          and every writer of 'active' clears paused_at, so the guard could
--          never exclude a candidate. Replaced with resume_grace_until, set by
--          a trigger only after a genuinely long pause — a real, falsifiable
--          predicate that still protects the honest blink-recovery.
--
--   E-F4   report_face_unavailable refreshed last_activity_at on every re-arm,
--          so a maintained outage claim held quiz_autoclose's 2h in-flight
--          window open and auto-reveal never fired for the whole class. The
--          re-arm no longer touches last_activity_at (answer_question remains
--          the only honest activity signal).
--
--   H3-RACE-F2  enroll_face's duplicate-face scan is a cross-transaction
--          read-then-insert: two accounts enrolling concurrently each lock
--          only their OWN profile row, both run the scan before either
--          inserts, and both land 'enrolled' — the only control that detects
--          one person holding two verified identities. A global transaction
--          advisory lock now covers (dup-scan → insert).
--
--   R2-FACE-F2  The five pg_cron schedules fail silently (exception → raise
--          notice). cron_health() gives the /api/health endpoint a way to
--          report each job's last outcome, so a dead schedule is observable.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. face_checks.nonce — the pose-attach key (E-F1)
-- ─────────────────────────────────────────────────────────────────────
-- record_face_check records the nonce its row was committed under; the pose
-- payload rides in the SAME row, so the column is written on insert and never
-- matched against a later client-supplied value.
alter table public.face_checks
  add column if not exists nonce uuid;

comment on column public.face_checks.nonce is
  'audit-3 E-F1: the verify nonce this check was committed under (record_face_check p_nonce). Retained as an audit join key — the pose payload is written in the same insert, so no post-hoc client match is needed.';

comment on column public.face_checks.frame_poses is
  'audit-3 (was audit-2 C-01): sidecar-reported [{yaw,pitch,roll,spoof}] per frame, written by record_face_check in the same statement as the verdict. Lecturer-audit signal; full server-side liveness gating needs sidecar spoof-model support.';

create index if not exists face_checks_nonce_idx
  on public.face_checks (session_id, nonce);

-- ─────────────────────────────────────────────────────────────────────
-- 2. record_face_check — fold the pose attach in (E-F1 + E-F3)
-- ─────────────────────────────────────────────────────────────────────
-- BASELINE: the LIVE 0045 revision (§2), verbatim except:
--   * new trailing `p_poses jsonb default null` (route-supplied per-frame
--     pose/spoof trail). A trailing DEFAULT keeps every existing caller
--     (scripts/verify-face.mjs, face-scenarios.mjs) arity-compatible.
--   * (8b) validates the poses shape alongside the other typed params.
--   * (11) writes `nonce` + `frame_poses` on the verdict row itself.
create or replace function public.record_face_check(
  p_session_id   uuid,
  p_subject      text,
  p_similarities real[],
  p_trigger      public.face_check_trigger,
  p_nonce        uuid,
  p_frames       text[],
  p_proof        text default null,
  p_poses        jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, app_private
as $$
declare
  FACE_SIMILARITY_MIN constant real := 0.5;
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
  -- audit-3 E-F1: the pose trail is route-supplied and must be an array when
  -- present. A malformed shape is a route bug — fail the check loudly rather
  -- than silently dropping the audit payload.
  if p_poses is not null and jsonb_typeof(p_poses) <> 'array' then
    return jsonb_build_object('error', 'invalid_frame');
  end if;

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

  -- (11) Insert ONE check row for the whole vote. audit-3 E-F1: the row now
  -- carries the nonce it was committed under and the per-frame pose/spoof
  -- trail, so the audit record is complete the moment the verdict exists.
  insert into public.face_checks
    (session_id, checked_at, matched, distance, trigger, suspected_replay, too_frequent, frame_hash, nonce, frame_poses)
  values
    (v_session.id, clock_timestamp(), v_matched, v_distance, p_trigger, v_suspected_replay, v_too_frequent, v_frame_hash, p_nonce, p_poses);

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

-- The 7-arg proof-defaulted overload must die: alongside the new 8-arg
-- version it would let a 7-arg PostgREST call resolve to it and skip the
-- pose attach (and, worse, keep an unguarded surface alive).
drop function if exists public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[], text);

revoke execute on function public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[], text, jsonb)
  from public, anon;
grant execute on function public.record_face_check(uuid, text, real[], public.face_check_trigger, uuid, text[], text, jsonb)
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. attach_frame_poses — removed (E-F1 + E-F3)
-- ─────────────────────────────────────────────────────────────────────
-- The function is dropped, not repaired: the pose payload now rides in the
-- verdict row (record_face_check §11), so there is no client-callable pose
-- writer left to forge with. Keeping a repaired version would re-open E-F3.
drop function if exists public.attach_frame_poses(uuid, uuid, jsonb);

-- ─────────────────────────────────────────────────────────────────────
-- 4. resume_grace_until — a real pause-resume guard (H3-RACE-F1)
-- ─────────────────────────────────────────────────────────────────────
alter table public.quiz_sessions
  add column if not exists resume_grace_until timestamptz;

comment on column public.quiz_sessions.resume_grace_until is
  'audit-3 H3-RACE-F1: silence-cron grace granted after a genuinely long (>300s) pause is recovered. Replaces the paused_at guard, which was a tautology — every writer of status=active clears paused_at, so it could never exclude a candidate. Granting requires a fresh >300s pause, so it cannot be renewed cheaply by pause cycling.';

-- Grant the grace on a long-pause recovery. BEFORE UPDATE so it observes the
-- PRE-update paused_at (the same statement clears it) and only touches the
-- new grace column, leaving every existing writer's semantics intact.
create or replace function public.set_resume_grace()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'active'
     and old.status is distinct from 'active'
     and old.paused_at is not null
     and old.paused_at < clock_timestamp() - interval '300 seconds' then
    new.resume_grace_until := clock_timestamp() + interval '120 seconds';
  end if;
  return new;
end;
$$;

drop trigger if exists quiz_sessions_resume_grace on public.quiz_sessions;
create trigger quiz_sessions_resume_grace
  before update of status on public.quiz_sessions
  for each row
  execute function public.set_resume_grace();

-- NOTE: no revoke/grant here on purpose. set_resume_grace returns `trigger`,
-- so PostgreSQL rejects any direct call ("trigger functions can only be called
-- as triggers") — the default PUBLIC EXECUTE grant is inert, not a surface.
-- The house convention of explicitly managing grants targets definer
-- functions that a client could otherwise invoke; this one is neither definer
-- nor invocable.

-- ─────────────────────────────────────────────────────────────────────
-- 5. flag_verify_silent_sessions — corrected corroboration polarity (R2-FACE-F1)
-- ─────────────────────────────────────────────────────────────────────
-- BASELINE: the LIVE 0046 §7 revision, verbatim except:
--   * the outage-claim terms are restated as ONE exemption predicate
--     (`not (claim fresh and corroborated)`) instead of four OR-disjuncts of
--     the candidacy clause. The 0046 form INVERTED the intent: a fresh claim
--     with no corroboration was a candidate-shortcut to exemption, so the
--     audit-2 C-02 attack survived; and a corroborated honest outage was
--     evaluated as a candidate.
--   * NULL-safe: `coalesce(..., false)` on the attempt stamp, so a NULL
--     column cannot propagate into the `not (...)` and vanish the candidate.
--   * the pause-resume guard keys on resume_grace_until (§4) instead of the
--     dead paused_at predicate.
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
       -- audit-3 R2-FACE-F1: the outage-claim EXEMPTION, stated positively.
       -- A claim suppresses the flag ONLY while it is fresh AND corroborated:
       --   * fresh  = stamped within the last 10 minutes (the client re-arms
       --              every 5, so a single dropped re-arm never flags).
       --   * corroborated = a face_checks row in the last 10 min (an honest
       --              broken camera still records FAIL votes) OR the route's
       --              attempt touch (a sidecar 503 records no row but DOES
       --              stamp the column — the route stamps only after a
       --              sidecar call reached a verdict, E-F2-ORDER).
       -- The audit-2 C-02 attack (block verify POSTs, re-arm the claim every
       -- few minutes) now produces a fresh claim with NO corroboration →
       -- not exempt → flagged. An honest outage (attempts flowing) stays
       -- exempt. The `coalesce` keeps a NULL attempt stamp from making the
       -- whole `not (...)` NULL (which would silently drop the candidate).
       and not (
         s.face_unavailable_at is not null
         and s.face_unavailable_at > clock_timestamp() - interval '10 minutes'
         and (
           exists (
             select 1 from public.face_checks fc
              where fc.session_id = s.id
                and fc.checked_at > clock_timestamp() - interval '10 minutes'
           )
           or coalesce(
             s.face_verify_attempted_at > clock_timestamp() - interval '10 minutes',
             false
           )
         )
       )
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
       -- Pause-resume guard (audit-3 H3-RACE-F1). The 0044/0045/0046 form
       -- (`paused_at is null or paused_at > now()-300s`) could never exclude a
       -- candidate: the cursor admits only status='active', and every writer
       -- of 'active' clears paused_at, so the guard was a tautology. The
       -- grace is now a dedicated stamp set by the trigger in §4, and only
       -- after a pause that genuinely lasted >300s — the honest
       -- blink-recovery case it was written for. It is not an evasion loop:
       -- re-earning the grace requires another >300s pause, during which
       -- answering is blocked (answer_question status gate) and the verify
       -- silence keeps ageing.
       and (s.resume_grace_until is null or s.resume_grace_until < clock_timestamp())
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
       -- Outage-claim exemption, cursor parity (audit-3 R2-FACE-F1).
       and not (
         quiz_sessions.face_unavailable_at is not null
         and quiz_sessions.face_unavailable_at > clock_timestamp() - interval '10 minutes'
         and (
           exists (
             select 1 from public.face_checks fc
              where fc.session_id = quiz_sessions.id
                and fc.checked_at > clock_timestamp() - interval '10 minutes'
           )
           or coalesce(
             quiz_sessions.face_verify_attempted_at > clock_timestamp() - interval '10 minutes',
             false
           )
         )
       )
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
       -- Pause-resume grace, cursor parity (audit-3 H3-RACE-F1).
       and (quiz_sessions.resume_grace_until is null
            or quiz_sessions.resume_grace_until < clock_timestamp())
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

-- ─────────────────────────────────────────────────────────────────────
-- 6. report_face_unavailable — re-arm must not fake activity (E-F4)
-- ─────────────────────────────────────────────────────────────────────
-- BASELINE: the LIVE 0045 §3 revision, verbatim except the re-arm UPDATE no
-- longer touches last_activity_at. quiz_autoclose holds auto-reveal while any
-- assessment session has last_activity_at within 2h, so a maintained outage
-- claim (the client re-arms every 6 min) kept the whole class's reveal
-- suppressed indefinitely. answer_question remains the only honest activity
-- signal; a degraded student who is not answering must not block the reveal.
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
       set face_unavailable_at = clock_timestamp()
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

-- ─────────────────────────────────────────────────────────────────────
-- 7. enroll_face — serialize the duplicate-face scan (H3-RACE-F2)
-- ─────────────────────────────────────────────────────────────────────
-- BASELINE: the LIVE 0039 revision, verbatim except the advisory lock added
-- at (5). The profile-row lock at (0) only serializes a SINGLE student's
-- concurrent calls; two DIFFERENT accounts enrolling the same person never
-- contend, so both ran the dup scan (READ COMMITTED) before either inserted
-- and both landed 'enrolled' — defeating the only control that detects one
-- person holding two verified identities. A transaction-scoped advisory lock
-- around (dup-scan → insert) makes the read set stable.
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

  -- (5) audit-3 H3-RACE-F2: serialize (dup-scan → insert) across ALL
  -- enrollees. The per-profile lock at (0) cannot order two different
  -- accounts, and the scan below reads a set that the OTHER transaction's
  -- pending insert is invisible to under READ COMMITTED. The advisory lock is
  -- transaction-scoped (released at commit/rollback), so it is held across
  -- exactly the read-modify-write it protects. The key is a constant: this
  -- serializes enrollments globally, which is correct for a control that must
  -- compare every new sample set against every stored one.
  perform pg_advisory_xact_lock(hashtext('face_enroll_dup_check'));

  -- (5b) INTERNAL duplicate check: max clamped cosine against OTHER students'
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

-- ─────────────────────────────────────────────────────────────────────
-- 8. cron_health — make silent pg_cron failures observable (R2-FACE-F2)
-- ─────────────────────────────────────────────────────────────────────
-- The five innovision schedules each live in their own
-- `exception when others then raise notice` block (0042/0019/0022/0030), so a
-- scheduling failure produces a notice nobody reads, and a job that stops
-- running has no surface at all. /api/health calls this to report each job's
-- last outcome.
--
-- ACCESS CONTROL: by GRANT, not by a runtime check. `revoke … from public,
-- anon, authenticated` + `grant … to service_role` below is the whole control.
-- An in-body `current_user = 'service_role'` test would be DEAD CODE: this
-- function is security definer, so `current_user` is the function OWNER
-- (whoever ran the migration), never the caller — an earlier draft shipped
-- exactly that check and it could not deny anyone. If a runtime check is ever
-- genuinely needed, use `session_user` or the request JWT claims instead.
create or replace function public.cron_health()
returns jsonb
language plpgsql
security definer
set search_path = public, cron
as $$
declare
  v_jobs jsonb;
begin
  select coalesce(jsonb_agg(j order by j ->> 'job'), '[]'::jsonb)
    into v_jobs
    from (
      select jsonb_build_object(
               'job', cj.jobname,
               'schedule', cj.schedule,
               'active', cj.active,
               'lastStatus', ld.status,
               'lastRunAt', ld.start_time,
               'lastEndedAt', ld.end_time,
               'lastReturnMessage', ld.return_message,
               'everRan', ld.runid is not null
             ) as j
        from cron.job cj
        left join lateral (
          select d.runid, d.status, d.start_time, d.end_time, d.return_message
            from cron.job_run_details d
           where d.jobid = cj.jobid
           order by d.start_time desc
           limit 1
        ) ld on true
       where cj.jobname like 'innovision-%'
    ) t;

  return jsonb_build_object('jobs', v_jobs, 'count', jsonb_array_length(v_jobs));
exception
  when others then
    -- pg_cron absent or its catalogs unreadable — report honestly, never
    -- fail the health probe.
    return jsonb_build_object('error', sqlerrm);
end;
$$;

revoke execute on function public.cron_health() from public, anon, authenticated;
grant execute on function public.cron_health() to service_role;

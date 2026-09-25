-- 0067: make a fresh identity check part of the answer commit. The answer
-- RPC remains the grading implementation, but authenticated callers can no
-- longer reach it directly for gesture-enabled assessments.

create or replace function public.commit_answer(
  p_session_id uuid,
  p_question_id uuid,
  p_selected_index int default null,
  p_selected_indices int[] default null,
  p_answer_text text default null,
  p_skipped boolean default false,
  p_nonce uuid default null,
  p_frames text[] default null,
  p_similarities real[] default null,
  p_proof text default null,
  p_answer_proof text default null,
  p_poses jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, app_private
as $$
declare
  v_session public.quiz_sessions;
  v_gestures boolean := false;
  v_requires_face boolean := false;
  v_concat text := '';
  v_frame_hash text;
  v_answer text;
  v_secret text;
  v_expected text;
  v_recorded jsonb;
  v_answered jsonb;
  v_i int;
  v_closes_at timestamptz;
  v_time_limit int;
begin
  if auth.uid() is null then return jsonb_build_object('error', 'not_authenticated'); end if;
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'student') then
    return jsonb_build_object('error', 'not_student');
  end if;

  -- Ownership and role are checked before choosing any bypass policy. The
  -- lock is shared by face verdict and answer writes in this transaction.
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
   for update;
  if not found then return jsonb_build_object('error', 'not_owner'); end if;

  select coalesce(q.gestures_enabled, false) into v_gestures
    from public.quizzes q where q.id = v_session.quiz_id;
  v_requires_face := v_session.mode = 'assessment'
    and v_gestures
    and not coalesce(v_session.face_exempt, false);

  -- A committed answer replay is idempotent and creates no new commit.
  -- Assessment response remains keyless; practice follows the legacy RPC.
  if exists (select 1 from public.session_answers sa
              where sa.session_id = v_session.id and sa.question_id = p_question_id)
     and v_session.mode = 'assessment' then
    return jsonb_build_object('error', 'already_answered');
  end if;

  if v_session.status <> 'active' then
    return jsonb_build_object('error', 'session_not_active');
  end if;
  if not public.can_student_view_quiz(v_session.quiz_id) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  -- Schedule/timer gates run BEFORE the face gate so an expired or closed
  -- session returns the SAME typed error the legacy answer_question would,
  -- even when the caller sent no verification frames. Otherwise a lapsed
  -- exam would report face_verification_required instead of time_expired
  -- (E10 contract), and the answer-held copy would name the wrong cause.
  select q.closes_at, q.time_limit_sec
    into v_closes_at, v_time_limit
    from public.quizzes q
   where q.id = v_session.quiz_id;

  if v_closes_at is not null and clock_timestamp() >= v_closes_at then
    return jsonb_build_object('error', 'quiz_window_closed');
  end if;

  if v_time_limit is not null
     and clock_timestamp() > v_session.started_at
         + (v_time_limit * interval '1 second')
         + interval '5 seconds' then
    return jsonb_build_object('error', 'time_expired');
  end if;


  if not v_requires_face then
    return public.answer_question(
      p_session_id, p_question_id, p_selected_index, p_selected_indices,
      p_answer_text, coalesce(p_skipped, false)
    );
  end if;

  if p_nonce is null or p_frames is null or array_ndims(p_frames) <> 1
     or cardinality(p_frames) <> 3 or p_similarities is null
     or array_ndims(p_similarities) <> 1 or cardinality(p_similarities) <> 3 then
    return jsonb_build_object('error', 'face_verification_required');
  end if;

  for v_i in 1..3 loop
    if p_frames[v_i] is null or length(p_frames[v_i]) > 200000
       or p_similarities[v_i] is null or p_similarities[v_i] < 0 or p_similarities[v_i] > 1 then
      return jsonb_build_object('error', 'invalid_frame');
    end if;
    v_concat := v_concat || '|' || coalesce(p_frames[v_i], '');
  end loop;
  v_frame_hash := encode(extensions.digest(v_concat, 'sha256'), 'hex');

  -- Length-prefixed UTF-8 fields match canonicalAnswer() in the route,
  -- avoiding delimiter ambiguity and preserving Unicode exactly.
  v_answer :=
    octet_length(convert_to(p_question_id::text, 'UTF8'))::text || ':' || p_question_id::text ||
    case when p_selected_index is null then '-:' else octet_length(convert_to(p_selected_index::text, 'UTF8'))::text || ':' || p_selected_index::text end ||
    case when p_selected_indices is null then '-:' else octet_length(convert_to(array_to_string(array(select distinct x from unnest(p_selected_indices) x order by x), ','), 'UTF8'))::text || ':' || array_to_string(array(select distinct x from unnest(p_selected_indices) x order by x), ',') end ||
    case when p_answer_text is null then '-:' else octet_length(convert_to(p_answer_text, 'UTF8'))::text || ':' || p_answer_text end ||
    octet_length(convert_to(coalesce(p_skipped, false)::text, 'UTF8'))::text || ':' || coalesce(p_skipped, false)::text;

  select secret into v_secret from app_private.verify_proof_secret where id = 1;
  if v_secret is null then return jsonb_build_object('error', 'proof_invalid'); end if;
  v_expected := encode(extensions.hmac(
    'answer:' || v_session.id::text || ':' || p_nonce::text || ':' || v_frame_hash || ':' || v_answer,
    v_secret, 'sha256'), 'hex');
  if coalesce(p_answer_proof, '') = '' or
     extensions.hmac(v_expected, v_secret, 'sha256') <>
     extensions.hmac(p_answer_proof, v_secret, 'sha256') then
    return jsonb_build_object('error', 'proof_invalid');
  end if;

  v_recorded := public.record_face_check(
    p_session_id, auth.uid()::text, p_similarities,
    'question'::public.face_check_trigger, p_nonce, p_frames, p_proof, p_poses
  );
  if v_recorded ? 'error' then return v_recorded; end if;
  if v_recorded->>'matched' <> 'true' then
    return jsonb_build_object('error', 'face_mismatch', 'faceCheck', v_recorded);
  end if;

  v_answered := public.answer_question(
    p_session_id, p_question_id, p_selected_index, p_selected_indices,
    p_answer_text, coalesce(p_skipped, false)
  );
  if v_answered ? 'error' then
    return jsonb_set(v_answered, '{faceCheck}', v_recorded, true);
  end if;
  return jsonb_set(v_answered, '{faceCheck}', v_recorded, true);
end;
$$;

revoke execute on function public.commit_answer(uuid, uuid, int, int[], text, boolean, uuid, text[], real[], text, text, jsonb)
  from public, anon;
grant execute on function public.commit_answer(uuid, uuid, int, int[], text, boolean, uuid, text[], real[], text, text, jsonb)
  to authenticated;

-- Close the direct PostgREST bypass. The function owner can still call this
-- SECURITY DEFINER function internally from commit_answer.
revoke execute on function public.answer_question(uuid, uuid, int, int[], text, boolean)
  from public, anon, authenticated;

notify pgrst, 'reload schema';

-- Updated integrity cadence and toggle-aware silence enforcement.
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
  MAX_VERIFY_ATTEMPTS constant int := 600;
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
       and exists (select 1 from public.quizzes q0 where q0.id = s.quiz_id and q0.gestures_enabled = true)
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
create or replace function public.session_verify_silent(p_session_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select coalesce((select s.mode = 'assessment'
    and exists (select 1 from public.quizzes q where q.id = s.quiz_id and q.gestures_enabled = true)
    and s.face_exempt = false
    and (s.resume_grace_until is null or s.resume_grace_until < clock_timestamp())
    and not (s.face_unavailable_at is not null
      and s.face_unavailable_at > clock_timestamp() - interval '10 minutes'
      and (exists (select 1 from public.face_checks fc where fc.session_id = s.id and fc.checked_at > clock_timestamp() - interval '10 minutes')
        or coalesce(s.face_verify_attempted_at > clock_timestamp() - interval '10 minutes', false)))
    and (select coalesce(max(fc.checked_at), s.started_at) from public.face_checks fc where fc.session_id = s.id) < clock_timestamp() - interval '300 seconds'
    and (select count(*) from public.session_answers sa where sa.session_id = s.id
      and sa.answered_at > coalesce((select max(fc.checked_at) from public.face_checks fc where fc.session_id = s.id), s.started_at)) >= 2
    from public.quiz_sessions s where s.id = p_session_id), false)
$$;
revoke execute on function public.session_verify_silent(uuid) from public, anon, authenticated;
notify pgrst, 'reload schema';

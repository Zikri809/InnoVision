-- ═══════════════════════════════════════════════════════════════════════
-- 0048 — Audit-3 session-loop hardening (Chunk D + R2-RLS + R2-NOTIF)
--
-- Supersedes the live bodies of the session-loop RPCs with the audit-3
-- fixes. Each function is the verbatim live revision (baseline cited per
-- section) plus ONLY the named change; the revoke/grant pair is re-applied
-- for every redefined signature (a fresh CREATE OR REPLACE keeps the old
-- ACLs, but the house convention re-states them so a future reader can see
-- the privilege posture next to the body).
--
-- Findings addressed:
--   D-F1  (High)   quiz closed mid-session strands an active assessment.
--                  (a) client fires submitNow() on 409 quiz_not_live
--                      (src/components/quiz/play-client.tsx);
--                  (b) quiz_autoclose now SEALS in-flight assessment
--                      sessions of closed quizzes (§5) — active/paused
--                      only; flagged is a lecturer decision (D-F3).
--   D-F2  (Low-Med) countdown never re-synced on the already-active /
--                  unlock recovery paths: remainingMs added to
--                  self_recover_session's early return (§1) and to
--                  unlock_session (§2); the GET route + pipeline adopt it.
--   D-F3  (Medium) stale-window seal force-completed FLAGGED sessions and
--                  stamped submitted_at for a never-submitted session.
--                  §4 excludes flagged from the seal's selection and stops
--                  writing submitted_at; the new autoclose seal (§5)
--                  inherits both rules.
--   D-F5  (Low)    pause route Zod enum now matches the RPC enum
--                  (src/app/api/sessions/[id]/pause/route.ts).
--   R2-SESS-F3 (Med) self_recover_session / unlock_session /
--                  exempt_face_session had no quiz-liveness gate: a closed
--                  quiz's session could be revived into 'active'. All three
--                  now refuse with quiz_not_live (§1/§2/§3).
--   R2-RLS-F1 (Med) students could read session_answers.is_correct and
--                  quiz_sessions.score directly off the base tables (§7).
--   R2-NOTIF-N1 (Low) quiz_completed_all could be lost to a two-submit
--                  race: an advisory lock serializes the count (§6) and
--                  quiz_autoclose re-evaluates the digest (§5).
--   R2-NOTIF-N2 (Low) unread notifications unbounded: prune now caps
--                  non-urgent unread rows per recipient (§8).
--
-- DEFERRED — D-F4 (answer acceptance not bound to identity verification):
--   The audit asked for the "defensible half" (detect + record interleaved
--   verify-nonce lineages) but explicitly forbade a hard gate. Investigation
--   shows there is NO defensible detection to implement without a product
--   change: the verify nonce is served to the session OWNER via
--   GET /api/sessions/[id] (OWN_COLS) and is therefore identical on every
--   device/tab of one account — it is a replay token, not a device identity.
--   Two devices sharing credentials present the SAME nonce lineage, so a
--   nonce-interleave signal cannot distinguish them from an honest two-tab
--   resume. A real signal needs a new per-device token minted at gate Begin
--   and carried on every answer/verify call — a client + route + schema
--   change that would also have to preserve the documented two-tab resume
--   flow. Per the audit's escape hatch ("if you cannot do this without
--   risking the honest two-tab flow, implement NOTHING and report it as
--   deferred-with-rationale"), D-F4 is NOT implemented here. The
--   lecturer-visible integrity surface (face checks, advisories, incident
--   clips, session counters) remains the available corroboration for
--   collusion today.
--
-- Seal semantics preserved (0045 §8/§9): sealed ≠ submitted, no
-- session_submitted mail, score = count(is_correct) via the
-- assign_seal_score trigger + the app.session_sealing GUC.
--
-- Depends on: 0008 (sessions/answers), 0012 (reveal + column grants),
-- 0019/0020/0032/0037/0043/0044/0045/0046 (supersession chain). Does NOT
-- depend on 0047 (the column grants in §7 deliberately omit 0047's
-- resume_grace_until).
-- ═══════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════
-- 1. self_recover_session — liveness gate (R2-SESS-F3) + remainingMs on
--    the already-active early return (D-F2)
-- BASELINE: the LIVE 0045 revision. Changes:
--   * R2-SESS-F3: a quiz that is no longer viewable (closed / archived /
--     student removed) cannot be revived into 'active' — refuse with
--     quiz_not_live. can_student_view_quiz already folds live + enrolled
--     for the CALLER (here the session's own student), so it is the exact
--     predicate the answer/verify gates use.
--   * D-F2: the `status = 'active'` early return now carries the same
--     remainingMs/nextNonce shape as the recovery branch. A second tab (or
--     an unlock this client has not polled yet) can have already recovered
--     the session; without the value this tab's countdown kept the frozen
--     pre-pause reading until the next mid-answer 403.
-- ═══════════════════════════════════════════════════════════════════════
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

  -- R2-SESS-F3: no resurrection onto a dead quiz. A closed (or archived, or
  -- unenrolled) quiz's session must not be flipped back to 'active': the
  -- answer/verify gates would refuse every subsequent call anyway, leaving
  -- a live-looking client on a dead quiz. The autoclose seal (§5) completes
  -- the session instead, preserving its evidence.
  if not public.can_student_view_quiz(v_session.quiz_id) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  select q.time_limit_sec into v_time_limit
    from public.quizzes q
   where q.id = v_session.quiz_id;

  -- D-F2: already active (another tab / a fresh unlock). Report the current
  -- deadline rather than a bare ack so this client re-syncs its countdown.
  if v_session.status = 'active' then
    if v_time_limit is null then
      v_remaining_ms := null;
    else
      v_remaining_ms := greatest(0, (
        extract(epoch from (
          v_session.started_at
            + (v_time_limit * interval '1 second')
            - clock_timestamp()
        )) * 1000
      ))::int;
    end if;
    return jsonb_build_object(
      'sessionStatus', 'active',
      'nextNonce', v_session.verify_nonce,
      'creditedSeconds', 0,
      'remainingMs', v_remaining_ms
    );
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

-- ═══════════════════════════════════════════════════════════════════════
-- 2. unlock_session — liveness gate (R2-SESS-F3) + remainingMs (D-F2)
-- BASELINE: the LIVE 0045 revision (120 s credit cap). Changes:
--   * R2-SESS-F3: refuse to unlock a session whose quiz is no longer live
--     (or whose class is archived). The caller is the LECTURER, so the
--     student-scoped can_student_view_quiz cannot be used here — the gate
--     is the caller-independent live + not-archived predicate.
--   * D-F2: return remainingMs computed from the POST-credit started_at so
--     the student's flagged poll (GET /api/sessions/[id]) can re-sync the
--     countdown at the moment the unlock lands.
-- ═══════════════════════════════════════════════════════════════════════
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
  v_time_limit int;
  v_started_at timestamptz;
  v_remaining_ms int;
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

  -- R2-SESS-F3: no resurrection onto a dead quiz. Caller-independent
  -- predicate (the caller here is the lecturer, not the session's student).
  if not exists (
    select 1 from public.quizzes q
    join public.classes c on c.id = q.class_id
    where q.id = v_session.quiz_id
      and q.status = 'live'
      and c.archived_at is null
  ) then
    return jsonb_build_object('error', 'quiz_not_live');
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

  -- D-F2: post-credit deadline for the student's flagged poll to adopt.
  select s.started_at into v_started_at
    from public.quiz_sessions s
   where s.id = v_session.id;
  select q.time_limit_sec into v_time_limit
    from public.quizzes q
   where q.id = v_session.quiz_id;
  if v_time_limit is null or v_started_at is null then
    v_remaining_ms := null;
  else
    v_remaining_ms := greatest(0, (
      extract(epoch from (
        v_started_at + (v_time_limit * interval '1 second') - clock_timestamp()
      )) * 1000
    ))::int;
  end if;

  return jsonb_build_object(
    'sessionStatus', 'active',
    'nextNonce', v_next_nonce,
    'remainingMs', v_remaining_ms
  );
end;
$$;

revoke execute on function public.unlock_session(uuid) from public, anon;
grant execute on function public.unlock_session(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. exempt_face_session — liveness gate (R2-SESS-F3)
-- BASELINE: the LIVE 0045 revision (paused_at cleared on exempt). Change:
-- the same caller-independent live + not-archived gate as §2. An exemption
-- is a fresh adjudication on a LIVE quiz; exempting a closed quiz's session
-- would revive a dead slot into 'active' with no answer path.
-- ═══════════════════════════════════════════════════════════════════════
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

  -- R2-SESS-F3: no resurrection onto a dead quiz (see §2).
  if not exists (
    select 1 from public.quizzes q
    join public.classes c on c.id = q.class_id
    where q.id = v_session.quiz_id
      and q.status = 'live'
      and c.archived_at is null
  ) then
    return jsonb_build_object('error', 'quiz_not_live');
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

-- ═══════════════════════════════════════════════════════════════════════
-- 4. start_quiz_session — stale seal: exclude flagged, stop stamping
--    submitted_at (D-F3)
-- BASELINE: the LIVE 0032 revision (FULL 0030 carry-forward). Changes,
-- both confined to the stale-window seal block:
--   * D-F3: the seal's selection excludes 'flagged'. A flagged session is a
--     LECTURER DECISION (the integrity hold); the seal was the only writer
--     that silently force-completed it, clearing the hold with no
--     adjudication. active/paused remain sealable (no human decision is
--     outstanding for them).
--   * D-F3: no submitted_at stamp. The session never submitted; stamping it
--     made the gradebook read "submitted" for a never-submitted attempt.
--     The row is still terminal (status='completed') and the
--     assign_seal_score trigger (0045 §8) still materializes the score, so
--     the gradebook keeps the honest artifact.
--   * A flagged session therefore keeps blocking the one-active slot (the
--     one_active_assessment_attempt index includes 'flagged') until the
--     lecturer adjudicates (reset / unlock). That is the intended posture:
--     the hold is the lecturer's, not the clock's.
-- ═══════════════════════════════════════════════════════════════════════
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
  v_opens_at    timestamptz;
  v_closes_at   timestamptz;
  v_enrolled    boolean;
  v_session     public.quiz_sessions;
  v_allow_retake    boolean;
  v_max_attempts    int;
  v_completed_count int;
  v_next_attempt    int;
  v_row_count       int;
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
  select q.mode, q.status, c.archived_at, q.opens_at, q.closes_at,
         q.allow_retake, q.max_attempts
    into v_mode, v_status, v_archived_at, v_opens_at, v_closes_at,
         v_allow_retake, v_max_attempts
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

  -- Window gating (enrolled callers only — schedule state, not identity).
  -- NULL = unbounded side. clock_timestamp() matches the house timer
  -- convention (0008:362-377) and stays correct inside long transactions.
  -- NOTE: opens_at gates unconditionally; closes_at is evaluated INSIDE the
  -- assessment path (below) so a stale non-completed session from a PASSED
  -- window can be void-completed instead of hard-erroring (QC-4). Practice
  -- has no attempts/multi-session state to recover, so it keeps the plain
  -- closes_at hard stop.
  if v_opens_at is not null and clock_timestamp() < v_opens_at then
    return jsonb_build_object('error', 'quiz_not_open');
  end if;
  if v_mode = 'practice'
     and v_closes_at is not null
     and clock_timestamp() >= v_closes_at then
    return jsonb_build_object('error', 'quiz_window_closed');
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
        'attempt', v_session.attempt,
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
      'attempt', v_session.attempt,
      'last_activity_at', v_session.last_activity_at
    ));
  end if;

  -- Assessment: serialize resume/void/spawn per (quiz, student). The lock
  -- was practice-only through 0031; multi-attempt spawn makes the
  -- read-modify-write a genuine race, so the assessment path now takes it
  -- too (QC-4 pre-flight decision).
  perform pg_advisory_xact_lock(hashtext(
    'quiz_start:' || p_quiz_id::text || ':' || auth.uid()::text
  ));

  -- Resume pre-check: NON-COMPLETED rows only (a completed attempt must
  -- never be handed back as resumable). D-F3: 'flagged' is still SELECTED
  -- here (it must keep blocking the slot) but is excluded from the seal
  -- below — the hold survives.
  select s.* into v_session
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
     and s.mode = 'assessment'
     and s.status in ('active', 'paused', 'flagged')
   order by s.started_at desc
   limit 1;

  if found then
    -- Stale-paused sealing (QC-4 pre-flight decision 2): a non-completed
    -- session from a PASSED window is unrecoverable (every answer →
    -- time_expired/quiz_window_closed). Seal it completed (scored as-is,
    -- nothing deleted) so its partial evidence is preserved; the spawn gate
    -- below then returns quiz_window_closed (a passed window cannot birth a
    -- new attempt). Unconditional: without this, the session would sit
    -- behind the one-active index as a remedy-free dead slot — the exact
    -- stranding the pre-flight decision rejected.
    --
    -- D-F3: FLAGGED is excluded — the integrity hold is the lecturer's
    -- decision, not the clock's. active/paused only.
    if v_closes_at is not null
       and clock_timestamp() >= v_closes_at
       and v_session.status in ('active', 'paused') then
      update public.quiz_sessions
         set status = 'completed',
             -- Explicit NULL so the assign_seal_score BEFORE-trigger's WHEN
             -- (`new.score is null`) fires deterministically. That trigger is
             -- what computes the sealed score AND sets the app.session_sealing
             -- GUC that suppresses the bogus session_submitted mail — a row
             -- reaching here with a pre-existing score would otherwise seal
             -- silently and notify as if the student had submitted.
             score = null,
             last_activity_at = clock_timestamp()
       where id = v_session.id
         and status in ('active', 'paused');
      get diagnostics v_row_count = row_count;
      if v_row_count = 1 then
        -- Sealed: the slot is freed and the partial evidence is scored by
        -- the assign_seal_score trigger. The spawn gate below cannot birth a
        -- new attempt from a passed window → quiz_window_closed.
        return jsonb_build_object('error', 'quiz_window_closed');
      end if;
      -- Concurrent writer flipped it first (submitted in another tab, or the
      -- autoclose sweep sealed it): re-read and report the surviving
      -- non-completed row.
      --
      -- The 0032 form tested `v_session is not null`, which is ALWAYS FALSE
      -- for a composite: plpgsql hands the test to the core parser, and
      -- `IS NOT NULL` on a row type is true only when EVERY FIELD is non-null
      -- — quiz_sessions has several nullable columns (submitted_at, score,
      -- paused_at, …), so a successfully re-read row failed the test and the
      -- documented quiz_window_closed fall-through was unreachable. `FOUND` is
      -- the correct signal for a SELECT INTO (audit-3 SQL review).
      select s.* into v_session
        from public.quiz_sessions s
       where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
         and s.mode = 'assessment'
         and s.status in ('active', 'paused', 'flagged')
       order by s.started_at desc
       limit 1;
      if found then
        return jsonb_build_object('error', 'already_attempted', 'session_id', v_session.id);
      end if;
      return jsonb_build_object('error', 'quiz_window_closed');
    end if;

    return jsonb_build_object('error', 'already_attempted', 'session_id', v_session.id);
  end if;

  -- Spawn: budget check over COMPLETED attempts.
  select count(*) into v_completed_count
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
     and s.mode = 'assessment' and s.status = 'completed';

  if v_completed_count > 0
     and (v_allow_retake is false or v_completed_count >= v_max_attempts) then
    -- Byte-identical legacy shape (0008/0017): budget-exhausted restarts
    -- return the LATEST completed session id so the client lands on the
    -- reveal-gated EndScreen (e5 pins the journey). No resumable row exists
    -- — this id points at the terminal attempt by construction.
    return jsonb_build_object(
      'error', 'already_attempted',
      'session_id', (
        select s.id from public.quiz_sessions s
         where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
           and s.mode = 'assessment'
         order by s.attempt desc, s.started_at desc
         limit 1
      )
    );
  end if;

  -- Window hard stop for NEW spawns (QC-3 semantics preserved: a fresh
  -- attempt cannot start past closes_at — the schedule error surfaces the
  -- truthful dead-end; the void path above already sealed the stale
  -- attempt as completed so its partial evidence is scored, not lost).
  if v_closes_at is not null and clock_timestamp() >= v_closes_at then
    return jsonb_build_object('error', 'quiz_window_closed');
  end if;

  v_next_attempt := coalesce((
    select max(s.attempt)
      from public.quiz_sessions s
     where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
       and s.mode = 'assessment'
  ), 0) + 1;

  begin
    insert into public.quiz_sessions (quiz_id, student_id, mode, status, attempt)
    values (p_quiz_id, auth.uid(), 'assessment', 'active', v_next_attempt)
    returning * into v_session;
  exception when unique_violation then
    -- Two concurrent spawns lost the race: return the RESUMABLE
    -- (non-completed) session with explicit ordering — NEVER a completed
    -- row (the 0017-era handler's arbitrary pick would hand back a dead
    -- session id under multi-attempt).
    select s.* into v_session
      from public.quiz_sessions s
     where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
       and s.mode = 'assessment'
       and s.status in ('active', 'paused', 'flagged')
     order by s.started_at desc
     limit 1;
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
    'attempt', v_session.attempt,
    'last_activity_at', v_session.last_activity_at
  ));
end;
$$;

revoke execute on function public.start_quiz_session(uuid) from public, anon;
grant execute on function public.start_quiz_session(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. quiz_autoclose — seal in-flight assessment sessions (D-F1b) and
--    re-evaluate the completion digest (R2-NOTIF-N1)
-- BASELINE: the LIVE 0045 revision. Changes:
--   * D-F1(b): after flipping live→closed, seal every still-active/paused
--     ASSESSMENT session belonging to a CLOSED quiz (not only the quizzes
--     just flipped — a manual close writes status='closed' directly and
--     would otherwise never be swept). The seal reuses the 0045 §8
--     machinery: score is left NULL so the assign_seal_score trigger
--     materializes count(is_correct) and sets app.session_sealing, and
--     notify_session_terminal then suppresses the submit-flavoured mail.
--     NO submitted_at stamp (D-F3) — sealed ≠ submitted. last_activity_at
--     is deliberately left untouched: the reveal quiet-window keeps reading
--     the student's REAL last activity. Note the window predicate has NO
--     status filter, so a freshly-sealed row DOES keep holding the window
--     open for its remaining 2h — that is the intended quiet-period
--     behaviour, not an oversight (audit-3 SQL review corrected an earlier
--     comment here that claimed the opposite).
--   * flagged sessions are NEVER sealed (D-F3): the integrity hold is a
--     lecturer decision.
--   * R2-NOTIF-N1: after the flips/seals, re-evaluate quiz_completed_all
--     for every quiz. A two-submit race can leave both triggers counting
--     before either row commits, losing the digest forever; this set-based
--     re-insert (same dedupe key) recovers it without ever double-firing.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.quiz_autoclose()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed   int;
  v_sealed   int;
  v_revealed int;
  v_digests  int;
begin
  update public.quizzes
     set status = 'closed'
   where status = 'live'
     and closes_at is not null
     and closes_at <= clock_timestamp();
  get diagnostics v_closed = row_count;

  -- D-F1(b): seal in-flight assessment sessions of closed quizzes. Covers
  -- both the flips above and manual closes (status='closed' written by the
  -- close route). score is explicitly NULLed so assign_seal_score's WHEN
  -- (`new.score is null`) fires deterministically and sets the GUC that makes
  -- notify_session_terminal skip the submit arms. submitted_at is NOT written
  -- (D-F3: sealed ≠ submitted). flagged is excluded.
  update public.quiz_sessions s
     set status = 'completed',
         score = null
   where s.mode = 'assessment'
     and s.status in ('active', 'paused')
     and exists (
       select 1 from public.quizzes q
        where q.id = s.quiz_id
          and q.status = 'closed'
     );
  get diagnostics v_sealed = row_count;

  -- audit-1 P1-6 (see 0045 §15 header). The 2h inactivity term covers ALL
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

  -- R2-NOTIF-N1: recover a quiz_completed_all digest lost to the
  -- two-submit race. Same inequality and dedupe key as
  -- notify_session_terminal (including the `enrolled > 0` guard — a quiz
  -- with an empty roster must never fire the digest); ON CONFLICT keeps
  -- at-most-once. Scoped to quizzes with a RECENT completed assessment
  -- session (the race is seconds wide), so the sweep never retroactively
  -- notifies for long-closed quizzes whose roster has since shrunk.
  --
  -- `submitted_at is not null` preserves the 0045 §9 "seal ≠ submit"
  -- semantics: a SEALED session (no submitted_at, per D-F3) must not vote
  -- for the digest, exactly as the GUC-guarded trigger arm excludes it.
  -- (A genuinely submitted session always stamps submitted_at, so this term
  -- only ever removes seals.)
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select c.lecturer_id,
         'quiz_completed_all',
         jsonb_build_object('quiz_id', q.id, 'quiz_title', q.title),
         'quiz_completed_all:' || q.id::text
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    cross join lateral (
      select count(*) as enrolled
        from public.class_enrollments ce
       where ce.class_id = q.class_id
    ) e
    cross join lateral (
      select count(distinct x.student_id) as completed
        from public.quiz_sessions x
       where x.quiz_id = q.id
         and x.status = 'completed'
         and x.submitted_at is not null
         and x.mode = 'assessment'
    ) d
   where e.enrolled > 0
     and d.completed >= e.enrolled
     and exists (
       select 1 from public.quiz_sessions recent
        where recent.quiz_id = q.id
          and recent.status = 'completed'
          and recent.mode = 'assessment'
          and recent.last_activity_at >= clock_timestamp() - interval '1 hour'
     )
  on conflict (recipient_id, dedupe_key) do nothing;
  get diagnostics v_digests = row_count;

  return v_closed + v_sealed + v_revealed + v_digests;
end;
$$;

revoke execute on function public.quiz_autoclose() from public, anon;
grant execute on function public.quiz_autoclose() to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. notify_session_terminal — serialize the completion count
--    (R2-NOTIF-N1) + exclude seals from the digest count (0045 §9)
-- BASELINE: the LIVE 0045 §9 revision. Changes:
--   * R2-NOTIF-N1: a transaction-scoped advisory lock keyed on the quiz is
--     taken BEFORE the distinct-student count in the completed arm. Without
--     it, two students submitting concurrently each count before the other's
--     row commits and BOTH see completed < enrolled, so neither fires the
--     digest and nothing re-fires it (the dedupe key can fire at most once
--     ever). With the lock the second trigger runs after the first
--     transaction commits, so its count sees both rows and fires. Lock order
--     is safe: this lock is taken inside the UPDATE trigger, BEFORE
--     submit_session's `quiz_reveal:` lock, so no cycle exists.
--   * the digest count gains `submitted_at is not null`, completing 0045
--     §9's seal≠submit rule for the COUNT (the GUC skip only suppressed a
--     seal's own trigger invocation; the sealed row still polluted later
--     counts).
-- The sealed-session skip (0045 §8 GUC) is unchanged and runs first.
-- ═══════════════════════════════════════════════════════════════════════
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
    -- 0045 §8: a sealed (window-passed / closed-quiz) session is terminal
    -- but NOT a submission — no session_submitted mail, no
    -- quiz_completed_all vote.
    if current_setting('app.session_sealing', true) = 'on' then
      return null;
    end if;

    -- R2-NOTIF-N1: serialize the count-then-insert across concurrent
    -- last-submits so the second caller's count sees the first's committed
    -- row.
    perform pg_advisory_xact_lock(
      hashtext('quiz_completed_all:' || new.quiz_id::text)
    );

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
    -- `submitted_at is not null` completes 0045 §9's "seal ≠ submit" rule:
    -- the GUC skip only suppresses a seal's OWN trigger invocation, so a
    -- sealed row still sat in the table as `completed` and polluted the
    -- count of every LATER genuine submit. Excluding it keeps this count
    -- identical to quiz_autoclose's sweeper.
    select q.class_id into v_class_id
      from public.quizzes q where q.id = new.quiz_id;

    select count(*) into v_enrolled
      from public.class_enrollments ce
     where ce.class_id = v_class_id;

    select count(distinct x.student_id) into v_completed
      from public.quiz_sessions x
     where x.quiz_id = new.quiz_id
       and x.status = 'completed'
       and x.submitted_at is not null
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

-- ═══════════════════════════════════════════════════════════════════════
-- 7. RLS / column-privilege fix (R2-RLS-F1)
--
-- WHY the 0012 column-level REVOKE was a NO-OP (correcting the misleading
-- headers at 0012:72-77 and 0037:14, which claim the columns are hidden "at
-- the privilege layer"):
--   Postgres ignores a column-level REVOKE while a TABLE-level SELECT grant
--   remains for the same role. `revoke select (is_correct) on
--   public.session_answers from authenticated` at 0012:78 therefore did
--   nothing: 0008:77-79 had granted table-level SELECT to `authenticated`,
--   and that grant keeps every column readable. The same no-op voided
--   `revoke select (score) on public.quiz_sessions` (0012:79 vs 0008:78) —
--   so a student could read their own pre-reveal is_correct AND score with a
--   direct PostgREST call, defeating the view-layer reveal gate entirely.
--
-- THE FIX: revoke the TABLE-level SELECT from `authenticated`, then re-grant
-- SELECT on the EXPLICIT safe column list (every column except
-- session_answers.is_correct and quiz_sessions.score). Column-level grants
-- are now the ONLY path, so a `select *` / direct sensitive-column read is
-- refused at the privilege layer — the layer 0012 intended.
--
-- WHY THIS DOES NOT BREAK `count(*)` (verified against PostgreSQL's
-- ExecCheckOneRelPerms, src/backend/executor/execMain.c): when a query
-- references NO columns (e.g. `SELECT count(*) FROM t`) Postgres allows it
-- if the role holds SELECT on ANY column (ACLMASK_ANY); a whole-row
-- reference (`select *`) is the case that requires SELECT on ALL columns and
-- therefore fails here. The app's two base-table counts
-- (lecturer builder `select id, count:exact, head:true` and the quiz-delete
-- guard) therefore keep working, while `select *` and the two sensitive
-- columns are denied.
--
-- Authorized reads are unaffected: every view over these tables
-- (student_session_view, lecturer_session_view, student_answers_view,
-- lecturer_answers_view, student_quiz_view, student_closed_revealed_quiz_view)
-- is security_barrier with security_invoker=false (the default; 0011:127-136
-- documents the choice), so it reads the base table with the VIEW OWNER's
-- privileges and re-exposes is_correct/score under the correct predicate.
-- Every production base-table read was audited to use only the granted
-- columns (face_exempt, status, mode, student_id, id, verify_nonce, …).
--
-- NOTE: the column list must be extended whenever a migration adds a
-- client-read column to either table (a column NOT listed here is simply not
-- readable by `authenticated` — fail-closed, never a leak).
-- quiz_sessions.resume_grace_until (0047) is deliberately NOT granted: no
-- client code reads it, and omitting it keeps this migration independent of
-- the concurrently-authored 0047 body.
-- ═══════════════════════════════════════════════════════════════════════

-- quiz_sessions: every column except `score` (and the internal-only
-- resume_grace_until — see the note above).
revoke select on public.quiz_sessions from authenticated;
grant select (
  id, quiz_id, student_id, mode, started_at, submitted_at, status,
  face_fail_streak, face_exempt, verify_nonce, last_activity_at,
  face_unavailable_at, paused_at, focus_pause_count, fullscreen_pause_count,
  face_fail_count, hand_pause_count, last_pause_reason,
  face_verify_attempted_at, attempt
) on public.quiz_sessions to authenticated;

-- session_answers: every column except `is_correct`.
revoke select on public.session_answers from authenticated;
grant select (
  id, session_id, question_id, selected_index, selected_indices, answered_at
) on public.session_answers to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. prune_expired_notifications — bound UNREAD rows (R2-NOTIF-N2)
-- BASELINE: the LIVE 0046 §11 revision. Change: the hard cap is extended to
-- UNREAD rows. 0046 capped READ rows only, so an account that never opens
-- the bell accumulated unread rows until the 180 d / 365 d age tiers —
-- unbounded badge counts and table bloat on the hot path.
--
-- Integrity posture (D11) preserved as far as a cap allows: the cap applies
-- to NON-URGENT unread rows only. The urgent tier (session_flagged,
-- session_reset, removed_from_class, results_revealed,
-- face_unavailable_reported, face_enrollment_held, session_unlocked) is
-- NEVER pruned by the cap, so an unseen integrity alert cannot be destroyed
-- by volume. Age tiers above still apply to urgent rows after 365 d.
-- ═══════════════════════════════════════════════════════════════════════
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
  v_unread_capped bigint;
  v_urgent_const public.notification_type[] :=
    array['session_flagged','session_reset','removed_from_class',
          'results_revealed','face_unavailable_reported',
          'face_enrollment_held','session_unlocked']::public.notification_type[];
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

  -- R2-NOTIF-N2: cap NON-URGENT UNREAD rows at 500 per recipient (newest
  -- kept). Urgent unread rows are exempt so an unseen integrity alert is
  -- never dropped by volume.
  delete from public.notifications n
   where n.read_at is null
     and n.type <> all (v_urgent_const)
     and n.seq <= (
       select x.seq from public.notifications x
        where x.recipient_id = n.recipient_id
          and x.read_at is null
          and x.type <> all (v_urgent_const)
        order by x.seq desc
        offset 500 limit 1
     );
  get diagnostics v_unread_capped = row_count;

  return jsonb_build_object(
    'pruned_read', v_read,
    'pruned_unread', v_unread,
    'pruned_unread_urgent', v_urgent,
    'pruned_over_cap', v_capped,
    'pruned_unread_over_cap', v_unread_capped
  );
end;
$$;

revoke all on function public.prune_expired_notifications() from public, anon;
grant execute on function public.prune_expired_notifications() to service_role;

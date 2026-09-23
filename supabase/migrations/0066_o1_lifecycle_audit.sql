-- ═══════════════════════════════════════════════════════════════════════
-- 0066 — session lifecycle audit rows (audit-5 O1)
--
-- 0062 shipped the M1–M4 gates but the audit's O1 finding (no audit/metric
-- for start/submit/seal) was addressed by EDITING 0062's function bodies —
-- which does not propagate to an environment where 0062 was already applied.
-- This migration therefore carries the O1 delta as a fresh, idempotent
-- redefinition of the three affected functions:
--
--   * submit_session     — writes `session_submitted` after the completion
--   * start_quiz_session — writes `session_started` for a newly spawned session
--   * quiz_autoclose     — writes `session_sealed` (set-based) before the seal
--
-- CREATE OR REPLACE is idempotent, so a fresh environment (0062 already has
-- the rows) and an upgraded one (0062 predates them) converge on identical
-- definitions. The audit_events(action, created_at) index the O2 snapshot
-- relies on ships in 0065.
--
-- Run: npx supabase db reset / db push
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. submit_session (O1: session_submitted) ─────────────────────────
create or replace function public.submit_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_score   numeric;
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

  -- Re-submit idempotency: return the stored result â€” score reveal-gated.
  -- C5-7: the recompute below is NEW behaviour (the live body returned the
  -- stored score untouched, so an override after submit never reached the
  -- student's own re-read).
  if v_session.status = 'completed' then
    select coalesce(sum(coalesce(sa.mark_score,
                 case when sa.is_correct then 1 else 0 end)), 0)
      into v_score
      from public.session_answers sa
     where sa.session_id = v_session.id
       and sa.mark_status <> 'pending';

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
        'score', v_score,
        'last_activity_at', v_session.last_activity_at
      ),
      'score', v_score,
      'total', v_total,
      'already_submitted', true
    );
  end if;

  if v_session.status not in ('active', 'paused') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- M1 (audit-5 B1): finalization-time silence evidence. The cron cannot see
  -- this session once the UPDATE below flips it to completed, and
  -- record_face_check refuses completed sessions â€” without this write the
  -- suppress-then-submit escape leaves NO flag anywhere. Dedupe guard: a
  -- session already carrying a silence marker (cron-flagged then unlocked,
  -- or an autoclose-seal marker) is not marked twice.
  if public.session_verify_silent(v_session.id)
     and not exists (
       select 1 from public.audit_events ae
        where ae.action = 'auto_flag_verify_silence'
          and ae.metadata ->> 'session_id' = v_session.id::text
     ) then
    insert into public.audit_events (actor_id, subject_id, action, metadata)
    values (
      null,
      v_session.student_id,
      'auto_flag_verify_silence',
      jsonb_build_object(
        'quiz_id', v_session.quiz_id,
        'session_id', v_session.id,
        'via', 'submit'
      )
    );
  end if;

  -- D10: the ONE arithmetic. Pending rows contribute 0 (their mark_score is
  -- NULL by session_answers_pending_shape and is_correct is false).
  select coalesce(sum(coalesce(sa.mark_score,
               case when sa.is_correct then 1 else 0 end)), 0)
    into v_score
    from public.session_answers sa
   where sa.session_id = v_session.id
     and sa.mark_status <> 'pending';

  update public.quiz_sessions
     set status = 'completed',
         score = v_score,
         submitted_at = clock_timestamp(),
         last_activity_at = clock_timestamp()
   where id = v_session.id;

  -- audit-5 O1: a lifecycle audit row for the submit (previously only
  -- indirectly observable via submitted_at / notifications). actor_id = the
  -- submitting student; subject_id is the same student (self-service event).
  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    v_session.student_id,
    v_session.student_id,
    'session_submitted',
    jsonb_build_object(
      'quiz_id', v_session.quiz_id,
      'session_id', v_session.id,
      'mode', v_session.mode,
      'score', v_score
    )
  );

  -- â”€â”€ Auto-reveal (assessment only, single transaction) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if v_session.mode = 'assessment' then
    if public.can_student_view_quiz(v_session.quiz_id) then
      -- Serialize count-then-reveal across concurrent last-submits.
      perform pg_advisory_xact_lock(hashtext('quiz_reveal:' || v_session.quiz_id::text));

      -- "All done" = no fresh (â‰¤2h) active/paused/flagged assessment sessions
      -- AND the CURRENT submitting student has no retake budget remaining
      -- (QC-4 pre-flight decision 1) AND (L4) no answer anywhere in the quiz
      -- is still pending AI marking. The pending term is what keeps a
      -- provisional score from being revealed as final: a revealed score is
      -- irreversible (quiz_reveal_once), so the quiz waits for the sweep.
      select not exists (
        select 1 from public.quiz_sessions s
        where s.quiz_id = v_session.quiz_id
          and s.mode = 'assessment'
          and s.status in ('active', 'paused', 'flagged')
          and s.last_activity_at >= now() - interval '2 hours'
      ) and not exists (
        select 1 from public.session_answers sa
        join public.quiz_sessions s2 on s2.id = sa.session_id
        where s2.quiz_id = v_session.quiz_id
          and sa.mark_status = 'pending'
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
        -- F8b: no status='live' term â€” the quiz may already be closed by the
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
    -- score but never triggers or participates in the global reveal â€” the
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

-- ─── 2. quiz_autoclose (O1: session_sealed) ────────────────────────────
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

  -- M1 (audit-5 B1): the autoclose seal bypasses submit_session, so the
  -- finalization-time evidence write must live here too â€” otherwise a
  -- silence-suppressed attempt that idles to the window close is sealed with
  -- no marker at all. Scoped to rows the seal below will actually take
  -- (active/paused, closed quiz); dedupe-guarded like submit's.
  insert into public.audit_events (actor_id, subject_id, action, metadata)
  select null,
         s.student_id,
         'auto_flag_verify_silence',
         jsonb_build_object(
           'quiz_id', s.quiz_id,
           'session_id', s.id,
           'via', 'autoclose_seal'
         )
    from public.quiz_sessions s
   where s.mode = 'assessment'
     and s.status in ('active', 'paused')
     and exists (
       select 1 from public.quizzes q
        where q.id = s.quiz_id
          and q.status = 'closed'
     )
     and public.session_verify_silent(s.id)
     and not exists (
       select 1 from public.audit_events ae
        where ae.action = 'auto_flag_verify_silence'
          and ae.metadata ->> 'session_id' = s.id::text
     );

  -- audit-5 O1: per-session lifecycle audit for the seal (set-based, taken
  -- BEFORE the seal UPDATE so ROW_COUNT accounting for v_sealed is untouched).
  -- Mirrors the seal predicate exactly; a session is audited at most once per
  -- seal (a sealed row is 'completed', which the predicate excludes next tick).
  insert into public.audit_events (actor_id, subject_id, action, metadata)
  select null, s.student_id, 'session_sealed',
         jsonb_build_object(
           'quiz_id', s.quiz_id,
           'session_id', s.id,
           'via', 'autoclose'
         )
    from public.quiz_sessions s
   where s.mode = 'assessment'
     and s.status in ('active', 'paused')
     and exists (
       select 1 from public.quizzes q
        where q.id = s.quiz_id
          and q.status = 'closed'
     );

  -- D-F1(b): seal in-flight assessment sessions of closed quizzes. Covers
  -- both the flips above and manual closes (status='closed' written by the
  -- close route). score is explicitly NULLed so assign_seal_score's WHEN
  -- (`new.score is null`) fires deterministically and sets the GUC that makes
  -- notify_session_terminal skip the submit arms. submitted_at is NOT written
  -- (D-F3: sealed â‰  submitted). flagged is excluded.
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

  -- audit-1 P1-6 (see 0045 Â§15 header). The 2h inactivity term covers ALL
  -- assessment session statuses: a fresh completed attempt = a student who
  -- may still retake (quiet window holds); a fresh active/paused/flagged
  -- session = someone mid-attempt (never reveal under them).
  -- L4: `not exists (... mark_status = 'pending')` â€” the same zero-pending
  -- term as submit_session's v_all_done.
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
     )
     and not exists (
       select 1 from public.session_answers sa
       join public.quiz_sessions s3 on s3.id = sa.session_id
        where s3.quiz_id = q.id
          and sa.mark_status = 'pending'
     );
  get diagnostics v_revealed = row_count;

  -- R2-NOTIF-N1: recover a quiz_completed_all digest lost to the
  -- two-submit race. Same inequality and dedupe key as
  -- notify_session_terminal (including the `enrolled > 0` guard â€” a quiz
  -- with an empty roster must never fire the digest); ON CONFLICT keeps
  -- at-most-once. Scoped to quizzes with a RECENT completed assessment
  -- session (the race is seconds wide), so the sweep never retroactively
  -- notifies for long-closed quizzes whose roster has since shrunk.
  --
  -- `submitted_at is not null` preserves the 0045 Â§9 "seal â‰  submit"
  -- semantics: a SEALED session (no submitted_at, per D-F3) must not vote
  -- for the digest, exactly as the GUC-guarded trigger arm excludes it.
  -- (A genuinely submitted session always stamps submitted_at, so this term
  -- only ever removes seals.)
  --
  -- L5: a session holding a PENDING answer is not "completed" for digest
  -- purposes â€” its mark is unresolved, so announcing the class finish would
  -- be premature. The sweep's finalize re-runs this check after resolving.
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
         and not exists (
           select 1 from public.session_answers sa
            where sa.session_id = x.id
              and sa.mark_status = 'pending'
         )
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

-- ─── 3. start_quiz_session (O1: session_started) ───────────────────────
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
  v_consent_at      timestamptz;
  v_face_status     text;
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

  -- Window gating (enrolled callers only â€” schedule state, not identity).
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

  -- M2 (audit-5 B2): assessment face-eligibility. The pre-start gate lived
  -- only in page props, so a direct POST /api/sessions caller started
  -- unverified. Consent is the privacy invariant (the camera never starts
  -- without it) and every registered student already has it; pending_review
  -- is a duplicate-flagged enrollment that must not start a proctored
  -- attempt. `enrolled` is deliberately NOT required here â€” see the file
  -- header (camera-off acceptance, PLAN risk 7).
  select p.consent_given_at, p.face_enrollment_status
    into v_consent_at, v_face_status
    from public.profiles p
   where p.id = auth.uid();

  if v_consent_at is null then
    return jsonb_build_object('error', 'consent_required');
  end if;
  if v_face_status = 'pending_review' then
    return jsonb_build_object('error', 'face_enrollment_pending');
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
  -- below â€” the hold survives.
  select s.* into v_session
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
     and s.mode = 'assessment'
     and s.status in ('active', 'paused', 'flagged')
   order by s.started_at desc
   limit 1;

  if found then
    -- Stale-paused sealing (QC-4 pre-flight decision 2): a non-completed
    -- session from a PASSED window is unrecoverable (every answer â†’
    -- time_expired/quiz_window_closed). Seal it completed (scored as-is,
    -- nothing deleted) so its partial evidence is preserved; the spawn gate
    -- below then returns quiz_window_closed (a passed window cannot birth a
    -- new attempt). Unconditional: without this, the session would sit
    -- behind the one-active index as a remedy-free dead slot â€” the exact
    -- stranding the pre-flight decision rejected.
    --
    -- D-F3: FLAGGED is excluded â€” the integrity hold is the lecturer's
    -- decision, not the clock's. active/paused only.
    if v_closes_at is not null
       and clock_timestamp() >= v_closes_at
       and v_session.status in ('active', 'paused') then
      update public.quiz_sessions
         set status = 'completed',
             -- Explicit NULL so the assign_seal_score BEFORE-trigger's WHEN
             -- (`new.score is null`) fires deterministically. That trigger is
             -- what computes the sealed score AND sets the app.session_sealing
             -- GUC that suppresses the bogus session_submitted mail â€” a row
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
        -- new attempt from a passed window â†’ quiz_window_closed.
        return jsonb_build_object('error', 'quiz_window_closed');
      end if;
      -- Concurrent writer flipped it first (submitted in another tab, or the
      -- autoclose sweep sealed it): re-read and report the surviving
      -- non-completed row.
      --
      -- The 0032 form tested `v_session is not null`, which is ALWAYS FALSE
      -- for a composite: plpgsql hands the test to the core parser, and
      -- `IS NOT NULL` on a row type is true only when EVERY FIELD is non-null
      -- â€” quiz_sessions has several nullable columns (submitted_at, score,
      -- paused_at, â€¦), so a successfully re-read row failed the test and the
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
    -- â€” this id points at the terminal attempt by construction.
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
  -- attempt cannot start past closes_at â€” the schedule error surfaces the
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
    -- (non-completed) session with explicit ordering â€” NEVER a completed
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

  -- audit-5 O1: a lifecycle audit row for the start (previously absent â€” start
  -- was observable only via the client and the session row). Only the newly
  -- INSERTED session path reaches here, so this fires once per real start.
  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    v_session.student_id,
    v_session.student_id,
    'session_started',
    jsonb_build_object(
      'quiz_id', v_session.quiz_id,
      'session_id', v_session.id,
      'mode', v_session.mode,
      'attempt', v_session.attempt
    )
  );

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

-- Self-hosted PostgREST cache: exactly one NOTIFY at the very end.
notify pgrst, 'reload schema';
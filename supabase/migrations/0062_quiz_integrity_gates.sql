-- ═══════════════════════════════════════════════════════════════════════
-- 0062 — Quiz/integrity/verification gates (audit-5, docs/audit/
--        audit-5-quiz-integrity-verification.md)
--
-- Implements the "must fix before prod" set that lives in SQL:
--
--   M1  Submit-escape from the silence cron (B1). flag_verify_silent_sessions
--       scans status='active' only; submit_session flips active→completed and
--       record_face_check refuses completed sessions, so a cheater who
--       suppresses verifies, answers ≥2 post-check questions and submits
--       before the next cron tick was NEVER flagged by any writer. Fix: a
--       finalization-time evidence write — submit_session and quiz_autoclose's
--       seal arm both evaluate the same silence predicate (via the shared
--       public.session_verify_silent helper) and record an
--       `auto_flag_verify_silence` audit row (the SAME action the cron uses,
--       so the lecturer timeline labels it identically; metadata.via names
--       the writer). A completed session cannot carry status='flagged'
--       (D-F3/the flagged hold semantics), so the audit row IS the flag.
--
--       Predicate deviation from the cron (deliberate, documented): the cron's
--       90-second answer-freshness term exists so an IDLE session is not
--       continuously flagged; at finalization the attempt is over, so the
--       whole attempt's silence is the evidence. The quiz-liveness and
--       enrollment terms are also dropped: submit stays permissive on a
--       closed quiz / removed student (P0-5) and the evidence should still
--       land. The outage-claim exemption (fresh AND corroborated) is kept
--       verbatim — with the client-side corroboration heartbeat (M5,
--       use-face-pipeline) an honest outage keeps stamping
--       face_verify_attempted_at and never earns a false marker.
--
--   M2  start_quiz_session had NO face-eligibility gate: a direct
--       POST /api/sessions caller started an assessment unverified (the gate
--       lived only in page props). Fix: assessment starts require
--       consent_given_at (typed `consent_required`) and refuse
--       face_enrollment_status='pending_review' (typed
--       `face_enrollment_required`).
--
--       DEVIATION from the audit's literal recommendation ("require
--       enrollment at start"): a hard `enrolled` requirement was REJECTED.
--       PLAN risk 7 deliberately accepts camera-off / camera-death students
--       completing assessments click-first (enrollment needs a camera; the
--       lecturer `exempt_face_session` is the safety net), and 0047 gate 3
--       deliberately allows a FIRST-TIME mid-session enrollment to break the
--       start-before-enrolling deadlock. A hard enrollment gate would strand
--       every camera-less student at Start and break that documented
--       deadlock-breaker. The exploitable half (mid-session identity swap) is
--       closed by M3 instead; the answer≤1 residual is bounded by the
--       silence cron (which already coalesces started_at — a zero-check
--       session answering ≥2 IS a candidate) and M1's submit-time marker.
--
--   M3  enroll_face's mid-session gate required `v_has_live_session AND
--       v_ever_enrolled`, so a NEVER-enrolled student could mint a session
--       (M2's hole), then bind ANY live face mid-quiz — full impersonation.
--       Fix: refuse whenever ANY live assessment session exists
--       (`live_assessment`). Consequence, accepted: an honest
--       start-before-enroll student must ask the lecturer for a reset before
--       enrolling (the previous "first-time mid-session allowed" path was the
--       impersonation vector).
--
--   M4  pending_review was a dead end: reject_face_enrollment had zero
--       route/UI callers, so a duplicate-flagged student could never start
--       (gate blocks), never verify (gate 8), and re-enroll re-flagged. Fix:
--       `approve_face_enrollment` (lecturer, audited) +
--       `list_pending_face_enrollments` (lecturer-scoped review list) +
--       the review route/UI in the same change.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. session_verify_silent: the shared finalization predicate ───────
-- Mirrors the LIVE 0047 flag_verify_silent_sessions cursor predicate minus
-- the cron-only terms (90s answer freshness, quiz-liveness/enrollment — see
-- the M1 header). NOT a replacement for the cron: the cron keeps its own
-- tuned copy (continuous detection wants freshness; finalization wants the
-- whole-attempt record). Internal helper only — revoked from every client
-- role; the security-definer callers below run as the owner.
create or replace function public.session_verify_silent(p_session_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce((
    select
      s.mode = 'assessment'
      and s.face_exempt = false
      and (s.resume_grace_until is null or s.resume_grace_until < clock_timestamp())
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
        select coalesce(max(fc.checked_at), s.started_at)
          from public.face_checks fc
         where fc.session_id = s.id
      ) < clock_timestamp() - interval '300 seconds'
      and (
        select count(*) from public.session_answers sa
         where sa.session_id = s.id
           and sa.answered_at > coalesce(
             (select max(fc.checked_at) from public.face_checks fc
               where fc.session_id = s.id),
             s.started_at
           )
      ) >= 2
    from public.quiz_sessions s
    where s.id = p_session_id
  ), false)
$$;

revoke execute on function public.session_verify_silent(uuid) from public, anon, authenticated;

-- ─── 2. submit_session: finalization-time silence evidence (M1) ────────
-- BASELINE: the LIVE 0055:700 revision. Change: after the active/paused gate
-- and BEFORE the completion UPDATE, evaluate the silence predicate and write
-- the audit marker (dedupe-guarded against an existing cron/submit/seal row
-- for the same session). The marker is written in the SAME transaction as
-- the completion, so a crash rolls back both.
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

  -- Re-submit idempotency: return the stored result — score reveal-gated.
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
  -- record_face_check refuses completed sessions — without this write the
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

  -- ── Auto-reveal (assessment only, single transaction) ─────────────
  if v_session.mode = 'assessment' then
    if public.can_student_view_quiz(v_session.quiz_id) then
      -- Serialize count-then-reveal across concurrent last-submits.
      perform pg_advisory_xact_lock(hashtext('quiz_reveal:' || v_session.quiz_id::text));

      -- "All done" = no fresh (≤2h) active/paused/flagged assessment sessions
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

-- ─── 3. quiz_autoclose: seal-time silence evidence (M1) ────────────────
-- BASELINE: the LIVE 0056:25 revision. Change: BEFORE the seal UPDATE, mark
-- every about-to-be-sealed assessment session that meets the silence
-- predicate. The marker is dedupe-guarded exactly like submit's. The seal
-- UPDATE (and v_sealed accounting) is untouched — the marker write is a
-- separate statement so ROW_COUNT stays the seal's.
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
  -- finalization-time evidence write must live here too — otherwise a
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
  -- L4: `not exists (... mark_status = 'pending')` — the same zero-pending
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
  --
  -- L5: a session holding a PENDING answer is not "completed" for digest
  -- purposes — its mark is unresolved, so announcing the class finish would
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

-- ─── 4. start_quiz_session: assessment face-eligibility gate (M2) ──────
-- BASELINE: the LIVE 0048:502 revision. Change: assessment mode additionally
-- requires consent_given_at (typed `consent_required`) and refuses a
-- pending_review enrollment status (typed `face_enrollment_required`). See
-- the file header for why `enrolled` is deliberately NOT required.
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

  -- M2 (audit-5 B2): assessment face-eligibility. The pre-start gate lived
  -- only in page props, so a direct POST /api/sessions caller started
  -- unverified. Consent is the privacy invariant (the camera never starts
  -- without it) and every registered student already has it; pending_review
  -- is a duplicate-flagged enrollment that must not start a proctored
  -- attempt. `enrolled` is deliberately NOT required here — see the file
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

-- ─── 5. enroll_face: no mid-session enrollment, ever (M3) ─────────────
-- BASELINE: the LIVE 0047:819 revision. Change: gate 3 refuses whenever ANY
-- live assessment session exists (was `v_has_live_session AND
-- v_ever_enrolled`). The ever-enrolled conjunct was the impersonation hole:
-- a never-enrolled student could start (M2's hole) then bind any live face
-- mid-quiz. v_ever_enrolled is kept for the audit action label only.
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

  -- (3) Live-assessment gate (audit-5 M3). The previous form required BOTH a
  -- live session AND an ever-enrolled marker, which left a never-enrolled
  -- student free to bind an arbitrary face mid-quiz (start unverified via
  -- the pre-M2 hole → enroll a different person's face → verify as them).
  -- ANY live assessment session now blocks enrollment: the baseline must be
  -- established BEFORE the attempt starts. An honest student who started
  -- before enrolling is unblocked by the lecturer's reset (the same remedy
  -- every other blocked state has); the pre-start UI already steers
  -- enrollment first, and camera-off students never enroll at all (PLAN
  -- risk 7 — they complete click-first and the lecturer exempts).
  -- v_ever_enrolled is retained ONLY for the audit action label below.
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
  if v_has_live_session then
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

-- ─── 6. approve_face_enrollment: the missing adjudication arm (M4) ─────
-- Mirror of reject_face_enrollment (0010): lecturer-of-a-class-the-student-
-- is-in only (single no-oracle 404), GUC-guarded status write, audited.
-- Approve is only meaningful for a pending_review enrollment (the samples
-- are already stored — pending_review is a duplicate-scan verdict, not an
-- incomplete capture); anything else returns `not_pending` rather than
-- silently setting 'enrolled' on a student who never enrolled.
create or replace function public.approve_face_enrollment(p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_status text;
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

  if not exists (
    select 1 from public.classes c
    join public.class_enrollments ce on ce.class_id = c.id
    where ce.student_id = p_student_id and c.lecturer_id = v_actor
  ) then
    return jsonb_build_object('error', 'not_owner');
  end if;

  select p.face_enrollment_status into v_status
    from public.profiles p
   where p.id = p_student_id;

  if v_status is distinct from 'pending_review' then
    return jsonb_build_object('error', 'not_pending');
  end if;

  perform set_config('app.face_enroll', 'on', true);
  perform set_config('app.face_enroll_actor', v_actor::text, true);

  update public.profiles
     set face_enrollment_status = 'enrolled'
   where id = p_student_id;

  insert into public.audit_events (actor_id, subject_id, action)
  values (v_actor, p_student_id, 'face_enroll_approved');

  return jsonb_build_object('ok', true, 'status', 'enrolled');
end;
$$;

revoke execute on function public.approve_face_enrollment(uuid) from public, anon;
grant execute on function public.approve_face_enrollment(uuid) to authenticated;

-- ─── 7. list_pending_face_enrollments: the lecturer review list (M4) ───
-- pending_review students enrolled in any of the caller's (non-archived)
-- classes, with the class titles for context. Security-definer so it can
-- read profiles (lecturer SELECT on profiles is self-only); lecturer-gated
-- in-body. The roster view deliberately omits face_enrollment_status
-- (security audit MED-3), so this narrow RPC is the only lecturer read of
-- the flag — and it returns ONLY pending_review rows, never enrolled ones.
create or replace function public.list_pending_face_enrollments()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_rows  jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'student_id', t.id,
           'full_name', t.full_name,
           'matric_no', t.matric_no,
           'classes', t.class_titles
         ) order by t.full_name nulls last, t.id), '[]'::jsonb)
    into v_rows
    from (
      select p.id,
             p.full_name,
             p.matric_no,
             (
               select jsonb_agg(c.title order by c.title)
                 from public.class_enrollments ce
                 join public.classes c on c.id = ce.class_id
                where ce.student_id = p.id
                  and c.lecturer_id = v_actor
                  and c.archived_at is null
             ) as class_titles
        from public.profiles p
       where p.face_enrollment_status = 'pending_review'
         and exists (
           select 1
             from public.class_enrollments ce
             join public.classes c on c.id = ce.class_id
            where ce.student_id = p.id
              and c.lecturer_id = v_actor
              and c.archived_at is null
         )
    ) t;

  return jsonb_build_object('ok', true, 'students', v_rows);
end;
$$;

revoke execute on function public.list_pending_face_enrollments() from public, anon;
grant execute on function public.list_pending_face_enrollments() to authenticated;

-- audit-5 M4: `list_pending_face_enrollments` + `approve_face_enrollment` are
-- new RPCs, and `start_quiz_session`/`submit_session`/`enroll_face` gained new
-- return branches. On self-hosted PostgREST a stale schema cache would 404 the
-- new RPCs until reload. Exactly one NOTIFY, at the very end.
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
-- 0056 — Lifecycle: pending-aware completion + seal trigger restore
--        (PLAN_GESTURE_OFF_RICH_TYPES)
--
-- Contents:
--   §1 quiz_autoclose  — reveal arm + digest arm gain the zero-pending term
--   §2 notify_session_terminal — completed-count excludes pending sessions
--   §3 quiz_sessions_seal_score trigger — RE-CREATED (dropped in 0053)
--   §4 quiz_status_transition freeze list — gains gestures_enabled (FS-8)
--
-- FS-2: §1/§2 use CREATE OR REPLACE, NOT drop+create. Both functions have
-- NORMAL trigger dependencies (0022:450-457, 0048:929-930), so a DROP fails
-- RESTRICT — and CASCADE would silently destroy the triggers.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. quiz_autoclose: pending-aware reveal + digest ─────────────────
-- BASELINE: the LIVE 0048:801 revision.
-- L4: the reveal arm gains the same zero-pending term as submit_session's
--     v_all_done — a quiz with unresolved AI marks is never auto-revealed,
--     because reveal is irreversible (quiz_reveal_once) and would freeze a
--     provisional score as final.
-- L5: the digest arm excludes sessions holding pending answers from the
--     completed count, so "class finished" is not announced while marks are
--     still being resolved.
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

-- ─── 2. notify_session_terminal: pending-aware completed count ────────
-- BASELINE: the LIVE 0048:931 revision. L5: the quiz_completed_all count
-- excludes sessions holding a pending answer (same rule as §1's digest arm),
-- so the trigger and the sweeper agree.
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
    -- L5: the pending exclusion keeps it identical to §1's digest arm too.
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
       and x.mode = 'assessment'
       and not exists (
         select 1 from public.session_answers sa
          where sa.session_id = x.id
            and sa.mark_status = 'pending'
       );

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

-- ─── 3. Restore the seal trigger (dropped in 0053 §2) ─────────────────
-- Body VERBATIM from 0045:1144-1152. assign_seal_score itself was redefined
-- in 0055 §8 with the D10 SUM + a NUMERIC v_score, so the WHEN clause's
-- `new.score is null` still means "no score written by an honest submit".
drop trigger if exists quiz_sessions_seal_score on public.quiz_sessions;
create trigger quiz_sessions_seal_score
  before update of status, score on public.quiz_sessions
  for each row
  when (new.status = 'completed'
        and old.status is distinct from 'completed'
        and new.mode = 'assessment'
        and new.score is null)
  execute function public.assign_seal_score();

-- ─── 4. quiz_status_transition: freeze gestures_enabled (FS-8) ────────
-- BASELINE: the LIVE 0034:68 revision. The freeze list gains
-- `NEW.gestures_enabled IS DISTINCT FROM OLD.gestures_enabled` so the flag
-- cannot be flipped once a quiz leaves draft. The route-level 409
-- (`hasNonWindowFields` → liveManageableOnly) is the friendly path; this is
-- the backstop that also stops a direct/service-role write.
--
-- D9 rationale: flipping the modality mid-live would desync in-flight
-- students (some with the gesture pad armed, some keyboard-only) against a
-- single quiz row, and there is no per-student migration path for a
-- partially-gesture session.
create or replace function public.quiz_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_question_count int;
begin
  -- audit-4 M9: RESTORED INSERT arm (live 0034:77-83). Without it a direct or
  -- service-role `INSERT ... status='live'` skips `cannot_publish_empty_quiz`
  -- entirely (the UPDATE-only count check below never runs for an INSERT), so
  -- a 0-question quiz lands live. A draft-first round trip is the contract the
  -- routes rely on; this is the backstop for everything else.
  if TG_OP = 'INSERT' then
    if NEW.status is distinct from 'draft' then
      raise exception 'quiz_must_start_draft'
        using errcode = 'P0001';
    end if;
    return NEW;
  end if;

  -- Metadata edit-lock: title/mode/time_limit/sources fields AND
  -- shuffle_questions (QT-3) AND gestures_enabled (this plan) are frozen
  -- once a quiz leaves draft. NOTE: opens_at/closes_at (QC-3) and
  -- allow_retake/max_attempts (QC-4) are deliberately NOT frozen —
  -- availability windows and retake config are live-quiz management
  -- (PLAN_R_QUIZ_LIFECYCLE).
  if OLD.status <> 'draft'
     and (NEW.title is distinct from OLD.title
          or NEW.mode is distinct from OLD.mode
          or NEW.time_limit_sec is distinct from OLD.time_limit_sec
          or NEW.source_file_url is distinct from OLD.source_file_url
          or NEW.source_text is distinct from OLD.source_text
          or NEW.sources is distinct from OLD.sources
          or NEW.shuffle_questions is distinct from OLD.shuffle_questions
          or NEW.gestures_enabled is distinct from OLD.gestures_enabled) then
    raise exception 'quiz_not_draft_edit'
      using errcode = 'P0001';
  end if;

  if NEW.status = OLD.status then
    if OLD.status = 'live' then
      perform pg_advisory_xact_lock(hashtext('quiz_publish:' || OLD.id::text));
      if exists (
        select 1 from public.quizzes q
        where q.id = OLD.id and q.status = 'closed'
      ) then
        raise exception 'closed_quiz_cannot_transition'
          using errcode = 'P0001';
      end if;
    end if;
    return NEW;
  end if;

  if OLD.status = 'closed' then
    raise exception 'closed_quiz_cannot_transition'
      using errcode = 'P0001';
  end if;

  if OLD.status = 'live' and NEW.status = 'draft' then
    raise exception 'live_quiz_cannot_reopen'
      using errcode = 'P0001';
  end if;

  if NEW.status = 'live' then
    select count(*) into v_question_count
      from public.questions
     where quiz_id = NEW.id;
    if v_question_count = 0 then
      raise exception 'cannot_publish_empty_quiz'
        using errcode = 'P0001';
    end if;
  end if;

  return NEW;
end;
$$;

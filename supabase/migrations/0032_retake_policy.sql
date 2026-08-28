-- ═══════════════════════════════════════════════════════════════════════
-- 0032 — Retake policy / multi-attempt assessments (PLAN_R_QUIZ_LIFECYCLE QC-4)
--
-- Adds:
--   1. quizzes.allow_retake (default false) + quizzes.max_attempts
--      (default 1, CHECK 1..3). Deliberately OUTSIDE the quiz_not_draft_edit
--      freeze list — retake config is live-quiz management (same rationale
--      as windows, 0030 §8); the redefined quiz_status_transition pins this.
--   2. quiz_sessions.attempt (default 1). Index swap:
--      drop one_assessment_attempt (one row per quiz+student) →
--        unique (quiz_id, student_id, attempt) where assessment
--        + partial unique (quiz_id, student_id)
--          where assessment AND status in (active,paused,flagged)
--      Preserves the one-ACTIVE-attempt invariant while letting completed
--      attempts coexist under retakes.
--   3. start_quiz_session redefinition (carries the FULL 0030 body forward —
--      window gating AFTER enrollment): assessment spawn computes
--      attempt = max(existing)+1 when budget permits; resume pre-checks
--      select among NON-completed rows ONLY; a stale non-completed session
--      from a PASSED window is SEALED completed (scored as-is, no evidence
--      destroyed — unconditional, since the session is a remedy-free dead
--      slot otherwise) with the spawn gate then returning quiz_window_closed;
--      the per-(quiz,student) advisory lock now covers the assessment path
--      too; the unique_violation handler re-selects the RESUMABLE
--      (non-completed) session with explicit ordering — never a completed row.
--   4. submit_session auto-reveal gains the retake-aware "all done" term:
--      a recently-completed (≤2h) student with retake budget REMAINING
--      keeps the quiz unrevealed.
--   5. quiz_completed_all digest counts DISTINCT STUDENTS (not session
--      rows) — a second attempt alone no longer satisfies the inequality.
--   6. Views gain attempt (APPENDED LAST — Postgres forbids reordering):
--      lecturer_session_view (attempt chips), student_session_view.
--
-- Default-config invariant: allow_retake=false/max_attempts=1 behaves
-- identically to 0008..0031 semantics (single attempt; already_attempted
-- on re-start; stale-paused voiding is new but only REACHABLE with a
-- windowed quiz — same-slot behavior is unchanged without it).
--
-- Depends on: 0008 (sessions), 0012 (views/reveal), 0016+0030 (trigger
-- carry-forward chain), 0021 (lecturer_session_view), 0022 (digest),
-- 0024 (submit_session auto-reveal), 0028, 0030 (windows).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Retake config columns ─────────────────────────────────────────
alter table public.quizzes
  add column if not exists allow_retake boolean not null default false,
  add column if not exists max_attempts int not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quizzes_max_attempts_check' and conrelid = 'public.quizzes'::regclass
  ) then
    alter table public.quizzes
      add constraint quizzes_max_attempts_check check (max_attempts between 1 and 3);
  end if;
end $$;

-- ─── 2. attempt column + index swap ───────────────────────────────────
-- Backfill first so the NOT NULL + unique swap sees a clean table (existing
-- rows are the attempt-1 of their (quiz, student) by construction of 0008).
alter table public.quiz_sessions
  add column if not exists attempt int not null default 1;

-- Migration-safety backfill (rows inserted between add-column and backfill
-- cannot exist in a single migration, but the belt-and-braces UPDATE is
-- idempotent and cheap):
update public.quiz_sessions s
   set attempt = x.ord
  from (
    select id, row_number() over (
             partition by quiz_id, student_id, mode order by started_at, id
           ) as ord
      from public.quiz_sessions
     where mode = 'assessment'
  ) x
 where s.id = x.id
   and s.attempt is distinct from x.ord;

drop index if exists one_assessment_attempt;

-- At most ONE row per (quiz, student, attempt) — the spawn-race guard.
create unique index if not exists one_assessment_attempt_per_attempt
  on public.quiz_sessions (quiz_id, student_id, attempt)
  where mode = 'assessment';

-- At most ONE NON-COMPLETED attempt per (quiz, student) — the one-ACTIVE
-- invariant across retakes (completed rows don't block a retake spawn).
create unique index if not exists one_active_assessment_attempt
  on public.quiz_sessions (quiz_id, student_id)
  where mode = 'assessment'
    and status in ('active', 'paused', 'flagged');

-- ─── 3. start_quiz_session: retake spawn (FULL 0030 carry-forward) ────
-- 0030's body carried forward verbatim (auth → role → no-oracle fold →
-- enrollment → windows → practice path) plus:
--   - assessment path under the SAME per-(quiz,student) advisory lock
--     (practice-only before; with multi-attempt spawn the lock now guards
--     the resume-or-void-or-spawn read-modify-write),
--   - resume pre-checks select among NON-completed rows ONLY,
--   - stale non-completed session from a PASSED window → void-completed
--     (scored as-is; evidence preserved) so the slot frees,
--   - spawn computes attempt = max+1 under budget
--     (completed count < max_attempts when allow_retake),
--   - unique_violation handler re-selects the RESUMABLE session with
--     explicit ordering — never a completed row.
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
  -- never be handed back as resumable).
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
    if v_closes_at is not null and clock_timestamp() >= v_closes_at then
      update public.quiz_sessions
         set status = 'completed',
             submitted_at = coalesce(submitted_at, clock_timestamp()),
             last_activity_at = clock_timestamp()
       where id = v_session.id
         and status in ('active', 'paused', 'flagged');
      get diagnostics v_row_count = row_count;
      if v_row_count <> 1 then
        -- Concurrent writer flipped it first; re-read for the response.
        select s.* into v_session
          from public.quiz_sessions s
         where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
           and s.mode = 'assessment'
           and s.status in ('active', 'paused', 'flagged')
         order by s.started_at desc
         limit 1;
      end if;
      if v_session is not null then
        return jsonb_build_object('error', 'already_attempted', 'session_id', v_session.id);
      end if;
      -- Sealed → fall through: the spawn gate returns quiz_window_closed.
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

-- ─── 4. submit_session: retake-aware auto-reveal (carries 0024 forward) ─
-- "All done" gains one term: a recently-completed (≤2h) student with retake
-- budget REMAINING keeps the quiz unrevealed (pre-flight decision 1 —
-- retake-after-reveal showing scores is pedagogically wrong; the 2h window
-- bounds the wait for students who will not retake). Everything else is the
-- verbatim 0024 F8b body.
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

-- ─── 5. quiz_completed_all: count DISTINCT students ────────────────────
-- A student's second attempt alone must not satisfy the inequality (QC-4).
-- The notification function body carries the whole notify_session_terminal
-- forward (completed + flagged arms) with only the v_completed count changed.
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

-- ─── 6. Views gain attempt (APPENDED LAST — Postgres forbids reorder) ──
-- student_quiz_view also gains the retake columns (APPENDED): the student
-- list surface renders "up to N attempts" copy (SQ consumption of QC-4).
create or replace view public.student_quiz_view
with (security_barrier = true)
as
select q.id, q.class_id, q.title, q.mode, q.status, q.time_limit_sec,
       q.created_at, q.results_revealed_at, q.opens_at, q.closes_at,
       q.allow_retake, q.max_attempts
from public.quizzes q
join public.classes c on c.id = q.class_id
where public.is_enrolled_in_class(q.class_id)
  and q.status = 'live'
  and c.archived_at is null;

grant select on public.student_quiz_view to authenticated;

create or replace view public.student_session_view
with (security_barrier = true)
as
select s.id, s.quiz_id, s.student_id, s.mode, s.status,
       s.started_at, s.submitted_at, s.last_activity_at,
       s.face_exempt, s.face_fail_streak, s.face_unavailable_at, s.verify_nonce,
       case when public.is_student_reveal_allowed(s.quiz_id)
            then s.score else null end as score,
       s.attempt
from public.quiz_sessions s
where s.student_id = auth.uid();

grant select on public.student_session_view to authenticated;

create or replace view public.lecturer_session_view
with (security_barrier = true)
as
select s.id, s.quiz_id, s.student_id, s.mode, s.status,
       s.started_at, s.submitted_at, s.last_activity_at,
       s.face_exempt, s.face_fail_streak, s.face_unavailable_at,
       s.score,
       s.focus_pause_count,
       s.attempt
from public.quiz_sessions s
where public.is_lecturer_of_quiz(s.quiz_id);

grant select on public.lecturer_session_view to authenticated;

-- ─── 7. quiz_status_transition: full 0030 carry-forward + retake pin ──
-- allow_retake/max_attempts are deliberately NOT in the quiz_not_draft_edit
-- freeze list: retake config is live-quiz management (QC-4 pre-flight), same
-- rationale as opens_at/closes_at (0030). Everything else is the verbatim
-- 0030 body (incl. the same-status advisory-lock close check).
create or replace function public.quiz_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_question_count int;
begin
  if TG_OP = 'INSERT' then
    if NEW.status is distinct from 'draft' then
      raise exception 'quiz_must_start_draft'
        using errcode = 'P0001';
    end if;
    return NEW;
  end if;

  -- Metadata edit-lock: title/mode/time_limit/sources fields are frozen once a
  -- quiz leaves draft. NOTE: opens_at/closes_at (QC-3) and allow_retake/
  -- max_attempts (QC-4) are deliberately NOT frozen — availability windows
  -- and retake config are live-quiz management (PLAN_R_QUIZ_LIFECYCLE).
  if OLD.status <> 'draft'
     and (NEW.title is distinct from OLD.title
          or NEW.mode is distinct from OLD.mode
          or NEW.time_limit_sec is distinct from OLD.time_limit_sec
          or NEW.source_file_url is distinct from OLD.source_file_url
          or NEW.source_text is distinct from OLD.source_text
          or NEW.sources is distinct from OLD.sources) then
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

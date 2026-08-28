-- ═══════════════════════════════════════════════════════════════════════
-- 0030 — Quiz lifecycle: close notifications + availability windows
-- (PLAN_R_QUIZ_LIFECYCLE QC-1 + QC-3)
--
-- Adds:
--   1. notification_type gains 'quiz_closed' (BLOCKER guard: without it the
--      notify trigger raises 22P02 and ROLLS BACK every close UPDATE —
--      enum-repair precedent 0026).
--   2. quizzes.opens_at / closes_at timestamptz (both nullable — windowless
--      manual publish/close stays valid forever) + CHECK closes_at > opens_at
--      when both set.
--   3. notify_quiz_closed trigger (mirrors notify_quiz_live 0022: non-
--      archived enrollment fan-out + dedupe_key 'quiz_closed:<id>').
--   4. quiz_autoclose() + pg_cron schedule (best-effort, 0019 pattern):
--      live→closed when closes_at passes. Read-time gating (start RPC +
--      answer RPC window terms) guarantees correctness if cron lags.
--   5. start_quiz_session: window gating AFTER the enrollment check (no
--      existence/window oracle for unenrolled probers), distinct typed
--      errors quiz_not_open / quiz_window_closed for enrolled callers.
--   6. answer_question: closes_at hard stop (quiz_window_closed) so untimed
--      quizzes cannot answer forever past a deadline when cron is absent.
--   7. student_quiz_view gains opens_at/closes_at PROJECTION (SQ-1 chips
--      consume); the WHERE predicate is NOT window-filtered — windows gate
--      STARTS/ANSWERS only, closing (status='closed') removes visibility.
--   8. quiz_status_transition redefinition: carries the FULL 0016 body
--      forward verbatim (incl. the same-status advisory-lock close-check,
--      0016:44-54) + pins that window fields sit OUTSIDE the edit-freeze
--      (scheduling is deliberate live-quiz management).
--
-- Depends on: 0004/0007/0016 (state machine), 0008/0012 (sessions/answers),
-- 0017 (archiving predicates), 0019 (pg_cron pattern), 0022/0024 (notifs),
-- 0028 (student_results).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. notification_type gains 'quiz_closed' ──────────────────────────
alter type public.notification_type add value if not exists 'quiz_closed';

-- ─── 2. Availability window columns ────────────────────────────────────
alter table public.quizzes
  add column if not exists opens_at timestamptz,
  add column if not exists closes_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quizzes_window_order_check' and conrelid = 'public.quizzes'::regclass
  ) then
    alter table public.quizzes
      add constraint quizzes_window_order_check
      check (closes_at is null or opens_at is null or closes_at > opens_at);
  end if;
end $$;

create index if not exists quizzes_autoclose_idx
  on public.quizzes (closes_at)
  where status = 'live' and closes_at is not null;

-- ─── 3. notify_quiz_closed ─────────────────────────────────────────────
-- Recipients = enrolled students in NON-archived classes (template:
-- notify_quiz_live, 0022:116-146 — archived-class students are dead-ended).
-- Dedupe: one notification per quiz, ever (idempotent across manual close,
-- cron re-runs, and same-second double-close races).
create or replace function public.notify_quiz_closed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (recipient_id, type, payload, dedupe_key)
  select ce.student_id,
         'quiz_closed'::public.notification_type,
         jsonb_build_object(
           'quiz_id', q.id,
           'quiz_title', q.title,
           'class_id', q.class_id,
           'class_title', c.title
         ),
         'quiz_closed:' || new.id::text
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    join public.class_enrollments ce on ce.class_id = q.class_id
   where q.id = new.id
     and c.archived_at is null
  on conflict (recipient_id, dedupe_key) do nothing;
  return null;
end;
$$;

drop trigger if exists notify_quiz_closed on public.quizzes;
create trigger notify_quiz_closed
  after update of status on public.quizzes
  for each row
  when (old.status is distinct from new.status and new.status = 'closed')
  execute function public.notify_quiz_closed();

-- ─── 4. quiz_autoclose + pg_cron (best-effort; 0019 pattern) ───────────
-- Flips live→closed once closes_at passes. 0 rows on retry (idempotent);
-- the flip fires notify_quiz_closed exactly once per quiz (dedupe holds).
create or replace function public.quiz_autoclose()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed int;
begin
  update public.quizzes
     set status = 'closed'
   where status = 'live'
     and closes_at is not null
     and closes_at <= clock_timestamp();
  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

revoke execute on function public.quiz_autoclose() from public, anon;
grant execute on function public.quiz_autoclose() to service_role;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('innovision-quiz-autoclose', '*/5 * * * *',
    'select public.quiz_autoclose()');
exception when others then
  raise notice 'pg_cron scheduling skipped (%); schedule quiz_autoclose manually', sqlerrm;
end $$;

-- ─── 5. start_quiz_session: window gating (carries 0017 forward) ───────
-- Order matters (no-oracle discipline): identity → status/archived fold →
-- ENROLLMENT → window terms. Window errors BEFORE enrollment would hand
-- unenrolled probers a 409-vs-404 existence/window oracle (plan QC-3).
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
  select q.mode, q.status, c.archived_at, q.opens_at, q.closes_at
    into v_mode, v_status, v_archived_at, v_opens_at, v_closes_at
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
  if v_opens_at is not null and clock_timestamp() < v_opens_at then
    return jsonb_build_object('error', 'quiz_not_open');
  end if;
  if v_closes_at is not null and clock_timestamp() >= v_closes_at then
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
      'last_activity_at', v_session.last_activity_at
    ));
  end if;

  -- Assessment: pre-check, then insert
  select s.* into v_session
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
     and s.mode = 'assessment';

  if found then
    return jsonb_build_object('error', 'already_attempted', 'session_id', v_session.id);
  end if;

  begin
    insert into public.quiz_sessions (quiz_id, student_id, mode, status)
    values (p_quiz_id, auth.uid(), 'assessment', 'active')
    returning * into v_session;
  exception when unique_violation then
    select s.* into v_session
      from public.quiz_sessions s
     where s.quiz_id = p_quiz_id and s.student_id = auth.uid()
       and s.mode = 'assessment';
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
    'last_activity_at', v_session.last_activity_at
  ));
end;
$$;

revoke execute on function public.start_quiz_session(uuid) from public, anon;
grant execute on function public.start_quiz_session(uuid) to authenticated;

-- ─── 6. answer_question: closes_at hard stop (carries 0012 F8-def forward)
-- Inserted AFTER the live checks, BEFORE the time-limit check: a timed quiz
-- past both deadlines surfaces quiz_window_closed first (terminal either
-- way; both map client-side to a typed dead-screen).
create or replace function public.answer_question(
  p_session_id      uuid,
  p_question_id     uuid,
  p_selected_index  int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session   public.quiz_sessions;
  v_closes_at timestamptz;
  v_time_limit int;
  v_options    text[];
  v_correct    int;
  v_explanation text;
  v_is_correct boolean;
  v_rows       int;
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

  if v_session.status <> 'active' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  if not exists (
    select 1 from public.quizzes q
    where q.id = v_session.quiz_id and q.status = 'live'
  ) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  if not public.can_student_view_quiz(v_session.quiz_id) then
    return jsonb_build_object('error', 'quiz_not_live');
  end if;

  -- Availability window hard stop (QC-3): bounds in-flight answering on
  -- UNTIMED quizzes (time_limit_sec is null would otherwise answer forever
  -- past closes_at when pg_cron is absent/best-effort). submit_session stays
  -- window-free — submit-only grace is deliberate.
  select q.closes_at into v_closes_at
    from public.quizzes q
   where q.id = v_session.quiz_id;

  if v_closes_at is not null
     and clock_timestamp() >= v_closes_at then
    return jsonb_build_object('error', 'quiz_window_closed');
  end if;

  select q.time_limit_sec into v_time_limit
    from public.quizzes q
   where q.id = v_session.quiz_id;

  if v_time_limit is not null
     and clock_timestamp() > v_session.started_at
         + (v_time_limit * interval '1 second')
         + interval '5 seconds' then
    return jsonb_build_object('error', 'time_expired');
  end if;

  select q.options, q.correct_index, q.explanation
    into v_options, v_correct, v_explanation
    from public.questions q
   where q.id = p_question_id and q.quiz_id = v_session.quiz_id;

  if not found then
    return jsonb_build_object('error', 'invalid_question');
  end if;

  if p_selected_index is null
     or p_selected_index < 0
     or p_selected_index >= cardinality(v_options) then
    return jsonb_build_object('error', 'invalid_selected_index');
  end if;

  v_is_correct := (p_selected_index = v_correct);

  if v_session.mode = 'assessment' then
    -- First answer wins; a re-answer returns `already_answered` WITHOUT any
    -- correctness signal (reveal-gated; leaking is_correct mid-session would
    -- defeat the whole feature).
    insert into public.session_answers (session_id, question_id, selected_index, is_correct)
    values (v_session.id, p_question_id, p_selected_index, v_is_correct)
    on conflict (session_id, question_id) do nothing;

    get diagnostics v_rows = row_count;

    if v_rows = 0 then
      update public.quiz_sessions
         set last_activity_at = now()
       where id = v_session.id;
      return jsonb_build_object('error', 'already_answered');
    end if;
  else
    -- Practice re-answer is always a 200 upsert (never already_answered).
    insert into public.session_answers (session_id, question_id, selected_index, is_correct)
    values (v_session.id, p_question_id, p_selected_index, v_is_correct)
    on conflict (session_id, question_id) do update
      set selected_index = excluded.selected_index,
          is_correct = excluded.is_correct,
          answered_at = now();
  end if;

  update public.quiz_sessions
     set last_activity_at = now()
   where id = v_session.id;

  -- Keyless ack for assessment (no is_correct, no key — reveal-gated).
  if v_session.mode = 'assessment' then
    return jsonb_build_object('recorded', true);
  end if;

  if v_explanation is null then
    return jsonb_build_object(
      'is_correct', v_is_correct,
      'correct_index', v_correct
    );
  end if;
  return jsonb_build_object(
    'is_correct', v_is_correct,
    'correct_index', v_correct,
    'explanation', v_explanation
  );
end;
$$;

revoke execute on function public.answer_question(uuid, uuid, int) from public, anon;
grant execute on function public.answer_question(uuid, uuid, int) to authenticated;

-- ─── 7. student_quiz_view: window columns in the PROJECTION only ───────
-- WHERE predicate stays live-only (0017); windows never filter here.
create or replace view public.student_quiz_view
with (security_barrier = true)
as
select q.id, q.class_id, q.title, q.mode, q.status, q.time_limit_sec,
       q.created_at, q.results_revealed_at, q.opens_at, q.closes_at
from public.quizzes q
join public.classes c on c.id = q.class_id
where public.is_enrolled_in_class(q.class_id)
  and q.status = 'live'
  and c.archived_at is null;

revoke all on public.student_quiz_view from anon, public;
grant select on public.student_quiz_view to authenticated;

-- ─── 8. quiz_status_transition: full 0016 body + window-freeze pin ─────
-- opens_at/closes_at are deliberately NOT in the quiz_not_draft_edit freeze
-- list: scheduling is live-quiz management (QC-3). Everything else is the
-- verbatim 0016 body (incl. the same-status advisory-lock close check).
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
  -- quiz leaves draft. NOTE: opens_at/closes_at are deliberately NOT frozen —
  -- availability windows are live-quiz management (PLAN_R_QUIZ_LIFECYCLE QC-3).
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
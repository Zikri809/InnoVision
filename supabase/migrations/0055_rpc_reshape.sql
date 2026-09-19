-- ═══════════════════════════════════════════════════════════════════════
-- 0055 — RPC reshape for the rich types (PLAN_GESTURE_OFF_RICH_TYPES)
--
-- Drops the LIVE arities and recreates them with the new-type branches and
-- the D10 single scoring arithmetic. Verified against pg_proc on the target
-- DB (not the plan text) — the live signatures are:
--   answer_question(uuid,uuid,int,int[])            (0037:173)
--   append_question(uuid,question_type,text,text[],int,text,int[])  (0045:1463)
--   clone_quiz(uuid,uuid)                           (0046:444)
--   submit_session(uuid)                            (0045:1263)
--   student_results(uuid)                           (0046:1133)
--   assign_seal_score()                             (0045:1122)
--
-- ── D10, the single arithmetic ────────────────────────────────────────
--   SUM(COALESCE(mark_score, CASE WHEN is_correct THEN 1 ELSE 0 END))
--   WHERE mark_status <> 'pending'
-- A bare `count(*) WHERE is_correct` awards 1 to a 0.5 mark
-- (is_correct = (mark_score >= 0.5)), so the two arithmetics diverge after
-- ANY half-mark. Every scoring site in the system now uses the SUM above.
--
-- ── A7-3: v_score is NUMERIC in ALL recreated bodies ──────────────────
-- The live bodies declare `v_score int`. A numeric→int4 assignment cast
-- ROUNDS (0.5 + 1.0 → 2), which would corrupt exactly the recompute paths
-- D10 protects. Declared numeric here and in 0056's seal body.
--
-- ── D5: every recreated function is re-REVOKEd + re-GRANTed ───────────
-- A fresh function body defaults to EXECUTE to PUBLIC. Five go to
-- authenticated; assign_seal_score is trigger-only (no grant needed, and
-- granting it would be a direct-call surface).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. DROP the live arities ─────────────────────────────────────────
-- A changed argument list makes CREATE OR REPLACE add an OVERLOAD instead of
-- replacing, which would leave the old body callable (and PostgREST would
-- then see two candidates).
drop function if exists public.answer_question(uuid, uuid, int, int[]);
drop function if exists public.append_question(uuid, public.question_type, text, text[], int, text, int[]);
drop function if exists public.clone_quiz(uuid, uuid);
drop function if exists public.submit_session(uuid);
drop function if exists public.student_results(uuid);
drop function if exists public.assign_seal_score();

-- ─── 2. D2-5 / C5-12: arity gate ──────────────────────────────────────
-- Runs AFTER the drops and BEFORE the creates: if any enumerated arity
-- survived the DROP block (a signature drift the plan text did not
-- anticipate), abort here rather than ship a silent overload.
do $do$
declare
  v_left text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_left
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('answer_question', 'append_question', 'clone_quiz',
                       'submit_session', 'student_results', 'assign_seal_score');
  if v_left is not null then
    raise exception 'stale arity after DROP: %', v_left
      using errcode = 'P0001';
  end if;
end $do$;

-- ─── 3. answer_question: 6-arg, all types ─────────────────────────────
-- X2-2: the signature is pinned verbatim; implementers must not invent one.
-- (The plan's 8-arg form carried p_selected_order/p_presented_order for the
-- `ordering` type; that type was CUT before implementation, so the two order
-- args are gone with it.)
-- Every EXISTING gate is carried forward verbatim from the live 0037:173
-- body (ownership, liveness, window, timer grace, first-answer-wins) —
-- 0045 never redefined this function, so 0037 IS the live body and the
-- 0030 window gates + 0037 multi branch must both be present.
--
-- New per-type grading:
--   mcq / true_false / multi_select — unchanged
--   short_text — mark_status='pending', is_correct=false, mark_score NULL
--               (session_answers_pending_shape holds), and a ledger row is
--               queued. It contributes 0 to the score until finalized.
--               FORWARD REFERENCE: `ai_marking_ledger` is created in 0057.
--               plpgsql resolves table names at EXECUTION time, not at
--               CREATE time, so this body compiles here and works as soon as
--               0057 has been applied — which is guaranteed before the
--               system serves traffic, since the CLI applies files in
--               numeric order within one deploy.
--   skip (p_skipped) — skipped=true, every answer field NULL
--               (session_answers_skip_shape), graded mark 0 with
--               mark_status='marked'. Terminal in assessment (S11): a skip
--               on a row that already holds a graded answer returns
--               `already_answered`.
create or replace function public.answer_question(
  p_session_id       uuid,
  p_question_id      uuid,
  p_selected_index   int default null,
  p_selected_indices int[] default null,
  p_answer_text      text default null,
  p_skipped          boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session    public.quiz_sessions;
  v_closes_at  timestamptz;
  v_time_limit int;
  v_options    text[];
  v_type       public.question_type;
  v_correct    int;
  v_correct_set int[];
  v_explanation text;
  v_is_correct boolean;
  v_answer_set int[];
  v_rows       int;
  v_trimmed    text;
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

  -- Availability window hard stop (QC-3, carried verbatim from 0030).
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

  select q.type, q.options, q.correct_index, q.correct_indices, q.explanation
    into v_type, v_options, v_correct, v_correct_set, v_explanation
    from public.questions q
   where q.id = p_question_id and q.quiz_id = v_session.quiz_id;

  if not found then
    return jsonb_build_object('error', 'invalid_question');
  end if;

  -- ── Skip (R13/S11/FC-5) ─────────────────────────────────────────────
  -- Terminal in assessment: a skip is an ANSWER (it writes a graded 0 row),
  -- so it obeys first-answer-wins exactly like any other answer. In practice
  -- it is a normal upsert (re-answer after skip is legal — the A5-5 reset
  -- below clears the skip fields, without which the upsert would violate
  -- session_answers_skip_shape with 23514).
  if p_skipped then
    -- Shape exclusivity: a skip carries no answer payload at all.
    if p_selected_index is not null or p_selected_indices is not null
       or p_answer_text is not null then
      return jsonb_build_object('error', 'invalid_selected_index');
    end if;

    if v_session.mode = 'assessment' then
      insert into public.session_answers
        (session_id, question_id, selected_index, is_correct, skipped,
         mark_status, mark_score, marked_at)
      values
        (v_session.id, p_question_id, null, false, true,
         'marked', 0, clock_timestamp())
      on conflict (session_id, question_id) do nothing;

      get diagnostics v_rows = row_count;

      if v_rows = 0 then
        update public.quiz_sessions
           set last_activity_at = now()
         where id = v_session.id;
        return jsonb_build_object('error', 'already_answered');
      end if;
    else
      -- Practice: full reset of every rich column (A5-5). Without this a
      -- practice re-answer after a skip would raise 23514 on
      -- session_answers_skip_shape, because the ON CONFLICT branch would
      -- leave skipped=true while writing a selection.
      insert into public.session_answers
        (session_id, question_id, selected_index, is_correct, skipped,
         mark_status, mark_score, marked_at)
      values
        (v_session.id, p_question_id, null, false, true,
         'marked', 0, clock_timestamp())
      on conflict (session_id, question_id) do update
        set selected_index = excluded.selected_index,
            selected_indices = null,
            answer_text = null,
            skipped = true,
            is_correct = false,
            mark_status = 'marked',
            mark_score = 0,
            marked_at = clock_timestamp(),
            answered_at = now();
    end if;

    update public.quiz_sessions
       set last_activity_at = now()
     where id = v_session.id;

    if v_session.mode = 'assessment' then
      return jsonb_build_object('recorded', true);
    end if;
    return jsonb_build_object('is_correct', false, 'correct_index', null::int);
  end if;

  -- ── short_text (B5-1/C5-1): queue for AI marking ────────────────────
  -- The row lands PENDING: is_correct=false, mark_score NULL, so
  -- session_answers_pending_shape holds and the D10 SUM counts 0 until the
  -- finalizer writes a mark. The ledger row carries the attempt epoch in
  -- its idempotency key (S10/L8) so a retry within one epoch reuses it.
  if v_type = 'short_text' then
    if p_selected_index is not null or p_selected_indices is not null then
      return jsonb_build_object('error', 'invalid_selected_index');
    end if;

    v_trimmed := btrim(coalesce(p_answer_text, ''));

    if char_length(v_trimmed) < 1 or char_length(v_trimmed) > 500 then
      return jsonb_build_object('error', 'invalid_answer_text');
    end if;

    if v_session.mode = 'assessment' then
      insert into public.session_answers
        (session_id, question_id, selected_index, is_correct, answer_text,
         skipped, mark_status, mark_score)
      values
        (v_session.id, p_question_id, null, false, v_trimmed, false,
         'pending', null)
      on conflict (session_id, question_id) do nothing;

      get diagnostics v_rows = row_count;

      if v_rows = 0 then
        update public.quiz_sessions
           set last_activity_at = now()
         where id = v_session.id;
        return jsonb_build_object('error', 'already_answered');
      end if;

      insert into public.ai_marking_ledger
        (quiz_id, session_id, question_id, attempt_version, idempotency_key)
      values
        (v_session.quiz_id, v_session.id, p_question_id, 1,
         v_session.id::text || ':' || p_question_id::text || ':1')
      on conflict (idempotency_key) do nothing;
    else
      -- Practice has NO AI marking path (D12/R14 — no spend budget). The
      -- row is recorded for the student's own review but never scored.
      insert into public.session_answers
        (session_id, question_id, selected_index, is_correct, answer_text,
         skipped, mark_status, mark_score)
      values
        (v_session.id, p_question_id, null, false, v_trimmed, false,
         'needs_review', null)
      on conflict (session_id, question_id) do update
        set selected_index = null,
            selected_indices = null,
            answer_text = excluded.answer_text,
            skipped = false,
            is_correct = false,
            mark_status = 'needs_review',
            mark_score = null,
            marked_at = null,
            answered_at = now();
    end if;

    update public.quiz_sessions
       set last_activity_at = now()
     where id = v_session.id;

    if v_session.mode = 'assessment' then
      return jsonb_build_object('recorded', true);
    end if;
    return jsonb_build_object('is_correct', false, 'correct_index', null::int);
  end if;

  -- ── multi_select (carried verbatim from 0037) ───────────────────────
  if v_type = 'multi_select' then
    -- The scalar must be ABSENT and the set present, with 1..5 elements each
    -- in bounds (SQL NULL elements rejected explicitly — '{1,NULL,2}'::int[]
    -- slips a naive `e < 0` guard and would NULL out the int[] equality,
    -- violating is_correct's NOT NULL). The set is normalized
    -- (sorted+distinct) before grading AND storage so int[] equality against
    -- the trigger-canonical correct_indices is exact-set.
    if p_selected_index is not null
       or p_selected_indices is null
       or cardinality(p_selected_indices) < 1
       or cardinality(p_selected_indices) > 5
       or p_answer_text is not null
       or exists (
         select 1 from unnest(p_selected_indices) e
         where e is null or e < 0 or e >= cardinality(v_options)
       ) then
      return jsonb_build_object('error', 'invalid_selected_indices');
    end if;

    select array_agg(distinct e order by e) into v_answer_set
      from unnest(p_selected_indices) e;

    v_is_correct := (v_answer_set = v_correct_set);

    if v_session.mode = 'assessment' then
      insert into public.session_answers
        (session_id, question_id, selected_index, selected_indices, is_correct,
         skipped, mark_status)
      values
        (v_session.id, p_question_id, null, v_answer_set, v_is_correct,
         false, 'marked')
      on conflict (session_id, question_id) do nothing;

      get diagnostics v_rows = row_count;

      if v_rows = 0 then
        update public.quiz_sessions
           set last_activity_at = now()
         where id = v_session.id;
        return jsonb_build_object('error', 'already_answered');
      end if;
    else
      insert into public.session_answers
        (session_id, question_id, selected_index, selected_indices, is_correct,
         skipped, mark_status)
      values
        (v_session.id, p_question_id, null, v_answer_set, v_is_correct,
         false, 'marked')
      on conflict (session_id, question_id) do update
        set selected_index = excluded.selected_index,
            selected_indices = excluded.selected_indices,
            answer_text = null,
            skipped = false,
            is_correct = excluded.is_correct,
            mark_status = 'marked',
            mark_score = null,
            marked_at = null,
            answered_at = now();
    end if;

    update public.quiz_sessions
       set last_activity_at = now()
     where id = v_session.id;

    if v_session.mode = 'assessment' then
      return jsonb_build_object('recorded', true);
    end if;

    -- Practice payload: scalar key nulled, set key added (route
    -- mapAnswerPayload + client highlights depend on this exact key set).
    if v_explanation is null then
      return jsonb_build_object(
        'is_correct', v_is_correct,
        'correct_index', null::int,
        'correct_indices', v_correct_set
      );
    end if;
    return jsonb_build_object(
      'is_correct', v_is_correct,
      'correct_index', null::int,
      'correct_indices', v_correct_set,
      'explanation', v_explanation
    );
  end if;

  -- ── Non-multi: scalar path (byte-identical semantics to 0037) ───────
  if p_selected_indices is not null
     or p_answer_text is not null then
    return jsonb_build_object('error', 'invalid_selected_indices');
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
    insert into public.session_answers
      (session_id, question_id, selected_index, is_correct, skipped, mark_status)
    values (v_session.id, p_question_id, p_selected_index, v_is_correct,
            false, 'marked')
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
    -- A5-5: the rich columns are reset explicitly — a practice re-answer
    -- after a skip or a short_text would otherwise carry the stale shape and
    -- violate session_answers_skip_shape / pending_shape.
    insert into public.session_answers
      (session_id, question_id, selected_index, is_correct, skipped, mark_status)
    values (v_session.id, p_question_id, p_selected_index, v_is_correct,
            false, 'marked')
    on conflict (session_id, question_id) do update
      set selected_index = excluded.selected_index,
          selected_indices = null,
          answer_text = null,
          skipped = false,
          is_correct = excluded.is_correct,
          mark_status = 'marked',
          mark_score = null,
          marked_at = null,
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

revoke execute on function public.answer_question(uuid, uuid, int, int[], text, boolean) from public, anon;
grant execute on function public.answer_question(uuid, uuid, int, int[], text, boolean) to authenticated;

-- ─── 4. append_question: new-type authoring args ──────────────────────
-- FC-2: without this the CHECKs would make every short_text row
-- unreachable — the authoring path had no way to supply a key.
-- BASELINE: the LIVE 0045:1463 revision (ownership + draft gate + unified
-- quiz_write lock + 30-cap + MAX(order_index)+1 + correct_indices
-- normalization + NULLIF(explanation) + the exact legacy error strings,
-- all carried verbatim; only the new columns are appended). audit-4 B1:
-- the first cut dropped the normalization/order/error contracts, which
-- the routes still map — do not "simplify" them again.
create or replace function public.append_question(
  p_quiz_id uuid,
  p_type public.question_type,
  p_prompt text,
  p_options text[],
  p_correct_index int default null,
  p_explanation text default null,
  p_correct_indices int[] default null,
  p_answer_key text default null,
  p_max_score numeric default 1
)
returns public.questions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.questions;
  v_existing_count int;
  v_next int;
  v_max_quiz_cap int := 30;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Ownership keeps the LIVE error strings (audit-4 B1): the route maps
  -- 'not_owner'/'quiz_not_found'/'questions_locked_quiz_not_draft'/
  -- 'quiz_question_limit_exceeded'. Renaming them turned typed 404/409/422
  -- arms into generic 503s.
  if not exists (
    select 1
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    where q.id = p_quiz_id and c.lecturer_id = auth.uid()
  ) then
    raise exception 'not_owner' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.quizzes q where q.id = p_quiz_id) then
    raise exception 'quiz_not_found' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.quizzes q
    where q.id = p_quiz_id and q.status = 'draft'
  ) then
    raise exception 'questions_locked_quiz_not_draft' using errcode = 'P0001';
  end if;

  -- Unified authoring lock (0045 §2.2): one namespace for every writer.
  perform pg_advisory_xact_lock(hashtext('quiz_write:' || p_quiz_id::text));

  select count(*) into v_existing_count
    from public.questions q
   where q.quiz_id = p_quiz_id;

  if v_existing_count + 1 > v_max_quiz_cap then
    raise exception 'quiz_question_limit_exceeded' using errcode = 'P0001';
  end if;

  -- MAX(order_index)+1, NOT count(*): after any delete/reorder the count
  -- collides with a live index and corrupts ordering (audit-4 B1).
  select coalesce(max(order_index), -1) + 1 into v_next
    from public.questions
   where quiz_id = p_quiz_id;

  -- Normalization carried verbatim from 0045: the multi set is sorted +
  -- distinct (the trigger demands canonical form) and an empty explanation
  -- string becomes NULL (Zod allows "").
  insert into public.questions
    (quiz_id, order_index, type, prompt, options, correct_index,
     correct_indices, answer_key, max_score, explanation)
  values
    (p_quiz_id, v_next, p_type, p_prompt, p_options, p_correct_index,
     case when p_correct_indices is null then null
          else (select array_agg(distinct e order by e) from unnest(p_correct_indices) e) end,
     p_answer_key, coalesce(p_max_score, 1), nullif(p_explanation, ''))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.append_question(uuid, public.question_type, text, text[], int, text, int[], text, numeric) from public, anon;
grant execute on function public.append_question(uuid, public.question_type, text, text[], int, text, int[], text, numeric) to authenticated;

-- ─── 5. clone_quiz: copy every new question column ────────────────────
-- BASELINE: the LIVE 0046:444 revision. Only the questions INSERT widens —
-- the quiz-level copy gains gestures_enabled (E-57: a clone must carry the
-- flag, else a gestures-off quiz silently comes back gesture-enabled).
create or replace function public.clone_quiz(
  p_src_quiz_id   uuid,
  p_dest_class_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src         public.quizzes%rowtype;
  v_dest        public.classes%rowtype;
  v_new_quiz_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Source: class-ownership gate first (covers missing + foreign alike).
  if not public.is_lecturer_of_quiz(p_src_quiz_id) then
    raise exception 'not_quiz_owner' using errcode = 'P0001';
  end if;

  -- Destination: owned class, not archived (quiz-create precedent:
  -- classes/[id]/quizzes/route.ts refuses archived classes).
  if not public.is_lecturer_of_class(p_dest_class_id) then
    raise exception 'not_class_owner' using errcode = 'P0001';
  end if;

  select c.* into v_dest from public.classes c where c.id = p_dest_class_id;
  if v_dest.archived_at is not null then
    raise exception 'class_archived' using errcode = 'P0001';
  end if;

  -- Serialize against save/save_web/reorder/append on the source under the
  -- SAME unified 'quiz_write:' key (M-25: was quiz_replace:).
  perform pg_advisory_xact_lock(hashtext('quiz_write:' || p_src_quiz_id::text));

  select q.* into v_src from public.quizzes q where q.id = p_src_quiz_id;
  if not found then
    -- Unreachable for a verified owner; kept for drift safety.
    raise exception 'quiz_not_found' using errcode = 'P0001';
  end if;

  insert into public.quizzes (
    class_id,
    created_by,
    title,
    mode,
    status,
    time_limit_sec,
    source_text,
    allow_retake,
    max_attempts,
    shuffle_questions,
    auto_reveal_on_complete,
    gestures_enabled
  )
  values (
    p_dest_class_id,
    auth.uid(),
    left(trim(v_src.title), 200 - length(' (copy)')) || ' (copy)',
    v_src.mode,
    'draft',
    v_src.time_limit_sec,
    v_src.source_text,
    v_src.allow_retake,
    v_src.max_attempts,
    v_src.shuffle_questions,
    v_src.auto_reveal_on_complete,
    v_src.gestures_enabled
  )
  returning id into v_new_quiz_id;

  insert into public.questions (
    quiz_id,
    order_index,
    type,
    prompt,
    options,
    correct_index,
    correct_indices,
    answer_key,
    max_score,
    explanation,
    image_path
  )
  select
    v_new_quiz_id,
    q.order_index,
    q.type,
    q.prompt,
    q.options,
    q.correct_index,
    q.correct_indices,
    q.answer_key,
    q.max_score,
    q.explanation,
    q.image_path
  from public.questions q
  where q.quiz_id = p_src_quiz_id
  order by q.order_index;

  return v_new_quiz_id;
end;
$$;

revoke execute on function public.clone_quiz(uuid, uuid) from public, anon;
grant execute on function public.clone_quiz(uuid, uuid) to authenticated;

-- ─── 6. submit_session: D10 arithmetic + pending-aware completion ─────
-- BASELINE: the LIVE 0045:1263 revision. Changes (all D10/L4/L10/C5-7):
--   (a) v_score is NUMERIC (A7-3).
--   (b) the score write uses the D10 SUM with `mark_status <> 'pending'`.
--   (c) C5-7: the already_submitted branch now RECOMPUTES instead of
--       returning the stored score — a resubmit after an override must
--       reflect the adjudication. L10: the unrevealed→score:null arm is
--       kept VERBATIM, so the recompute can never leak a provisional score.
--   (d) L4: `v_all_done` additionally requires ZERO pending answers
--       quiz-wide — a quiz with unresolved AI marks is never auto-revealed.
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

-- ─── 7. student_results: rich rows + pending_count ────────────────────
-- BASELINE: the LIVE 0046:1133 revision. Changes (S5/L6/L3):
--   (a) v_score NUMERIC (A7-3).
--   (b) BOTH mode branches use the D10 SUM — including the practice branch,
--       so a legacy 0.5 override survives a practice re-read (L3).
--   (c) per-row keys: mark_status/mark_score/skipped/answer_text/
--       attempt_version, each reveal-gated exactly as the existing
--       is_correct/correct_index keys are.
--   (d) quiz-level pending_count (FS-4 — the EndScreen's pending banner).
create or replace function public.student_results(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_score   numeric;
  v_total   int;
  v_pending int;
  v_questions jsonb;
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

  -- Single no-oracle gate: not enrolled / quiz gone / not revealed → same error.
  if not public.is_student_reveal_allowed(p_quiz_id) then
    return jsonb_build_object('error', 'not_revealed');
  end if;

  -- L-07 (audit-2): `, id desc` tiebreak — equal started_at attempts must
  -- not flip which attempt surfaces across reads (export/gradebook feeds
  -- already order started_at DESC, id DESC).
  select s.* into v_session
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid() and s.status = 'completed'
   order by s.started_at desc, s.id desc
   limit 1;

  if not found then
    return jsonb_build_object('error', 'not_revealed');
  end if;

  select count(*) into v_total
    from public.questions q
   where q.quiz_id = p_quiz_id;

  -- D10 in BOTH branches (L3): the practice branch already recomputed so a
  -- legacy 0.5 override survived; audit-4 D3 makes the ASSESSMENT branch use
  -- the SAME live SUM rather than the stored `session.score`.
  --
  -- Why that is safe and strictly better: every post-migration writer of
  -- `session.score` (submit ×2, seal, escalate, finalize, override) already
  -- writes this exact SUM, and pre-migration rows have no mark_score at all
  -- (so `count(is_correct)` ≡ SUM). Reading live therefore cannot disagree with
  -- the sealed artifact for any row that exists today — it just cannot go
  -- stale. The SUM still ignores `pending` rows, so a mid-marking assessment
  -- cannot leak a provisional number here, and the reveal gate above has
  -- already run.
  select coalesce(sum(coalesce(sa.mark_score,
               case when sa.is_correct then 1 else 0 end)), 0)
    into v_score
    from public.session_answers sa
   where sa.session_id = v_session.id
     and sa.mark_status <> 'pending';

  select count(*) into v_pending
    from public.session_answers sa
   where sa.session_id = v_session.id
     and sa.mark_status = 'pending';

  select coalesce(jsonb_agg(js order by (js->>'order_index')::int), '[]'::jsonb) into v_questions
  from (
    select jsonb_build_object(
      'question_id', q.id,
      'order_index', q.order_index,
      'type', q.type,
      'prompt', q.prompt,
      'options', q.options,
      'selected_index', sa.selected_index,
      'selected_indices', sa.selected_indices,
      'is_correct', sa.is_correct,
      'correct_index', q.correct_index,
      'correct_indices', q.correct_indices,
      'explanation', q.explanation,
      'has_image', (q.image_path is not null),
      -- Rich-type / marking state (S5). Reached only past the reveal gate
      -- above, so these are safe to expose here.
      'answer_text', sa.answer_text,
      'skipped', coalesce(sa.skipped, false),
      'mark_status', coalesce(sa.mark_status, 'marked'),
      'mark_score', sa.mark_score,
      'answer_key', q.answer_key,
      'attempt_version', sa.attempt_version
    ) as js
    from public.questions q
    left join public.session_answers sa
      on sa.question_id = q.id and sa.session_id = v_session.id
    where q.quiz_id = p_quiz_id
  ) t;

  return jsonb_build_object(
    'score', v_score,
    'total', v_total,
    'pending_count', v_pending,
    'questions', v_questions
  );
end;
$$;

revoke execute on function public.student_results(uuid) from public, anon;
grant execute on function public.student_results(uuid) to authenticated;

-- ─── 8. assign_seal_score: D10 body + NUMERIC v_score ─────────────────
-- X2-4/D2-2. The TRIGGER is re-created in 0056 (it was dropped in 0053 so
-- the column could widen). No REVOKE/GRANT: this function is only ever
-- reached through its trigger (0047:481-486 precedent — a trigger-return
-- function is not directly invocable, and granting it would add no surface).
create or replace function public.assign_seal_score()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_score numeric;
begin
  select coalesce(sum(coalesce(sa.mark_score,
               case when sa.is_correct then 1 else 0 end)), 0)
    into v_score
    from public.session_answers sa
   where sa.session_id = new.id
     and sa.mark_status <> 'pending';

  new.score := v_score;

  perform set_config('app.session_sealing', 'on', true);

  return new;
end;
$$;

-- audit-4 D11 / plan D5: EVERY recreation file must republish so self-hosted
-- PostgREST (the VPS path) picks up the new arities. Hosted projects
-- auto-invalidate, but a stale schema cache there is a silent 404 on exactly
-- the new signatures this file exists to install. Exactly one NOTIFY per file,
-- at the end (house precedent: 0054).
notify pgrst, 'reload schema';

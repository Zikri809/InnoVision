-- ═══════════════════════════════════════════════════════════════════════
-- 0037 — Multi-select questions (QT-1, PLAN_R_QUESTION_TYPES)
--
-- Schema: questions.correct_indices int[] + correct_index becomes NULLABLE
-- (multi rows store the honest NULL — the compiler-forced branch beats a
-- sentinel); session_answers.selected_indices int[] companion column
-- (single-select fast path stays byte-identical; multi rows store the
-- canonical sorted set with selected_index NULL).
--
-- Secrecy model UNCHANGED: there has never been a column-level revoke on
-- questions.correct_index — student secrecy is RLS row-omission
-- (0004:129-136) plus the barrier question views, which select explicit
-- columns and therefore omit both new columns by construction. The 0012
-- column-revokes (session_answers.is_correct / quiz_sessions.score) are
-- untouched; selected_indices is the student's OWN answer, not a key, and
-- is exposed through the same owner-privilege views as selected_index.
--
-- Overload mechanics (0025:2-15 precedent): answer_question and
-- append_question change arity, which CREATE OR REPLACE cannot do in place
-- — the old signatures are DROPPED and the house revoke/grant pattern is
-- re-applied to the new signatures (a fresh function defaults to EXECUTE
-- to PUBLIC).
--
-- Student domain: student_quiz_questions gets a CHECK rejecting
-- multi_select — v1 is lecturer quizzes only (QT-1 plan scope line); the
-- DB enforces it, not convention.
--
-- Gesture interaction (user-specified amendment): multi questions are
-- answered by holding N fingers to TOGGLE option N and an open palm to
-- COMMIT — hence the 4-option cap (questions_multi_option_cap): five
-- fingers must never be an option pose.
--
-- Depends on: 0004 (questions/triggers), 0008 (session_answers),
-- 0012 (views/student_results lineage), 0023 (student_quiz_questions),
-- 0025 (save_quiz_questions), 0028 (student_results), 0030 (answer_question),
-- 0035 (clone_quiz), 0036 (enum value).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Question answer-key columns ───────────────────────────────────
alter table public.questions
  add column if not exists correct_indices int[];

alter table public.questions
  alter column correct_index drop not null;

-- Exactly one answer-key shape per row. The 0004:58 bounds CHECK keeps
-- applying to the scalar on non-multi rows (NULL passes CHECKs; the
-- correct_index IS NOT NULL arm below pins the non-multi shape).
alter table public.questions
  add constraint questions_correct_shape
  check (
    (type = 'multi_select' and correct_index is null and correct_indices is not null)
    or (type <> 'multi_select' and correct_index is not null and correct_indices is null)
  );

-- Gesture amendment (QT-1): multi-select questions cap at FOUR options —
-- 5 fingers is reserved for palm-commit, so a fifth option pose cannot
-- exist. Options stay 2..N per the base CHECK; this narrows multi rows.
alter table public.questions
  add constraint questions_multi_option_cap
  check (type <> 'multi_select' or cardinality(options) between 2 and 4);

-- ─── 2. correct_indices guard trigger ─────────────────────────────────
-- Row CHECKs cannot express per-element bounds against another column, so
-- the deep checks follow the questions_options_distinct trigger pattern
-- (0004:295-327). Event list covers type/options/correct_index/
-- correct_indices: an options-shrink UPDATE must re-validate even when the
-- array itself is untouched, and a type flip changes which shape is legal.
create or replace function public.questions_correct_indices_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.type = 'multi_select' then
    if NEW.correct_index is not null then
      raise exception 'invalid_correct_indices'
        using errcode = 'P0001';
    end if;
    if NEW.correct_indices is null
       or cardinality(NEW.correct_indices) < 1
       or cardinality(NEW.correct_indices) > cardinality(NEW.options) then
      raise exception 'invalid_correct_indices'
        using errcode = 'P0001';
    end if;
    -- Per-element bounds INCLUDING NULL elements (a naive `e < 0` loop
    -- passes SQL NULLs — the 0008:389 trap, array edition).
    if exists (
      select 1 from unnest(NEW.correct_indices) e
      where e is null or e < 0 or e >= cardinality(NEW.options)
    ) then
      raise exception 'invalid_correct_indices'
        using errcode = 'P0001';
    end if;
    -- Distinct + sorted ascending (canonical form; the grading RPC relies
    -- on int[] equality against a normalized submission).
    if (select count(distinct e) from unnest(NEW.correct_indices) e)
       <> cardinality(NEW.correct_indices) then
      raise exception 'invalid_correct_indices'
        using errcode = 'P0001';
    end if;
    if NEW.correct_indices is distinct from
       (select array_agg(e order by e) from unnest(NEW.correct_indices) e) then
      raise exception 'invalid_correct_indices'
        using errcode = 'P0001';
    end if;
  else
    if NEW.correct_indices is not null then
      raise exception 'invalid_correct_indices'
        using errcode = 'P0001';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists questions_correct_indices_guard on public.questions;
create trigger questions_correct_indices_guard
  before insert or update of type, options, correct_index, correct_indices
  on public.questions
  for each row execute function public.questions_correct_indices_guard();

-- ─── 3. session_answers.selected_indices companion column ─────────────
-- The student's own selections (NOT a secret — is_correct remains the
-- column-revoked field). Upper bound lives in the RPC like selected_index's
-- (0008:66 is lower-bound-only by precedent).
alter table public.session_answers
  add column if not exists selected_indices int[];

alter table public.session_answers
  add constraint session_answers_selected_indices_cardinality
  check (selected_indices is null or cardinality(selected_indices) between 1 and 5);

-- ─── 4. Student-domain scope guard ────────────────────────────────────
-- v1: multi-select is lecturer-quiz only. The student authoring RPCs cast
-- to the shared enum, so without this row CHECK a direct RPC call could
-- create a multi row the student player cannot answer.
alter table public.student_quiz_questions
  add constraint student_quiz_questions_no_multi_select
  check (type <> 'multi_select');

-- ─── 5. Owner-privilege answer views: selected_indices appended LAST ──
-- (create or replace view can only append columns — QT-3 rule.)
create or replace view public.student_answers_view
with (security_barrier = true)
as
select sa.id, sa.session_id, sa.question_id, sa.selected_index, sa.answered_at,
       case when public.is_student_reveal_allowed(qs.quiz_id)
            then sa.is_correct else null end as is_correct,
       sa.selected_indices
from public.session_answers sa
join public.quiz_sessions qs on qs.id = sa.session_id
where qs.student_id = auth.uid();

grant select on public.student_answers_view to authenticated;

create or replace view public.lecturer_answers_view
with (security_barrier = true)
as
select sa.id, sa.session_id, sa.question_id, sa.selected_index, sa.is_correct,
       sa.answered_at,
       sa.selected_indices
from public.session_answers sa
join public.quiz_sessions qs on qs.id = sa.session_id
where public.is_lecturer_of_quiz(qs.quiz_id);

grant select on public.lecturer_answers_view to authenticated;

-- ─── 6. answer_question: multi-select grading branch ──────────────────
-- Carries the full 0030 body forward (windows + time-limit gates verbatim)
-- with the multi branch added and both INSERT statements widened.
create or replace function public.answer_question(
  p_session_id       uuid,
  p_question_id      uuid,
  p_selected_index   int default null,
  p_selected_indices int[] default null
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

  if v_type = 'multi_select' then
    -- Multi-select: the scalar must be ABSENT and the set present, with
    -- 1..5 elements each in bounds (SQL NULL elements rejected explicitly —
    -- '{1,NULL,2}'::int[] slips a naive `e < 0` guard and would NULL out
    -- the int[] equality, violating is_correct's NOT NULL). The set is
    -- normalized (sorted+distinct) before grading AND storage so int[]
    -- equality against the trigger-canonical correct_indices is exact-set.
    if p_selected_index is not null
       or p_selected_indices is null
       or cardinality(p_selected_indices) < 1
       or cardinality(p_selected_indices) > 5
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
        (session_id, question_id, selected_index, selected_indices, is_correct)
      values
        (v_session.id, p_question_id, null, v_answer_set, v_is_correct)
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
        (session_id, question_id, selected_index, selected_indices, is_correct)
      values
        (v_session.id, p_question_id, null, v_answer_set, v_is_correct)
      on conflict (session_id, question_id) do update
        set selected_index = excluded.selected_index,
            selected_indices = excluded.selected_indices,
            is_correct = excluded.is_correct,
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

  -- ── Non-multi: scalar path, byte-identical semantics to 0030 ──
  if p_selected_indices is not null then
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
          selected_indices = excluded.selected_indices,
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

-- Overload cleanup: the old 3-arg signature must DIE (a create-or-replace
-- with a changed arg list only ADDS an overload) and the grants re-applied
-- to the new signature (fresh functions default to EXECUTE to PUBLIC).
drop function if exists public.answer_question(uuid, uuid, int);
revoke execute on function public.answer_question(uuid, uuid, int, int[]) from public, anon;
grant execute on function public.answer_question(uuid, uuid, int, int[]) to authenticated;

-- ─── 7. append_question: correct_indices param ────────────────────────
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

  -- Serialize appends per quiz; two concurrent adds cannot both read the same
  -- MAX(order_index).
  perform pg_advisory_xact_lock(hashtext('quiz_append:' || p_quiz_id::text));

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

drop function if exists public.append_question(uuid, public.question_type, text, text[], int, text);
revoke execute on function public.append_question(uuid, public.question_type, text, text[], int, text, int[]) from public, anon;
grant execute on function public.append_question(uuid, public.question_type, text, text[], int, text, int[]) to authenticated;

-- ─── 8. save_quiz_questions: correct_indices mirror ───────────────────
-- Same signature (create-or-replace safe). The per-question validation
-- gains the multi mirror: bounds vs options + absent-scalar are checked
-- HERE so the AI/import pipelines get the same clean error string the
-- routes map, with the table trigger as backstop.
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

  if p_title is not null and (char_length(trim(p_title)) < 1 or char_length(p_title) > 200) then
    raise exception 'invalid_title' using errcode = 'P0001';
  end if;

  -- Serialize concurrent generates per quiz (restored from 0007; see 0025 R2).
  perform pg_advisory_xact_lock(hashtext('quiz_replace:' || p_quiz_id::text));

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

-- ─── 9. student_results: breakdown rows gain the set keys ─────────────
-- 0028 body verbatim + 'correct_indices'/'selected_indices' per row. The
-- whole payload is already reveal-gated (is_student_reveal_allowed), so no
-- per-field gating is added.
create or replace function public.student_results(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_score   int;
  v_total   int;
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

  select s.* into v_session
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid() and s.status = 'completed'
   order by s.started_at desc
   limit 1;

  if not found then
    return jsonb_build_object('error', 'not_revealed');
  end if;

  select count(*) into v_total
    from public.questions q
   where q.quiz_id = p_quiz_id;

  if v_session.mode = 'assessment' then
    v_score := coalesce(v_session.score, 0);
  else
    select count(*) into v_score
      from public.session_answers sa
     where sa.session_id = v_session.id and sa.is_correct;
  end if;

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
      'has_image', (q.image_path is not null)
    ) as js
    from public.questions q
    left join public.session_answers sa
      on sa.question_id = q.id and sa.session_id = v_session.id
    where q.quiz_id = p_quiz_id
  ) t;

  return jsonb_build_object(
    'score', v_score,
    'total', v_total,
    'questions', v_questions
  );
end;
$$;

revoke execute on function public.student_results(uuid) from public, anon;
grant execute on function public.student_results(uuid) to authenticated;

-- ─── 10. clone_quiz: copy the answer key set verbatim ─────────────────
-- 0035 body verbatim + correct_indices in the question INSERT...SELECT —
-- without it, clones silently lose the multi answer key (verify:clone D9).
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

  -- Serialize against save_quiz_questions on the source, then read the
  -- source snapshot under the lock.
  perform pg_advisory_xact_lock(hashtext('quiz_replace:' || p_src_quiz_id::text));

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
    auto_reveal_on_complete
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
    v_src.auto_reveal_on_complete
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
    q.explanation,
    q.image_path
  from public.questions q
  where q.quiz_id = p_src_quiz_id
  order by q.order_index;

  return v_new_quiz_id;
end;
$$;

-- House-pattern grants (0025:190-191 posture).
revoke execute on function public.clone_quiz(uuid, uuid) from public, anon;
grant execute on function public.clone_quiz(uuid, uuid) to authenticated;

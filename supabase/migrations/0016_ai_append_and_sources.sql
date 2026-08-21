-- InnoVision — Phase 9: AI Append Mode & Multi-Source Tracking
-- Depends on: 0004_quizzes.sql, 0007_ai_generation.sql, 0013_drop_source_text_limit.sql
--
-- Adds:
--  1. quizzes.sources (jsonb not null default '[]'::jsonb) for multi-file provenance.
--  2. Updates quiz_status_transition trigger to freeze quizzes.sources once a quiz leaves draft.
--  3. save_quiz_questions() unified RPC supporting both 'replace' and 'append' modes.
--  4. Updates replace_quiz_questions() as a backward-compatible wrapper.

-- ─── 1. Add sources column (jsonb default '[]') ──────────────────
alter table public.quizzes
  add column if not exists sources jsonb not null default '[]'::jsonb;

-- ─── 2. Update quiz_status_transition to freeze sources ──────────
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

  -- Metadata edit-lock: title/mode/time_limit/sources fields are frozen once a quiz leaves draft.
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

-- ─── 3. Unified save_quiz_questions RPC (Replace + Append) ───────
create or replace function public.save_quiz_questions(
  p_quiz_id         uuid,
  p_title           text,
  p_source_file_url text,
  p_source_text     text,
  p_questions       jsonb,
  p_mode            text default 'replace'
)
returns setof public.questions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status          public.quiz_status;
  v_i               int;
  v_count           int;
  v_existing_count  int;
  v_start_index     int;
  v_max_quiz_cap    constant int := 30; -- Strict quiz total question ceiling
  v_q               jsonb;
  v_type            text;
  v_prompt          text;
  v_options         text[];
  v_correct         int;
  v_expl            text;
  v_row             public.questions;
  v_source_entry    jsonb;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated'
      using errcode = 'P0001';
  end if;

  -- Verify class ownership (no oracle)
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

  if p_mode not in ('replace', 'append') then
    raise exception 'invalid_generation_mode'
      using errcode = 'P0001';
  end if;

  -- Unified advisory lock for all question mutations on this quiz
  perform pg_advisory_xact_lock(hashtext('quiz_questions:' || p_quiz_id::text));

  -- Validate the questions payload:
  -- Replace mode requires 3..30 questions (AI quiz minimum).
  -- Append mode allows 1..30 questions.
  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    raise exception 'invalid_questions_json'
      using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_questions);
  if (p_mode = 'replace' and v_count < 3) or (p_mode = 'append' and v_count < 1) or v_count > 30 then
    raise exception 'invalid_questions_json'
      using errcode = 'P0001';
  end if;

  -- Title: if provided, must be a sane non-empty trimmed string
  if p_title is not null and (char_length(trim(p_title)) < 1 or char_length(p_title) > 200) then
    raise exception 'invalid_title'
      using errcode = 'P0001';
  end if;

  -- Mode-specific setup
  if p_mode = 'replace' then
    delete from public.questions where quiz_id = p_quiz_id;
    v_start_index := 0;
  else -- 'append'
    select count(*), coalesce(max(order_index), -1) + 1
      into v_existing_count, v_start_index
      from public.questions
     where quiz_id = p_quiz_id;

    if (v_existing_count + v_count) > v_max_quiz_cap then
      raise exception 'quiz_question_limit_exceeded'
        using errcode = 'P0001';
    end if;
  end if;

  -- Insert questions in contiguous sequence
  for v_i in 0 .. v_count - 1 loop
    v_q := p_questions -> v_i;
    if jsonb_typeof(v_q) <> 'object' then
      raise exception 'invalid_questions_json'
        using errcode = 'P0001';
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
       or (v_q -> 'options') is null or jsonb_typeof(v_q -> 'options') <> 'array'
       or v_correct is null or v_correct < 0 then
      raise exception 'invalid_questions_json'
        using errcode = 'P0001';
    end if;

    insert into public.questions
      (quiz_id, order_index, type, prompt, options, correct_index, explanation)
    values
      (p_quiz_id, v_start_index + v_i, v_type::public.question_type, v_prompt, v_options, v_correct, nullif(v_expl, ''))
    returning * into v_row;

    return next v_row;
  end loop;

  -- Prepare audit entry for sources
  if p_source_file_url is not null or p_source_text is not null then
    v_source_entry := jsonb_build_object(
      'file_url', p_source_file_url,
      'added_at', now(),
      'question_count', v_count,
      'mode', p_mode
    );
  else
    v_source_entry := null;
  end if;

  -- Update quiz metadata & sources
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
  else -- 'append'
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

-- ─── 4. Backward-compatible replace_quiz_questions wrapper ───────
create or replace function public.replace_quiz_questions(
  p_quiz_id         uuid,
  p_title           text,
  p_source_file_url text,
  p_source_text     text,
  p_questions       jsonb
)
returns setof public.questions
language sql
security definer
set search_path = public
as $$
  select * from public.save_quiz_questions(p_quiz_id, p_title, p_source_file_url, p_source_text, p_questions, 'replace');
$$;

revoke execute on function public.replace_quiz_questions(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.replace_quiz_questions(uuid, text, text, text, jsonb) to authenticated;

-- ─── 5. Update append_question to share unified advisory lock ─────
create or replace function public.append_question(
  p_quiz_id uuid,
  p_type public.question_type,
  p_prompt text,
  p_options text[],
  p_correct_index int,
  p_explanation text
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

  -- Unified advisory lock for all question mutations on this quiz
  perform pg_advisory_xact_lock(hashtext('quiz_questions:' || p_quiz_id::text));

  select coalesce(max(order_index), -1) + 1 into v_next
    from public.questions
   where quiz_id = p_quiz_id;

  insert into public.questions (quiz_id, order_index, type, prompt, options, correct_index, explanation)
  values (p_quiz_id, v_next, p_type, p_prompt, p_options, p_correct_index, nullif(p_explanation, ''))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.append_question(uuid, public.question_type, text, text[], int, text) from public, anon;
grant execute on function public.append_question(uuid, public.question_type, text, text[], int, text) to authenticated;

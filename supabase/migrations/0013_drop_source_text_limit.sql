-- InnoVision — remove the 15k source_text cap.
--
-- The app runs on the lecturer's own machine (no Vercel 60s serverless
-- budget), so there is no reason to truncate extracted chapter text at 15k
-- characters. This removes BOTH enforcement layers:
--   1. The `quizzes.source_text` inline column CHECK (≤ 15000) — the DB
--      backstop that would reject any stored source text longer than 15k.
--   2. The `source_text_too_long` guard inside replace_quiz_questions().

-- ─── 1. Drop the source_text CHECK constraint ────────────────────
-- The column is defined inline (`add column ... check (...)`), so the
-- constraint was auto-named `quizzes_source_text_check`. Drop it defensively
-- by name; if a future migration renames/replaces it, this fails loudly
-- rather than silently keeping an old cap.
alter table public.quizzes
  drop constraint if exists quizzes_source_text_check;

-- ─── 2. replace_quiz_questions without the source_text length guard ──
-- Same function as 0007 but WITHOUT the `source_text_too_long` raise.
create or replace function public.replace_quiz_questions(
  p_quiz_id      uuid,
  p_title        text,
  p_source_file_url text,
  p_source_text  text,
  p_questions    jsonb
)
returns setof public.questions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status    public.quiz_status;
  v_i         int;
  v_count     int;
  v_q         jsonb;
  v_type      text;
  v_prompt    text;
  v_options   text[];
  v_correct   int;
  v_expl      text;
  v_row       public.questions;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated'
      using errcode = 'P0001';
  end if;

  -- Same ownership pattern as reorder_questions/append_question: a non-existent
  -- quiz and a non-owned quiz both fail here → single 'not_owner' (no oracle).
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

  -- Serialize concurrent generates per quiz.
  perform pg_advisory_xact_lock(hashtext('quiz_replace:' || p_quiz_id::text));

  -- Validate the questions payload (bounds mirror the AI contract: 3..30).
  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    raise exception 'invalid_questions_json'
      using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_questions);
  if v_count < 3 or v_count > 30 then
    raise exception 'invalid_questions_json'
      using errcode = 'P0001';
  end if;

  -- Title: if provided, must be a sane non-empty trimmed string.
  if p_title is not null and (char_length(trim(p_title)) < 1 or char_length(p_title) > 200) then
    raise exception 'invalid_title'
      using errcode = 'P0001';
  end if;

  -- Delete existing questions, then insert the new set in order.
  delete from public.questions where quiz_id = p_quiz_id;

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

    -- Basic per-element validation (triggers do the deep checks; these give
    -- clean typed errors before the trigger's generic constraint violations).
    if v_type is null or v_prompt is null
       or (v_q -> 'options') is null or jsonb_typeof(v_q -> 'options') <> 'array'
       or v_correct is null or v_correct < 0 then
      raise exception 'invalid_questions_json'
        using errcode = 'P0001';
    end if;

    insert into public.questions
      (quiz_id, order_index, type, prompt, options, correct_index, explanation)
    values
      (p_quiz_id, v_i, v_type::public.question_type, v_prompt, v_options, v_correct, nullif(v_expl, ''))
    returning * into v_row;

    return next v_row;
  end loop;

  -- Metadata write — only after the draft re-check above (in the same
  -- transaction, so a non-draft quiz can never reach this UPDATE). The
  -- extended edit-lock trigger is the backstop for direct SQL.
  update public.quizzes
     set title = coalesce(p_title, title),
         source_file_url = coalesce(p_source_file_url, source_file_url),
         source_text = coalesce(p_source_text, source_text)
   where id = p_quiz_id;
end;
$$;

revoke execute on function public.replace_quiz_questions(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.replace_quiz_questions(uuid, text, text, text, jsonb) to authenticated;

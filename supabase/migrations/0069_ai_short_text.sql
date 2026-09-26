-- ═══════════════════════════════════════════════════════════════════════
-- 0069 — AI-generated short_text: save_quiz_questions_web accepts the
-- gesture-off typed-answer shape.
--
-- Context: AI generation auto-enables multi_select + short_text for
-- gesture-off quizzes (allowMultiSelect/allowShortText). Multi rows already
-- flow through this function (the M-24 branch, ported from 0037); short_text
-- rows did not — a null correct_index fell into the scalar `else` and raised
-- invalid_question_fields AFTER the LLM spend. This revision adds the third
-- arm: an option-less row graded against the answer_key rubric.
--
-- Shape contract (mirrors questions_answer_key_shape +
-- questions_short_text_shape + questions_correct_shape, 0052 — the table
-- CHECKs stay the backstop; violations here raise invalid_question_fields,
-- which the generate route maps to a typed 422):
--   short_text → options present-but-empty, correct_index null, NO
--   correct_indices array, answer_key a JSON string trimmed 1..500.
-- Non-short rows must NOT carry answer_key (a rubric on a choice row is a
-- caller bug, not data; an explicit JSON null reads as absent).
--
-- Deliberate tightenings vs the 0046 baseline (non-short paths are otherwise
-- verbatim): a stray answer_key on choice rows is REJECTED (was silently
-- dropped), and a non-numeric correct_index raises invalid_question_fields
-- instead of an unmapped 22P02 at the cast.
--
-- Signature UNCHANGED (same 8 args) — no PostgREST overload churn, existing
-- grants persist (re-stated below, 0046 posture). The insert only widens by
-- the answer_key column.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.save_quiz_questions_web(
  p_quiz_id         uuid,
  p_title           text,
  p_source_file_url text,
  p_source_text     text,
  p_questions       jsonb,
  p_mode            text default 'replace',
  p_web_sources     jsonb default null,
  p_source_paths    jsonb default null
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
  v_key            text;
  v_answer_key     text;
  v_expl           text;
  v_source_entry   jsonb;
  v_existing_count int;
  v_start_index    int;
  v_max_quiz_cap   int := 30;
  v_web_entries    jsonb := '[]'::jsonb;
  v_w              jsonb;
  v_web_url        text;
  v_file_entries   jsonb := '[]'::jsonb;
  v_path           text;
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

  -- ─── Web-source validation (in-body; skip-invalid, never fatal) ────────
  if p_web_sources is not null then
    if jsonb_typeof(p_web_sources) <> 'array' then
      raise exception 'invalid_web_sources_json' using errcode = 'P0001';
    end if;
    for v_w in select * from jsonb_array_elements(p_web_sources) loop
      if jsonb_typeof(v_w) <> 'object' then
        continue;
      end if;
      v_web_url := coalesce(v_w ->> 'url', '');
      if v_web_url !~* '^https?://[^[:space:]]+$' or char_length(v_web_url) > 2048 then
        continue;
      end if;
      v_web_entries := v_web_entries || jsonb_build_object(
        'id', gen_random_uuid(),
        'kind', 'web',
        'url', v_web_url,
        'title', coalesce(left(v_w ->> 'title', 200), ''),
        'retrieved_at', coalesce(v_w ->> 'retrieved_at', clock_timestamp()::text),
        'query', coalesce(left(v_w ->> 'query', 200), '')
      );
    end loop;
  end if;

  -- ─── Source-path-list validation (0041; route pre-validates tenants) ───
  if p_source_paths is not null then
    if jsonb_typeof(p_source_paths) <> 'array' then
      raise exception 'invalid_source_paths_json' using errcode = 'P0001';
    end if;
    for v_w in select * from jsonb_array_elements(p_source_paths) loop
      if jsonb_typeof(v_w) <> 'string' then
        continue;
      end if;
      v_path := v_w #>> '{}';
      if v_path is null or char_length(trim(v_path)) = 0 then
        continue;
      end if;
      v_file_entries := v_file_entries || jsonb_build_object(
        'id', gen_random_uuid(),
        'filename', substring(v_path from '[^/]+$'),
        'storage_path', v_path,
        'added_at', clock_timestamp()
      );
    end loop;
  end if;

  -- Fallback: no explicit path list but a primary URL — the 0040 single-
  -- entry shape (import flows / any caller that only sends the URL).
  if v_file_entries = '[]'::jsonb and p_source_file_url is not null
     and p_source_file_url <> '' then
    v_file_entries := jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(),
      'filename', substring(p_source_file_url from '[^/]+$'),
      'storage_path', p_source_file_url,
      'added_at', clock_timestamp(),
      'mode', p_mode
    ));
  end if;

  -- M-25 (audit-2): unified 'quiz_write:' namespace — this fn was the last
  -- 'quiz_replace:' holdout besides clone_quiz, so an AI generate could
  -- interleave with a manual add/reorder on the same quiz.
  perform pg_advisory_xact_lock(hashtext('quiz_write:' || p_quiz_id::text));

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
    -- Numeric pre-check: a non-numeric correct_index would raise an unmapped
    -- 22P02 at the cast below for direct-RPC callers (the model path is
    -- Zod-gated first). SIGNED pattern: negatives must reach the scalar <0
    -- arm, not die at the cast. An explicit JSON null reads as absent.
    if (v_q ->> 'correct_index') is not null
       and (v_q ->> 'correct_index') !~ '^-?[0-9]+$' then
      raise exception 'invalid_question_fields' using errcode = 'P0001';
    end if;
    v_correct := (v_q ->> 'correct_index')::int;
    v_expl    := v_q ->> 'explanation';

    if v_type is null or v_prompt is null
       or (v_q -> 'options') is null or jsonb_typeof(v_q -> 'options') <> 'array' then
      raise exception 'invalid_question_fields' using errcode = 'P0001';
    end if;

    -- Gesture-off short_text (AI generation): the option-less row graded
    -- against the answer_key rubric. A rubric on any OTHER type is a caller
    -- bug — rejected here so a stray key can never silently attach to a
    -- choice row.
    if v_type = 'short_text' then
      -- The rubric must be a real JSON string (`->>` coerces numbers/bools
      -- to text, so check the TYPE, not the coerced value).
      if jsonb_typeof(v_q -> 'answer_key') <> 'string' then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_key := nullif(trim(v_q ->> 'answer_key'), '');
      if jsonb_array_length(v_q -> 'options') <> 0
         or v_correct is not null
         or jsonb_typeof(v_q -> 'correct_indices') = 'array'
         or v_key is null or char_length(v_key) > 500 then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_correct := null;
      v_correct_set := null;
      v_answer_key := v_key;
    -- M-24 (audit-2): the multi_select branch, ported verbatim from the
    -- 0037 6-arg fn (the 0041 rewrite dropped it — every allowMultiSelect
    -- generation emitting a multi row failed here AFTER the LLM spend).
    elsif v_type = 'multi_select' then
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
      -- A stray rubric on a multi row is a caller bug (same posture as the
      -- scalar arm below); drop-nothing, reject. An explicit JSON null
      -- reads as absent (the route's JSON.stringify drops undefined keys,
      -- so only a deliberately-sent null arrives this way).
      if v_q ? 'answer_key' and jsonb_typeof(v_q -> 'answer_key') <> 'null' then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_answer_key := null;
    else
      -- jsonb null ≠ SQL null: `jsonb_typeof(...)` on a jsonb null is 'null',
      -- so only a REAL array means "set present" on a scalar row — and only
      -- a REAL (non-null) answer_key means "rubric present".
      if v_correct is null or v_correct < 0
         or jsonb_typeof(v_q -> 'correct_indices') = 'array'
         or (v_q ? 'answer_key' and jsonb_typeof(v_q -> 'answer_key') <> 'null') then
        raise exception 'invalid_question_fields' using errcode = 'P0001';
      end if;
      v_correct_set := null;
      v_answer_key := null;
    end if;

    insert into public.questions (
      quiz_id,
      order_index,
      type,
      prompt,
      options,
      correct_index,
      correct_indices,
      answer_key,
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
      v_answer_key,
      case when v_expl is null or length(trim(v_expl)) = 0 then null else trim(v_expl) end
    );
  end loop;

  -- ─── Additive sources assembly (0041) ──────────────────────────────────
  -- File entries and web entries COMBINE (the 0040 CASE was either/or and
  -- silently dropped web citations whenever a file entry existed).
  if p_mode = 'replace' then
    update public.quizzes
       set title = coalesce(p_title, title),
           source_file_url = p_source_file_url,
           source_text = p_source_text,
           sources = v_file_entries || v_web_entries
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
           sources = coalesce(sources, '[]'::jsonb) || v_file_entries || v_web_entries
     where id = p_quiz_id;
   end if;
end;
$$;

revoke execute on function public.save_quiz_questions_web(uuid, text, text, text, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public.save_quiz_questions_web(uuid, text, text, text, jsonb, text, jsonb, jsonb) to authenticated;

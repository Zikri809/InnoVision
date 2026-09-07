-- ═══════════════════════════════════════════════════════════════════════
-- 0040 — Grounded web-search source provenance (grounded-search.md §5)
--
-- Adds save_quiz_questions_web (a sibling of the 0025 6-arg function) taking
-- p_web_sources jsonb so topic-mode generations persist {kind:"web"} citation
-- entries in quizzes.sources. Legacy {storage_path,...} file entries keep
-- their exact shape (0016/0025) — live quizzes are permanently mixed-shape
-- (the 0016 freeze trigger makes old rows immutable), so both shapes must be
-- tolerated forever.
--
-- WHY A SIBLING FUNCTION, not a 7-arg overload: PostgREST cannot resolve
-- NAMED-ARGUMENT calls when two overloads of the same function name are
-- visible ("Could not choose the best candidate function between: public...")
-- — the 6-arg call sites (import-questions route + existing tests) would
-- break at the wire layer even though Postgres itself resolves them. A
-- distinct name keeps every existing caller byte-identical.
--
-- The BODY is the 0025 body VERBATIM (auth check, ownership check, draft
-- check, mode check, source_text cap, advisory lock, per-question validation)
-- + web-source branches — critique finding: an overload that silently drops
-- 0025's hardening would regress D39 serialization.
--
-- Web entry shape (assembled in-function; the route sends a plain array):
--   {id, kind:'web', url, title, retrieved_at, query}
-- Validation happens IN THE FUNCTION BODY (no DDL CHECK can reach jsonb
-- array elements): a web entry whose url is not ^https?://<no-whitespace>$
-- or longer than 2048 chars is SKIPPED, not fatal.
--
-- The 6-arg signature's grants are re-asserted below (verify-ai D35 posture).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.save_quiz_questions_web(
  p_quiz_id         uuid,
  p_title           text,
  p_source_file_url text,
  p_source_text     text,
  p_questions       jsonb,
  p_mode            text default 'replace',
  p_web_sources     jsonb default null
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
  v_expl           text;
  v_source_entry   jsonb;
  v_existing_count int;
  v_start_index    int;
  v_max_quiz_cap   int := 30;
  v_web_entries    jsonb := '[]'::jsonb;
  v_w              jsonb;
  v_web_url        text;
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
       or (v_q -> 'options') is null or jsonb_typeof(v_q -> 'options') <> 'array'
       or v_correct is null or v_correct < 0 then
      raise exception 'invalid_question_fields' using errcode = 'P0001';
    end if;

    insert into public.questions (
      quiz_id,
      order_index,
      type,
      prompt,
      options,
      correct_index,
      explanation
    )
    values (
      p_quiz_id,
      v_start_index + v_i,
      v_type::public.question_type,
      trim(v_prompt),
      v_options,
      v_correct,
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
             when jsonb_array_length(v_web_entries) > 0 then v_web_entries
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
             when jsonb_array_length(v_web_entries) > 0 then coalesce(sources, '[]'::jsonb) || v_web_entries
             else coalesce(sources, '[]'::jsonb)
           end
      where id = p_quiz_id;
   end if;
end;
$$;

-- ─── Grants on the new function + re-assert the 6-arg house pattern ───────
revoke execute on function public.save_quiz_questions(uuid, text, text, text, jsonb, text) from public, anon;
grant execute on function public.save_quiz_questions(uuid, text, text, text, jsonb, text) to authenticated;
revoke execute on function public.save_quiz_questions_web(uuid, text, text, text, jsonb, text, jsonb) from public, anon;
grant execute on function public.save_quiz_questions_web(uuid, text, text, text, jsonb, text, jsonb) to authenticated;

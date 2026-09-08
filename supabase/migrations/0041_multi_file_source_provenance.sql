-- ═══════════════════════════════════════════════════════════════════════
-- 0041 — Full multi-file provenance in quizzes.sources
--
-- BUG: a multi-file generation merged ALL files into source_text (the
-- preview shows "=== SOURCE [1/2] …" fences) but only ONE chip was
-- persisted, because the route could forward a single p_source_file_url
-- and the RPC assembled exactly one {storage_path,...} entry from it.
--
-- FIX, in save_quiz_questions_web (the generate route's function):
--   1. NEW 8th arg p_source_paths jsonb — the FULL validated path list.
--      One {id, filename, storage_path, added_at} entry is built per path
--      (same legacy shape as 0016/0040; the parser in
--      src/lib/quizzes/sources.ts already tolerates N file entries).
--      p_source_file_url KEEPS its meaning (primary path: replace mode
--      still writes it to quizzes.source_file_url, append mode still
--      coalesces) so single-file flows are byte-identical.
--   2. Additive sources assembly: file entries and web entries are no
--      longer mutually exclusive — the old CASE dropped web citations
--      whenever a file entry existed (both modes).
--
-- WHY A REPLACE OF THE WEB FN, not the 6-arg sibling: save_quiz_questions
-- has other callers (import-questions route) and 0040's header documents
-- the PostgREST overload hazard — same-name overloads break NAMED-ARGUMENT
-- resolution at the wire layer. The 7-arg web fn has exactly one caller
-- (the generate route, updated in the same commit), and drop/recreate
-- follows the 0019 precedent (returns-type change forced it there). The
-- grants pattern is re-asserted below (verify-ai D35 posture).
--
-- Path-list validation happens IN THE FUNCTION BODY (skip-invalid, never
-- fatal — mirrors the p_web_sources posture): a non-array p_source_paths
-- is a hard 'invalid_source_paths_json' (the route controls this arg and
-- must never send garbage — fail loud), but individual non-text elements
-- are SKIPPED. storage_path stays the presence key: an element that is
-- not a non-empty text yields no entry. No path-format policing beyond
-- that — the route owns tenant-prefix/traversal validation BEFORE this
-- function is reachable; the entry shape is display provenance, not a
-- security boundary.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.save_quiz_questions_web(uuid, text, text, text, jsonb, text, jsonb);

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
  -- Hard-typed rejection for a non-array (route bug must fail loud), but
  -- individual elements are skip-invalid: only JSON STRING paths become
  -- provenance entries, in list order. (jsonb_array_elements_text would
  -- coerce 42 → "42" — probe H4 caught exactly that; type-check FIRST.)
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

-- ─── Grants (re-assert the revoked-from-anon house pattern) ───────────────
revoke execute on function public.save_quiz_questions_web(uuid, text, text, text, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public.save_quiz_questions_web(uuid, text, text, text, jsonb, text, jsonb, jsonb) to authenticated;

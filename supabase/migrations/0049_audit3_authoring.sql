-- ═══════════════════════════════════════════════════════════════════════
-- 0049 — audit-3 authoring fixes (docs/audit/audit-3-ledger.md, Chunk C +
--        H3-RACE / H3-ATOM items owned by the quiz-authoring chunk)
--
-- Fixes landed here (each keyed to its audit finding ID):
--
--   H3-RACE-F3  Bulk question import gains an idempotency key. A
--               `questions.generation_id` tag + a `p_generation_id` argument
--               on `save_quiz_questions` (mirroring the student path's
--               audit-1 P1-10 mechanism) make a post-commit retry of the SAME
--               import a no-op instead of a duplicate append. The
--               `quiz_write:` advisory lock already serialized writers; it
--               just had nothing to dedupe ON.
--
--   H3-ATOM-F1  Student AI generate no longer deletes concurrently-added
--               manual questions. The route passes the ids it saw BEFORE the
--               LLM call as `p_replace_ids`; the replace branch deletes only
--               those rows and appends the generated rows after whatever
--               survived. (Previously `delete ... where quiz_id = ...`
--               destroyed every row, including one added during the 30-900 s
--               generation window, with no error.)
--
--   H3-RACE-F4  `join_class` takes a row lock (`for share`) on the class row
--               BEFORE reading `archived_at`, so a concurrent archive
--               serializes: the join either sees the archived flag or commits
--               before the archive. Previously an unlocked read let a join
--               land in a just-archived class — invisible in
--               `student_class_view` (0017:26-30) yet present in
--               `student_roster_view` (0006:33-39) and firing
--               `notify_student_joined` (0022:459-463).
--
-- HOUSE PATTERN: supersede by redefining the function; never edit an earlier
-- migration. `save_quiz_questions` gains TWO defaulted parameters, so the
-- old 6-arg overload MUST be dropped (a defaulted param otherwise makes
-- PostgREST resolve old-shaped calls onto the new guarded version — the same
-- hazard 0045 documented for save_student_quiz_questions).
--
-- NOT EXECUTED LOCALLY (no Supabase/Docker in this environment): validated by
-- re-reading the live definitions (0045:1551-1745, 0045:1938-2080,
-- 0046:66-186) and diffing the bodies below against them.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. questions.generation_id (H3-RACE-F3 support column)
--    Mirrors student_quiz_questions.generation_id (0045:1929-1935).
-- ─────────────────────────────────────────────────────────────────────
alter table public.questions
  add column if not exists generation_id uuid;

create index if not exists questions_generation_idx
  on public.questions (quiz_id, generation_id)
  where generation_id is not null;

-- ─────────────────────────────────────────────────────────────────────
-- 2. save_quiz_questions (H3-RACE-F3 + H3-ATOM-F1)
--    BASELINE: the LIVE 0045 revision (0045:1551-1745). Changes:
--      a. new `p_generation_id uuid default null` — an APPEND retry carrying
--         a key that already tagged rows on this quiz returns without
--         re-appending (the audit-1 P1-10 student mechanism, ported);
--      b. new `p_replace_ids uuid[] default null` — a REPLACE deletes only
--         the rows the caller observed before the LLM call, and appends the
--         generated rows after whatever survived;
--      c. `generation_id` is written on append rows (null on replace rows).
--    Body otherwise verbatim.
--
--    DELIBERATE ASYMMETRY (do not "fix" by porting blindly): the lecturer
--    AI-generate path calls save_quiz_questions_web (0041), whose replace
--    branch is still the blanket `delete from questions where quiz_id = …`.
--    That is correct for THIS route because its `p_mode` is an explicit
--    client choice made at submit time, not a pre-LLM count latched ~30-900 s
--    earlier — the H3-ATOM-F1 lost-update window does not exist there (the
--    ledger adjudicates the same at audit-3-ledger.md:379). If you ever make
--    the web path latch its mode from a pre-call count, port p_replace_ids to
--    it in the same change.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.save_quiz_questions(
  p_quiz_id         uuid,
  p_title           text,
  p_source_file_url text,
  p_source_text     text,
  p_questions       jsonb,
  p_mode            text default 'replace',
  p_generation_id   uuid default null,
  p_replace_ids     uuid[] default null
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

  if p_title is not null and (char_length(trim(p_title)) < 1 or char_length(trim(p_title)) > 200) then
    raise exception 'invalid_title' using errcode = 'P0001';
  end if;

  -- Unified per-quiz write lock (0045 §2.11): one namespace for
  -- replace/append/reorder (was quiz_replace: vs quiz_append: — a replace
  -- and an append could interleave and duplicate order_index values).
  perform pg_advisory_xact_lock(hashtext('quiz_write:' || p_quiz_id::text));

  -- H3-RACE-F3: an APPEND retry carrying a generation id that already tagged
  -- rows on this quiz is a post-commit retry of the SAME import — return
  -- without touching the quiz (the rows are already there).
  if p_mode = 'append' and p_generation_id is not null then
    if exists (
      select 1 from public.questions q
       where q.quiz_id = p_quiz_id
         and q.generation_id = p_generation_id
    ) then
      return;
    end if;
  end if;

  if p_mode = 'replace' then
    -- H3-ATOM-F1: delete only the rows the caller observed BEFORE the AI
    -- call. Rows appended concurrently (a manual question added during the
    -- 30-900 s generation window) survive. A NULL list keeps the historical
    -- full-replace semantics for any other caller.
    if p_replace_ids is null then
      delete from public.questions where quiz_id = p_quiz_id;
      v_start_index := 0;
    else
      delete from public.questions
       where quiz_id = p_quiz_id and id = any(p_replace_ids);
      -- Append generated rows after whatever survived so order_index stays
      -- continuous and unique-by-construction under the write lock.
      select count(*), coalesce(max(order_index), -1) + 1
        into v_existing_count, v_start_index
        from public.questions
       where quiz_id = p_quiz_id;
      if (v_existing_count + v_count) > v_max_quiz_cap then
        raise exception 'quiz_question_limit_exceeded' using errcode = 'P0001';
      end if;
    end if;
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
      explanation,
      generation_id
    )
    values (
      p_quiz_id,
      v_start_index + v_i,
      v_type::public.question_type,
      trim(v_prompt),
      v_options,
      v_correct,
      v_correct_set,
      case when v_expl is null or length(trim(v_expl)) = 0 then null else trim(v_expl) end,
      case when p_mode = 'append' then p_generation_id else null end
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

-- New 8-arg signature (old 6-arg overload must die — defaulted params make
-- PostgREST resolve old-shaped calls onto the guarded version).
drop function if exists public.save_quiz_questions(uuid, text, text, text, jsonb, text);
revoke execute on function public.save_quiz_questions(uuid, text, text, text, jsonb, text, uuid, uuid[]) from public, anon;
grant execute on function public.save_quiz_questions(uuid, text, text, text, jsonb, text, uuid, uuid[]) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. save_student_quiz_questions (H3-ATOM-F1)
--    BASELINE: the LIVE 0045 revision (0045:1938-2080). Change: new
--    `p_replace_ids uuid[] default null` — a REPLACE deletes only the rows
--    the caller observed BEFORE the LLM call; concurrently-added manual rows
--    survive and the generated rows append after them. Body otherwise
--    verbatim (generation_id append dedupe preserved).
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.save_student_quiz_questions(
  p_quiz_id  uuid,
  p_questions jsonb,
  p_mode     text default 'replace',
  p_generation_id uuid default null,
  p_replace_ids uuid[] default null
)
returns setof public.student_quiz_questions
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
  v_existing_count int;
  v_start_index    int;
  v_row            public.student_quiz_questions;
  v_already_saved  boolean := false;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Authoring-tier re-enforcement (D-SQ6): authoring is student-only even via
  -- direct RPC — a user demoted after creating the quiz cannot bulk-save.
  if not public.is_student() then
    raise exception 'not_student' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.student_quizzes s
    where s.id = p_quiz_id and s.created_by = auth.uid()
  ) then
    raise exception 'not_owner' using errcode = 'P0001';
  end if;

  if p_mode not in ('replace', 'append') then
    raise exception 'invalid_mode' using errcode = 'P0001';
  end if;

  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    raise exception 'invalid_questions_json' using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_questions);
  if v_count < 1 or v_count > 50 then
    raise exception 'invalid_questions_json' using errcode = 'P0001';
  end if;

  -- Serialize against single appends + the cap trigger BEFORE counting or
  -- deleting (0025 R2 ordering). Same key as append_student_question /
  -- enforce_student_question_cap → session already holding it re-acquires as
  -- a no-op; no lock-order inversion exists.
  perform pg_advisory_xact_lock(hashtext('student_quiz_append:' || p_quiz_id::text));

  -- audit-1 P1-10: an APPEND retry carrying a generation id that already
  -- tagged rows on this quiz is a post-commit retry of the SAME run —
  -- return the saved rows untouched instead of duplicating them.
  if p_mode = 'append' and p_generation_id is not null then
    if exists (
      select 1 from public.student_quiz_questions sqq
       where sqq.quiz_id = p_quiz_id
         and sqq.generation_id = p_generation_id
    ) then
      v_already_saved := true;
    end if;
  end if;

  if v_already_saved then
    return query
      select sqq.*
        from public.student_quiz_questions sqq
       where sqq.quiz_id = p_quiz_id
       order by sqq.order_index;
    return;
  end if;

  if p_mode = 'replace' then
    -- H3-ATOM-F1: delete only the rows the caller observed BEFORE the LLM
    -- call. A manual question appended during the 30-900 s generation window
    -- survives (previously the blanket delete destroyed it silently). A NULL
    -- list keeps the historical full-replace semantics.
    if p_replace_ids is null then
      delete from public.student_quiz_questions where quiz_id = p_quiz_id;
      v_start_index := 0;
    else
      delete from public.student_quiz_questions
       where quiz_id = p_quiz_id and id = any(p_replace_ids);
      select count(*), coalesce(max(order_index), -1) + 1
        into v_existing_count, v_start_index
        from public.student_quiz_questions
       where quiz_id = p_quiz_id;
      if (v_existing_count + v_count) > 50 then
        raise exception 'question_cap_reached' using errcode = 'P0001';
      end if;
    end if;
  else
    select count(*), coalesce(max(order_index), -1) + 1
      into v_existing_count, v_start_index
      from public.student_quiz_questions
     where quiz_id = p_quiz_id;

    if (v_existing_count + v_count) > 50 then
      raise exception 'question_cap_reached' using errcode = 'P0001';
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

    insert into public.student_quiz_questions (
      quiz_id,
      order_index,
      type,
      prompt,
      options,
      correct_index,
      explanation,
      generation_id
    )
    values (
      p_quiz_id,
      v_start_index + v_i,
      v_type::public.question_type,
      trim(v_prompt),
      v_options,
      v_correct,
      case when v_expl is null or length(trim(v_expl)) = 0 then null else trim(v_expl) end,
      case when p_mode = 'append' then p_generation_id else null end
    )
    returning * into v_row;

    -- setof semantics: emit EVERY inserted row, not just the last.
    return next v_row;
  end loop;
end;
$$;

-- New 5-arg signature (old 4-arg overload must die — a defaulted param makes
-- PostgREST resolve old-shaped calls onto the guarded version).
drop function if exists public.save_student_quiz_questions(uuid, jsonb, text, uuid);
revoke execute on function public.save_student_quiz_questions(uuid, jsonb, text, uuid, uuid[]) from public, anon;
grant execute on function public.save_student_quiz_questions(uuid, jsonb, text, uuid, uuid[]) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 4. join_class (H3-RACE-F4)
--    BASELINE: the LIVE 0046 revision (0046:66-186). Change: the class
--    lookup takes `for share` so a concurrent archive UPDATE serializes
--    against it — the join either observes archived_at (→ class_archived)
--    or commits before the archive can commit. Every other behaviour
--    (throttle bookkeeping, no-oracle invalid_code, matric_required,
--    already_enrolled, success notification) is preserved verbatim.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.join_class(code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id    uuid;
  v_title       text;
  v_archived_at timestamptz;
  v_rows        int;
  v_norm_code   text;
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

  -- H-11 (audit-2): the matric-capture gate is layout-only; /join sits
  -- OUTSIDE the student layout and the old body checked role only, so a
  -- NULL-matric SSO student could enroll with no captured identity. The
  -- authority gate lives HERE: the caller must already have a matric.
  if exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.matric_no is null
  ) then
    return jsonb_build_object('error', 'matric_required');
  end if;

  -- Throttle bookkeeping: create/refresh the attempt row first.
  insert into public.class_join_attempts as a (student_id)
  values (auth.uid())
  on conflict (student_id) do nothing;

  update public.class_join_attempts a
     set fail_count        = case when a.window_started_at < clock_timestamp() - interval '10 minutes'
                                then 0 else a.fail_count end,
         window_started_at = case when a.window_started_at < clock_timestamp() - interval '10 minutes'
                                  then clock_timestamp() else a.window_started_at end
   where a.student_id = auth.uid();

  if exists (
    select 1 from public.class_join_attempts
     where student_id = auth.uid()
       and locked_until is not null
       and locked_until > clock_timestamp()
  ) then
    return jsonb_build_object('error', 'join_locked');
  end if;

  -- L-02 (audit-2): canonicalize EXACTLY like the app's normalizeJoinCode
  -- (strip spaces/dashes, then upcase) so direct-RPC callers are judged on
  -- the same inputs the UI accepts instead of burning fail_count on them.
  v_norm_code := upper(regexp_replace(trim(code), '[\s-]', '', 'g'));

  -- H3-RACE-F4 (audit-3): take a share lock on the class row so a concurrent
  -- archive UPDATE (classes/[id]/route.ts sets archived_at) cannot commit
  -- between this read and the enrollment insert. `for share` lets concurrent
  -- joins proceed in parallel (no needless serialization) while blocking the
  -- archiver until this transaction ends.
  select c.id, c.title, c.archived_at
    into v_class_id, v_title, v_archived_at
   from public.classes c
  where c.join_code = v_norm_code
    for share;

  if v_class_id is null then
    update public.class_join_attempts a
       set fail_count   = a.fail_count + 1,
           locked_until = case when a.fail_count + 1 >= 5
                               then clock_timestamp() + interval '15 minutes'
                               else a.locked_until end
     where a.student_id = auth.uid();
    return jsonb_build_object('error', 'invalid_code');
  end if;

  -- H-03 (audit-2): the counter is NO LONGER cleared merely because the
  -- code exists. archived/already-enrolled outcomes leave the failure
  -- state alone; only a REAL enrollment (v_rows = 1) proves code
  -- knowledge worth resetting the budget. (The old position — delete
  -- right after the lookup — let "4 wrong + 1 known-good" loop forever.)

  if v_archived_at is not null then
    return jsonb_build_object('error', 'class_archived');
  end if;

  insert into public.class_enrollments (class_id, student_id)
  values (v_class_id, auth.uid())
  on conflict (class_id, student_id) do nothing;

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return jsonb_build_object('error', 'already_enrolled');
  end if;

  -- Success: clear any failure state.
  delete from public.class_join_attempts where student_id = auth.uid();

  return jsonb_build_object('class', jsonb_build_object(
    'id', v_class_id,
    'title', v_title
  ));
end;
$$;

revoke execute on function public.join_class(text) from public, anon;
grant execute on function public.join_class(text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 5. is_student_reveal_allowed (H3-ATOM-F5 backstop)
--    BASELINE: the LIVE 0012 revision (0012:26-43). Change: on a LIVE quiz,
--    the CALLER's own in-flight session suppresses the reveal.
--
--    The route refuses a lecturer reveal while ANY session is in flight, but
--    the reveal timestamp is caller-writable via direct PostgREST (owner
--    UPDATE policy) and the auto-reveal flip in submit_session bypasses the
--    route entirely. This is the authoritative correctness gate, so it must
--    not expose `is_correct` to a student who is still mid-attempt.
--
--    Deliberately narrow: the `status = 'live'` term means a CLOSED quiz is
--    unaffected (its answers can no longer change — answer_question gates on
--    live), so a closed quiz's reveal is untouched. The check is scoped to the
--    CALLER, so an abandoned peer session cannot hold the whole cohort's
--    results hostage. Practice is untouched (always revealed).
--
--    SCOPE NOTE (audit-3 SQL review — the earlier comment here claimed the
--    opposite and was wrong): the term is QUIZ-scoped, not session-scoped, so
--    on a LIVE quiz a student with a retake in flight ALSO has attempt 1's
--    correctness masked. That is intended, not a regression: a retake serves
--    the SAME questions, so exposing attempt 1's key while attempt 2 is open
--    is precisely the mid-attempt feedback leak H3-ATOM-F5 closes. The
--    student regains the full reveal the moment the in-flight attempt ends
--    (submit, seal, or flag) or the quiz closes.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.is_student_reveal_allowed(p_quiz_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.quizzes q
    where q.id = p_quiz_id
      and (
        q.mode = 'practice'
        or (
          q.results_revealed_at is not null
          -- H3-ATOM-F5: never expose correctness to a student who is still
          -- answering a LIVE assessment.
          and not (
            q.status = 'live'
            and exists (
              select 1 from public.quiz_sessions s
               where s.quiz_id = q.id
                 and s.student_id = auth.uid()
                 and s.status in ('active', 'paused', 'flagged')
            )
          )
        )
      )
      and public.is_enrolled_in_class(q.class_id)
      and exists (select 1 from public.class_enrollments ce
                   where ce.class_id = q.class_id and ce.student_id = auth.uid())
  );
$$;

revoke execute on function public.is_student_reveal_allowed(uuid) from public, anon;
grant execute on function public.is_student_reveal_allowed(uuid) to authenticated;

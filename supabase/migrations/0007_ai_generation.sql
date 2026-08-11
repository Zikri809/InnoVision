-- InnoVision — Phase 4: AI generation support
-- Depends on: 0004_quizzes.sql (quizzes/questions/triggers/RPCs), 0003_storage.sql
-- (quiz-sources bucket), 0002_classes.sql (is_lecturer_of_quiz helpers).
--
-- Adds:
--  1. quizzes.source_text (nullable, ≤ 15k chars) for the builder's source-text
--     preview + AI provenance marker.
--  2. Extends the quiz_status_transition metadata edit-lock to freeze
--     source_file_url/source_text once a quiz leaves draft (the trigger already
--     fires on ANY update — verified `before insert or update on quizzes`).
--  3. replace_quiz_questions() security-definer RPC — atomic "replace all
--     questions" used by /api/ai/generate-quiz (all-or-nothing: I15).
--  4. Storage hardening: bucket file_size_limit + allowed_mime_types, and the
--     insert policy restricted to lecturers (S1/S5 from the P4 plan review).

-- ─── 1. source_text column (nullable, backstop CHECK ≤ 15000) ────
alter table public.quizzes
  add column if not exists source_text text
  check (source_text is null or char_length(source_text) <= 15000);

-- ─── 2. Extend the metadata edit-lock to source fields ───────────
-- The existing trigger (0004) fires on any UPDATE of quizzes. Extend the
-- function body to also compare source_file_url/source_text, so a live/closed
-- quiz's source cannot be swapped or cleared — even via direct SQL.
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

  -- Metadata edit-lock: title/mode/time_limit/source fields are frozen once a
  -- quiz leaves draft. No-op same-value updates are allowed.
  if OLD.status <> 'draft'
     and (NEW.title is distinct from OLD.title
          or NEW.mode is distinct from OLD.mode
          or NEW.time_limit_sec is distinct from OLD.time_limit_sec
          or NEW.source_file_url is distinct from OLD.source_file_url
          or NEW.source_text is distinct from OLD.source_text) then
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

-- Recreate the trigger (drop+create is idempotent and keeps the def current).
drop trigger if exists quiz_status_transition on public.quizzes;
create trigger quiz_status_transition
  before insert or update on public.quizzes
  for each row execute function public.quiz_status_transition();

-- ─── 3. replace_quiz_questions RPC — atomic all-or-nothing replace ──
-- security definer: MUST re-validate auth.uid() + class ownership + draft-only.
-- Single transaction: delete existing questions, insert the new set with
-- order_index = 0..n-1, update quiz title/source fields. Any trigger violation
-- (lengths, distinctness, true_false=2) raises and ROLLS BACK the whole
-- replace, leaving the prior questions intact (D36).
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
  if p_source_text is not null and char_length(p_source_text) > 15000 then
    raise exception 'source_text_too_long'
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

-- ─── 4. Storage hardening (S1/S5) ────────────────────────────────
-- Bucket-level size + MIME enforcement (defense-in-depth on top of the
-- client-side checks; the serverless route re-checks too).
update storage.buckets
   set file_size_limit = 26214400, -- 25 MB
       allowed_mime_types = array[
         'application/pdf',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'text/plain',
         'text/markdown',
         'image/png',
         'image/jpeg',
         'image/webp'
       ]
 where id = 'quiz-sources';

-- Restrict uploads to lecturers (students never upload source material). The
-- is_lecturer() helper is security definer and reads public.profiles only, so
-- it cannot recurse into storage.objects.
drop policy if exists "quiz-sources owner upload" on storage.objects;
create policy "quiz-sources owner upload"
  on storage.objects for insert
  with check (
    bucket_id = 'quiz-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_lecturer()
  );

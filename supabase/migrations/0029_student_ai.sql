-- ═══════════════════════════════════════════════════════════════════════
-- 0029 — Student AI quiz generation (F1).
-- Design: docs/PLAN_MEDIA_AND_STUDENT_AI.md §3/§6-D5/D6.
--
-- Adds:
--   1. WIDENED `quiz-sources` upload policy: 0007 appended
--      `and public.is_lecturer()` to the owner-folder INSERT policy, which
--      blocks students from uploading source material for AI generation.
--      This migration restores the 0003 semantics (owner-folder = any
--      authenticated user) so the student generate flow can upload files to
--      `${uid}/${studentQuizId}/…`. The widening is DELIBERATE and probed by
--      verify-media MEDIA-D9; the bucket's own file-size/mime limits plus
--      owner-folder isolation bound the new surface (source material is not
--      biometric data — the incident-footage strictness does not apply).
--   2. `save_student_quiz_questions(p_quiz_id, p_questions, p_mode)` — bulk
--      atomic save mirroring EVERY 0025 protection, scoped to the student
--      domain:
--        a. auth.uid() null raise
--        b. ownership raise (created_by = auth.uid()) + is_student() re-check
--           (demoted users cannot invoke — append_student_question precedent)
--        c. mode whitelist 'replace'|'append'
--        d. jsonb array-of-objects validation at 0025's exact depth (parity,
--           not improvement: correct_index < cardinality(options) relies on
--           table CHECKs exactly as 0025 does)
--        e. trim/nullif explanation normalization
--        f. counts under THE 0023 LOCK KEY — pg_advisory_xact_lock(
--           hashtext('student_quiz_append:' || quiz_id)) taken BEFORE any
--           count/delete so bulk saves serialize against single appends and
--           the enforce_student_question_cap trigger (same key re-acquired
--           per-row → no-op, no reverse ordering, no deadlock). replace ≥1,
--           append ≥1, final total ≤50.
--        g. grants block per 0025 R1 (revoke public/anon, grant authenticated)
--        h. updated_at bumping is inherited via student_questions_touch_parent
--           (0023) — NOT reimplemented here
--        i. NO title/source params and NO quiz-metadata mutation — deliberate
--           divergence from save_quiz_questions (0025:161–185); practice
--           metadata edits ride PATCH /api/student-quizzes/[id].
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Restore owner-folder-only upload on quiz-sources ────────────────
drop policy if exists "quiz-sources owner upload" on storage.objects;
create policy "quiz-sources owner upload"
  on storage.objects for insert
  with check (
    bucket_id = 'quiz-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ─── 2. save_student_quiz_questions ─────────────────────────────────────
create or replace function public.save_student_quiz_questions(
  p_quiz_id  uuid,
  p_questions jsonb,
  p_mode     text default 'replace'
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

  if p_mode = 'replace' then
    delete from public.student_quiz_questions where quiz_id = p_quiz_id;
    v_start_index := 0;
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
    )
    returning * into v_row;

    -- setof semantics: emit EVERY inserted row, not just the last.
    return next v_row;
  end loop;
end;
$$;

-- Grants block per 0025 R1 (lost once before — verify-ai D35 asserts it).
revoke execute on function public.save_student_quiz_questions(uuid, jsonb, text) from public, anon;
grant execute on function public.save_student_quiz_questions(uuid, jsonb, text) to authenticated;

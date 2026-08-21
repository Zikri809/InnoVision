# AI Quiz Generation Suite (Multi-File Ingestion, Steering, Difficulty & Append Mode)

**Status**: Implemented, Multi-Subagent Audited & Hardened  
**Target Modules**:  
- AI Pipeline: `src/lib/ai/quiz-prompt.ts`, `src/lib/ai/quiz-schema.ts`, `src/lib/ai/validation.ts`  
- Generation Route: `src/app/api/ai/generate-quiz/route.ts`  
- File Extraction & Dropzone: `src/lib/extract/types.ts`, `src/lib/extract/native.ts`, `src/components/extract/UploadDropzone.tsx`, `src/components/extract/GenerateFromFileDialog.tsx`  
- Database & Migrations: `supabase/migrations/0016_ai_append_and_sources.sql`, `src/lib/types/database.ts`  
- Internationalization: `src/messages/en.json`, `src/messages/ms.json`  
- Test Suites: `src/lib/ai/quiz-prompt.test.ts`, `src/lib/extract/types.test.ts`, `src/app/api/ai/__tests__/ai-routes.test.ts`

---

## 1. Executive Summary & Capabilities

The AI Quiz Generation flow has been upgraded into a hardened, full-fledged **AI Ingestion Suite**:

1. **Multi-File Document Ingestion**: Allows lecturers to drag-and-drop or select up to **5 files simultaneously** ($\le 50\text{ MB}$ total, $\le 200$ pages/file, $\le 120,000$ total chars) across PDF, PPTX, DOCX, TXT, MD, and slide images.
2. **Custom Steering Guidance**: Lecturers can provide specific focus directives ($\le 500$ chars) to emphasize subtopics, request scenario-based questions, or omit introductory history.
3. **Cognitive Difficulty Levels (Bloom's Taxonomy)**:
   - **Easy (Recall & Foundations)**: Direct facts, key terminology, explicit definitions.
   - **Medium (Application & Understanding)**: Conceptual comprehension, practical application, comparing concepts.
   - **Hard (Analysis & Evaluation)**: Multi-step reasoning, subtle distinctions, edge cases.
   - **Mixed / Adaptive (Default)**: Balanced distribution across foundational and analytical questions.
4. **Question Format Distribution**:
   - **Balanced Mix (Default)**: Multiple choice (2–5 options) and True/False questions (2 options).
   - **MCQ Only**: Multiple-choice questions only.
   - **True / False Only**: True/False questions only.
5. **Append vs. Replace Mode**: Choose between appending newly generated questions to an existing draft quiz (with sequential `order_index` continuous numbering up to the 30-question total quiz limit) or replacing all existing draft questions.
6. **2-Step Progressive Stepper**: Divides the workflow into **Step 1 (Documents & OCR Extraction)** and **Step 2 (AI Steering & Parameters)** with clean cancellation and `AbortController` tracking.
7. **Bilingual Parity**: Symmetrical localization in English (`en`) and Bahasa Melayu (`ms`).

---

## 2. Multi-Subagent Audit & Hardening Matrix

| Domain | Finding | Resolution Applied |
| :--- | :--- | :--- |
| **Security** | Quiz-level storage isolation gap (only checked `${userId}/`). | Enforced `${userId.toLowerCase()}/${quizId.toLowerCase()}/` prefix check on all `sourcePaths` and fallback `source_file_url`. |
| **Security** | Insecure context collision in batch uploads (`f-${Date.now()}`). | Implemented RFC4122 v4 UUID generator fallback in `UploadDropzone.tsx`. |
| **Security** | Uncapped PPTX slide decompression bomb risk. | Capped `slideFiles` to `MAX_PARSE_PAGES` (50) in `native.ts`. |
| **Security** | Server-side multi-file download and text aggregate caps. | Enforced `MAX_TOTAL_UPLOAD_BYTES` (50 MB) cumulative download limit and `MAX_AGGREGATE_CHARS` (80,000 chars) text slice in `route.ts`. |
| **AI Reliability** | System prompt question count phrasing contradiction. | Harmonized system prompt: `- Generate the exact number of questions requested in the user prompt (bounded between 3 and 30).` |
| **AI Reliability** | System prompt collision on single-question regeneration (`regenerateQuestion`). | Created dedicated `buildRegenerateSystemPrompt` and enforced question type invariance on regeneration. |
| **AI Reliability** | Format distribution drift bypassing schema validation. | Integrated format distribution check (`mcq_only` / `true_false_only`) inside `generateQuiz` retry loop. |
| **AI Reliability** | Markdown fence escaping in untrusted source text. | Escaped internal triple-backticks (`'''`) in `buildQuizUserPrompt`. |
| **Database** | Advisory lock key split (`quiz_append:` vs `quiz_questions:`). | Unified `append_question` in `0016_ai_append_and_sources.sql` under `quiz_questions:<quiz_id>`. |
| **Database** | Mock fidelity gap in `FakeSupabase`. | Updated `FakeSupabase` to populate `sources` JSONB array, preserve custom titles on append, and use standard separators. |
| **UI/UX & a11y** | In-flight promises on modal close & stale cache on Step 1 modify. | Added `activeAbortRef` aborting on close/unmount, and invalidated stale `extractedText` on file modifications. |
| **UI/UX & a11y** | Question count input snap & emoji usage. | Implemented string-buffered input clamped on blur, and replaced emojis with Lucide SVG icons. |
| **UI/UX & a11y** | Missing radio group ARIA semantics and hardcoded strings. | Added `role="radiogroup"` / `role="radio"` with `aria-checked` attributes and localized all strings across `en.json` and `ms.json`. |

---

## 3. Database Architecture (`0016_ai_append_and_sources.sql`)

### Unified `save_quiz_questions` RPC
```sql
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
  v_max_quiz_cap    constant int := 30;
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
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    where q.id = p_quiz_id and c.lecturer_id = auth.uid()
  ) then
    raise exception 'not_owner' using errcode = 'P0001';
  end if;

  select q.status into v_status from public.quizzes q where q.id = p_quiz_id;
  if v_status is null then
    raise exception 'quiz_not_found' using errcode = 'P0001';
  end if;
  if v_status <> 'draft' then
    raise exception 'questions_locked_quiz_not_draft' using errcode = 'P0001';
  end if;

  if p_mode not in ('replace', 'append') then
    raise exception 'invalid_generation_mode' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('quiz_questions:' || p_quiz_id::text));

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

  if p_mode = 'replace' then
    delete from public.questions where quiz_id = p_quiz_id;
    v_start_index := 0;
  else -- 'append'
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
    v_type    := v_q ->> 'type';
    v_prompt  := v_q ->> 'prompt';
    v_options := coalesce((
      select array_agg(elem::text)
      from jsonb_array_elements_text(v_q -> 'options') as elem
    ), '{}'::text[]);
    v_correct := (v_q ->> 'correct_index')::int;
    v_expl    := v_q ->> 'explanation';

    insert into public.questions
      (quiz_id, order_index, type, prompt, options, correct_index, explanation)
    values
      (p_quiz_id, v_start_index + v_i, v_type::public.question_type, v_prompt, v_options, v_correct, nullif(v_expl, ''))
    returning * into v_row;

    return next v_row;
  end loop;

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
```

---

## 4. Verification & Test Matrix

| Test Suite | Command | Coverage | Result |
| :--- | :--- | :--- | :--- |
| **Quiz Prompt Suite** | `npx vitest run src/lib/ai/quiz-prompt.test.ts` | 26 tests: prompt generation, difficulty levels, format mix enforcement, type preservation on regen | **PASSED (26/26)** |
| **Extract Types Suite** | `npx vitest run src/lib/extract/types.test.ts` | 9 tests: extension verification, path sanitization, batching | **PASSED (9/9)** |
| **AI Route Integration** | `npx vitest run src/app/api/ai/__tests__/ai-routes.test.ts` | 49 tests: append mode, 30-cap rejection, multi-file combining, tenant isolation | **PASSED (49/49)** |
| **TypeScript Typecheck** | `npx tsc --noEmit` | Full project compilation | **PASSED (0 errors)** |
| **i18n Symmetry Check** | `node scripts/check-i18n.mjs` | Translation key completeness (`en` / `ms`) | **PASSED (0 missing)** |
| **Full Regression Suite** | `npm test` | **631 tests across 44 test files** | **PASSED (631/631)** |

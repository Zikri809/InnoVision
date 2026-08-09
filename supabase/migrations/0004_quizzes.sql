-- InnoVision — Phase 3: quizzes, questions, RLS, publish/edit state machine
-- Depends on: 0001_profiles.sql (profiles + user_role), 0002_classes.sql
-- (classes, class_enrollments, join_class, RLS helpers), 0003_storage.sql

-- ─── Enums (idempotent) ─────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'quiz_mode') then
    create type public.quiz_mode as enum ('practice', 'assessment');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'quiz_status') then
    create type public.quiz_status as enum ('draft', 'live', 'closed');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'question_type') then
    create type public.question_type as enum ('mcq', 'true_false');
  end if;
end
$$;

-- ─── quizzes ────────────────────────────────────────────────────
-- Per PLAN §1: class_id → class, created_by → author (audit only; authZ
-- ownership is class ownership), mode/status/time_limit_sec as locked.
create table if not exists public.quizzes (
  id              uuid primary key default gen_random_uuid(),
  class_id        uuid not null references public.classes (id) on delete cascade,
  created_by      uuid not null references public.profiles (id) on delete cascade,
  title           text not null check (char_length(trim(title)) between 1 and 200),
  mode            public.quiz_mode not null default 'practice',
  status          public.quiz_status not null default 'draft',
  time_limit_sec  int check (time_limit_sec is null or time_limit_sec between 1 and 7200),
  source_file_url text,
  created_at      timestamptz not null default now()
);

create index if not exists quizzes_class_id_idx on public.quizzes (class_id);

-- ─── questions ──────────────────────────────────────────────────
-- Per PLAN §1: 2–5 options, correct_index < options.length, true_false ⇒ 2.
-- Distinct-options is enforced by a trigger (Postgres forbids subqueries in
-- CHECK constraints) + Zod app-side — see questions_options_distinct below.
create table if not exists public.questions (
  id            uuid primary key default gen_random_uuid(),
  quiz_id       uuid not null references public.quizzes (id) on delete cascade,
  order_index   int not null check (order_index >= 0),
  type          public.question_type not null,
  prompt        text not null check (char_length(trim(prompt)) between 1 and 2000),
  options       text[] not null check (cardinality(options) between 2 and 5),
  correct_index int not null check (correct_index >= 0 and correct_index < cardinality(options)),
  explanation   text,
  created_at    timestamptz not null default now(),
  check (type <> 'true_false' or cardinality(options) = 2)
);

create index if not exists questions_quiz_id_idx on public.questions (quiz_id);

-- ─── RLS helper: is the caller the lecturer who owns this quiz's class? ──
-- security definer + pinned search_path to break cross-table policy recursion
-- (same pattern as is_lecturer_of_class). Checks auth.uid() against the class
-- owner, so a caller can never discover quizzes outside their own classes.
create or replace function public.is_lecturer_of_quiz(p_quiz_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.quizzes q
    join public.classes c on c.id = q.class_id
    where q.id = p_quiz_id and c.lecturer_id = auth.uid()
  );
$$;

revoke execute on function public.is_lecturer_of_quiz(uuid) from public, anon;
grant execute on function public.is_lecturer_of_quiz(uuid) to authenticated;

-- ─── Grants (required even with RLS) ────────────────────────────
grant select, insert, update, delete on public.quizzes to authenticated;
grant select, insert, update, delete on public.questions to authenticated;
grant select, insert, update, delete on public.quizzes to service_role;
grant select, insert, update, delete on public.questions to service_role;

-- ─── RLS ────────────────────────────────────────────────────────
alter table public.quizzes enable row level security;
alter table public.questions enable row level security;

-- quizzes: SELECT = lecturer of the class OR enrolled student seeing a LIVE
-- quiz. Drafts are invisible to students (answer-sheet secrecy before publish).
drop policy if exists "Lecturer or enrolled student can view quiz" on public.quizzes;
create policy "Lecturer or enrolled student can view quiz"
  on public.quizzes for select
  using (
    is_lecturer_of_class(class_id)
    or (is_enrolled_in_class(class_id) and status = 'live')
  );

-- quizzes: INSERT = lecturer creating a quiz in their own class.
drop policy if exists "Lecturer can create quiz in own class" on public.quizzes;
create policy "Lecturer can create quiz in own class"
  on public.quizzes for insert
  with check (
    auth.uid() = created_by
    and is_lecturer_of_class(class_id)
    and is_lecturer()
  );

-- quizzes: UPDATE/DELETE = lecturer of the class (cannot transfer the class).
drop policy if exists "Lecturer can update own class quiz" on public.quizzes;
create policy "Lecturer can update own class quiz"
  on public.quizzes for update
  using (is_lecturer_of_class(class_id))
  with check (is_lecturer_of_class(class_id) and is_lecturer());

drop policy if exists "Lecturer can delete own class quiz" on public.quizzes;
create policy "Lecturer can delete own class quiz"
  on public.quizzes for delete
  using (is_lecturer_of_class(class_id));

-- questions: lecturer-of-quiz ONLY. Students have NO read policy at all, so
-- a student SELECT always returns 0 rows — D5 (answer secrecy) is enforced by
-- RLS, not by the app. `correct_index` is therefore never client-visible.
drop policy if exists "Quiz lecturer manages questions" on public.questions;
create policy "Quiz lecturer manages questions"
  on public.questions for all
  using (is_lecturer_of_quiz(quiz_id))
  with check (is_lecturer_of_quiz(quiz_id));

-- ─── Integrity triggers (defense-in-depth, apply even via direct SQL) ──

-- 1) One-way quiz status machine. Blocks re-opening a live/closed quiz and
--    publishing an empty quiz. Idempotent same-status updates allowed.
--    Also covers INSERT: a quiz can only be created as 'draft' (direct SQL
--    cannot insert a live/closed empty quiz — D21 holds on every write path).
--    Also locks METADATA edits (title/mode/time_limit_sec) on non-draft
--    quizzes: a live/closed quiz is immutable end-to-end, not just in its
--    questions, even via direct SQL.
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
    -- New quizzes always start as a draft; a live/closed status on insert is
    -- invalid (an empty live quiz would be visible to students).
    if NEW.status is distinct from 'draft' then
      raise exception 'quiz_must_start_draft'
        using errcode = 'P0001';
    end if;
    return NEW;
  end if;

  -- Metadata edit-lock: once a quiz leaves draft, its title/mode/time limit
  -- are frozen (route enforces this too; the DB is the backstop for direct
  -- SQL / service-role writes). No-op same-value updates are allowed.
  if OLD.status <> 'draft'
     and (NEW.title is distinct from OLD.title
          or NEW.mode is distinct from OLD.mode
          or NEW.time_limit_sec is distinct from OLD.time_limit_sec) then
    raise exception 'quiz_not_draft_edit'
      using errcode = 'P0001';
  end if;

  if NEW.status = OLD.status then
    -- Same-status update on a LIVE quiz: an idempotent re-publish racing a
    -- close could otherwise silently "re-open" the quiz (the close's
    -- closed_quiz_cannot_transition guard never fires because the UPDATE never
    -- changes status). Serialize on the quiz and re-read the authoritative
    -- status: if it is now closed, refuse the no-op.
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

  -- A closed quiz is terminal: no transition out of it.
  if OLD.status = 'closed' then
    raise exception 'closed_quiz_cannot_transition'
      using errcode = 'P0001';
  end if;

  -- A live quiz must never return to an editable state.
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

drop trigger if exists quiz_status_transition on public.quizzes;
create trigger quiz_status_transition
  before insert or update on public.quizzes
  for each row execute function public.quiz_status_transition();

-- 2) Questions are immutable once the quiz leaves 'draft'. Blocks INSERT /
--    UPDATE / DELETE of questions (even by direct SQL / service role) while
--    the parent quiz is live or closed.
create or replace function public.questions_draft_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quiz_id uuid;
  v_status  public.quiz_status;
begin
  if TG_OP = 'DELETE' then
    v_quiz_id := OLD.quiz_id;
  else
    v_quiz_id := NEW.quiz_id;
  end if;

  -- A question can NEVER be moved between quizzes. The builder edits in place
  -- (PATCH always keeps quiz_id fixed); forbidding moves closes the hole where
  -- a locked question on a LIVE quiz could be UPDATE'd to a draft quiz (or
  -- vice-versa) via direct SQL, silently altering a published question set.
  if TG_OP = 'UPDATE' and OLD.quiz_id is distinct from NEW.quiz_id then
    raise exception 'question_quiz_id_immutable'
      using errcode = 'P0001';
  end if;

  select q.status into v_status
    from public.quizzes q
   where q.id = v_quiz_id;

  -- DELETE during an ON DELETE CASCADE from the parent quiz/class/profile:
  -- the parent row is already gone by the time the child trigger fires, so
  -- `v_status` is NULL. That is a legitimate cascade, NOT a "quiz not found"
  -- error — allow it. (D22's protection — blocking a single-question delete on
  -- a live quiz — still holds: in that case the parent EXISTS and is not draft.)
  if TG_OP = 'DELETE' and v_status is null then
    return OLD;
  end if;

  if v_status is null then
    raise exception 'quiz_not_found'
      using errcode = 'P0001';
  end if;

  if v_status <> 'draft' then
    raise exception 'questions_locked_quiz_not_draft'
      using errcode = 'P0001';
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

drop trigger if exists questions_draft_only on public.questions;
create trigger questions_draft_only
  before insert or update or delete on public.questions
  for each row execute function public.questions_draft_only();

-- 3) Distinct options (no ambiguous finger targets) + option length/trim
--    backstops. Postgres forbids subqueries in CHECK constraints, so enforce
--    via trigger + Zod app-side. Distinctness folds case + trims so the DB and
--    Zod agree ("Yes"/"yes", " a "/"a" are the same target). Empty-after-trim
--    options are rejected. Per-element length mirrors Zod's 500-char cap.
create or replace function public.questions_options_distinct()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o text;
begin
  foreach v_o in array NEW.options loop
    if char_length(trim(v_o)) = 0 then
      raise exception 'empty_option'
        using errcode = 'P0001';
    end if;
    if char_length(v_o) > 500 then
      raise exception 'option_too_long'
        using errcode = 'P0001';
    end if;
  end loop;

  if (select count(distinct lower(trim(o))) from unnest(NEW.options) o)
     <> cardinality(NEW.options) then
    raise exception 'duplicate_options'
      using errcode = 'P0001';
  end if;
  return NEW;
end;
$$;

drop trigger if exists questions_options_distinct on public.questions;
create trigger questions_options_distinct
  before insert or update of options on public.questions
  for each row execute function public.questions_options_distinct();

-- 4) Explanation length backstop (mirrors Zod's 2000-char cap). Options are
--    length-checked in the trigger above; explanation is unbounded in the DB.
create or replace function public.questions_explanation_length()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.explanation is not null and char_length(NEW.explanation) > 2000 then
    raise exception 'explanation_too_long'
      using errcode = 'P0001';
  end if;
  return NEW;
end;
$$;

drop trigger if exists questions_explanation_length on public.questions;
create trigger questions_explanation_length
  before insert or update of explanation on public.questions
  for each row execute function public.questions_explanation_length();

-- ─── reorder_questions RPC — atomic renumber (single transaction) ──
-- security definer: MUST re-validate auth.uid() + class ownership, and enforce
-- draft-only (published question order is locked). Validates the exact id set
-- (no foreign ids, no count drift, no duplicates) then renumbers 0..n-1.
create or replace function public.reorder_questions(p_quiz_id uuid, p_ordered_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected int;
  v_found    int;
  v_status   public.quiz_status;
  v_i        int;
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

  select count(*) into v_expected
    from public.questions
   where quiz_id = p_quiz_id;

  if p_ordered_ids is null or cardinality(p_ordered_ids) <> v_expected then
    raise exception 'id_count_mismatch'
      using errcode = 'P0001';
  end if;

  -- Every provided id must belong to this quiz AND be unique. Counting
  -- distinct matching ids catches both foreign ids and duplicates.
  select count(distinct provided.id) into v_found
    from unnest(p_ordered_ids) as provided(id)
   where exists (
     select 1 from public.questions q
     where q.id = provided.id and q.quiz_id = p_quiz_id
   );

  if v_found <> v_expected then
    raise exception 'foreign_question_id'
      using errcode = 'P0001';
  end if;

  for v_i in 1 .. v_expected loop
    update public.questions
       set order_index = v_i - 1
     where id = p_ordered_ids[v_i] and quiz_id = p_quiz_id;
  end loop;
end;
$$;

revoke execute on function public.reorder_questions(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_questions(uuid, uuid[]) to authenticated;

-- ─── append_question RPC — atomic add with serialized order_index ──
-- Closes the read-then-insert race in the route (two concurrent adds could
-- produce duplicate order_index values). A per-quiz advisory lock serializes
-- appends; order_index = COALESCE(MAX(order_index), -1) + 1 is computed inside
-- the same transaction. security definer: re-validates auth.uid() + class
-- ownership + draft-only (same invariants as reorder_questions).
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

  -- Serialize appends per quiz; two concurrent adds cannot both read the same
  -- MAX(order_index).
  perform pg_advisory_xact_lock(hashtext('quiz_append:' || p_quiz_id::text));

  select coalesce(max(order_index), -1) + 1 into v_next
    from public.questions
   where quiz_id = p_quiz_id;

  -- NULLIF normalizes an empty explanation string to NULL (Zod allows "").
  insert into public.questions (quiz_id, order_index, type, prompt, options, correct_index, explanation)
  values (p_quiz_id, v_next, p_type, p_prompt, p_options, p_correct_index, nullif(p_explanation, ''))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.append_question(uuid, public.question_type, text, text[], int, text) from public, anon;
grant execute on function public.append_question(uuid, public.question_type, text, text[], int, text) to authenticated;

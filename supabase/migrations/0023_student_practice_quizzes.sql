-- InnoVision — Phase SQ: student-created practice quizzes (shareable)
-- Depends on: 0001_profiles.sql (profiles + roles), 0002_classes.sql,
-- 0004_quizzes.sql (question_type enum; questions_options_distinct /
-- questions_explanation_length trigger functions, attached here — never
-- redefined), 0008_sessions.sql (player-view + RPC conventions).
--
-- Design: docs/PLAN_STUDENT_PRACTICE_QUIZZES.md. Additive-only — nothing in
-- the lecturer/assessment surface is dropped or altered.
--
-- Adds:
--  1. `student_quizzes` / `student_quiz_questions` tables (practice-only by
--     construction: no mode column, no draft/live/closed machine).
--  2. Role/ownership helpers: is_student() (NEW — did not exist before this
--     migration), is_student_quiz_creator(), is_shared_student_quiz().
--  3. RLS: creator CRUD on own quizzes/questions; any authenticated user can
--     SELECT a shared quiz (no role predicate — lecturers may play too).
--     Players read questions ONLY through student_quiz_player_question_view
--     (no correct_index / explanation) — direct table access stays
--     creator-only so the answer key can never leak via PostgREST.
--  4. Abuse caps DB-side (25 quizzes/student, 50 questions/quiz): BEFORE
--     INSERT triggers derive the owner from row data (never auth.uid(), which
--     is NULL under service_role) and serialize on per-quiz/per-owner advisory
--     locks (same key as append_student_question → reentrant, no deadlock).
--  5. updated_at maintenance incl. child-question edits bumping the parent.
--  6. Security-definer RPCs: append_student_question /
--     reorder_student_questions / answer_student_question (SINGLE-statement
--     grading — no TOCTOU between "verify shared" and "fetch key"; NULL
--     selections reveal nothing) / resolve_shared_student_quiz (code → quiz
--     metadata + creator FIRST NAME ONLY; created_by UUID never leaves).
--  7. Privilege-layer grants: revoke-all then minimal grants (0008 style).

-- ─── Tables ────────────────────────────────────────────────────────
create table if not exists public.student_quizzes (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(trim(title)) between 1 and 200),
  description text check (description is null or char_length(description) <= 500),
  -- Single source of truth: share_code IS NOT NULL <=> shared. Unshare nulls
  -- it (revocation is meaningful); re-sharing mints a fresh code.
  share_code  text check (share_code is null or share_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists student_quizzes_created_by_idx
  on public.student_quizzes (created_by);

create unique index if not exists student_quizzes_share_code_idx
  on public.student_quizzes (share_code) where share_code is not null;

create table if not exists public.student_quiz_questions (
  id            uuid primary key default gen_random_uuid(),
  quiz_id       uuid not null references public.student_quizzes (id) on delete cascade,
  order_index   int not null check (order_index >= 0),
  type          public.question_type not null,
  prompt        text not null check (char_length(trim(prompt)) between 1 and 2000),
  options       text[] not null check (cardinality(options) between 2 and 5),
  correct_index int not null check (correct_index >= 0 and correct_index < cardinality(options)),
  explanation   text,
  created_at    timestamptz not null default now(),
  check (type <> 'true_false' or cardinality(options) = 2)
);

-- Composite serves both ordered play-fetches and count aggregates.
create index if not exists student_quiz_questions_quiz_id_order_idx
  on public.student_quiz_questions (quiz_id, order_index);

-- ─── Role/ownership helpers ────────────────────────────────────────
-- House convention: security definer + pinned search_path (breaks policy
-- recursion), revoke from public+anon, grant to authenticated.

create or replace function public.is_student()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'student'
  );
$$;

revoke execute on function public.is_student() from public, anon;
grant execute on function public.is_student() to authenticated;

create or replace function public.is_student_quiz_creator(p_quiz_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.student_quizzes s
    where s.id = p_quiz_id and s.created_by = auth.uid()
  );
$$;

revoke execute on function public.is_student_quiz_creator(uuid) from public, anon;
grant execute on function public.is_student_quiz_creator(uuid) to authenticated;

-- Shared AND reachable-by-code (the only player-visible state). Used by BOTH
-- the SELECT policy and the player view so they can never drift apart.
create or replace function public.is_shared_student_quiz(p_quiz_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.student_quizzes s
    where s.id = p_quiz_id and s.share_code is not null
  );
$$;

revoke execute on function public.is_shared_student_quiz(uuid) from public, anon;
grant execute on function public.is_shared_student_quiz(uuid) to authenticated;

-- ─── Grants (privilege layer — intent, not just RLS) ───────────────
-- NOTE: BOTH write grants are COLUMN-RESTRICTED on purpose. share_code is
-- minted ONLY by student_quiz_share_action (definer RPC below):
--  - UPDATE (title, description): stops arbitrary code assignment via PATCH.
--  - INSERT (created_by, title, description): stops creating a quiz that
--    BORN holding a chosen code — the partial unique index only blocks
--    collisions with LIVE codes, so without this restriction an attacker
--    could resurrect a REVOKED code onto their own quiz and hijack every
--    old /s/<code> link.
revoke all on public.student_quizzes from anon, authenticated;
revoke all on public.student_quiz_questions from anon, authenticated;
grant select on public.student_quizzes to authenticated;
grant insert (created_by, title, description) on public.student_quizzes to authenticated;
grant update (title, description) on public.student_quizzes to authenticated;
grant delete on public.student_quizzes to authenticated;
grant select, insert, update, delete on public.student_quiz_questions to authenticated;
grant all on public.student_quizzes to service_role;
grant all on public.student_quiz_questions to service_role;

-- ─── RLS ───────────────────────────────────────────────────────────
alter table public.student_quizzes enable row level security;
alter table public.student_quiz_questions enable row level security;

drop policy if exists "Creator or shared-visible" on public.student_quizzes;
create policy "Creator or shared-visible"
  on public.student_quizzes for select
  using (created_by = auth.uid() or is_shared_student_quiz(id));

drop policy if exists "Student creates own quiz" on public.student_quizzes;
create policy "Student creates own quiz"
  on public.student_quizzes for insert
  with check (created_by = auth.uid() and is_student());

drop policy if exists "Creator updates own quiz" on public.student_quizzes;
create policy "Creator updates own quiz"
  on public.student_quizzes for update
  using (created_by = auth.uid())
  with check (created_by = auth.uid() and is_student());

drop policy if exists "Creator deletes own quiz" on public.student_quizzes;
create policy "Creator deletes own quiz"
  on public.student_quizzes for delete
  using (created_by = auth.uid());
-- DELIBERATE asymmetry: DELETE has no is_student() predicate — a user demoted
-- from student keeps cleanup rights over content they own, while INSERT/
-- UPDATE freeze (authoring is student-only per D-SQ6). Documented tradeoff.

-- Questions: creator-only CRUD. Players NEVER read this table directly —
-- the player view below is the only path, and it omits the answer key.
drop policy if exists "Creator manages own questions" on public.student_quiz_questions;
create policy "Creator manages own questions"
  on public.student_quiz_questions for all
  using (is_student_quiz_creator(quiz_id))
  with check (is_student_quiz_creator(quiz_id) and is_student());

-- ─── Triggers: ATTACH existing functions under NEW names ───────────
-- questions_options_distinct() and questions_explanation_length() (0004)
-- reference only NEW columns → attach verbatim. Redefining them would change
-- enforcement on public.questions and break the additive-only guarantee.

drop trigger if exists student_questions_options_distinct on public.student_quiz_questions;
create trigger student_questions_options_distinct
  before insert or update of options on public.student_quiz_questions
  for each row execute function public.questions_options_distinct();

drop trigger if exists student_questions_explanation_length on public.student_quiz_questions;
create trigger student_questions_explanation_length
  before insert or update of explanation on public.student_quiz_questions
  for each row execute function public.questions_explanation_length();

-- ─── updated_at ────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists student_quizzes_touch_updated_at on public.student_quizzes;
create trigger student_quizzes_touch_updated_at
  before update on public.student_quizzes
  for each row execute function public.touch_updated_at();

-- Child edits bump the parent's updated_at so the "content may change" signal
-- is honest about question-only edits too. AFTER-trigger: during ON DELETE
-- CASCADE the parent is already gone, so the UPDATE silently matches zero rows
-- — a legitimate cascade, not an error. (Reorder fires this per-row; bounded
-- by the 50-question cap.)
create or replace function public.touch_parent_student_quiz()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quiz_id uuid;
begin
  v_quiz_id := case when TG_OP = 'DELETE' then old.quiz_id else new.quiz_id end;
  update public.student_quizzes s
     set updated_at = now()
   where s.id = v_quiz_id;
  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists student_questions_touch_parent on public.student_quiz_questions;
create trigger student_questions_touch_parent
  after insert or update or delete on public.student_quiz_questions
  for each row execute function public.touch_parent_student_quiz();

-- ─── Caps (D-SQ7): row-derived owner, advisory-lock serialized ─────
-- A plain count-then-check BEFORE INSERT trigger oversubscribes under
-- concurrent inserts; serializing per owner/quiz makes the cap exact. The
-- question cap uses the SAME advisory-lock key as append_student_question so
-- the RPC→trigger path re-acquires a lock its session already holds (no-op)
-- and no reverse ordering exists (no deadlock).

create or replace function public.enforce_student_quiz_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext('student_quiz_cap:' || new.created_by::text));
  select count(*) into v_count
    from public.student_quizzes s
   where s.created_by = new.created_by;
  if v_count >= 25 then
    raise exception 'quiz_cap_reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists student_quizzes_cap on public.student_quizzes;
create trigger student_quizzes_cap
  before insert on public.student_quizzes
  for each row execute function public.enforce_student_quiz_cap();

create or replace function public.enforce_student_question_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext('student_quiz_append:' || new.quiz_id::text));
  select count(*) into v_count
    from public.student_quiz_questions q
   where q.quiz_id = new.quiz_id;
  if v_count >= 50 then
    raise exception 'question_cap_reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists student_questions_cap on public.student_quiz_questions;
create trigger student_questions_cap
  before insert on public.student_quiz_questions
  for each row execute function public.enforce_student_question_cap();

-- ─── Player view — NO correct_index, NO explanation ────────────────
-- Name kept distinct from 0008's student_question_view (different table,
-- different gate — greppability matters in incidents). security_barrier=true:
-- default (definer-rights) views BYPASS base-table RLS, so this WHERE clause
-- IS the boundary — stated deliberately. Cost: barrier blocks qual pushdown,
-- so is_shared_student_quiz runs per row over the questions scan; bounded by
-- the 50-question cap and PK-indexed lookups (documented tradeoff, mirrors
-- 0008:124-126).
create or replace view public.student_quiz_player_question_view
with (security_barrier = true) as
select q.id, q.quiz_id, q.order_index, q.type, q.prompt, q.options, q.created_at
from public.student_quiz_questions q
where public.is_shared_student_quiz(q.quiz_id);

grant select on public.student_quiz_player_question_view to authenticated;

-- ─── append_student_question RPC ───────────────────────────────────
-- Mirror of 0004's append_question for the student domain: atomic add with
-- serialized order_index. security definer: MUST re-validate auth.uid() +
-- ownership (RLS is bypassed inside definer bodies). The advisory-lock key
-- matches enforce_student_question_cap exactly ('student_quiz_append:'||quiz).

create or replace function public.append_student_question(
  p_quiz_id        uuid,
  p_type           public.question_type,
  p_prompt         text,
  p_options        text[],
  p_correct_index  int,
  p_explanation    text
)
returns public.student_quiz_questions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next int;
  v_row  public.student_quiz_questions;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Definer bodies bypass RLS, so the D-SQ6 authoring tier is re-enforced
  -- here: authoring is student-only even via direct RPC (a user demoted
  -- after quiz creation cannot keep appending).
  if not public.is_student() then
    raise exception 'not_student' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.student_quizzes s
    where s.id = p_quiz_id and s.created_by = auth.uid()
  ) then
    raise exception 'not_owner' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('student_quiz_append:' || p_quiz_id::text));

  select coalesce(max(order_index), -1) + 1 into v_next
    from public.student_quiz_questions
   where quiz_id = p_quiz_id;

  insert into public.student_quiz_questions
    (quiz_id, order_index, type, prompt, options, correct_index, explanation)
  values
    (p_quiz_id, v_next, p_type, p_prompt, p_options, p_correct_index, nullif(p_explanation, ''))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.append_student_question(uuid, public.question_type, text, text[], int, text) from public, anon;
grant execute on function public.append_student_question(uuid, public.question_type, text, text[], int, text) to authenticated;

-- ─── reorder_student_questions RPC ─────────────────────────────────
-- Mirror of 0004's reorder_questions: validates the EXACT id set (no foreign
-- ids, no duplicates, no count drift) then renumbers 0..n-1 atomically.

create or replace function public.reorder_student_questions(
  p_quiz_id      uuid,
  p_ordered_ids  uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected int;
  v_found    int;
  v_i        int;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Same authoring-tier re-enforcement as append_student_question (D-SQ6).
  if not public.is_student() then
    raise exception 'not_student' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.student_quizzes s
    where s.id = p_quiz_id and s.created_by = auth.uid()
  ) then
    raise exception 'not_owner' using errcode = 'P0001';
  end if;

  select count(*) into v_expected
    from public.student_quiz_questions
   where quiz_id = p_quiz_id;

  if p_ordered_ids is null or cardinality(p_ordered_ids) <> v_expected then
    raise exception 'id_count_mismatch' using errcode = 'P0001';
  end if;

  select count(distinct provided.id) into v_found
    from unnest(p_ordered_ids) as provided(id)
   where exists (
     select 1 from public.student_quiz_questions q
     where q.id = provided.id and q.quiz_id = p_quiz_id
   );

  if v_found <> v_expected then
    raise exception 'foreign_question_id' using errcode = 'P0001';
  end if;

  for v_i in 1 .. v_expected loop
    update public.student_quiz_questions
       set order_index = v_i - 1
     where id = p_ordered_ids[v_i] and quiz_id = p_quiz_id;
  end loop;
end;
$$;

revoke execute on function public.reorder_student_questions(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_student_questions(uuid, uuid[]) to authenticated;

-- ─── answer_student_question RPC ───────────────────────────────────
-- SINGLE-statement grading: verify-shared, fetch-key, bounds-check all happen
-- in ONE snapshot — no TOCTOU window between "verify shared" and "return
-- correct_index" while a creator unshares/deletes/edits mid-flight. Any miss
-- (foreign id / deleted / unshared / out-of-bounds / NULL selection) folds
-- into ONE no-oracle {error:'unavailable'} — NULL selections reveal nothing.
-- Performs ZERO writes (stateless play; also makes "creators cannot see who
-- played" true by construction — keep it that way).
-- NOTE (D-SQ4): this is PER-QUESTION REVEAL, not key secrecy — answering every
-- question harvests the key. Accepted for practice semantics.

create or replace function public.answer_student_question(
  p_question_id    uuid,
  p_selected_index int
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select jsonb_build_object(
      'is_correct',    p_selected_index = q.correct_index,
      'correct_index', q.correct_index,
      'explanation',   q.explanation
    )
    from public.student_quiz_questions q
    join public.student_quizzes s on s.id = q.quiz_id
    where q.id = p_question_id
      and p_selected_index between 0 and cardinality(q.options) - 1
      and (s.created_by = auth.uid() or s.share_code is not null)
  ), jsonb_build_object('error', 'unavailable'));
$$;

revoke execute on function public.answer_student_question(uuid, int) from public, anon;
grant execute on function public.answer_student_question(uuid, int) to authenticated;

-- ─── resolve_shared_student_quiz RPC ───────────────────────────────
-- Code → quiz metadata for the /s/[code] landing page. profiles SELECT is
-- self-only (0006 MED-3), so the creator's name cannot be FK-embedded through
-- the client — this definer RPC projects ONLY split_part(full_name,' ',1).
-- The created_by UUID NEVER leaves. Normalization contract: callers pass
-- PRE-NORMALIZED codes (normalizeShareCode); upper(trim()) here is a thin
-- idempotent backstop only. No-row (invalid OR revoked) returns NULL — one
-- no-oracle shape for both cases.

create or replace function public.resolve_shared_student_quiz(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', s.id,
    'title', s.title,
    'description', s.description,
    'updated_at', s.updated_at,
    'creator_first_name', btrim(split_part(btrim(coalesce(p.full_name, '')), ' ', 1)),
    'question_count', (select count(*) from public.student_quiz_questions q where q.quiz_id = s.id),
    'created_at', s.created_at
  )
  from public.student_quizzes s
  join public.profiles p on p.id = s.created_by
  where s.share_code = upper(trim(p_code))
  limit 1;
$$;

revoke execute on function public.resolve_shared_student_quiz(text) from public, anon;
grant execute on function public.resolve_shared_student_quiz(text) to authenticated;

-- ─── student_quiz_share_action RPC ─────────────────────────────────
-- The ONLY write path for share_code (column-level UPDATE grants exclude it).
-- Definer: re-validates auth.uid() + is_student() + creator. Actions:
--   'share'      → mint p_code; IDEMPOTENT when already shared (returns the
--                  current code so the creator can always re-copy it).
--   'unshare'    → NULL the code — every existing link dies immediately.
--   'regenerate' → rotate; gated on CURRENTLY shared with a re-check INSIDE
--                  the UPDATE (closes the unshare-regenerate race window).
-- Unique-violation on the partial index propagates to the caller, which
-- retries with a FRESH code (route-side retry loop, join-code precedent).
-- Normalization contract: callers MUST pass a pre-normalized code
-- (trim/uppercase/alphabet — see normalizeShareCode); this RPC validates the
-- charset as a backstop but does not normalize.

create or replace function public.student_quiz_share_action(
  p_quiz_id uuid,
  p_action  text,
  p_code    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  if not public.is_student() then
    raise exception 'not_student' using errcode = 'P0001';
  end if;

  select s.share_code into v_current
    from public.student_quizzes s
   where s.id = p_quiz_id and s.created_by = auth.uid();
  if not found then
    raise exception 'not_owner' using errcode = 'P0001';
  end if;

  if p_action = 'unshare' then
    update public.student_quizzes set share_code = null where id = p_quiz_id;
    return jsonb_build_object('share_code', null);
  end if;

  if p_action = 'share' and v_current is not null then
    return jsonb_build_object('share_code', v_current);
  end if;

  if p_action = 'regenerate' and v_current is null then
    raise exception 'not_shared' using errcode = 'P0001';
  end if;

  if p_action not in ('share', 'regenerate') or p_code is null then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;
  if p_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' then
    raise exception 'invalid_code' using errcode = 'P0001';
  end if;

  -- share-mint / regenerate. The share_code IS NOT NULL predicate re-checks
  -- sharedness atomically: a concurrent unshare between our read and write
  -- updates zero rows → treated as not_shared instead of resurrecting.
  -- BOTH branches map unique_violation → code_collision so the route's retry
  -- loop (fresh code per attempt) engages uniformly.
  begin
    update public.student_quizzes
       set share_code = p_code
     where id = p_quiz_id
       and created_by = auth.uid()
       and (p_action = 'share' or share_code is not null);
    if not found then
      raise exception 'not_shared' using errcode = 'P0001';
    end if;
  exception when unique_violation then
    raise exception 'code_collision' using errcode = 'P0001';
  end;

  return jsonb_build_object('share_code', p_code);
end;
$$;

revoke execute on function public.student_quiz_share_action(uuid, text, text) from public, anon;
grant execute on function public.student_quiz_share_action(uuid, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 0028 — Media attachments: question images + profile avatars (F2/F3).
-- Design: docs/PLAN_MEDIA_AND_STUDENT_AI.md (v2).
--
-- Adds:
--   1. Private buckets `question-images` (≤5 MB, PNG/JPEG/WebP) and
--      `avatars` (≤2 MB, same types) with ZERO client policies — deny-by-
--      default exactly like incident-footage (0020). Uploads/signing ride the
--      service-role admin client through API routes; grants on storage.objects
--      (0003) do NOT confer access without a policy.
--   2. `image_path text` on questions + student_quiz_questions;
--      `avatar_path text` on profiles. Paths are owner-prefixed
--      (`<uid>/<uuid>.<ext>`, `<uid>/avatar.<ext>`); the app validates the
--      format server-side before every signed-URL mint (defense in depth —
--      never trust stored columns blindly).
--   3. `resolve_question_image(p_question_id)` SECURITY DEFINER RPC — THE
--      authorization boundary for reading question images. Returns at most
--      one row {image_path}; no rows ≡ unknown/not-permitted (no-oracle 404
--      upstream). Visibility matrix:
--        A. assessment question q → quiz k:
--           class owner (any status incl. draft/closed)                → row
--           enrolled AND k.status='live'                               → row
--           enrolled AND k.status='closed' AND is_student_reveal_allowed
--             (an image can encode the answer — image access follows score
--              reveal, not merely quiz-close; mirrors student_results)  → row
--           draft / closed-unrevealed / unenrolled / removed-after-close → none
--        B. practice question q → student_quizzes s:
--           creator                                                    → row
--           shared (share_code IS NOT NULL)                            → row
--           unshared + non-creator                                     → none
--      Enumeration resistance: UUIDv4 ids + route rate limit + uniform empty
--      result = no practical oracle; the RPC returns ONLY image_path (no
--      pivot to correct_index or any other column).
--   4. `ai_generation_usage` (F1 daily cost counter) — zero client policies,
--      service-role only; routes check/increment via the admin client.
--   5. View/RPC refreshes to expose image PRESENCE (never paths) to players:
--      student_question_view + student_quiz_player_question_view gain
--      `has_image boolean`; student_results rows gain `has_image`.
--
-- Depends on: 0003 (storage grants), 0004 (questions), 0008 (views),
-- 0012 (is_student_reveal_allowed, student_results), 0017 (class archiving
-- predicates used transitively), 0020 (deny-by-default bucket precedent),
-- 0023 (student quiz tables/helpers).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Buckets (idempotent; limits tightened on re-run) ────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'question-images', 'question-images', false,
  5242880, -- 5 MB
  array['image/png', 'image/jpeg', 'image/webp']::text[]
),
(
  'avatars', 'avatars', false,
  2097152, -- 2 MB
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ─── 2. Columns ────────────────────────────────────────────────────────
alter table public.questions
  add column if not exists image_path text;
alter table public.student_quiz_questions
  add column if not exists image_path text;
alter table public.profiles
  add column if not exists avatar_path text;

-- ─── 3. resolve_question_image — the read boundary ─────────────────────
-- Returns the storage path AND the signed-URL TTL the route must use:
-- shared-practice images get a SHORT 300 s TTL (capability = share code,
-- revocable; bounds the post-unshare residue) while owner/enrollment-scoped
-- access gets the standard 3600 s (plan D13).
create or replace function public.resolve_question_image(p_question_id uuid)
returns table (image_path text, ttl_seconds int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_path text;
  v_ttl  int;
begin
  if auth.uid() is null then
    return;
  end if;

  -- Branch A: assessment question (owner OR enrolled+live OR enrolled+
  -- closed+reveal-allowed). Archived CLASSES are excluded from the student
  -- arm to mirror `can_student_view_quiz` (0017) — an enrollment in an
  -- archived class must not keep minting image URLs via direct API calls.
  perform 1
  from public.questions q
  join public.quizzes k on k.id = q.quiz_id
  where q.id = p_question_id
    and q.image_path is not null
    and (
      public.is_lecturer_of_quiz(q.quiz_id)
      or (
        not exists (
          select 1 from public.classes c
          where c.id = k.class_id and c.archived_at is not null
        )
        and exists (
          select 1 from public.class_enrollments e
          where e.class_id = k.class_id
            and e.student_id = auth.uid()
        )
        and (
          k.status = 'live'
          or (k.status = 'closed' and public.is_student_reveal_allowed(k.id))
        )
      )
    );
  if found then
    select q.image_path into v_path
      from public.questions q
     where q.id = p_question_id and q.image_path is not null;
    return query values (v_path, 3600);
    return;
  end if;

  -- Branch B: practice question (creator OR shared-by-code).
  select q.image_path into v_path
    from public.student_quiz_questions q
    join public.student_quizzes s on s.id = q.quiz_id
   where q.id = p_question_id
     and q.image_path is not null
     and (s.created_by = auth.uid() or s.share_code is not null);
  if found then
    select case when s.created_by = auth.uid() then 3600 else 300 end
      into v_ttl
      from public.student_quizzes s
      join public.student_quiz_questions q on q.quiz_id = s.id
     where q.id = p_question_id;
    return query values (v_path, v_ttl);
    return;
  end if;
end;
$$;

revoke execute on function public.resolve_question_image(uuid) from public, anon;
grant execute on function public.resolve_question_image(uuid) to authenticated;

-- ─── 4. AI generation daily usage (F1) — service-role only ─────────────
create table if not exists public.ai_generation_usage (
  user_id uuid not null,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, day)
);

alter table public.ai_generation_usage enable row level security;
revoke all on public.ai_generation_usage from anon, authenticated;
grant all on public.ai_generation_usage to service_role;

-- ─── 5. Player surfaces expose PRESENCE only (never storage paths) ─────

-- Assessment play questions (0008 definition + has_image).
create or replace view public.student_question_view
with (security_barrier = true)
as
select q.id, q.quiz_id, q.order_index, q.type, q.prompt, q.options, q.created_at,
       (q.image_path is not null) as has_image
from public.questions q
where public.can_student_view_quiz(q.quiz_id);

-- Shared practice play questions (0023 definition + has_image). Barrier stays:
-- this WHERE clause IS the boundary for players (no base-table RLS reach).
create or replace view public.student_quiz_player_question_view
with (security_barrier = true) as
select q.id, q.quiz_id, q.order_index, q.type, q.prompt, q.options, q.created_at,
       (q.image_path is not null) as has_image
from public.student_quiz_questions q
where public.is_shared_student_quiz(q.quiz_id);

grant select on public.student_quiz_player_question_view to authenticated;

-- Student results breakdown (0012 body + has_image per question).
create or replace function public.student_results(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_score   int;
  v_total   int;
  v_questions jsonb;
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

  -- Single no-oracle gate: not enrolled / quiz gone / not revealed → same error.
  if not public.is_student_reveal_allowed(p_quiz_id) then
    return jsonb_build_object('error', 'not_revealed');
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.quiz_id = p_quiz_id and s.student_id = auth.uid() and s.status = 'completed'
   order by s.started_at desc
   limit 1;

  if not found then
    return jsonb_build_object('error', 'not_revealed');
  end if;

  select count(*) into v_total
    from public.questions q
   where q.quiz_id = p_quiz_id;

  if v_session.mode = 'assessment' then
    v_score := coalesce(v_session.score, 0);
  else
    select count(*) into v_score
      from public.session_answers sa
     where sa.session_id = v_session.id and sa.is_correct;
  end if;

  select coalesce(jsonb_agg(js order by (js->>'order_index')::int), '[]'::jsonb) into v_questions
  from (
    select jsonb_build_object(
      'question_id', q.id,
      'order_index', q.order_index,
      'type', q.type,
      'prompt', q.prompt,
      'options', q.options,
      'selected_index', sa.selected_index,
      'is_correct', sa.is_correct,
      'correct_index', q.correct_index,
      'explanation', q.explanation,
      'has_image', (q.image_path is not null)
    ) as js
    from public.questions q
    left join public.session_answers sa
      on sa.question_id = q.id and sa.session_id = v_session.id
    where q.quiz_id = p_quiz_id
  ) t;

  return jsonb_build_object(
    'score', v_score,
    'total', v_total,
    'questions', v_questions
  );
end;
$$;

revoke execute on function public.student_results(uuid) from public, anon;
grant execute on function public.student_results(uuid) to authenticated;

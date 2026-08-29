-- ═══════════════════════════════════════════════════════════════════════
-- 0035 — Quiz duplication / copy-to-class (AP-2, PLAN_R_AUTHORING_PRODUCTIVITY)
--
-- Adds:
--   1. clone_quiz(p_src_quiz_id, p_dest_class_id) returns uuid — single
--      SECURITY DEFINER transaction copying a quiz + its questions into a
--      FRESH DRAFT in the destination class.
--
-- Why one RPC: the quiz INSERT and the question INSERT...SELECT must be
-- atomic (an orphan half-clone is worse than a failed clone), and the
-- questions_draft_only trigger (0004) requires the parent to already be
-- 'draft' at question-insert time — the same transaction guarantees the
-- dst quiz row is visible as draft to the question inserts.
--
-- Destination is ALWAYS draft: the quiz_status_transition trigger
-- (0004:156-164, carried through 0034) rejects any INSERT with
-- status <> 'draft', which is exactly why draft/live/closed sources clone
-- with zero special-casing.
--
-- Copied metadata: title (with " (copy)" suffix, trimmed to the 200-char
-- CHECK), mode, time_limit_sec, allow_retake, max_attempts,
-- shuffle_questions, auto_reveal_on_complete, source_text (plain-text
-- provenance). Deliberately NOT copied: source_file_url and sources — the
-- AI-regen route re-validates source_file_url against
-- `<uid>/<quizId>/` of the quiz being generated FOR
-- (generate-quiz/route.ts ~202-231), so a copied storage path is dead
-- weight; the clone starts with clean file provenance. Also never copied:
-- results_revealed_at, opens_at/closes_at (fresh windows), created_at,
-- and any session/linkage state (share codes live on student_quizzes,
-- not quizzes).
--
-- image_path is copied VERBATIM by this RPC. The route layer then
-- duplicates the storage objects server-side (storage.copy) so clones
-- never share objects — question-image DELETE removes the object
-- (image/route.ts), which would break a sharing clone's render. If the
-- route dies before that phase, dst rows transiently reference the src
-- objects (same-owner sharing; sign route degrades a missing object to a
-- clean 404).
--
-- Cap policy: the 30-question cap is deliberately NOT enforced here — a
-- faithful copy of a quiz that exceeded 30 via the uncapped manual
-- append_question path must not fail. This is a copy, not a batch add
-- (documented deviation from save_quiz_questions' posture).
--
-- Locking: pg_advisory_xact_lock('quiz_replace:' || src) serializes
-- against save_quiz_questions writers on the source (same key namespace,
-- 0025:92). append_question writers use a different key — a concurrent
-- append on a draft source can race the snapshot read; the effect is
-- snapshot skew only (no integrity violation; no unique index on
-- (quiz_id, order_index) per 0025 header R2).
--
-- No-oracle discipline: ownership gates run BEFORE existence checks
-- (reorder_questions precedent, 0004:378-386) — a non-owner cannot
-- distinguish "missing quiz" from "foreign quiz". Destination failures
-- fold missing + non-owned into 'not_class_owner'.
--
-- Depends on: 0002 (classes/is_lecturer_of_class), 0004 (quizzes/
-- questions/is_lecturer_of_quiz/triggers), 0017 (classes.archived_at),
-- 0030 (windows), 0032 (retake), 0034 (shuffle flag).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.clone_quiz(
  p_src_quiz_id   uuid,
  p_dest_class_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src         public.quizzes%rowtype;
  v_dest        public.classes%rowtype;
  v_new_quiz_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Source: class-ownership gate first (covers missing + foreign alike).
  if not public.is_lecturer_of_quiz(p_src_quiz_id) then
    raise exception 'not_quiz_owner' using errcode = 'P0001';
  end if;

  -- Destination: owned class, not archived (quiz-create precedent:
  -- classes/[id]/quizzes/route.ts refuses archived classes).
  if not public.is_lecturer_of_class(p_dest_class_id) then
    raise exception 'not_class_owner' using errcode = 'P0001';
  end if;

  select c.* into v_dest from public.classes c where c.id = p_dest_class_id;
  if v_dest.archived_at is not null then
    raise exception 'class_archived' using errcode = 'P0001';
  end if;

  -- Serialize against save_quiz_questions on the source, then read the
  -- source snapshot under the lock.
  perform pg_advisory_xact_lock(hashtext('quiz_replace:' || p_src_quiz_id::text));

  select q.* into v_src from public.quizzes q where q.id = p_src_quiz_id;
  if not found then
    -- Unreachable for a verified owner; kept for drift safety.
    raise exception 'quiz_not_found' using errcode = 'P0001';
  end if;

  insert into public.quizzes (
    class_id,
    created_by,
    title,
    mode,
    status,
    time_limit_sec,
    source_text,
    allow_retake,
    max_attempts,
    shuffle_questions,
    auto_reveal_on_complete
  )
  values (
    p_dest_class_id,
    auth.uid(),
    left(trim(v_src.title), 200 - length(' (copy)')) || ' (copy)',
    v_src.mode,
    'draft',
    v_src.time_limit_sec,
    v_src.source_text,
    v_src.allow_retake,
    v_src.max_attempts,
    v_src.shuffle_questions,
    v_src.auto_reveal_on_complete
  )
  returning id into v_new_quiz_id;

  insert into public.questions (
    quiz_id,
    order_index,
    type,
    prompt,
    options,
    correct_index,
    explanation,
    image_path
  )
  select
    v_new_quiz_id,
    q.order_index,
    q.type,
    q.prompt,
    q.options,
    q.correct_index,
    q.explanation,
    q.image_path
  from public.questions q
  where q.quiz_id = p_src_quiz_id
  order by q.order_index;

  return v_new_quiz_id;
end;
$$;

-- House-pattern grants (0025:190-191 posture).
revoke execute on function public.clone_quiz(uuid, uuid) from public, anon;
grant execute on function public.clone_quiz(uuid, uuid) to authenticated;

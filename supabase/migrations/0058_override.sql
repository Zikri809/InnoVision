-- ═══════════════════════════════════════════════════════════════════════
-- 0058 — Lecturer override + reveal re-publish (PLAN_GESTURE_OFF_RICH_TYPES)
--
-- §1 override_answer_mark  — lecturer adjudication of a mark
-- §2 quiz_reveal_once      — gains the app.mark_overridden arm (C6/L1)
--
-- D4: override is ADJUDICATION, not submission. It never stamps
-- submitted_at/last_activity_at. Its ONLY trigger-visible side effect is the
-- reveal transition, which is why the GUC in §2 is its sole consumer.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. override_answer_mark ──────────────────────────────────────────
create or replace function public.override_answer_mark(
  p_session_id UUID, p_question_id UUID, p_mark NUMERIC, p_reason TEXT)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quiz uuid;
  v_max numeric;
  v_count int;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  select quiz_id into v_quiz from public.quiz_sessions where id = p_session_id;
  if not found or not public.is_lecturer_of_quiz(v_quiz) then
    return jsonb_build_object('error', 'not_owner');
  end if;

  -- C9: `p_mark NOT IN (...)` alone lets a NULL mark through (SQL three-valued
  -- logic makes NULL NOT IN (...) NULL, and an IF on NULL does not fire).
  if p_mark is null or p_mark not in (0, 0.5, 1) then
    return jsonb_build_object('error', 'invalid_mark');
  end if;

  if p_reason is null or char_length(trim(p_reason)) not between 5 and 500 then
    return jsonb_build_object('error', 'reason_required');
  end if;

  -- D2-7: transaction-local (is_local => true), so §2's trigger sees it for
  -- exactly this transaction and no other.
  perform set_config('app.mark_overridden', 'on', true);

  -- C8/D2-6: lock SESSIONS first, then answers — the SAME order submit and
  -- answer use (0008:480-483, 0045:1289-1292). v4.2's text locked `sa` via
  -- FOR UPDATE OF in the membership check BEFORE the session lock, which
  -- preserved the AB-BA deadlock the patch was supposed to fix. The
  -- membership check therefore runs BELOW the session lock, not above it.
  perform 1 from public.quiz_sessions where id = p_session_id for update;

  -- C10: the question must belong to THIS quiz AND have an answer row in
  -- THIS session. Without both terms a foreign question id returns ok:true
  -- (a silent no-op that looks like a successful adjudication) and the join
  -- becomes a cross-quiz existence oracle.
  select q.max_score into v_max
    from public.questions q
    join public.session_answers sa on sa.question_id = q.id
   where q.id = p_question_id
     and q.quiz_id = v_quiz
     and sa.session_id = p_session_id
     for update of sa;

  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  if p_mark > v_max then
    return jsonb_build_object('error', 'mark_exceeds_max');
  end if;

  -- L8: attempt_version is the override epoch — bumping it invalidates any
  -- in-flight AI mark (the finalizer's guard is
  -- `attempt_version = p_attempt_version`, D2-13), so a late worker write
  -- cannot clobber this adjudication.
  update public.session_answers
     set mark_score = p_mark,
         mark_status = 'marked',
         is_correct = (p_mark >= 0.5),
         marked_at = clock_timestamp(),
         attempt_version = attempt_version + 1
   where session_id = p_session_id
     and question_id = p_question_id;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;

  update public.quiz_sessions s
     set score = (
       select coalesce(sum(coalesce(mark_score,
                    case when is_correct then 1 else 0 end)), 0)
         from public.session_answers
        where session_id = s.id
          and mark_status <> 'pending')
   where id = p_session_id;

  -- D2-7/D2-8: re-publish INSIDE the same txn while the GUC is live. The GUC
  -- is transaction-local, so a second call would throw reveal_once_only.
  -- Last-writer-wins on a concurrent fresh reveal is accepted and documented;
  -- the notify trigger re-fires safely on re-publish (0022:49-50, unique
  -- nulls not distinct).
  --
  -- C6/L1: `results_revealed_at` lives on QUIZZES (0012:20), and the
  -- one-way trigger (0012:51-70) rejects ANY change from non-null —
  -- including →NULL. §2 is what makes this write legal.
  update public.quizzes
     set results_revealed_at = null
   where id = v_quiz
     and results_revealed_at is not null;

  insert into public.audit_events(actor_id, subject_id, action, metadata)
  values (
    auth.uid(), p_session_id, 'override_answer_mark',
    jsonb_build_object(
      'quiz_id', v_quiz,
      'question_id', p_question_id,
      'mark', p_mark,
      'reason', left(trim(p_reason), 500)
    )
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.override_answer_mark(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.override_answer_mark(uuid, uuid, numeric, text) to authenticated;

-- ─── 2. quiz_reveal_once: permit the override's re-publish ────────────
-- BASELINE: the LIVE 0012:51 body. The ONLY change is the GUC arm: a
-- non-null → NULL transition is permitted exactly when
-- `app.mark_overridden = 'on'`, which only override_answer_mark sets (§1,
-- transaction-local). Every other rule is verbatim:
--   - NULL → non-NULL (the reveal itself) is allowed,
--   - a same-value no-op (idempotent auto-reveal / re-click) passes,
--   - non-null → different non-null still throws reveal_once_only.
--
-- audit-4 D1: the GUC arm additionally requires `NEW.results_revealed_at is
-- null`, so the bypass permits ONLY a non-null → NULL re-publish (the override
-- txn's sole write). Without that term the GUC would also legalize a non-null →
-- DIFFERENT-non-null rewrite for the duration of the override transaction —
-- defense-in-depth, since no writer does that today, but the "one-way" claim
-- should not rest on the absence of a writer. A NULL → value reveal outside the
-- GUC is unaffected (it never reaches this branch).
--
-- Why a GUC and not a wider trigger: the re-publish exists so a lecturer who
-- changes a mark AFTER reveal can push the corrected results back out (the
-- UI surfaces "re-publish required", and the lecturer then re-reveals via the
-- existing reveal route, which only ever writes null → value). Widening the
-- trigger for everyone would remove the irreversibility guarantee that makes
-- auto-reveal safe.
create or replace function public.quiz_reveal_once()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if OLD.results_revealed_at is not null
     and NEW.results_revealed_at is distinct from OLD.results_revealed_at
     and not (NEW.results_revealed_at is null
              and coalesce(current_setting('app.mark_overridden', true), '') = 'on') then
    raise exception 'reveal_once_only'
      using errcode = 'P0001';
  end if;
  return NEW;
end;
$$;

-- audit-4 D11: republish after the override RPC + the reveal-trigger
-- replacement so self-hosted PostgREST serves the new signature. Exactly one
-- NOTIFY per file, at the end.
notify pgrst, 'reload schema';

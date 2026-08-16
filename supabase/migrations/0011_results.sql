-- InnoVision — Phase 8: results & attendance (session reset + lecturer audit view)
-- Depends on: 0008_sessions.sql (quiz_sessions, one_assessment_attempt,
-- is_lecturer_of_quiz), 0009_face.sql (audit_events), 0002_classes.sql
-- (class_enrollments, is_lecturer), 0004_quizzes.sql (is_lecturer_of_quiz).
--
-- Adds:
--  1. `reset_session(p_session_id uuid) → jsonb` — the lecturer's session-reset
--     RPC. Security definer; single locked query with the lecturer-ownership
--     predicate in the WHERE (0008 "never row-lock a foreign id" pattern);
--     assessment-mode gate; cascade delete (answers + face_checks) and a
--     `session_reset` audit row (metadata carries session_id + quiz_id so the
--     trail survives self-unenrollment and is fully attributable).
--  2. `lecturer_audit_view` — security-barrier, curated view over audit_events.
--     Projects scalars `event_quiz_id`/`event_session_id` (NEVER raw metadata —
--     kills the biometric-adjacent leak of face_enroll status / flagged_sessions
--     / exempt reasons). New rows (metadata.quiz_id set) are quiz-attributable
--     via is_lecturer_of_quiz and do NOT depend on current enrollment; legacy
--     rows (no quiz_id metadata) surface only via CURRENT class membership
--     (subject-granular, documented trade-off).
--
-- Invariants honored (PLAN_PHASE8 §2 D2/D4):
--  - Session writes stay RPC-only: the dead "Lecturer can delete session"
--    DELETE policy (0008) is NEVER used by authenticated paths.
--  - Deleting a quiz_sessions row frees the one-assignment slot atomically
--    (the partial unique index is row-scoped) — no migration needed for I21.
--  - The raw audit_events table grant set stays untouched (service-role only).

-- ─── reset_session RPC (lecturer-only) ────────────────────────────
-- Full file framing identical to unlock_session (0009). Reset is a supervisor
-- fallback (dead laptop / glitched submit): ANY session status resets (active/
-- paused/flagged/completed) but ONLY assessment mode (practice has no one-attempt
-- slot to release; practice resets would be a corruption risk without benefit).
-- Every reset is audited; the session_reset row is the residual trail after the
-- cascade. `metadata` carries session_id + quiz_id for full attribution.
create or replace function public.reset_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'lecturer'
  ) then
    return jsonb_build_object('error', 'not_lecturer');
  end if;

  -- Lock + lecturer-ownership in ONE query (0008 "never row-lock a foreign id"
  -- pattern): a guessed foreign session id is never row-locked — the join to
  -- is_lecturer_of_quiz runs before the lock is taken. Non-existent and
  -- not-owned fold into the same `not_owner` (no oracle).
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id
     and public.is_lecturer_of_quiz(s.quiz_id)
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  -- Mode gate (post-lock — the only caller who can reach it owns the quiz;
  -- keeps the distinct 400). Practice has no one-attempt slot to release.
  if v_session.mode <> 'assessment' then
    return jsonb_build_object('error', 'not_assessment');
  end if;

  -- Cascade deletes session_answers + face_checks (FK on delete cascade).
  -- Deleting by the LOCKED row (not the raw param) keeps it structural.
  delete from public.quiz_sessions where id = v_session.id;

  -- Residual trail: fully attributable (metadata = session_id + quiz_id).
  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'session_reset',
    jsonb_build_object('session_id', v_session.id, 'quiz_id', v_session.quiz_id)
  );

  return jsonb_build_object(
    'ok', true,
    'deleted_session_id', v_session.id,
    'student_id', v_session.student_id,
    'quiz_id', v_session.quiz_id
  );
end;
$$;

revoke execute on function public.reset_session(uuid) from public, anon;
grant execute on function public.reset_session(uuid) to authenticated;

-- ─── safe_audit_uuid helper ─────────────────────────────────────────
-- Null-safe, shape-safe uuid cast for audit metadata scalars. `nullif(x,'')`
-- alone only guards EMPTY strings — a malformed NON-empty value (e.g. 'oops')
-- would raise `invalid input syntax for type uuid` during the cast and break
-- lecturer_audit_view for EVERY lecturer (the plan's own stated failure mode,
-- §9 iter-3). This helper returns NULL for null/empty/malformed input so the
-- view never raises, keeping both the projection and the WHERE predicate safe.
create or replace function public.safe_audit_uuid(p_value text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case
    -- Case-insensitive and tolerant of the { } / plain-32-char forms PostgreSQL's
    -- ::uuid also accepts; a canonical hyphenated uuid (lowercase or not) is
    -- what jsonb_build_object writes, so malformed input never reaches the cast.
    when lower(btrim(p_value, '{} ')) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then btrim(lower(p_value), '{} ')::uuid
    else null
  end;
$$;

revoke execute on function public.safe_audit_uuid(text) from public, anon;
grant execute on function public.safe_audit_uuid(text) to authenticated;

-- ─── lecturer_audit_view ──────────────────────────────────────────
-- Curated projection + event-scoped predicate. security_invoker = false is
-- spelled out even though it is the PG default: a future flip to
-- security_invoker = true would silently return 0 rows for every lecturer (the
-- base table has no authenticated grants) — do not flip or drop it.
-- `safe_audit_uuid` is applied in BOTH the SELECT projection AND the WHERE
-- predicate: a malformed metadata value can never raise during the cast and
-- can never break the view for every lecturer (the projection-only guard would
-- not protect the predicate).
create or replace view public.lecturer_audit_view
with (security_barrier = true, security_invoker = false)
as
select ae.id,
       ae.actor_id,
       ae.subject_id,
       ae.action,
       ae.created_at,
       public.safe_audit_uuid(ae.metadata ->> 'quiz_id')   as event_quiz_id,
       public.safe_audit_uuid(ae.metadata ->> 'session_id') as event_session_id
  from public.audit_events ae
 where public.is_lecturer()
   and (
         (
           public.safe_audit_uuid(ae.metadata ->> 'quiz_id') is not null
           and public.is_lecturer_of_quiz(public.safe_audit_uuid(ae.metadata ->> 'quiz_id'))
         )
         or
         ( -- legacy, subject-granular rows: visible only via CURRENT class membership
           public.safe_audit_uuid(ae.metadata ->> 'quiz_id') is null
           and exists (
             select 1 from public.class_enrollments ce
             join public.classes c on c.id = ce.class_id
             where ce.student_id = ae.subject_id and c.lecturer_id = auth.uid()
           )
         )
       );

revoke all on public.lecturer_audit_view from anon, authenticated;
grant select on public.lecturer_audit_view to authenticated;
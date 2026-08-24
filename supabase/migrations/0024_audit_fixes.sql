-- ═══════════════════════════════════════════════════════════════════════
-- 0024 — Audit remediation (code-audit fixes, Aug 2026)
--
-- Fixes surfaced by the multi-agent code audit:
--   F1. revoke_face_consent flagged paused sessions without clearing
--       paused_at → unlock credited the entire flagged idle period as exam
--       time (same class of bug R1 fixed for pause_session/record_face_check
--       in 0021).
--   F2. exempt_face_session did not reset focus_pause_count → a session
--       exempted while focus-flagged re-flagged on the very next genuine
--       blur, defeating the lecturer's decision (R2 fixed unlock_session in
--       0021; this is the third flag-clearing path).
--   F3. Storage "quiz-sources owner update" policy had USING but no
--       WITH CHECK → an owner could rename an object into ANOTHER user's
--       folder prefix ("victim-uid/a.pdf"), planting content under a foreign
--       identity and poisoning the AI provenance chain.
--   F4. profiles.face_deletion_pending was owner-writable via the broad 0019
--       self-update policy → a student could clear the pending-deletion flag
--       and suppress CompreFace subject cleanup (biometric-retention
--       control). Mirrors the face_enrollment_status column revoke of 0010.
--   F5. replace_quiz_questions() has been broken since 0019: it is a SQL
--       wrapper doing SELECT * FROM save_quiz_questions(...), but 0019
--       recreated save_quiz_questions as RETURNS VOID (a void function
--       cannot appear in FROM). No caller remains (routes use
--       save_quiz_questions directly) → drop the dead wrapper.
--   F6. CHECK constraint on profiles.face_enrollment_status (only 'enrolled'
--       | 'pending_review' | NULL are ever written; gate logic depends on
--       exact strings).
--   F7. Missing FK indexes: quizzes.created_by (cascade path from profile
--       deletes), session_answers.question_id (question-first lookups +
--       cascade + student_results breakdown join).
--   F8. Reveal/notification pipeline assumed status = 'live':
--       notify_results_revealed's WHEN clause required live, and
--       submit_session's guarded auto-reveal required live — so a lecturer
--       who closes a quiz BEFORE revealing never notifies students, and
--       auto-reveal silently never fires when the last submit lands after
--       close. The reveal-once trigger semantics (null→not-null) make both
--       conditions unnecessary.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── F1. revoke_face_consent: clear paused_at when force-flagging ──────
create or replace function public.revoke_face_consent()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_flagged jsonb;
begin
  if v_actor is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'student'
  ) then
    return jsonb_build_object('error', 'not_student');
  end if;

  perform set_config('app.face_enroll', 'on', true);
  perform set_config('app.face_enroll_actor', v_actor::text, true);
  perform set_config('app.consent_write', 'on', true);

  update public.profiles
     set consent_given_at = null,
         face_enrollment_status = null,
         face_deletion_pending = true
   where id = v_actor;

  select coalesce(jsonb_agg(id), '[]'::jsonb)
    into v_flagged
    from (
      select id
        from public.quiz_sessions
       where student_id = v_actor and mode = 'assessment'
         and status in ('active', 'paused')
         for update
    ) s;

  -- F1: clear paused_at alongside the flag — a later unlock must NOT credit
  -- the flagged period as exam time (mirrors 0021 R1).
  update public.quiz_sessions
     set status = 'flagged',
         paused_at = null
   where student_id = v_actor and mode = 'assessment'
     and status in ('active', 'paused');

  -- Privacy cleanup for COMPLETED sessions only — in-progress fail history
  -- must not be wiped (a revoke cannot launder a live investigation).
  delete from public.face_checks fc
    using public.quiz_sessions s
   where fc.session_id = s.id
     and s.student_id = v_actor
     and s.status = 'completed';

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    v_actor,
    v_actor,
    'consent_revoked',
    jsonb_build_object('flagged_sessions', v_flagged)
  );

  return jsonb_build_object('ok', true, 'flagged_sessions', v_flagged);
end;
$$;

revoke execute on function public.revoke_face_consent() from public, anon;
grant execute on function public.revoke_face_consent() to authenticated;

-- ─── F2. exempt_face_session: reset focus_pause_count ──────────────────
create or replace function public.exempt_face_session(p_session_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_next_nonce uuid;
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

  -- Lock + lecturer-ownership in ONE query (never row-lock a foreign id).
  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id
     and public.is_lecturer_of_quiz(s.quiz_id)
   for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  -- Bound the reason at the SQL layer too (the route's ExemptSchema caps at
  -- 500; a direct RPC caller must not bloat audit_events.metadata).
  if p_reason is null or length(p_reason) > 500 then
    return jsonb_build_object('error', 'invalid_reason');
  end if;

  if v_session.status = 'completed' then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  -- F2: reset focus_pause_count so an exemption clears the flag threshold —
  -- otherwise the next genuine blur instantly re-flags (mirrors 0021 R2).
  update public.quiz_sessions
     set face_exempt = true,
         status = 'active',
         face_fail_streak = 0,
         focus_pause_count = 0,
         verify_nonce = gen_random_uuid(),
         last_activity_at = clock_timestamp()
   where id = v_session.id
   returning verify_nonce into v_next_nonce;

  insert into public.audit_events (actor_id, subject_id, action, metadata)
  values (
    auth.uid(),
    v_session.student_id,
    'exempt_face',
    jsonb_build_object('reason', p_reason)
  );

  return jsonb_build_object('sessionStatus', 'active', 'nextNonce', v_next_nonce);
end;
$$;

revoke execute on function public.exempt_face_session(uuid, text) from public, anon;
grant execute on function public.exempt_face_session(uuid, text) to authenticated;

-- ─── F3. Storage update policy gains WITH CHECK ────────────────────────
drop policy if exists "quiz-sources owner update" on storage.objects;
create policy "quiz-sources owner update"
  on storage.objects for update
  using (
    bucket_id = 'quiz-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'quiz-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ─── F4. face_deletion_pending is RPC/service-role-only ────────────────
revoke update (face_deletion_pending) on public.profiles from authenticated, anon;

-- Sanctioned write path for the flag-clear: after a SUCCESSFUL CompreFace
-- subject deletion the consent route confirms it here. SECURITY DEFINER runs
-- as the owner (implicit column privilege), caller identity re-checked.
create or replace function public.confirm_face_subject_deleted()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'not_authenticated');
  end if;

  -- Only the data subject may confirm their own biometric deletion.
  update public.profiles
     set face_deletion_pending = false
   where id = auth.uid();

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.confirm_face_subject_deleted() from public, anon;
grant execute on function public.confirm_face_subject_deleted() to authenticated;

-- ─── F5. Drop the broken replace_quiz_questions wrapper ────────────────
drop function if exists public.replace_quiz_questions(uuid, text, text, text, jsonb);

-- ─── F6. CHECK constraint on face_enrollment_status ────────────────────
alter table public.profiles
  add constraint profiles_face_enrollment_status_chk
  check (face_enrollment_status in ('enrolled', 'pending_review'))
  not valid;

-- ─── F7. Missing FK indexes ────────────────────────────────────────────
create index if not exists quizzes_created_by_idx on public.quizzes (created_by);
create index if not exists session_answers_question_id_idx on public.session_answers (question_id);

-- ─── F9. Defense-in-depth: revoke default anon grants ──────────────────
-- Early migrations granted to `authenticated` but never revoked the default
-- `anon` DML grants. RLS already denies every anon path; this removes the
-- grant layer entirely (matching the 0008+ house pattern).
revoke all on public.profiles from anon;
revoke all on public.classes from anon;
revoke all on public.class_enrollments from anon;
revoke all on public.quizzes from anon;
revoke all on public.questions from anon;
revoke all on public.quiz_sessions from anon;
revoke all on public.session_answers from anon;

-- ─── F8a. Reveal notifications no longer require status='live' ─────────
drop trigger if exists notify_results_revealed on public.quizzes;
create trigger notify_results_revealed
  after update of results_revealed_at on public.quizzes
  for each row
  when (old.results_revealed_at is null and new.results_revealed_at is not null)
  execute function public.notify_results_revealed();

-- ─── F8b. submit_session auto-reveal works on closed quizzes too ───────
create or replace function public.submit_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.quiz_sessions;
  v_score   int;
  v_total   int;
  v_revealed boolean;
  v_all_done boolean;
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

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id and s.student_id = auth.uid()
    for update;

  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;

  select count(*) into v_total
    from public.questions q
   where q.quiz_id = v_session.quiz_id;

  -- Reveal state derived from the CURRENT rule (practice always reveals).
  v_revealed := public.is_student_reveal_allowed(v_session.quiz_id);

  -- Re-submit idempotency: return the stored result — score reveal-gated.
  if v_session.status = 'completed' then
    if v_session.mode = 'assessment' and not v_revealed then
      return jsonb_build_object(
        'session', jsonb_build_object(
          'id', v_session.id,
          'quiz_id', v_session.quiz_id,
          'student_id', v_session.student_id,
          'mode', v_session.mode,
          'status', v_session.status,
          'started_at', v_session.started_at,
          'submitted_at', v_session.submitted_at,
          'score', null,
          'last_activity_at', v_session.last_activity_at
        ),
        'score', null,
        'total', null,
        'already_submitted', true
      );
    end if;
    return jsonb_build_object(
      'session', jsonb_build_object(
        'id', v_session.id,
        'quiz_id', v_session.quiz_id,
        'student_id', v_session.student_id,
        'mode', v_session.mode,
        'status', v_session.status,
        'started_at', v_session.started_at,
        'submitted_at', v_session.submitted_at,
        'score', v_session.score,
        'last_activity_at', v_session.last_activity_at
      ),
      'score', v_session.score,
      'total', v_total,
      'already_submitted', true
    );
  end if;

  if v_session.status not in ('active', 'paused') then
    return jsonb_build_object('error', 'session_not_active');
  end if;

  select count(*) into v_score
    from public.session_answers sa
   where sa.session_id = v_session.id and sa.is_correct;

  update public.quiz_sessions
     set status = 'completed',
         score = v_score,
         submitted_at = clock_timestamp(),
         last_activity_at = clock_timestamp()
   where id = v_session.id;

  -- ── Auto-reveal (assessment only, single transaction) ─────────────
  if v_session.mode = 'assessment' then
    -- Serialize count-then-reveal across concurrent last-submits.
    perform pg_advisory_xact_lock(hashtext('quiz_reveal:' || v_session.quiz_id::text));

    -- "All done" = no fresh (≤2h) active/paused/flagged assessment sessions.
    -- Stale sessions read as done; `flagged` blocks (lecturer decision first).
    select not exists (
      select 1 from public.quiz_sessions s
      where s.quiz_id = v_session.quiz_id
        and s.mode = 'assessment'
        and s.status in ('active', 'paused', 'flagged')
        and s.last_activity_at >= now() - interval '2 hours'
    ) into v_all_done;

    if v_all_done then
      -- F8b: no status='live' term — the quiz may already be closed by the
      -- time the last submission lands; reveal-once semantics are carried by
      -- results_revealed_at is null alone.
      update public.quizzes
         set results_revealed_at = clock_timestamp()
       where id = v_session.quiz_id
         and auto_reveal_on_complete
         and results_revealed_at is null;
      -- row_count 0 = not the flipper (idempotent; no side effect to re-run).
    end if;

    -- Re-read reveal state AFTER the guarded flip (same transaction sees it).
    v_revealed := public.is_student_reveal_allowed(v_session.quiz_id);
  end if;

  select s.* into v_session
    from public.quiz_sessions s
   where s.id = p_session_id;

  if v_session.mode = 'assessment' and not v_revealed then
    return jsonb_build_object(
      'session', jsonb_build_object(
        'id', v_session.id,
        'quiz_id', v_session.quiz_id,
        'student_id', v_session.student_id,
        'mode', v_session.mode,
        'status', v_session.status,
        'started_at', v_session.started_at,
        'submitted_at', v_session.submitted_at,
        'score', null,
        'last_activity_at', v_session.last_activity_at
      ),
      'score', null,
      'total', null
    );
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_session.id,
      'quiz_id', v_session.quiz_id,
      'student_id', v_session.student_id,
      'mode', v_session.mode,
      'status', v_session.status,
      'started_at', v_session.started_at,
      'submitted_at', v_session.submitted_at,
      'score', v_session.score,
      'last_activity_at', v_session.last_activity_at
    ),
    'score', v_score,
    'total', v_total
  );
end;
$$;

revoke execute on function public.submit_session(uuid) from public, anon;
grant execute on function public.submit_session(uuid) to authenticated;

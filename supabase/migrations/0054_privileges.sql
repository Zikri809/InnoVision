-- ═══════════════════════════════════════════════════════════════════════
-- 0054 — Column privileges for the rich columns (PLAN_GESTURE_OFF_RICH_TYPES)
--
-- D2 / the 0048 lesson (0048:1039-1101): a COLUMN-level REVOKE is a NO-OP
-- while a TABLE-level SELECT grant exists — ACLMASK_ANY means a table grant
-- satisfies every column read. The 0012:78-79 revokes were dead for exactly
-- that reason and 0048 had to redo the whole thing as
-- "REVOKE table, then GRANT explicit columns". This file follows that order.
--
-- ── What is withheld and why ──────────────────────────────────────────
--
-- questions.answer_key
--   The short_text rubric IS the answer key: a student who could read it
--   could write a perfect answer with no understanding. Lecturer surfaces
--   read the new owner-predicated `lecturer_questions_view` (0060) instead
--   of widening this grant.
--
-- session_answers.mark_score / mark_status / marked_at / answer_text /
-- attempt_version
--   S1 BLOCKER: students hold RLS SELECT on their OWN session_answers rows
--   (0008:155-160), so `mark_score >= 0.5 ⇔ is_correct` would be a verbatim
--   pre-reveal answer-key oracle — the exact leak 0048:1039-1101 closed for
--   is_correct. All of these are reachable only through the barrier views
--   (`student_answers_view` / `lecturer_answers_view`, 0060) and the
--   reveal-gated definer RPCs.
--
-- resume_grace_until stays omitted (0048:1081-1083 — no client reads it).
--
-- NOTE: `ai_marking_ledger`'s GRANT lives in 0057 where the table is
-- created (C3) — a privileges file cannot grant on a non-existent relation.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. questions ─────────────────────────────────────────────────────
revoke select on public.questions from authenticated;
-- max_score joins the student-readable set: it is a scale factor (always 1
-- today), not an answer. image_path is NOT granted (0028:145-160 exposes
-- presence only, via student_question_view.has_image).
grant select (id, quiz_id, order_index, type, prompt, options, created_at, max_score)
  on public.questions to authenticated;

-- ─── 2. session_answers ───────────────────────────────────────────────
revoke select on public.session_answers from authenticated;
-- `skipped` IS granted: it is the student's own action record, not an
-- oracle — it reveals nothing about the key, only that they pressed Skip.
grant select (id, session_id, question_id, selected_index, selected_indices,
  skipped, answered_at)
  on public.session_answers to authenticated;

-- ─── 3. quiz_sessions ─────────────────────────────────────────────────
revoke select on public.quiz_sessions from authenticated;
-- Verbatim the 0048:1089-1095 list (score deliberately absent — it is
-- reveal-gated through student_session_view and fully exposed through
-- lecturer_session_view).
grant select (id, quiz_id, student_id, mode, started_at, submitted_at, status,
  face_fail_streak, face_exempt, verify_nonce, last_activity_at,
  face_unavailable_at, paused_at, focus_pause_count, fullscreen_pause_count,
  face_fail_count, hand_pause_count, last_pause_reason,
  face_verify_attempted_at, attempt)
  on public.quiz_sessions to authenticated;

-- ─── 4. service_role keeps full table access ──────────────────────────
-- The marking worker and the sweep RPCs run as service_role and need the
-- raw columns (mark_score/mark_metadata are written by the finalizer).
grant all on public.questions to service_role;
grant all on public.session_answers to service_role;
grant all on public.quiz_sessions to service_role;

-- ─── 5. PostgREST schema cache ────────────────────────────────────────
-- D5: new columns/args are invisible to PostgREST until it reloads; without
-- this the new columns 404 through the REST layer until the next restart.
notify pgrst, 'reload schema';

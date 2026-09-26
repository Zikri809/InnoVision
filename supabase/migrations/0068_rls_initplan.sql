-- InnoVision — 0068 RLS initPlan remediation (Supabase auth_rls_initplan advisor).
--
-- The advisor flagged 15 policies that call bare `auth.uid()` in USING/WITH
-- CHECK: Postgres re-evaluates a bare stable-function call for EVERY row, so
-- dashboard-scale scans (sessions, enrollments, notifications) pay the auth
-- lookup per row. Wrapping as `(select auth.uid())` makes the planner hoist
-- it to an initPlan evaluated ONCE per query.
--
-- Semantics: NONE — `(select auth.uid())` returns the identical value; every
-- predicate below is otherwise byte-identical to the live definition it
-- replaces (sources: 0001/0002/0004/0005/0008/0019/0022/0023/0045, verified
-- against the 2026-09-26 advisor output naming each policy). Helper calls
-- (`is_lecturer()`, `is_lecturer_of_class()`, …) are security-definer row
-- lookups, not auth.* calls — the linter does not flag them and they stay
-- untouched. The notifications predicate stays helper-free (its O(1)
-- Realtime re-check property is preserved — a select-wrapped uid is still a
-- single initPlan value, not a helper call).
--
-- Run: npx supabase db reset / db push

-- ─── profiles ─────────────────────────────────────────────────────
drop policy if exists "Users read own profile" on public.profiles;
create policy "Users read own profile"
  on public.profiles for select
  using ((select auth.uid()) = id);

drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile"
  on public.profiles for update
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ─── classes ──────────────────────────────────────────────────────
drop policy if exists "Lecturer can create class" on public.classes;
create policy "Lecturer can create class"
  on public.classes for insert
  with check (lecturer_id = (select auth.uid()) and is_lecturer());

drop policy if exists "Lecturer can update own class" on public.classes;
create policy "Lecturer can update own class"
  on public.classes for update
  using (lecturer_id = (select auth.uid()))
  with check (lecturer_id = (select auth.uid()) and is_lecturer());

drop policy if exists "Lecturer can delete own class" on public.classes;
create policy "Lecturer can delete own class"
  on public.classes for delete
  using (lecturer_id = (select auth.uid()));

drop policy if exists "Lecturer can view own class" on public.classes;
create policy "Lecturer can view own class"
  on public.classes for select
  using (lecturer_id = (select auth.uid()));

-- ─── class_enrollments ────────────────────────────────────────────
drop policy if exists "Lecturer or enrolled student can view enrollment" on public.class_enrollments;
create policy "Lecturer or enrolled student can view enrollment"
  on public.class_enrollments for select
  using (student_id = (select auth.uid()) or is_lecturer_of_class(class_id));

drop policy if exists "Student can unenroll self or lecturer can remove" on public.class_enrollments;
create policy "Student can unenroll self or lecturer can remove"
  on public.class_enrollments for delete
  using (student_id = (select auth.uid()) or is_lecturer_of_class(class_id));

-- ─── notifications ────────────────────────────────────────────────
drop policy if exists "Recipient reads own notifications" on public.notifications;
create policy "Recipient reads own notifications"
  on public.notifications for select
  using (recipient_id = (select auth.uid()));

-- ─── quizzes ──────────────────────────────────────────────────────
drop policy if exists "Lecturer can create quiz in own class" on public.quizzes;
create policy "Lecturer can create quiz in own class"
  on public.quizzes for insert
  with check (
    (select auth.uid()) = created_by
    and is_lecturer_of_class(class_id)
    and is_lecturer()
  );

-- ─── quiz_sessions ────────────────────────────────────────────────
drop policy if exists "Student can view own session or lecturer of quiz" on public.quiz_sessions;
create policy "Student can view own session or lecturer of quiz"
  on public.quiz_sessions for select
  using (student_id = (select auth.uid()) or is_lecturer_of_quiz(quiz_id));

-- ─── student_quizzes ──────────────────────────────────────────────
drop policy if exists "Student creates own quiz" on public.student_quizzes;
create policy "Student creates own quiz"
  on public.student_quizzes for insert
  with check (created_by = (select auth.uid()) and is_student());

drop policy if exists "Creator updates own quiz" on public.student_quizzes;
create policy "Creator updates own quiz"
  on public.student_quizzes for update
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()) and is_student());

drop policy if exists "Creator deletes own quiz" on public.student_quizzes;
create policy "Creator deletes own quiz"
  on public.student_quizzes for delete
  using (created_by = (select auth.uid()));

drop policy if exists "Creator only (shared reads are code-gated RPC/view paths)" on public.student_quizzes;
create policy "Creator only (shared reads are code-gated RPC/view paths)"
  on public.student_quizzes for select
  using (created_by = (select auth.uid()));

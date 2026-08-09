-- InnoVision — Phase 3 hardening: close join_code / lecturer_id exposure to
-- enrolled students (security audit M-1).
-- Depends on: 0002_classes.sql (classes, is_enrolled_in_class), 0004_quizzes.sql
--
-- Problem: the `classes` SELECT policy is row-level only
-- (lecturer_id = auth.uid() OR is_enrolled_in_class(id)). An ENROLLED student
-- can therefore hit GET /rest/v1/classes?select=id,join_code and read the join
-- code (and the lecturer's UUID) — contradicting the app's "students see
-- title-only" behavior and join-code secrecy.
--
-- Fix: students no longer read `classes` directly. They read
-- `student_class_view`, a projection exposing ONLY id/title/created_at, scoped
-- by the security-definer is_enrolled_in_class(). The view is owned by
-- postgres (bypasses RLS) and filters internally, so it cannot leak rows
-- beyond enrollment, and it has no join_code column to project.
--
-- Lecturers keep full access to `classes` (owner-only SELECT policy).

-- ─── student_class_view (id/title/created_at only) ────────────
create or replace view public.student_class_view
as
select c.id, c.title, c.created_at
from public.classes c
where public.is_enrolled_in_class(c.id);

grant select on public.student_class_view to authenticated;
grant select on public.student_class_view to service_role;

-- ─── classes: owner-only SELECT (students use the view) ────────
drop policy if exists "Lecturer or enrolled student can view class" on public.classes;
create policy "Lecturer can view own class"
  on public.classes for select
  using (lecturer_id = auth.uid());

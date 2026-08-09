-- InnoVision — Phase 3 hardening round 2: column-level secrecy on quizzes and
-- profiles, plus view hardening (security audit MED-1, MED-3; round-2 findings).
-- Depends on: 0004_quizzes.sql (quizzes/questions), 0005_join_code_secrecy.sql
-- (student_class_view, owner-only classes), 0002_classes.sql (profiles policy).

-- ─── MED-1: student_quiz_view — students see live quiz metadata ONLY ──
-- The `quizzes` SELECT policy is row-level, so an enrolled student can read
-- `source_file_url` (private storage path) and `created_by` (lecturer UUID) of
-- any live quiz via direct PostgREST. Mirror the classes fix: students read a
-- projection view (id/class_id/title/mode/status/time_limit_sec/created_at),
-- and `quizzes` SELECT becomes owner-only.
create or replace view public.student_quiz_view
with (security_barrier = true)
as
select q.id, q.class_id, q.title, q.mode, q.status, q.time_limit_sec, q.created_at
from public.quizzes q
where public.is_enrolled_in_class(q.class_id) and q.status = 'live';

grant select on public.student_quiz_view to authenticated;

-- quizzes: owner-only SELECT (students use student_quiz_view).
drop policy if exists "Lecturer or enrolled student can view quiz" on public.quizzes;
create policy "Lecturer can view own quiz"
  on public.quizzes for select
  using (is_lecturer_of_class(class_id));

-- ─── MED-3: student_roster_view — lecturers see roster fields only ──
-- The "Lecturer can view enrolled students' profiles" policy (0002) grants the
-- owning lecturer ALL columns of enrolled students' profiles, including the
-- future `face_embedding` (biometric data). The roster feature only needs
-- student_id + full_name. Restrict direct `profiles` SELECT to self, and give
-- lecturers a purpose-built roster view that cannot expose embeddings.
create or replace view public.student_roster_view
with (security_barrier = true)
as
select ce.class_id, ce.student_id, p.full_name, ce.enrolled_at
from public.class_enrollments ce
join public.profiles p on p.id = ce.student_id
where public.is_lecturer_of_class(ce.class_id);

grant select on public.student_roster_view to authenticated;

-- Replace the broad profiles policy with self-only; the roster view is the
-- only lecturer path to enrolled students' names. (The "Users read own
-- profile" policy already exists from 0001 — only drop the broad one.)
drop policy if exists "Lecturer can view enrolled students' profiles" on public.profiles;

-- ─── Hardening (round-2 LOW-1 / LOW-2) ──────────────────────────
-- security_barrier on the classes view (defense-in-depth against planner
-- push-down oracles), and drop the redundant service_role grant (it already
-- reads classes directly).
drop view if exists public.student_class_view;
create or replace view public.student_class_view
with (security_barrier = true)
as
select c.id, c.title, c.created_at
from public.classes c
where public.is_enrolled_in_class(c.id);

grant select on public.student_class_view to authenticated;

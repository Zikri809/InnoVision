-- InnoVision — Migration 0014: Practice quizzes untimed constraint
-- Depends on: 0004_quizzes.sql, 0007_ai_generation.sql

-- 1. Temporarily disable the draft edit-lock trigger to sanitize legacy rows safely
alter table public.quizzes disable trigger quiz_status_transition;

update public.quizzes
   set time_limit_sec = null
 where mode = 'practice'
   and time_limit_sec is not null;

alter table public.quizzes enable trigger quiz_status_transition;

-- 2. Practice quizzes are untimed — authoritative invariant across all write paths
alter table public.quizzes
  add constraint quizzes_practice_untimed
  check (mode <> 'practice' or time_limit_sec is null);

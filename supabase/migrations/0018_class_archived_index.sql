-- Migration 0018: Partial index for fast lecturer archived class lookups and sorting
--
-- Enables instant, indexed retrieval of archived classes for the dedicated
-- /lecturer/classes/archived page without scanning active rows.

create index if not exists classes_lecturer_archived_idx
  on public.classes (lecturer_id, archived_at desc, created_at desc)
  where archived_at is not null;

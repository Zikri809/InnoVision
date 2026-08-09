-- InnoVision — Phase 1: profiles table, RLS, auto-create on signup
-- Extends Supabase auth.users with role, consent, and (later) face_embedding

-- ─── pgvector extension (for face_embedding, used in Phase 7) ─────
create extension if not exists vector;

-- ─── Enums ───────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('lecturer', 'student');
  end if;
end
$$;

-- ─── profiles table ──────────────────────────────────────────────
create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  role            user_role not null,
  full_name       text,
  consent_given_at timestamptz,
  face_embedding  vector(192),
  created_at      timestamptz not null default now()
);

-- ─── RLS ─────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

-- Grant table privileges to authenticated users (required even with RLS)
grant select, insert, update, delete on public.profiles to authenticated;

-- Grant service_role full access (bypasses RLS) for server-side flows:
-- grading, face verification/compare, and privileged role assignment.
grant select, insert, update, delete on public.profiles to service_role;

-- A user can read and update their own profile row.
-- NOTE: self-signup is always 'student' (server action enforces it). The
-- insert policy below is intentionally ABSENT: profile rows are created by
-- the on_auth_user_created trigger, never by client insert. Role can only be
-- changed by a privileged path (admin RPC / edge function that bypasses RLS),
-- never by the user updating their own row.
create policy "Users read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id and role = 'student');

-- (Lecturer read/update access to student profiles in their classes is
--  added in a later phase when classes + enrollment exist.)

-- ─── Auto-create profile row on signup ───────────────────────────
-- The role is always 'student' for self-signup. user_metadata.role is
-- UNTRUSTED (client-controllable), so it is ignored entirely — self-signup
-- can never self-escalate to lecturer. A privileged path (admin RPC /
-- edge function bypassing RLS) is the only way to set a non-student role.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name)
  values (
    new.id,
    'student',
    new.raw_user_meta_data ->> 'full_name'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

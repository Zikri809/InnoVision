-- Migration 0027: Matric numbers on student profiles.
--
-- Format: EXACTLY 6 DIGITS (institutional matric style). Adds
-- profiles.matric_no (case-trivially unique across all profiles), rewrites
-- handle_new_user to copy+normalize it from signup metadata
-- (normalize-and-NULL on malformed input — mirrors the 0015 locale fallback
-- precedent; requiredness/friendly errors are enforced by the registration
-- server action, the 23505 uniqueness abort stays the race-safe net),
-- backfills existing students with system-generated numbers in the reserved
-- 99xxxx range, and extends student_roster_view with the new column (drop +
-- recreate per the 0006 precedent so security_barrier retention is explicit;
-- MED-3 minimization rationale intact — matric is directory data, biometrics
-- stay hidden).

-- ── Column + format contract ────────────────────────────────────────────────
-- Stored shape: exactly 6 ASCII digits. Direct REST PATCHes with anything else
-- fail opaquely here by design — sanctioned paths (registration action,
-- profile-modal edit action) normalize before writing.
alter table public.profiles
  add column if not exists matric_no text;

-- Defensive wrapper so a manual re-run (psql \i / SQL-editor paste) doesn't
-- die on 42710; Supabase migrations themselves run exactly once.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_matric_no_format'
  ) then
    alter table public.profiles
      add constraint profiles_matric_no_format
      check (matric_no is null or matric_no ~ '^[0-9]{6}$');
  end if;
end $$;

-- Uniqueness across all profiles. Plain CREATE UNIQUE INDEX: ACCESS EXCLUSIVE
-- lock is acceptable at this table scale and CONCURRENTLY is unavailable
-- inside a migration transaction — do not "fix" this into an error.
create unique index if not exists profiles_matric_no_unique
  on public.profiles (matric_no)
  where matric_no is not null;

-- ── Signup trigger (supersedes the 0015 body) ───────────────────────────────
-- Locale whitelist logic preserved verbatim; matric is normalized then
-- dropped (NULL) when malformed so attacker-controlled user_metadata sent
-- straight at the auth API can never abort the whole signup opaquely.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_locale text;
  v_matric text;
begin
  v_locale := coalesce(new.raw_user_meta_data ->> 'locale', 'en');
  if v_locale not in ('en', 'ms') then
    v_locale := 'en';
  end if;

  v_matric := new.raw_user_meta_data ->> 'matric_no';
  if v_matric is not null then
    v_matric := btrim(regexp_replace(v_matric, '\s', '', 'g'));
    -- Shape check AND reserved-range check: raw GoTrue signups bypass the
    -- app's normalizeMatric, so the 99xxxx system namespace must be refused
    -- here too — otherwise a squatted value could collide with the backfill.
    if v_matric !~ '^[0-9]{6}$' or v_matric ~ '^99' then
      v_matric := null;
    end if;
  end if;

  insert into public.profiles (id, role, full_name, locale, matric_no)
  values (
    new.id,
    'student',
    new.raw_user_meta_data ->> 'full_name',
    v_locale,
    v_matric
  );
  return new;
end;
$$;

-- ── Backfill legacy students ────────────────────────────────────────────────
-- System-generated numbers live in the RESERVED 99xxxx range; normalizeMatric()
-- refuses user-chosen values in that range and the signup trigger NULLs them,
-- so nothing else can occupy it. The sequence starts PAST any existing 99xxxx
-- value (defensive: a re-run after post-migration NULL-matric rows appeared
-- must not collide with the original assignment). Single-statement =
-- snapshot-atomic; on concurrent-commit loss it rolls back and re-runs.
do $$ begin
  -- Fail LOUDLY before touching anything if the namespace cannot fit every
  -- NULL-matric student (lpad would silently produce 7-char values that
  -- violate the format CHECK and abort the migration opaquely).
  if (
    select count(*) from public.profiles where role = 'student' and matric_no is null
  ) + (
    select coalesce(max((substring(matric_no from 3)::int)), 0)
    from public.profiles where matric_no ~ '^99[0-9]{4}$'
  ) > 9999 then
    raise exception '0027 backfill: 99xxxx namespace exhausted';
  end if;
end $$;
with legacy as (
  select id, row_number() over (order by created_at asc, id asc) as rn
  from public.profiles
  where role = 'student' and matric_no is null
), offset_max as (
  select coalesce(max((substring(matric_no from 3)::int)), 0) as used
  from public.profiles
  where matric_no ~ '^99[0-9]{4}$'
)
update public.profiles p
set matric_no = '99' || lpad((l.rn + o.used)::text, 4, '0')
from legacy l cross join offset_max o
where p.id = l.id;

-- ── Roster view: expose matric to the owning lecturer ──────────────────────
-- Drop + recreate (not OR REPLACE) so security_barrier retention is explicit
-- and the new column lands appended last (Postgres forbids renaming/reordering
-- existing view output columns).
drop view if exists public.student_roster_view;

create view public.student_roster_view
with (security_barrier = true)
as
select ce.class_id, ce.student_id, p.full_name, ce.enrolled_at, p.matric_no
from public.class_enrollments ce
join public.profiles p on p.id = ce.student_id
where public.is_lecturer_of_class(ce.class_id);

grant select on public.student_roster_view to authenticated;

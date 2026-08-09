-- InnoVision — Phase 2: classes, class_enrollments, join RPC, RLS
-- Depends on: 0001_profiles.sql (profiles + user_role enum + RLS)

-- ─── classes ─────────────────────────────────────────────────────
create table if not exists public.classes (
  id          uuid primary key default gen_random_uuid(),
  lecturer_id uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(trim(title)) between 1 and 200),
  join_code   text not null unique
              -- 6 chars, unambiguous alphabet (no 0/O/1/I):
              -- ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (32 chars)
              check (join_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'),
  created_at  timestamptz not null default now()
);

create index if not exists classes_lecturer_id_idx on public.classes (lecturer_id);

-- ─── class_enrollments ───────────────────────────────────────────
create table if not exists public.class_enrollments (
  class_id    uuid not null references public.classes (id) on delete cascade,
  student_id  uuid not null references public.profiles (id) on delete cascade,
  enrolled_at timestamptz not null default now(),
  primary key (class_id, student_id)
);

create index if not exists class_enrollments_student_id_idx
  on public.class_enrollments (student_id);

-- ─── RLS helper functions (security definer, bypass RLS) ─────────
-- RLS policies must NOT cross-reference other RLS-protected tables or they
-- recurse ("infinite recursion detected in policy"). These helpers check the
-- caller's OWN relationships only, so they leak nothing a caller doesn't
-- already know, and they break the recursion by running as the definer.
create or replace function public.is_lecturer()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'lecturer'
  );
$$;

create or replace function public.is_enrolled_in_class(p_class_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.class_enrollments ce
    where ce.class_id = p_class_id and ce.student_id = auth.uid()
  );
$$;

create or replace function public.is_lecturer_of_class(p_class_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.classes c
    where c.id = p_class_id and c.lecturer_id = auth.uid()
  );
$$;

revoke execute on function public.is_lecturer() from public, anon;
grant execute on function public.is_lecturer() to authenticated;
revoke execute on function public.is_enrolled_in_class(uuid) from public, anon;
grant execute on function public.is_enrolled_in_class(uuid) to authenticated;
revoke execute on function public.is_lecturer_of_class(uuid) from public, anon;
grant execute on function public.is_lecturer_of_class(uuid) to authenticated;

-- ─── RLS ─────────────────────────────────────────────────────────
alter table public.classes enable row level security;
alter table public.class_enrollments enable row level security;

-- Grants (required even with RLS)
grant select, insert, update, delete on public.classes to authenticated;
grant select, insert, update, delete on public.class_enrollments to authenticated;
grant select, insert, update, delete on public.classes to service_role;
grant select, insert, update, delete on public.class_enrollments to service_role;

-- classes: SELECT = owner OR enrolled student.
-- Students must NOT see unenrolled classes — this preserves join-code secrecy.
create policy "Lecturer or enrolled student can view class"
  on public.classes for select
  using (lecturer_id = auth.uid() or is_enrolled_in_class(id));

-- classes: INSERT = lecturer creating their own class.
create policy "Lecturer can create class"
  on public.classes for insert
  with check (lecturer_id = auth.uid() and is_lecturer());

-- classes: UPDATE/DELETE = owner only, and cannot transfer ownership.
create policy "Lecturer can update own class"
  on public.classes for update
  using (lecturer_id = auth.uid())
  with check (lecturer_id = auth.uid() and is_lecturer());

create policy "Lecturer can delete own class"
  on public.classes for delete
  using (lecturer_id = auth.uid());

-- class_enrollments: SELECT = lecturer of the class OR own enrollment.
create policy "Lecturer or enrolled student can view enrollment"
  on public.class_enrollments for select
  using (student_id = auth.uid() or is_lecturer_of_class(class_id));

-- NOTE: NO direct INSERT policy on class_enrollments.
-- Enrollment is ONLY possible via the join_class(code) security-definer RPC,
-- which re-validates role + code server-side. This closes the hole where a
-- student could enroll themselves in any class by guessing/leaking a UUID.

-- class_enrollments: DELETE = self-unenroll OR lecturer of the class.
create policy "Student can unenroll self or lecturer can remove"
  on public.class_enrollments for delete
  using (student_id = auth.uid() or is_lecturer_of_class(class_id));

-- ─── profiles: lecturer can read enrolled students (roster) ─────
create policy "Lecturer can view enrolled students' profiles"
  on public.profiles for select
  using (
    exists (
      select 1 from public.class_enrollments ce
      where ce.student_id = profiles.id and is_lecturer_of_class(ce.class_id)
    )
  );

-- ─── join_class(code) RPC — the ONLY enrollment path ────────────
-- security definer bypasses RLS, so it MUST re-validate auth.uid() and role,
-- normalize the code, and hardcode student_id = auth.uid() (never a param).
create or replace function public.join_class(code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id uuid;
  v_title    text;
  v_rows     int;
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

  select c.id, c.title
    into v_class_id, v_title
    from public.classes c
   where c.join_code = upper(trim(code));

  if v_class_id is null then
    return jsonb_build_object('error', 'invalid_code');
  end if;

  insert into public.class_enrollments (class_id, student_id)
  values (v_class_id, auth.uid())
  on conflict (class_id, student_id) do nothing;

  -- GET DIAGNOSTICS is the unambiguous way to detect ON CONFLICT DO NOTHING:
  -- row_count = 0 when the row already existed (conflict), 1 when inserted.
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return jsonb_build_object('error', 'already_enrolled');
  end if;

  return jsonb_build_object('class', jsonb_build_object(
    'id', v_class_id,
    'title', v_title
  ));
end;
$$;

-- Restrict execution: only authenticated role, never anon/public.
revoke execute on function public.join_class(text) from public, anon;
grant execute on function public.join_class(text) to authenticated;

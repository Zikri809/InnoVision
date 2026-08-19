-- Migration 0015: Add user locale preference to profiles
alter table public.profiles
  add column if not exists locale text not null default 'en'
  check (locale in ('en', 'ms'));

-- Update handle_new_user trigger to populate locale from signup metadata
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_locale text;
begin
  v_locale := coalesce(new.raw_user_meta_data ->> 'locale', 'en');
  if v_locale not in ('en', 'ms') then
    v_locale := 'en';
  end if;

  insert into public.profiles (id, role, full_name, locale)
  values (
    new.id,
    'student',
    new.raw_user_meta_data ->> 'full_name',
    v_locale
  );
  return new;
end;
$$;

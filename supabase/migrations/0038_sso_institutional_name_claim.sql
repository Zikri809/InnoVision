-- 0038 — AU-2 Microsoft institutional SSO support.
--
-- OAuth-provisioned users arrive with NO raw_user_meta_data: the existing
-- handle_new_user (0027) already handles that shape correctly — matric stays
-- NULL (the app gates them at /matric-capture), role stays 'student'
-- (anti-escalation), locale defaults to 'en'.
--
-- The ONLY gap: Microsoft's OIDC `name` claim lands in
-- `raw_user_meta_data->'name'` (supabase-js/GoTrue mapping), NOT
-- `full_name` — so SSO profiles would show a null name in the app shell.
-- This migration teaches the trigger the provider's claim without touching
-- the password path (which sets full_name via signup metadata).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_locale text;
  v_matric text;
  v_full_name text;
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

  -- 0038 (AU-2): OAuth identities carry the display name under the OIDC
  -- `name` claim. The password path's semantics are UNCHANGED — raw
  -- `full_name` metadata as 0027 stored it (register trims before signup);
  -- only the NEW name claim is trimmed/blank-rejected here.
  v_full_name := coalesce(
    new.raw_user_meta_data ->> 'full_name',
    nullif(btrim(new.raw_user_meta_data ->> 'name'), '')
  );

  insert into public.profiles (id, role, full_name, locale, matric_no)
  values (
    new.id,
    'student',
    v_full_name,
    v_locale,
    v_matric
  );
  return new;
end;
$$;

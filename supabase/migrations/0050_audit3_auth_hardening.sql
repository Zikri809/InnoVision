-- ═══════════════════════════════════════════════════════════════════════
-- 0050 — audit-3: auth/identity hardening (Chunk A + H-F4/H-F5)
-- ═══════════════════════════════════════════════════════════════════════
-- Findings closed here:
--
--   A-F6  profiles.full_name had no length bound anywhere in 46 migrations.
--         The app caps it (register.ts) but the cap is app-only, and a
--         student can self-PATCH their own full_name at any time (0001's
--         self-update RLS policy; the 0046 restricted-columns trigger guards
--         only role/consent/matric_no). The roster renders the name with CSS
--         truncation only, so an oversized value inflates every roster
--         payload. A CHECK bounds it at the source of truth.
--
--   A-F9  The institutional-domain block lived ONLY in the app path
--         (register.ts + the SSO callback), so the public GoTrue signup API
--         (`/sb/auth/v1/signup` with the anon key — the `sb/` prefix is
--         excluded from the proxy matcher and the rewrite is unconditional)
--         still created a USABLE password account for an institutional email.
--         With `enable_confirmations=false` (config.toml) that account is
--         immediately usable, and no login-path domain check exists. The gate
--         now also runs in `handle_new_user`, the one place EVERY provisioning
--         path (password signup, OAuth, admin API) must pass through.
--
-- A-F6/A-F9 were confirmed at Medium; the domain list is read from the
-- `app.institutional_email_domains` GUC (same house pattern as
-- `app.session_sealing` / `app.face_enroll`) so the DB gate and the app's
-- INSTITUTIONAL_EMAIL_DOMAINS env var can be kept in sync without a schema
-- change. Unset/empty ⇒ no restriction, which preserves the current
-- dev/demo behaviour and is the honest default for a deployment that has not
-- configured SSO.
--
-- OPS: set the GUC once per environment to enforce the gate, e.g.
--   alter database postgres set app.institutional_email_domains = 'ump.edu.my,student.ump.edu.my';
-- (or `alter role authenticator set ...`). Keep it equal to the app's
-- INSTITUTIONAL_EMAIL_DOMAINS value; see .env.local.example.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. A-F6: bound full_name at the source of truth
-- ─────────────────────────────────────────────────────────────────────
-- 120 characters is generous for a display name and keeps the roster payload
-- bounded. NULL stays allowed (OAuth users without a name claim).
--
-- NOT VALID first, then backfill, then VALIDATE. `ADD CONSTRAINT … CHECK`
-- without NOT VALID scans and validates every existing row and ABORTS the
-- whole migration on the first violation — and full_name has had no DB bound
-- for 46 migrations while the app allowed up to 200 characters
-- (src/lib/auth/register.ts's own cap), so a 121-200-char row is producible
-- today via the app, a direct self-PATCH, or the public GoTrue signup API. A
-- plain CHECK would therefore block deployment on live data (audit-3 SQL
-- review, High). This ordering never fails: the constraint is added unvalidated
-- (new writes are checked immediately), existing rows are trimmed to fit, and
-- VALIDATE then verifies the whole table.
alter table public.profiles
  drop constraint if exists profiles_full_name_len;
alter table public.profiles
  add constraint profiles_full_name_len
  check (full_name is null or char_length(full_name) <= 120) not valid;
update public.profiles
   set full_name = left(full_name, 120)
 where full_name is not null
   and char_length(full_name) > 120;
alter table public.profiles
  validate constraint profiles_full_name_len;

comment on column public.profiles.full_name is
  'Display name. Bounded to 120 chars by profiles_full_name_len (audit-3 A-F6): the app cap alone was bypassable via a direct self-PATCH and via the public GoTrue signup API, and the roster renders it with CSS truncation only.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. A-F9 + A-F6: handle_new_user — institutional gate + name clamp
-- ─────────────────────────────────────────────────────────────────────
-- BASELINE: the LIVE 0038 revision, verbatim except:
--   * (new) institutional-domain gate: when the deployment configures
--     `app.institutional_email_domains`, an account whose email is at one of
--     those domains is REFUSED unless it carries an azure identity. Raising
--     aborts the GoTrue signup transaction, so no credential and no profile
--     row are created — the only place that can block the password path.
--   * (new) full_name is clamped to 120 chars, mirroring the CHECK above so a
--     raw signup with a 1MB `full_name` fails cleanly (or truncates) instead
--     of raising an opaque constraint violation.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_locale text;
  v_matric text;
  v_full_name text;
  v_domains text;
  v_email_domain text;
  v_has_azure boolean;
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

  -- audit-3 A-F6: clamp to the CHECK bound so a raw signup carrying an
  -- oversized name truncates instead of raising an opaque 23514.
  if v_full_name is not null and char_length(v_full_name) > 120 then
    v_full_name := left(v_full_name, 120);
  end if;

  -- audit-3 A-F9: institutional-domain gate. This is the ONLY provisioning
  -- chokepoint every path shares (password signup, OAuth callback, admin
  -- API), so it is where the app-path-only check must be mirrored. The list
  -- comes from the GUC so DB and app can be kept in sync; unset ⇒ no gate.
  v_domains := coalesce(
    nullif(btrim(current_setting('app.institutional_email_domains', true)), ''),
    ''
  );
  if v_domains <> '' and new.email is not null and position('@' in new.email) > 0 then
    -- Take the segment after the LAST '@' — exact parity with
    -- lib/auth/institutional.ts's `slice(lastIndexOf("@") + 1)`. split_part(…,2)
    -- would instead use the FIRST '@', disagreeing for a quoted local part
    -- that itself contains one (audit-3 SQL review).
    v_email_domain := lower(btrim(regexp_replace(new.email, '^.*@', '')));
    -- Exact, case-insensitive domain match over a comma-separated list —
    -- parity with lib/auth/institutional.ts (no wildcard subdomains).
    if v_email_domain = any (
      string_to_array(lower(replace(v_domains, ' ', '')), ',')
    ) then
      -- OAuth identities legitimately own these addresses; only the
      -- password-credential path is refused.
      --
      -- The provider is read from raw_app_meta_data, NOT auth.identities:
      -- this trigger is AFTER INSERT ON auth.users, and GoTrue inserts the
      -- identity row AFTER the user row, so an identities lookup here would
      -- see nothing and reject every legitimate SSO signup. GoTrue populates
      -- raw_app_meta_data at user-insert time with
      -- {"provider": "azure", "providers": ["azure"]} for an OAuth signup and
      -- {"provider": "email", ...} for a password signup, so that is the
      -- correct and available signal.
      v_has_azure := (
        coalesce(new.raw_app_meta_data ->> 'provider', '') = 'azure'
        -- jsonb_exists() rather than the `?` operator: `?` is valid PostgreSQL,
        -- but any client/runner that treats it as a parameter placeholder would
        -- mangle the statement (audit-3 SQL review).
        or jsonb_exists(coalesce(new.raw_app_meta_data -> 'providers', '[]'::jsonb), 'azure')
      );
      if not v_has_azure then
        raise exception
          'institutional_email_requires_sso'
          using errcode = 'P0001',
                hint = 'This address belongs to an institutional domain. Sign in with Microsoft SSO instead of creating a password.';
      end if;
    end if;
  end if;

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

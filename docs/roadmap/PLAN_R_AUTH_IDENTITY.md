# Roadmap Plan — Auth & Identity

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec.
>
> Domain: how users prove identity and recover access. Touches GoTrue config,
> the register/login server actions (`src/lib/auth/*`), matric capture (0027),
> invite-code promotion model (constant-time compare, migration 0001 trigger).

---

## AU-1 · Forgot password flow (HIGH, smallest high-value item in roadmap)

**Problem:** No recovery whatsoever — grep `forgot|resetPassword|reset_password`
empty. Login offers registration link only (`login/page.tsx:152–161`). Supabase
natively supports password reset; pure affordance gap.

**Design sketch**
- "Forgot password?" link under password field → page asking email →
  `supabase.auth.resetPasswordForEmail(email, { redirectTo: <origin>/auth/callback?next=/reset-password/confirm })`.
  Generic confirmation copy regardless of account existence (no enumeration
  oracle — consistent with app-wide no-oracle posture).
- Confirmation page (`/reset-password/confirm`): handles recovery-session
  landing (PKCE through existing `/auth/callback` route already handles
  code exchange — VERIFY exact callback capabilities at pre-flight),
  new-password form (min-length parity with register validation constants,
  shared Zod schema), then supabase.auth.updateUser({password}).
- Session semantics decision: after reset force re-login everywhere? Choose
  "sign out other sessions" explicit checkbox v1 (cheap) vs silent global
  revoke.
- Rate limiting: server action respects same in-memory limiter style as
  login/register actions.
- Email templates: DEFAULT Supabase sender templates initially — note COSTS.md
  §2.5 context (built-in auth email covers ≤20 users scale).
- i18n: all four new strings minimum ×2 locales.

**Tests:** action/route unit tests incl. enum-oracle absence, Zod parity,
E2E happy-path with mocked mailer seam where feasible; document manual check
for hosted mode.

---

## AU-2 · SSO/OAuth institutional login (MED-HIGH, strategic; schedule after AU-1)

**Problem:** Email+password only. University deployments expect campus SSO;
matric hard-binding happens at signup with no external identity anchor.

**Design sketch**
- Provider wiring in Supabase Auth (SAML/OIDC — config-side mostly);
  `/auth/callback` extended for provider callbacks (VERIFY existing PKCE
  handling covers this shape at pre-flight).
- Profile bootstrap: `handle_new_user` trigger currently FORCES role='student'
  (anti-escalation) — SSO arrival keeps that default; promotion stays via
  LECTURER_INVITE_CODE path post-first-login (unchanged mechanics, now
  reachable from settings-ish menu if we add prompt post-login).
- Matric capture for OAuth users: registration UI captured matric for password
  users; OAuth users need a first-login supplementary step (profile row created
  by trigger without matric → gate student surfaces requiring matric presence
  behind a one-time capture screen mirroring 0027 validation/uniqueness).
- Register-page account linking risk: SAME EMAIL existing → defer linking,
  show clear conflict message rather than auto-merge (no surprise merges).
- CSP/headers unaffected; `sanitizeRedirect` continues guarding post-login
  redirects.

**Tests:** fake-provider harness for callback flows (id-token claim→profile
mapping), conflict matrix tests (same-email pre-existing password account),
matric capture gate E2E.

---

## Pre-flight log

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- (none yet)

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

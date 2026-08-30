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

**Design sketch** *(reconciled 2026-08-28 — corrections in Pre-flight log)*
- "Forgot password?" link under password field → page asking email →
  `supabase.auth.resetPasswordForEmail(email, { redirectTo: <origin>/auth/callback?redirect=/reset-password/confirm })`.
  NOTE: the callback route reads the **`redirect`** param (not `next`) and
  passes it through `sanitizeRedirect` — use that param name.
  Generic confirmation copy regardless of account existence (no enumeration
  oracle — consistent with app-wide no-oracle posture).
- Confirmation page (`/reset-password/confirm`): handles recovery-session
  landing (PKCE through existing `/auth/callback` route already handles
  code exchange + cookie set — verified: `src/app/auth/callback/route.ts:36`
  calls `exchangeCodeForSession` and returns cookies on the redirect response),
  new-password form (min-length parity with register validation constants —
  **6**, per `src/lib/auth/register.ts:77` and UI `minLength={6}`), then
  supabase.auth.updateUser({password}).
- Session semantics decision: after reset force re-login everywhere? Choose
  "sign out other sessions" explicit checkbox v1 (cheap) vs silent global
  revoke.
- Rate limiting: server action uses the shared in-memory limiter
  (`rateLimit` from `@/lib/classes/rate-limit`) with the same `envLimit()`
  env-tunable pattern as register (`src/lib/auth/register.ts:27–36`); the
  generic "too many attempts" message already exists at `authErrors.tooManyAttempts`.
- Validation: NO Zod on the auth path — register/login use manual inline
  validation (email regex + length checks). Mirror that style; do not
  introduce Zod here.
- Email templates: DEFAULT Supabase sender templates initially — note COSTS.md
  §2.5 context (built-in auth email covers ≤20 users scale).
- No schema change, no migration — this is GoTrue + UI + server actions only.
- i18n: new strings in `src/messages/en.json` and `src/messages/ms.json`
  under the existing `auth` and `authErrors` namespaces (NOT
  `src/i18n/messages/` — that path doesn't exist; messages live in
  `src/messages/*.json`).

**Tests:** action/route unit tests incl. enum-oracle absence (generic message
regardless of account existence), min-length parity (6), rate-limit budget
(`_seedRateLimit`/`_resetRateLimiter` helpers as in `register.test.ts`),
E2E happy-path with mocked mailer seam where feasible; document manual check
for hosted mode.

---

## AU-2 · SSO/OAuth institutional login — Microsoft (Entra ID / Office 365
## school tenant), uni-domain-filtered (MED-HIGH, strategic; schedule after
## AU-1)

**Problem:** Email+password only. University deployments expect campus SSO;
matric hard-binding happens at signup with no external identity anchor.
The USER DECISION (2026-08-30) pins the provider and the trust boundary:
Microsoft institutional login (the tenant students/lecturers already have
for Office 365/Outlook), NOT Google/other providers, and filtered to
university email domains (e.g. `@xxxuni.edu.my`) — a personal
`@outlook.com`/`@hotmail.com` Microsoft account must be REJECTED with a
clear "use your university account" message even though it authenticates
fine against the same Microsoft tenant flow.

**Design sketch**
- Provider wiring in Supabase Auth: Azure/Entra ID (OIDC) — config-side
  mostly (tenant ID + client secret + redirect). Force the tenant-specific
  authority (`/organizations` or the exact tenant GUID) rather than
  `common`, so personal Microsoft accounts never even reach the
  university-tenant consent screen; the domain filter is the SECOND layer.
- Domain allowlist: a single config value (env/Supabase Auth config, e.g.
  `INSTITUTIONAL_EMAIL_DOMAINS=xxxuni.edu.my`) checked post-callback on the
  identity token's `email` claim: case-insensitive exact-suffix match of
  the LAST `@` segment. Multi-domain unis supported by a comma list. A
  non-matching domain → sign the user out cleanly + "use your university
  account" error screen (NO session created — do not create-then-reject;
  reject BEFORE the profile trigger can fire).
- First-login gate for OAuth users: no password registration happens, so
  `handle_new_user` fires on first successful callback. Role stays
  'student' (anti-escalation unchanged); promotion stays via
  LECTURER_INVITE_CODE post-first-login (unchanged mechanics).
- Matric capture for OAuth users: registration UI captured matric for
  password users; OAuth users need a first-login supplementary step
  (profile row created by trigger without matric → gate student surfaces
  requiring matric presence behind a one-time capture screen mirroring
  0027 validation/uniqueness).
- Register-page account linking risk: SAME EMAIL existing (a password
  account with the same uni email) → defer linking, show clear conflict
  message rather than auto-merge (no surprise merges).
- CSP/headers unaffected; `sanitizeRedirect` continues guarding post-login
  redirects.

**Tests:** fake-provider harness for callback flows (id-token claim→profile
mapping), DOMAIN-FILTER matrix (matching domain → session; personal
@outlook.com/@hotmail.com/@gmail.com → rejected, no profile row; case/
subdomain traps `@sub.xxxuni.edu.my` — decide allow vs reject at
pre-flight), conflict matrix tests (same-email pre-existing password
account), matric capture gate E2E.
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

- 2026-08-30 (AU-2 scope note, pre-reconciliation): user pinned the
  provider + trust boundary — Microsoft institutional login with a
  university-domain allowlist (e.g. `@xxxuni.edu.my`); personal Microsoft
  accounts rejected pre-profile-creation. Design sketch updated; the
  full Step-1 codebase reconciliation (callback PKCE shape, Supabase
  Azure provider config, domain-filter insertion point) happens before
  implementation as usual.
- 2026-08-28: reconciled AU-1 against commit 9c8e484; no migration needed
  (auth-only change); corrected callback param name to `redirect` (route.ts:13),
  password min length to 6 (register.ts:77), rate-limiter import to
  `@/lib/classes/rate-limit`, i18n location to `src/messages/*.json`;
  confirmed callback handles PKCE exchange + cookie set (route.ts:36);
  noted register link actually at login/page.tsx:156–161; noted NO Zod on
  auth path (manual validation style).

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

### AU-1 · Forgot password — shipped (in-progress log, pre-move-out)

**Shipped surfaces**
- `src/lib/auth/reset.ts` — `requestReset` (generic no-oracle success, per-email
  + per-IP budgets via `rateLimit`, host-derived absolute `redirectTo` with
  `host`/`x-forwarded-host` fallback) and `confirmPassword` (min-6 parity,
  per-IP budget). Both localized via the `NEXT_LOCALE` cookie.
- `src/app/(auth)/forgot-password/page.tsx` — email form → generic `role=status`
  confirmation; "Back to sign in" button + footer link.
- `src/app/(auth)/reset-password/confirm/page.tsx` — new-password form with
  mismatch + min-6 client guards, server-error `role=alert` (`resetFailed`),
  success → `/dashboard`.
- `src/app/(auth)/login/page.tsx` — "Forgot password?" link above the error area.
- i18n: 15 keys in `auth` + `resetFailed` in `authErrors` (en/ms parity 877/877).

**Middleware change (production-critical, found by E2E gap audit)**
- `src/lib/supabase/middleware.ts` — added `/forgot-password` and
  `/reset-password` to `PUBLIC_ROUTES`, and **exempted `/reset-password/confirm`
  from the authenticated-auth-page bounce** (`AUTH_BOUNCE_EXEMPT`). Without the
  exemption a user completing the recovery code exchange holds a REAL session
  and would be bounced to `/dashboard` before setting a new password — the
  whole flow strands. This is the single most important correctness catch of
  the audit: the happy path was broken end-to-end in prod.

**Rate-limit harness**
- `playwright.config.ts` — added `RESET_RATE_LIMIT` / `RESET_IP_RATE_LIMIT` /
  `RESET_CONFIRM_RATE_LIMIT: "1000"` (harness-only bump, same class as the
  existing signup/invite bumps; production defaults stay 5/min + 10/min).

**Tests added**
- Unit: `src/lib/auth/reset.test.ts` (21 — no-oracle, 429 mapping, both rate
  budgets + `unknown` IP key, headers()-throws fallbacks, host/proto fallback,
  ms-locale copy, env-tuned `RESET_RATE_LIMIT`).
- Unit: `src/lib/supabase/middleware.test.ts` (auth bounce off new public
  routes, `/reset-password/confirm` exemption, nested public subpaths,
  prefix-collision negative).
- Unit: `src/app/auth/callback/route.test.ts` (NEW — the callback had zero
  coverage before; exchange, sanitized redirect, hostile redirect values,
  no-code → `/login`, cookie write on redirect response, failed-exchange
  tolerance).
- E2E: `e2e/e34-forgot-password.spec.ts` (9 — link nav, generic copy unknown +
  known, min-length + mismatch parity, expired-session `resetFailed` via
  signed-out submit, authenticated bounce off `/forgot-password` +
  `/reset-password/confirm` exemption, BM copy after toggle, no duplicate brand
  link).

**Seam experiment — full happy-path E2E verdict**
- Attempted to make the reset happy path hermetic via the service-role admin
  seam (`auth.admin.generateLink({ type: "recovery" })`, e2e/helpers.ts:628
  `resolveServiceClient`). Result: admin-minted recovery links use GoTrue's
  **implicit `#access_token`** shape, while the app's callback
  (`src/app/auth/callback/route.ts`) only handles the **PKCE `?code=`** shape
  (production `resetPasswordForEmail` is called server-side with
  `flowType: "pkce"`, so production emails DO carry `?code=` and work). The
  admin seam therefore cannot reproduce the production PKCE exchange; driving
  `requestReset` from the browser to seed the verifier cookie does not change
  the admin link's implicit shape.
- **Conclusion:** the happy path (email → click → exchange → confirm →
  `/dashboard`) remains a **manual hosted-mode check** — see below. Everything
  except the email hop is now covered (callback exchange unit-tested, confirm
  page + middleware exemption E2E-tested).

**Manual check (hosted mode) — required before declaring AU-1 done**
1. Configure SMTP or a dev mail catcher in Supabase; ensure the recovery
   template renders (default template is fine).
2. Register an account; go to `/login` → "Forgot password?" → submit email →
   confirm generic "on its way" copy (identical for an unknown address).
3. Open the recovery email, click the link → must land on
   `/reset-password/confirm` (NOT `/dashboard` — regression check for the
   `AUTH_BOUNCE_EXEMPT` middleware change).
4. Set a new password → confirm → lands signed-in on `/dashboard`.
5. Sign out, sign in with the NEW password → success; with the OLD password →
   failure.

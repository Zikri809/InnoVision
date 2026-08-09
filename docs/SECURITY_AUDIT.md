# InnoVision — Security Audit

> **Date:** 2026-08-08
> **Scope:** Phase 1 codebase (Scaffold): Next.js 16 App Router, Supabase auth, shadcn/ui, e2e tests, initial migration.
> **Audit type:** Manual code review — authentication, authorization, RLS, input handling, secrets handling.

---

## Summary

The Phase 1 scaffold has a solid base: RLS is enabled, `.env*` is gitignored, there is no stored/reflected XSS (`dangerouslySetInnerHTML`/`eval`/`innerHTML` are absent), and server pages use the secure `getUser()` pattern.

However, the **role privilege-escalation path is live today** — an attacker can self-register as `lecturer`. This is the highest-priority finding and is followed by an open-redirect and overly-broad RLS policies.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | 🔴 High | Client-controlled `role` allows self-escalation to `lecturer` | ✅ Fixed |
| 2 | 🔴 High | Consent is client-side only; no server/DB enforcement for future face enrollment | ⚠️ Mitigated (server action), re-audit at Phase 7 |
| 3 | 🟠 Medium | Open redirect via `redirect` param in `/auth/callback` | ✅ Fixed |
| 4 | 🟠 Medium | RLS `insert` policy + broad `grant` allow role/embedding self-escalation | ✅ Fixed |
| 5 | 🟡 Low | Redundant `getUser()` in middleware (perf) | Open (accepted) |
| 6 | 🟡 Low | Hardcoded test password in e2e specs | Open (accepted, test-only) |

---

## Findings

### 🔴 HIGH-1 — Privilege escalation: anyone can register as `lecturer`

**Location:** `src/app/(auth)/register/page.tsx:59` and `supabase/migrations/0001_profiles.sql:57`

The register form sends `role` directly into `supabase.auth.signUp({ data: { role } })`, and the DB trigger trusts it verbatim:

```sql
-- 0001_profiles.sql:57
coalesce(new.raw_user_meta_data ->> 'role', 'student')::user_role
```

`user_metadata.role` is client-controlled. An attacker can POST `role: "lecturer"` and immediately receive a lecturer profile. Lecturers later gain control of classes, quizzes, face-unlock, face-exempt, and session-reset endpoints (PLAN §2).

**Fix (server-authoritative role):** register via a server action that always sets `role: "student"` and never trusts client metadata. The DB trigger default (`coalesce(..., 'student')`) is a correct safety net; add a comment that `user_metadata.role` is untrusted.

```ts
"use server";
export async function register({ email, password, fullName }) {
  const supabase = createServerClient(/* anon, server context */);
  return supabase.auth.admin.createUser({
    email, password,
    email_confirm: false,
    user_metadata: { role: "student", full_name: fullName }, // role always 'student'
  });
}
```

---

### 🔴 HIGH-2 — Consent is enforced client-side only

**Location:** `src/app/(auth)/register/page.tsx:40,73` and `src/app/dashboard/dashboard-content.tsx:74`

The biometric-consent promise ("face images never saved, revocable") is gated purely by a checkbox and `consent_given_at` is written via the browser client. There is no DB constraint or server check. When Phase 7 (`/api/face/enroll`) arrives, the client could call it without `consent_given_at` set and with a forged embedding.

**Fix:** enforce `consent_given_at IS NOT NULL` server-side before accepting an embedding (`/api/face/enroll`), and write an `audit_events` row per PLAN §2. Optionally add a DB-level check on enrollment.

---

### 🟠 MED-3 — Open redirect via `redirect` param

**Location:** `src/app/auth/callback/route.ts:7,10`

```ts
const redirect = searchParams.get("redirect") ?? "/dashboard";
...
NextResponse.redirect(`${origin}${redirect}`);
```

The value is used verbatim. An attacker can craft `/auth/callback?code=...&redirect=//evil.com` → after login the user lands on an attacker-controlled site (phishing). The middleware (`src/lib/supabase/middleware.ts:54`) also sets this param from `pathname`, so it must be validated at the sink.

**Fix — allow only local paths:**

```ts
const redirect = searchParams.get("redirect") ?? "/dashboard";
const safe = redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/dashboard";
```

---

### 🟠 MED-4 — Overly broad RLS grant + insert policy

**Location:** `supabase/migrations/0001_profiles.sql:30,42`

```sql
grant select, insert, update, delete on public.profiles to authenticated;

create policy "Users insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);
```

- The `insert` policy is redundant (the trigger creates the profile on signup) and lets any user insert a profile row for their own id with **any role**.
- The `update` policy (`with check (auth.uid() = id)`) also allows a student to set `role = 'lecturer'` and forge `face_embedding` later.

**Fix:**
- Drop the `insert` policy (trigger owns creation).
- Constrain `update` (and insert if kept) with `with check (auth.uid() = id AND role = 'student')`.
- Provide a separate, privilege-verified path (admin RPC / edge function bypassing RLS) for lecturer assignment.

---

### 🟡 LOW-5 — Redundant `getUser()` in middleware

**Location:** `src/lib/supabase/middleware.ts:39`

`getUser()` hits the Supabase auth server for token verification on every request. Correct for security; consider a session cache (e.g. cookie-backed) once request volume grows. Not a vulnerability.

---

### 🟡 LOW-6 — Hardcoded test password in e2e specs

**Location:** `e2e/e1a-auth-consent.spec.ts:6` — `const PASSWORD = "testpass123";`

Fine for Playwright tests, but never seed real data with it and keep test creds out of any committed production seed.

---

## What's already correct (no action)

- `.env*` is gitignored (`src/.gitignore`), only `.env.local.example` (with blank values) is committed.
- No `dangerouslySetInnerHTML`, `eval`, `new Function`, or `innerHTML` anywhere — React escaping holds, no stored XSS today.
- `profiles` RLS is enabled with per-user `select`/`update` policies.
- Server components and route handlers use `supabase.auth.getUser()` (not `getSession()`) — the secure token-verification pattern.
- `proxy.ts` matcher excludes static assets and images from middleware.
- The auth callback always uses anon key (no service role exposed to the browser).

## Notes for future phases (from docs/PLAN.md)

- **Service role key** (`SUPABASE_SERVICE_ROLE_KEY`) is planned for server-only grading / face-compare endpoints — keep it server-only, never in `NEXT_PUBLIC_*`, never used from the browser client.
- **Answer secrecy:** questions must never expose `correct_index` to a client-readable policy/view (planned in PLAN §1). Verify on read.
- **One-attempt enforcement** relies on a partial unique index + security-definer RPC — the security-definer function must validate its own authorization (caller is a lecturer? session belongs to caller?) rather than trusting RLS, since `security definer` bypasses RLS.
- **Face endpoints** (`/api/face/enroll|verify|self-recover|unlock`): every mutation must re-check the session owner / lecturer role server-side, since `security definer` and client-callable routes bypass the page-level auth guard.
- **Storage:** private `quiz-sources` bucket with lecturer-owner RLS only (PLAN §1). Face photos never stored — embeddings only.
- **Rate limiting / abuse:** no rate limiting exists yet; enrollment and verify endpoints are prime abuse targets at demo/class scale.

## Phase 2 additions (2026-08-09)

- **Lecturer provisioning (invite code):** self-signup still always creates a `student` profile (DB trigger hardcodes `student`). A lecturer is only produced when the server action `register()` receives a valid `LECTURER_INVITE_CODE` (constant-time compare) — the user is then promoted via the **service-role admin client** (`src/lib/supabase/admin.ts`, server-only, never imported by client components). `user_metadata.role` remains untrusted.
- **Classes RLS:** `classes` SELECT = owner OR enrolled student (join-code secrecy preserved); INSERT requires `role='lecturer'`; UPDATE/DELETE owner-only with `WITH CHECK` preventing ownership transfer. `class_enrollments` has **no INSERT policy** — enrollment is only via the `join_class(code)` security-definer RPC, which re-validates `auth.uid()` + role, normalizes the code, and hardcodes `student_id = auth.uid()`. RLS helpers (`is_lecturer`, `is_enrolled_in_class`, `is_lecturer_of_class`) are security-definer to avoid cross-table policy recursion.
- **Storage (D12):** private `quiz-sources` bucket; `storage.objects` policies keyed on `(storage.foldername(name))[1] = auth.uid()::text` (NOT `owner`, which is NULL for service-role uploads).
- **Middleware:** unauthenticated `/api/*` requests now get a JSON 401 (not an HTML login redirect); route handlers own their own authz via `requireLecturer`/`requireStudent`.
- **Verified:** `scripts/verify-classes.mjs` (20/20) proves D8 isolation, D12 storage denial, join idempotency/role checks, and escalation probes with real anon tokens. `scripts/verify-security.mjs` (3/3) still green.

## Recommended remediation order

1. **HIGH-1 + HIGH-2 (server-authoritative role + server-enforced consent)** — close the privilege-escalation path and the consent bypass before any lecturer-only feature ships.
2. **MED-3 (open redirect)** — one-line fix in the auth callback.
3. **MED-4 (RLS)** — drop insert policy, tighten update policy.
4. Re-audit before Phase 7 (face pipeline) ships.

## Verified files

| File | Role in scope |
|------|---------------|
| `src/lib/supabase/middleware.ts` | Route guard, session refresh |
| `src/lib/supabase/server.ts` | Server client (anon key) |
| `src/lib/supabase/client.ts` | Browser client (anon key) |
| `src/app/auth/callback/route.ts` | OAuth/callback exchange, redirect |
| `src/app/(auth)/register/page.tsx` | Registration + role picker + consent |
| `src/app/(auth)/login/page.tsx` | Login |
| `src/lib/auth/register.ts` | Server action: register (role fixed to student) |
| `src/lib/auth/login.ts` | Server action: login |
| `src/lib/auth/logout.ts` | Server action: logout |
| `src/app/dashboard/page.tsx` | Authed server page, profile read |
| `src/app/dashboard/dashboard-content.tsx` | Client dashboard, logout |
| `src/app/page.tsx` | Root redirect |
| `supabase/migrations/0001_profiles.sql` | Profiles table, RLS, signup trigger |
| `proxy.ts` | Middleware entry |
| `.env.local.example` | Env template (blank secrets) |
| `.gitignore` | Secret hygiene |
| `e2e/e1a-auth-consent.spec.ts` | E2E auth/consent tests |

---

## Remediation record (applied 2026-08-08)

All fixes verified against live local Supabase + the running app.

### Applied changes

**1. HIGH-1 — Server-authoritative role** (`src/lib/auth/register.ts` new, `src/app/(auth)/register/page.tsx`)
- Added a `"use server"` action `register()` that calls `supabase.auth.signUp` with `role` **hardcoded to `"student"`** and `full_name` from user input. The client no longer touches auth directly for signup; the UI role picker is now display-only.
- Consent write (`consent_given_at`) moved **server-side** into the action (was browser-client).
- The DB trigger now ignores `user_metadata.role` entirely and inserts `'student'` (belt-and-suspenders).

**2. MED-3 — Open redirect** (`src/app/auth/callback/route.ts`)
- `redirect` is now validated: must start with `/` and not `//`, else fall back to `/dashboard`.

**3. MED-4 — RLS tightening** (`supabase/migrations/0001_profiles.sql`)
- Removed the `Users insert own profile` policy (profile creation belongs to the trigger only).
- Update policy now: `with check (auth.uid() = id AND role = 'student')` — a user can never self-escalate role.
- Added `service_role` grant (SELECT/INSERT/UPDATE/DELETE) — previously missing, would have blocked planned server-side grading/face-compare.

**4. All auth moved server-side** (`src/lib/auth/login.ts` + `src/lib/auth/logout.ts` new, `src/app/(auth)/login/page.tsx`, `src/app/dashboard/dashboard-content.tsx`)
- Login (`signInWithPassword`) moved from the browser client into a `"use server"` action (`login.ts`).
- Logout (`signOut`) moved from the browser client into a `"use server"` action (`logout.ts`).
- The browser Supabase client (`src/lib/supabase/client.ts`) is no longer used for any auth operation — register, login, and logout all go through server actions, closing the dev's own flagged "security leaks" on the client.

### Verification (all green)

| Check | Result |
|-------|--------|
| `npm run lint` | 0 errors, 0 warnings |
| `npm run typecheck` | Clean |
| `npm run build` | Production build succeeds |
| `npx playwright test e2e/e1a-auth-consent.spec.ts` | 3/3 pass (register lecturer+student, consent persists, unauthed redirect) |
| `node scripts/verify-security.mjs` (live DB, real auth tokens) | 3/3 pass |
| `supabase db reset --local` + `migration list` | 0001 applied clean |

### Security harness

`scripts/verify-security.mjs` — run against a live local Supabase to re-verify:
1. signup claiming `role=lecturer` → profile is `student`
2. an authenticated student cannot update their own `role` to `lecturer`
3. an authenticated student cannot insert a profile row for another user

### Notes
- `.env.local` (gitignored) was refreshed with current local anon/service keys after the DB reset; the previous `AI_API_KEY` value was lost in the refresh — re-add it when AI-generation routes (Phase 4) are built. Only affects future AI features, not auth.
- HIGH-2 (consent enforcement at the DB layer) is mitigated for Phase 1 but **must** be enforced server-side in `/api/face/enroll` (Phase 7) — the current fix moves the write server-side but does not yet add a DB-level consent gate.

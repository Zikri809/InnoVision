# Plan: QR Code Class Join (scan-to-enroll)

> Status: CRITIQUED — 2 subagent critics (security/architecture,
> implementation/UX) returned findings; all BLOCKER/MAJOR resolutions are
> folded into this revision (see "Critique revisions" below, house format of
> docs/plans/grounded-search.md). Adds a QR code to the lecturer class page
> encoding a universal `/join/[code]` deep link; students who scan are joined
> (or asked to log in first, then returned to the same join).

## Goal

Eliminate manual join-code entry, the highest-friction step in the student
onboarding path and the main trigger of the DB-side lockout
(`class_join_attempts`: 5 invalid codes / 10 min → 15 min lock). A QR on the
lecturer's class page encodes `{origin}/join/{joinCode}`; the landing route
branches on auth state:

- **logged-in student** → confirm-and-join surface (pre-join card → POST
  `/api/classes/join` → success → `/student/classes`);
- **logged-in lecturer** → explanatory "students scan this" state (no join);
- **anonymous** → bounced to `/login?redirect=/join/{code}` (login completes
  → back here → join proceeds).

## Critique revisions (folded in)

1. **[MAJOR] Error-copy i18n keys do NOT exist today — the plan v1 claimed
   they did.** Verified against `src/messages/en.json`: the join drawer's
   namespace `student.classes` carries only `alreadyEnrolled` +
   `joinedNotice` (+ drawer chrome); there is NO `invalidCode`,
   `classArchived`, or `joinLocked` key anywhere. Worse, the drawer's
   non-409 path renders the API's raw English `message`
   (`student-classes-client.tsx:60`) — the existing drawer already leaks
   English under the `ms` locale. Revision: §6 authors the FULL typed-error
   key set (`invalidCode`, `alreadyEnrolled`, `classArchived`, `joinLocked`,
   `forbidden`, `rateLimited`) in BOTH en.json + ms.json under the new `join`
   namespace; the `/join` island maps every typed error to a key. (Fixing
   the drawer's English leak is a separate, optional follow-up — out of
   scope here.)
2. **[MAJOR] Register path silently dropped the redirect — and
   first-day students are the QR flow's primary audience.** The anonymous
   branch lands on `/login?redirect=/join/{code}`, but the login form's
   "Register" link carries no param and `register/page.tsx` hardcodes
   `router.push("/dashboard")` post-signup — the join is lost exactly for
   the population this feature targets. Revision: new work item §4 — carry
   `?redirect=` on the register link, read + `sanitizeRedirect` it in the
   register page, push there after signup (same contract as the login form).
3. **[MAJOR] SSO-start IP rate limit false-positives under classroom NAT.**
   `startInstitutionalSso` limits 10/min keyed on first
   `x-forwarded-for` IP (`sso.ts:9,35`); campus Wi-Fi NATs 40 students
   behind one egress IP, so mass QR onboarding would lock out SSO logins #
   11+. Availability issue (not a bypass — join limits and DB lockout are
   per-user). Revision: raise `SSO_START_RATE` to 60/min AND re-key on
   `ip + stabilized session cookie` if present; added to work item §3 with
   a load-shaped unit test. Implementation must ALSO check the password
   `login` action for the same IP-keyed limiter problem.
4. **[MAJOR→corrected framing] The anonymous bounce is performed by
   MIDDLEWARE, not the page.** `PUBLIC_ROUTES`
   (`src/lib/supabase/middleware.ts:6`) does not include `/join`, so
   unauthenticated hits are bounced (with `redirect=<pathname>` preserved)
   before the page renders — the plan's page-level `redirect()` is
   defense-in-depth, not the mechanism (same as the working `/s/[code]`
   precedent). **Do NOT add `/join` to `PUBLIC_ROUTES`**:
   `shouldBounceAuthenticated` would then bounce LOGGED-IN users to
   `/dashboard`, breaking branches 2–3. §1 rewritten accordingly.
5. **[MAJOR] QR rendering must not use `dangerouslySetInnerHTML`.** Both
   critics converged: use `react-qr-code` (~3 KB, pure React SVG, no
   innerHTML/async — fits the clay dialog directly) or `qrcode` +
   `toDataURL` into an `<img>` (`img-src` CSP already allows `data:`).
   React-rendered SVG chosen. §5 revised.
6. **[MINOR] Reuse `normalizeJoinCode`** (`src/lib/classes/join-code.ts:54`)
   in the `/join` page instead of ad-hoc uppercase+trim — page and API
   validation can't drift (the `/s/[code]` route does the same with
   `normalizeShareCode`). Alphabet excludes 0/O/1/I/L.
7. **[MINOR] Percent-encode the code in the bounce URL**
   (`encodeURIComponent(code)`) — a raw `#`/`?` in the path segment would
   mangle the round-tripped redirect.
8. **[MINOR] Two stated invariants**: (a) the `/join` page performs NO
   class lookup by code (no title fetch, no existence probe) — the
   no-oracle property holds because the API stays the sole authority; the
   confirm card shows the CODE, and the class title arrives only inside the
   200 response (success toast reuses `joinedNotice {title}`).
   (b) `/join` is never added to `PUBLIC_ROUTES` (see 4).
9. **[MINOR] Hide QR affordances on archived classes**
   (`cls.archived_at` is already in the client at
   `class-detail-client.tsx:65`; joining archived classes always 409s).
10. **[MINOR] Auth branch needs a profile read** (role comes from
    `profiles.role`, guards.ts pattern; a missing profile row renders the
    neutral unknown-code card). Stale doc comment at `sso.ts:44-48`
    ("no query param is needed") updated in §3.
11. **[MINOR] e2e helper correction**: `helpers.joinClass` drives the
    `/student/classes` drawer (label-based) and CANNOT drive the `/join`
    confirm; spec (b)/(c) use `helpers.createClass` (returns the code) +
    a role-based locator on the new page (`data-testid` kept as backup).
12. **[MINOR] Deployment hint**: `window.location.origin` QR is correct on
    prod/staging but unresolvable from phones in dev/LAN — the QR dialog
    shows the resolved URL as text so the lecturer can spot it; optional
    `NEXT_PUBLIC_SITE_URL` override documented, not required.
13. **[MINOR] No-auto-submit rationale corrected**: CSRF (`checkSameOrigin`)
    would NOT block an auto-submitting same-origin fetch. The real reasons
    for user-initiation stand: link-preview bots must not fire enrollment
    RPCs, deliberate-confirm UX, and don't burn DB lockout counters on
    drive-by page loads.

## Current-state facts (verified in code by two independent reviewers)

| Fact | Where |
|---|---|
| Join = client POST `/api/classes/join` `{code}` from the join drawer on `/student/classes`; drawer renders raw server English for most errors | `student-classes-client.tsx:50,60` |
| Route errors (typed): `invalid_code`, `already_enrolled`, `not_student`, `class_archived`, `join_locked`, `forbidden`, `rate_limited`, `internal` | `join/route.ts:83-114` |
| Lecturer class page shows + copies the code (mobile chip + desktop card); `ResponsiveModal` already imported there | `class-detail-client.tsx:793-798, 809-822` |
| Middleware bounces anonymous users off non-`PUBLIC_ROUTES` with `redirect=<pathname>` — `/join` will bounce automatically; authenticated users pass through | `src/lib/supabase/middleware.ts:6,81-87` |
| Login form consumes `?redirect=` client-side (`sanitizeRedirect` → `router.push`) | `login-form.tsx:31-35, 99-100` |
| `/auth/callback` honors + re-sanitizes `?redirect=` at point of use (attacker-crafted direct hits fold to `/dashboard`) | `auth/callback/route.ts:17,30` |
| SSO path drops any redirect; `startInstitutionalSso()` takes no args; IP rate limit 10/min | `sso.ts:9,28,64` |
| Register hardcodes `/dashboard` post-signup; login form's Register link carries no redirect | `register/page.tsx:115`, `login-form.tsx:233-237` |
| Student layout gates null-matric OAuth students to `/matric-capture`; `join_class` itself has NO matric dependency (0019:692-746) — join works pre-matric, and the post-capture hardcode lands on `/student/classes` anyway | `(student)/layout.tsx:50-51`, `matric-capture-form.tsx:37` |
| `sanitizeRedirect` preserves query+hash; rejects protocol-relative/backslash/CRLF/encoded variants → `/dashboard` | `src/lib/auth/redirect.ts:14-43` |
| Join code alphabet 32 chars (excl. 0/O/1/I/L); normalization helper exists | `src/lib/classes/join-code.ts:8-14,54` |
| No QR dependency in package.json / lockfile; only existing `dangerouslySetInnerHTML` is the theme boot script | — |

## Design decisions (settled, with rationale)

1. **Confirm-join, not auto-join.** The landing page renders a pre-join
   card ("Join ABC123?") with a single primary CTA. The error states
   (`already_enrolled`, `class_archived`, `join_locked`) need a real surface
   with a back path regardless, so the confirm card is strictly simpler and
   user-initiation keeps link-preview bots from firing enrollment RPCs and
   keeps DB lockout counters meaningful. (CSRF is NOT the reason —
   `checkSameOrigin` passes for same-origin fetches either way.)
2. **Route is top-level `/join/[code]`**, OUTSIDE the `(student)` layout —
   the `/matric-capture` pattern (top-level placement serves pre-auth
   reachability and skips role-gated layout redirects). Root layout
   inheritance is clean (NextIntlClientProvider + Toaster are global).
3. **No class lookup by code in the page** — no-oracle invariant; the API
   is the sole authority on code validity. The confirm card shows the code;
   the class title arrives only in the 200 response.
4. **One universal URL shape**: `{origin}/join/{code}`, origin computed
   client-side at dialog-open (`window.location.origin`) — no
   `NEXT_PUBLIC_SITE_URL` requirement (optional override documented in the
   dialog's hint text).
5. **Bounce-back reuses the `?redirect=` contract** end-to-end; the only
   NEW auth plumbing is SSO threading (§3) + register threading (§4).

## Architecture

### 1. `src/app/join/[code]/page.tsx` (NEW, top-level, server component)

```
middleware (existing, NO changes): anonymous → /login?redirect=/join/CODE
  (page-level redirect kept as defense-in-depth, /s/[code] precedent)

page:
  normalizeJoinCode(segment) → invalid → neutral "check the code" card
  auth branch (createClient → getUser + profile.role read):
    anonymous      → redirect(`/login?redirect=/join/${encodeURIComponent(code)}`)
    lecturer       → "students scan this" info card + link back
    student        → render <JoinConfirmClient code={code} />
    no profile row → same neutral card (signup-trigger race)
```

`/join` must NEVER be added to `PUBLIC_ROUTES` (middleware would bounce
logged-in users to `/dashboard` and destroy branches 2–3).

### 2. `src/app/join/[code]/join-confirm-client.tsx` (NEW, client island)

- Confirm card: code in mono display, one primary button
  (`data-testid="join-confirm"` + role/name locators for e2e), localized
  copy (`join.confirmTitle` etc.).
- POST `/api/classes/join` `{code}` →
  - 200 → toast `joinedNotice {title}` (same key as the drawer; the API
    returns `body.class.title`) → `router.replace("/student/classes")`
  - every typed error → inline alert mapped to NEW `join.*` keys (§6);
    `join_locked` states the 15-min window explicitly.
- `router.replace` (not push): a QR scan is a cold navigation; Back from
  `/student/classes` exits to the camera app — nothing breaks.

### 3. SSO threading — `src/lib/auth/sso.ts`

- `startInstitutionalSso({ redirect }: { redirect?: string })`; the login
  form passes its ALREADY-sanitized value; the action RE-sanitizes
  server-side (`sanitizeRedirect(value, origin)` — never trust the client
  copy) and appends `?redirect=${encodeURIComponent(safe)}` to
  `redirectTo`. `/auth/callback` already sanitizes at point of use.
- Rate limit: raise `SSO_START_RATE` 10→60/min; key on
  `ip + stable cookie` when available (classroom-NAT finding 3). Same audit
  for the password `login` action's limiter.
- Update the now-stale comment at `sso.ts:44-48` ("no query param needed").
- Default when absent stays bare `/auth/callback` → `/dashboard` (zero
  change for existing logins).

### 4. Register threading (NEW — critique finding 2)

- Login form's Register link carries `?redirect=` (when present).
- `register/page.tsx` reads it, `sanitizeRedirect`s it, and pushes there
  after successful signup (replacing the hardcoded `/dashboard`);
  server-side re-sanitization inside the register action mirrors §3.

### 5. QR dialog on the lecturer class page — `class-detail-client.tsx`

- "Show QR" beside the existing copy affordances (mobile chip + desktop
  card), rendered ONLY when `!cls.archived_at`.
- Opens a `ResponsiveModal` (already imported there) with a `react-qr-code`
  SVG (~3 KB, pure React, no innerHTML/async — dep addition), the resolved
  URL as text, the code in mono underneath (projector legibility), and a
  copy-link button. Origin from `window.location.origin` at dialog-open.
- Hand-rolling QR encoding is banned; `qrcode`+`toDataURL` is the fallback
  if `react-qr-code` misbehaves under React 19.

### 6. i18n — `src/messages/{en,ms}.json`

NEW `join` namespace, authored in BOTH files (parity is CI-enforced):
`showQr`, `qrTitle`, `qrHint`, `qrUrlHint`, `copyLink`,
`confirmTitle`, `confirmCta`, `joining`, `joinedSuccess` (reuse pattern of
`student.classes.joinedNotice`), `invalidCode`, `classArchived`,
`joinLocked`, `rateLimited`, `forbidden`, `lecturerNotice`,
`lecturerBack`. Known-issue note: the existing drawer's English-message
leak is out of scope (optional follow-up).

### 7. Testing

| Layer | Coverage |
|---|---|
| Unit (`redirect.test.ts` extension) | `/join/CODE` targets with query+hash preserved through `sanitizeRedirect` |
| Unit (sso/register actions, fake context) | sanitized redirect appended; garbage dropped (bare callback); absent param unchanged; new rate-limit behavior load-shaped test |
| e2e `e52-qr-join.spec.ts` (NEW; next free slot; invite-gated per `docs/TESTING.md`, `expect.configure` timeout pattern from e47) | (a) lecturer opens QR dialog (role-based locators; `helpers.createClass` returns the code); (b) student joins via `/join/{code}` → enrolled + lands `/student/classes`; (c) already-enrolled → localized `already_enrolled` copy, no double-join (NOTE: `helpers.joinClass` drives the drawer, not this page — do not reuse); (d) anonymous `/join/{code}` → middleware bounce → `/login?redirect=…` → password login → back on join page; (e) invalid code → neutral card; (f) register-with-redirect → post-signup bounce completes the join (covers §4) |
| Live-SQL | none — no schema change |

## Deliberate decisions (open to critique)

- **No new migration.** Enrollment, lockouts, and code validity live in
  existing tables/RPCs; the QR is a client-side encoding of an existing
  URL.
- **Lecturer gets an info card, not the join flow** — a lecturer scan is
  almost always a QR test; surfacing `not_student` server copy would
  confuse.
- **Rate-limit raise is scoped**: only `SSO_START_RATE` (and, if the audit
  finds one, the password login limiter) — join limits stay per-user and
  untouched.
- **Announcements (future plan)** can target class pages with the same
  `?redirect=` machinery this plan completes for SSO + register.

## Risks

| Risk | Mitigation |
|---|---|
| GoTrue rejects `redirectTo` with query param (hosted validation quirk) | Verify on hosted staging before merge; fallback = short-lived cookie set by the login page (documented escape hatch, not the default) |
| Students share `/join/{code}` links (QR is photographable) | Accepted — identical to sharing the printed code; trust model unchanged (reviewers verified: carrier change only, brute-force economics identical) |
| Link-preview bots / scanners fetch shared URLs | Page performs zero class lookups; the POST is user-initiated; enrollment RPCs fire only from a deliberate click |
| Stale printed code → student hits `join_locked` | `joinLocked` copy states the 15-min window; lecturer re-displays QR from the live page (codes don't rotate) |
| Classroom NAT + SSO (rate-limit finding) | `SSO_START_RATE` raise + re-keying in §3, with a load-shaped test |
| SSO + matric-capture chain | `/join` needs no matric; post-join `/student/classes` bounces to capture; capture's hardcode lands on `/student/classes` — acceptable (join persists) |
| dev/LAN QR URLs unresolvable from phones | Dialog shows the resolved URL as text; optional `NEXT_PUBLIC_SITE_URL` override |

## Rollout order

1. `join/[code]` route + confirm island + error-key i18n (self-contained;
   valuable without QR — the URL works on a whiteboard).
2. SSO + register redirect threading (+ unit tests) — independent, small;
   register piece fixes a real drop for existing flows too.
3. QR dialog + `react-qr-code` dep on the lecturer page (+ archived-class
   gating).
4. e2e spec lands with the pieces it exercises; i18n keys land per PR to
   keep `check:i18n` green.

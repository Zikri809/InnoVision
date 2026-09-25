# Plan: Demo Mode (exhibition kiosk with concurrent walk-up visitors)

> Status: CRITIQUED — proposed 2026-09-25, 2 critique rounds × 3 subagent
> critics (security/architecture, implementation/Next.js, demo-day operations);
> BLOCKER/MAJOR resolutions folded into this revision (see "Critique revisions"
> below, house format of docs/plans/grounded-search.md). Flag-gated demo
> infrastructure for exhibition day: one seeded lecturer account, walk-up
> visitors scan a QR and get an auto-created student account already joined to
> the demo class, plus a presenter-led lecturer showcase. Everything lives
> behind `NEXT_PUBLIC_DEMO_MODE=1` and is dead code in production.

## Goal

Support two distinct demo audiences on one machine:

1. **Walk-up crowd track (concurrent, self-service):** visitors scan a QR at
   the booth, tap one button, and are dropped into the demo class with a
   **practice-mode** quiz they can play immediately in parallel — click
   answering, no camera, instant score reveal on submit. No typing, no
   passwords, no account collisions.
2. **Lecturer showcase track (presenter-driven):** the presenter drives the
   lecturer side (create class → AI-generate quiz → live monitoring →
   results/integrity) and, with a volunteer, face enrollment + finger
   gestures + pause/flag choreography. **The crowd doubles as live data:**
   practice sessions ARE real `quiz_sessions` rows with stored scores (the
   practice branch of `start_quiz_session` inserts a session row,
   `0066:554-556`; practice submit computes a score, `0012:467-539`), so the
   lecturer live-session view fills with "Guest #N (Visitor)" entries as the
   crowd answers. Practice start skips the consent/face gates (the gate block
   precedes them, `0066:527-584`), which is exactly why guests can play
   without enrollment.

## Design decisions (settled)

- **Per-visitor guest accounts, not pooled logins.** The attempt invariant is
  one active session per (quiz, student) — sharing one student account would
  collide on session rows, timers, and results. Guests are cheap:
  `admin.auth.admin.createUser({ email, password, email_confirm: true })`
  (same pattern as `scripts/seed-demo.mjs:76` — the password is REQUIRED:
  D2 signs the guest in via `signInWithPassword` immediately after creation).
- **Guest matric from the `98xxxx` range, NOT `99xxxx`.** The reserved
  namespace is write-refused three ways: `handle_new_user` nulls any `^99`
  metadata (`0050_audit3_auth_hardening.sql:105`), the
  `profiles_matric_no_not_reserved` CHECK blocks new service-role writes
  matching `^99` (`0046_audit2_hardening.sql:1118`), and NULL matric wedges
  the guest behind `/matric-capture` + `join_class` refuses
  (`matric_required`, `0046:92`). `98xxxx` passes the `^[0-9]{6}$` shape and
  the `!~ '^99'` reserve checks in both. Assigned via `user_metadata.matric_no`
  (the trigger maps it to `profiles.matric_no`, `0050:99-108,171-178` —
  verified). `profiles_matric_no_unique` (`0027:38`) is enforced inside the
  trigger, so allocation must be **random within `980000–989999` + retry on
  23505** (max-scan races under concurrent bursts; retry precedent
  `seed-demo.mjs:79`). "Guest #N" derives from a count of existing
  `guest-*@demo.innovision.test` users (approximate is fine for a roster
  label).
- **Entry point is the REAL QR flow, not a special kiosk page.** Visitors scan
  `{origin}/join/{DEMO_JOIN_CODE}` — the exact feature we demo. The demo
  branch only changes what happens to *anonymous* scanners of the demo class
  code; all other QR behavior is untouched.
- **Guest emails** `guest-<8rand>@demo.innovision.test`, `role='student'` via
  metadata. Institutional-domain note: `handle_new_user`'s GUC gate
  (`app.institutional_email_domains`, migration 0050:133-168) only REJECTS
  emails whose domain IS listed — guests pass with the GUC unset OR set; the
  only requirement is that `demo.innovision.test` is NOT in the list. (Never
  "allowlist" the demo domain — that would raise on every guest.)
- **Guest naming** "Guest #N (Visitor)" so the lecturer live-session view
  projects a believable roster. Guests are full student principals (can
  author practice quizzes, hit student-AI spend) — accepted booth risk;
  per-user spend caps + the reset scripts contain it.
- **Two quizzes in TWO classes (leak containment):**
  - **Demo class** (guests auto-join): contains ONLY the walk-up quiz —
    **`mode: 'practice'`**. Practice answers reveal correctness + explanation
    instantly on the wire (satisfying booth loop) and skip the face gate
    entirely (gate applies only to `mode === 'assessment'` starts).
    Containment facts (corrected): practice sessions DO create
    `quiz_sessions` rows and scores — but that is a FEATURE here (live
    monitor data); deletion cascades make resets clean
    (`quiz_sessions.quiz_id` cascade, `0008_sessions.sql:34`). Guests never
    see the showcase quiz, can't enroll faces into the showcase dataset —
    `student_quiz_view` only exposes LIVE quizzes of ENROLLED classes
    (`0060:44-58`, verified).
  - **Showcase class** (demo lecturer only, guests NEVER join): the
    gestures-ON assessment quiz kept in **draft** until showtime (zero
    enrollment = invisible to guests by construction) + the seeded
    closed-and-revealed history quiz for dashboards. Its join code is a
    RANDOM 6-char legal-alphabet string generated at seed time, never
    printed anywhere (guessable fixed codes are a self-enroll door).
- **Walk-up quiz resets = recreate, not re-publish.** The lifecycle is
  one-way (draft→live→closed; reveal irreversible) and
  `quiz_status_transition` forces insert-as-draft even for service-role
  (`0004:156-162`) — so resets create a FRESH practice quiz then transition
  it live (same shape as `ensureQuiz`), never mutate lifecycle state.
- **Reused-phone handling (second visitor on the same device).** Session
  cookies persist for hours; the next scanner silently continues as the
  PREVIOUS guest. The demo branch therefore covers BOTH states: anonymous →
  mint-and-join; authenticated with a `@demo.innovision.test` email →
  "Continue as Guest #N" + "Start fresh" (client sign-out → re-run mint).
  Real-account users keep the ordinary confirm-and-join (their real session
  is never replaced).
- **Face enrollment is NOT auto-provisioned** (biometric enrollment stays a
  deliberate user action, same posture as the seed). The showcase track does
  it live with a volunteer, on the presenter machine.
- **Lecturer mode for visitors = Option A only:** hand them a device already
  logged into the demo lecturer account; they click, you narrate. No
  auto-provisioned lecturer accounts, no lecturer-guest route (escalation
  surface, dataset mutation, AI spend), no credential pool (dropped).

## Build items

### Phase 1 — Flag + guest provisioning

- [ ] **D1. `NEXT_PUBLIC_DEMO_MODE` flag + gate.** New module
  `src/lib/demo/gate.ts` exporting `DEMO_JOIN_CODE` (pure, middleware-
  importable) and `isDemoModeEnabled()` = `process.env.NEXT_PUBLIC_DEMO_MODE
  === "1"` — explicit-only (does NOT auto-on in dev, unlike
  `isDevPlaygroundEnabled`). `NEXT_PUBLIC_` because the middleware branch
  (D3) runs in the Edge sandbox where non-public env is build-time-inlined;
  harness-flag precedent `NEXT_PUBLIC_E2E_FAKE_SEAM` (`seam-gate.ts:18`).
  The flag must be present at `next build` AND runtime. Anti-carry, ALL of:
  `.env.local.example` row (commented `# NEXT_PUBLIC_DEMO_MODE=` —
  `check-env-parity.mjs:63-85` SCANS `src/**` and FAILS without it, so this
  blocks `check:env`); CI kill-switch assertion
  (`.github/workflows/ci.yml:202-227` posture); `KILL_SWITCHES` in
  `src/lib/prod-guards.ts:68`; Dockerfile ARG default `"0"` (`Dockerfile:142`
  block); `deploy/build-images.sh:143` assertion.
- [ ] **D2. `POST /api/demo/guest`** (gated: flag-off responds via
  `notFound()` — framework-identical 404, no typed-shape oracle). Steps,
  following the API preamble (ARCHITECTURE §3):
  1. Rate limit with booth reality in mind: run the booth build with
     `TRUSTED_PROXY_COUNT=0` so `clientIpFromHeaders` ignores spoofable
     forwarding headers and the honest crowd collapses into ONE shared
     bucket; budget ≥300/10min (50 visitors burst comfortably) plus an
     **absolute cap on live guest accounts (~200)** — per-user spend caps
     bound AI spend, not account count.
  2. `createAdminClient().auth.admin.createUser({ email:
     guest-<8rand>@demo.innovision.test, password: <random 24-char>,
     email_confirm: true, user_metadata: { full_name: "Guest #N (Visitor)",
     matric_no: <random 98xxxx> } })`. Retry loop on 23505 (matric race);
     regenerate BOTH email suffix and matric on collision. No listUsers
     lookup in the hot path.
  3. Sign in server-side: `signInWithPassword` via `createClient()` in the
     route handler (cookies writable there; mirrors
     `src/lib/auth/login.ts:101`; chunked cookies handled by @supabase/ssr;
     pinned name matches proxy refresh). Then **assert `getUser()`** returns
     the guest before responding — the shared `COOKIE_HANDLERS.setAll`
     swallows cookie-set failures; a 200 with no session is a silent
     booth-killer.
  4. Enroll into the demo class via the `join_class` RPC (matric present,
     real semantics; idempotent `already_enrolled` tolerated).
  5. Return `{ redirect: "/student/quizzes" }` (the quiz list — the classes
     page costs the crowd one extra tap reading a poster).
- [ ] **D3. Middleware demo branch (SKIP only).** The anonymous→`/login`
  bounce lives in `updateSession` (`src/lib/supabase/middleware.ts:124-131`),
  NOT proxy.ts (which only delegates + matcher). Edit THERE: skip the bounce
  only when `isDemoModeEnabled()` AND
  `normalizeJoinCode(pathname.split("/")[2]) === DEMO_JOIN_CODE`
  (`join-code.ts` has zero imports — Edge-safe; `split("/")[2]` is correct
  for `/join/CODE`; `normalizeJoinCode` returns null on malformed → falls
  through to the bounce). Do NOT add `/join` to `PUBLIC_ROUTES` (would 302
  logged-in users to `/dashboard`). Flag-off / non-demo codes:
  byte-for-byte current behavior. Add a `middleware.test.ts` row.
- [ ] **D4. `/join/[code]` demo branch IN THE PAGE — both auth states.** The
  page's own `!user → redirect("/login?…")` (`page.tsx:83`) would fire even
  when middleware skips the bounce, so the branch lives BEFORE it, gated
  **`isDemoModeEnabled() && normalizeJoinCode(code) === DEMO_JOIN_CODE`**:
  - **anonymous** → confirm card → POST `/api/demo/guest` →
    `router.replace(redirect)`;
  - **authenticated guest email** → "Continue as Guest #N" / "Start fresh"
    (client `signOut()` → re-run mint);
  - **authenticated real account** → falls through to the ordinary
    confirm-and-join (never replaced).
  No state passing — the code param IS the state, re-verified server-side.
  Files: `page.tsx` + new `demo-confirm-client.tsx` island; `demo.*` i18n
  keys in BOTH en.json + ms.json (check:i18n enforces parity).

### Phase 2 — Demo dataset + booth ops

- [ ] **D5. Seed extension (`scripts/seed-demo.mjs`):** SMALLER than
  round-1 assumed — the seed already authors lecturer-owned
  `mode:'practice'` quizzes (`seed-demo.mjs:419-492`; mode is a plain enum,
  `0004_quizzes.sql:9,38`, no creator/mode trigger), and `seedSession` is
  invoked explicitly per quiz so no accidental sessions land on the walk-up
  quiz. Add: demo lecturer (fixed password synced with the run-sheet),
  **demo class** (fixed join code `SCAN23` — legal alphabet
  `^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$` EXCLUDES O/0/1/I/L; `DEMO23` is
  illegal) + its walk-up practice quiz (live; gestures false
  belt-and-braces), **showcase class** (random unprinted join code, draft
  gestures-ON assessment quiz + reuse of the seeded closed history).
  Idempotent like the rest.
- [ ] **D6. Reset scripts — split by blast radius.** Single source of truth
  in `src/lib/demo/walkup-reset.ts` (service-role admin client,
  `resetWalkup({ maxAgeHours })` → summary object). Thin route
  `POST /api/demo/reset-walkup` wraps it (flag-off `notFound()` →
  same-origin → **authorize: session profile must be the demo lecturer**
  (email match vs `DEMO_LECTURER_EMAIL` env — no new token to leak) →
  confirm body flag → run). `npm run demo:reset:walkup` = 5-line fetch to
  `http://localhost:3000` (server running at booth by construction) — page
  button and CLI share identical logic, zero duplication. What it does:
  deletes guest accounts older than N=2h (FK cascade: auth.users→profiles→
  enrollments→sessions→answers/notifications — verified end-to-end),
  strips non-guest enrollments from the demo class, recreates the walk-up
  practice quiz (create-then-publish), logs a summary. Full morning
  `demo:reset` additionally runs the pre-flight report.
  Documented non-fix: stale guest cookies after deletion degrade gracefully
  (refresh → getUser null → cookies cleared → anonymous bounce) — leave it.
- [ ] **D7. `npm run demo:prep`** one-command morning boot:
  `supabase start → db:reset → seed:demo → face:start → demo:reset →
  next build (with NEXT_PUBLIC_DEMO_MODE=1) → next start -H 0.0.0.0`.
  Build AFTER seeding; flag present in build env per D1.

### Phase 3 — Serving topology, run-sheet, contingencies

- [ ] **D8. Booth network + origin topology (decided):**
  - **Presenter laptop = `localhost` origin** (secure context → camera
    works → showcase track runs here).
  - **Visitor phones reach `http://<booth-LAN-IP>:3000`** (same machine,
    `next start -H 0.0.0.0`) on a **dedicated travel router / phone hotspot
    — never venue wifi**. Plain-HTTP LAN has NO `navigator.mediaDevices` —
    accepted: the walk-up track never touches the camera (practice mode).
  - Cookie fact (corrected): @supabase/ssr sets NO `secure` flag at all
    (`DEFAULT_COOKIE_OPTIONS`: path/sameSite/httpOnly/maxAge only), so the
    LAN-HTTP round-trip works by default — still pre-flight-verify
    SameSite=lax survives the redirect chain on a real phone.
- [ ] **D9. `/demo` status page (`src/app/demo/page.tsx`, top-level,
  deliberately OUTSIDE the proxy matcher; self-gates with
  `!isDemoModeEnabled() → notFound()` + own auth).** Renders pre-flight
  ticks (flag on, DB seeded, sidecar up, AI keys, walk-up quiz live,
  375px smoke, camera probe on presenter device) + run-sheet + the
  "Reset walk-up" button → POST the route from D6, confirm dialog lists the
  blast radius ("removes N guests older than 2h + recreates the quiz"),
  labeled "Between shows only". Page itself requires the demo-lecturer
  session (visitor phones on the booth LAN can otherwise read internals —
  flag-gating is not authorization). Guest-join probe: deletes its probe
  guest immediately + cooldown so repeated pre-flight presses don't consume
  budget.
- [ ] **D10. Presenter run-sheet (printed AND on `/demo`):**
  - **Booth card / poster:** "1. Scan the QR 2. Tap Join the demo 3. Answer
    the quiz — watch the big screen!" + backup QR print.
  - **Big screen definition:** presenter laptop mirrored to the projector;
    lecturer live-session view during the monitoring beat, quiz player
    during the showcase beat — switch sources only between beats.
  - **10-min lecturer walkthrough:** create class → QR join → AI-generate
    from topic → publish → live session view filling with Guest #N entries
    (crowd practice sessions ARE the data) → close + reveal → integrity
    dashboard.
  - **5-min showcase:** volunteer enrolls (presenter laptop) → gestures-ON
    quiz → finger answering → deliberate look-away pause → flag on lecturer
    view → unlock.
  - **Fallbacks (rehearsed):** AI generation fails → manual authoring OR
    pre-generated draft; network death → seeded student accounts' historical
    sessions for the monitoring beat; camera misbehaves → skip to
    results/integrity on seeded data.
  - **Between shows:** `demo:reset:walkup` (or `/demo` button).
  - **Booth machine settings checklist (hour-3 killers):** disable OS +
    display sleep / presentation mode, keep plugged in, disable browser
    Memory/Energy Saver (tab sleep kills MediaPipe + monitoring timers),
    keep presenter tabs foreground, defer Windows Update restarts.
  - **Kit list:** spare laptop imaged with `demo:prep` run + verified
    (swap ≤10 min), chargers, printed credentials sheet (never on-screen),
    backup QR, tape.
- [ ] **D11. Post-submit demo footer (build item, not poster copy):** the
  practice EndScreen gets a `demo.*` footer — score + "Nice! Watch the big
  screen / hand the phone back" + a **"Done" button** (client
  `supabase.auth.signOut()`), giving guests a clean exit and next-visitor
  devices a clean slate. Both locales.

### Phase 4 — Tests

- [ ] **D12.** `middleware.test.ts`: anonymous + demo code + flag on → NO
  login bounce; flag off → current bounce preserved. Route tests:
  `/api/demo/guest` 404 flag-off (`notFound()` shape), happy path
  creates+signs-in+enrolls, rate-limit + guest-cap trip, 23505 retry.
  e2e unaffected while the flag stays unset in playwright webServer env
  (`e52-qr-join.spec.ts:105` keeps passing).

### As-built notes (implementation divergences from the plan text)

- **D6 CLI duplication is acknowledged + parity-pinned.** A bare node fetch
  cannot present the SSR session cookie the reset route requires, so
  `scripts/demo-reset.mjs` re-implements `resetWalkup()`'s steps rather than
  calling it. `src/lib/demo/gate.test.ts` pins the shared literals
  (`SCAN23`, `demo-lecturer@innovision.test`, the guest domain) across
  gate.ts / seed-demo.mjs / demo-reset.mjs so the copies cannot drift.
- **e59, not e44**: the walk-up spec was renumbered to
  `e2e/e59-demo-walkup.spec.ts` (e44 was already taken by the duplicate-quiz
  spec).
- **Session binding**: the guest route asserts `user.id === guest.id`, not
  just the email domain (adversarial round 1).

## Critique revisions (folded in)

**Round 1:**
1. [BLOCKER→fixed] `99xxxx` matric claim false (trigger nulls, CHECK
   refuses, NULL wedges) → `98xxxx` via metadata.
2. [BLOCKER→fixed] `DEMO23` join code illegal ('O' excluded) → `SCAN23`.
3. [BLOCKER→fixed] D3 ignored the page's own anonymous bounce → branch in
   `page.tsx` before the redirect; middleware only skips.
4. [MAJOR→fixed] `DEMO_MODE` build-time-inlined in middleware →
   `NEXT_PUBLIC_DEMO_MODE` + CI assertion + build in D7.
5. [MAJOR→fixed] GUC remedy inverted (allowlisting would RAISE) → corrected.
6. [MAJOR→fixed] createUser lacked a password; swallowed cookie-set failure
   → password + `getUser()` assertion.
7. [MAJOR→fixed] Per-IP limit would throttle the booth's own crowd → sized.
8. [MAJOR→fixed] Showcase quiz leaked to guests → two-class containment.
9. [MAJOR→fixed] Quiz exhaustion / dead-end UX / reset legality → practice
   mode + recreate-not-republish + blast-radius split.
10. [MAJOR→fixed] QR origin/camera topology undefined → D8 pinned.
11. [MAJOR→fixed] Ops gaps → run-sheet fallbacks, status page, kit list.
12. [MINOR→noted] Guests are full student principals — accepted, contained.
13. [MINOR→noted] Real-account scanner keeps ordinary confirm-and-join.
14. [NIT→fixed] Dedicated `src/lib/demo/gate.ts`, explicit-only; typed 404
    posture (superseded by `notFound()` in round 2).

**Round 2:**
15. [BLOCKER→fixed] "Crowd as live data" vs practice-statelessness
    contradiction — practice DOES write session rows + scores
    (`0066:554-556`, `0012:467-539`); goal holds; false claims corrected.
16. [MAJOR→fixed] Matric max-scan race under concurrent bursts (unique
    index in-trigger, `0027:38`) → random + 23505 retry; Guest #N from
    guest-email count.
17. [MAJOR→fixed] Reused phone silently continues as previous guest →
    D4 handles authenticated guest emails ("Start fresh" / "Continue").
18. [MAJOR→fixed] `/demo` reset unauthenticated on booth LAN → demo-lecturer
    session required (page + route); flag-gating ≠ authorization.
19. [MAJOR→fixed] Flag-carry unguarded outside CI → `KILL_SWITCHES`
    (`prod-guards.ts:68`) + Dockerfile ARG + build-images.sh assertion.
20. [MAJOR→fixed] Per-IP key forgeable (`x-real-ip` mints buckets) →
    `TRUSTED_PROXY_COUNT=0` + higher shared budget + absolute guest cap.
21. [MAJOR→fixed] D3 named the wrong file (bounce lives in
    `src/lib/supabase/middleware.ts:124-131`) → corrected; `DEMO_JOIN_CODE`
    exported from the pure gate module.
22. [MAJOR→fixed] Round-1 dead-end fix was poster copy, not a build item →
    D11 (footer + Done/signOut).
23. [MAJOR→fixed] Zero 8-hour-runtime ops guidance → booth machine settings
    checklist (D10).
24. [MAJOR→fixed] D5 claim "seed lacks practice authoring" false — seed
    already does (`seed-demo.mjs:419-492`); work scope corrected;
    reset must create-then-publish (`quiz_status_transition` forces
    draft-on-insert, `0004:156-162`).
25. [MINOR→fixed] Cookie "Secure on https only" claim wrong — @supabase/ssr
    sets no secure flag at all; D8 corrected, pre-flight kept.
26. [MINOR→fixed] No guest logout story → D11 "Done" signOut button.
27. [MINOR→fixed] Showcase class join code guessable → random unprinted.
28. [MINOR→fixed] `/demo` join-probe pollutes (rate budget, roster) →
    immediate probe cleanup + cooldown.
29. [MINOR→fixed] `check-env-parity` is a hard gate, not a nicety →
    `.env.local.example` row required for `check:env` to pass (D1).
30. [MINOR→fixed] D2 redirect `/student/classes` costs a tap →
    `/student/quizzes`.
31. [MINOR→fixed] Reset confirm shows no impact → blast-radius dialog +
    "Between shows only" label (D9).
32. [MINOR→fixed] Big screen never defined → D10 one-liner (mirrored laptop,
    view per beat, source switches between beats).
33. [MINOR→noted] Stale-guest-cookie post-reset degrades gracefully
    (verified) — documented non-fix (D6).
34. [NIT→fixed] D4 branch explicitly gated on the demo condition with
    real-account fall-through (auth states enumerated).
35. [NIT→fixed] Flag-off route uses `notFound()` (framework-identical 404,
    no shape oracle).
36. [NIT→fixed] `/demo` placed top-level, outside the proxy matcher,
    self-gating (D9).
37. [NIT→verified] Volume math holds: per-IP 100+/10min adequate, GoTrue
    local `email_confirm:true` sends no mail, in-memory limiter fine on a
    single `next start`, `98xxxx` headroom (~10k) exceeds daily volume.

## Non-goals

- No auto face enrollment for guests (deliberate user action).
- No lecturer provisioning for visitors (Option A only).
- No changes to production auth paths — every demo touch point checks
  `isDemoModeEnabled()` first; flag off = byte-for-byte current behavior
  (CI + prod-guards + Docker assertions make accidental carry impossible).
- No i18n scope beyond the `demo.*` keys (en + ms parity).

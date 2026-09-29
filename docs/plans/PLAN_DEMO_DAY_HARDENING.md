# Plan: Demo-Day Hardening — App Fixes + Tunnel-Booth Ops

> Status: PART A IMPLEMENTED — 2026-09-27 (all code + tests + docs items
> landed; gates green — see "As-built notes"). Part B remains an ops run-sheet
> for exhibition week.
> - **Part A** — app-bug fixes for the demo track (7 code fixes + docs/tests).
> - **Part B** — tunnel-booth operations run-sheet (local stack + Cloudflare
>   tunnel, so guests stay on their own data; zero wifi-joining).
>
> Verified context: the demo-day gap audit (artifacts: demo LIB `src/lib/demo/*`,
> guest route, reset route + CLI twin, `/join` branch, `/demo` control room, e59
> spec, seed/reset scripts, Next 16 `request.url` construction traced through the
> shipped bundle, migration RPC sources). Nothing below is assumed — file:line
> citations are load-bearing, and each fix lists its regression test.

## Design decisions (settled)

### Face gates for guests: neither bypass nor verification (A1's premise)

The walk-up track touches three distinct gates. Verified per-gate:

- **Gate 1 — Face *enrollment* (samples + liveness).** Guests are fully exempt
  already, with zero code needed. The `enrolled` quiz-list banner
  (`student-quizzes-client.tsx:205/422`) is a passive, non-blocking pill. The
  play page only arms the face gate when `mode === "assessment" AND
  gestures_enabled === true` (`src/app/play/[sessionId]/page.tsx:283-289`);
  both guest-playable quizzes seed gestures-off (`seed-demo.mjs:610,630`), so
  `initialFaceStatus = "off"` and the whole verification stack (face pipeline,
  per-answer HMAC identity binding in `commit_answer`, verify-silence cron
  candidacy) stands down by design. The RPC deliberately does NOT require
  `enrolled` status to start (0062 header: "camera-off acceptance"). No
  enrollment bypass flag is required — the existing `gestures_enabled` toggle
  IS the bypass.
- **Gate 2 — Biometric *consent* (`consent_given_at`).** The ONLY gate guests
  collide with, and only on the curated assessment (`0062:662` demands it for
  every assessment start; practice returns at `:605-648`, before the check).
  Consent here does double duty: privacy invariant for camera use AND a
  start-authorization token. For a gestures-off assessment on a camera-less
  phone it authorizes nothing physical — pure paperwork.
- **Gate 3 — Duplicate-identity review (`pending_review`).** Irrelevant: no
  enrollment means no review flag, and `0062:665` refuses only `pending_review`
  rows, not nulls.

**Decision: keep A1's consent-at-provisioning; build no bypass, require no
verification.** A consent bypass (skipping the check for guest identities)
would be a role-shaped hole in a security gate and needs an RPC migration to
do cleanly — rejected. Requiring face verification is physically impossible on
plain-HTTP phones (no `mediaDevices`), contradicts PLAN_DEMO_MODE's non-goal
("no auto face enrollment — deliberate user action"), and destroys the
30-second walk-up loop — rejected. `grant_face_consent` writes ONLY
`consent_given_at` under the `app.consent_write` GUC (`0019:567-601`) — no
samples, no camera, no enrollment state change. Semantically: "this booth
account consents to biometric processing should any occur" — and none will.

**INVARIANT (do not "fix" later): guest consent ≠ guest enrollment. The face
stack stays off via `gestures_enabled=false`, never via identity checks.** If
anyone flips a walk-up quiz to gestures-on, guests hit the real face gate
(`"gate"` phase, `commit_answer` proof requirement) and hard-fail. Guardrail
on the run-sheet (§A8, §B6): "never enable gestures on walk-up quizzes."

## Part A — app fixes (code)

Work order is blast-radius order: A1–A4 un-break core beats; A5–A7 close the
remaining holes. All demo-surface text goes through existing `demo.*` i18n keys
(en + ms parity, `npm run check:i18n`).

### A1. Curated assessment is unstartable by guests (`consent_required`)

**Bug.** `start_quiz_session` (`0062_quiz_integrity_gates.sql:650-667`) gates
EVERY `mode='assessment'` start on `consent_given_at` — gestures-off included.
The walk-up flow never grants consent, so Start on "Demo Assessment — Click to
Answer (No Camera)" returns `403 consent_required`, and the quiz-list copy
(`src/messages/en.json:803`) points guests at Face Setup, which is a dead end
on a plain-HTTP camera-less phone. The practice quiz ("Try InnoVision") is
unaffected (practice branch returns at `:605-648`, before the gate). Seed
comment `seed-demo.mjs:620-622` claims guests can play the curated assessment —
that claim is false.

**Fix (recommended): consent at provisioning.** In
`src/app/api/demo/guest/route.ts`, after the `user.id === guest.id` session
assertion and before `joinDemoClass`, call the sanctioned RPC with the guest's
own session:

```ts
const { error: consentError } = await userClient.rpc("grant_face_consent");
```

Rationale: guests are told nothing camera-related happens; consent here
authorizes *starting* assessments, and the consent is booth-scoped (account
deleted by the reset). See "Design decisions" above for the full face-gate
analysis: no bypass flag, no guest verification — consent-at-provisioning is
the middle path, and the `gestures_enabled=false` toggle (not identity
checks) is what keeps the face stack off. Alternatives considered and
rejected: converting the curated quiz to `practice` (loses the
assessment/keyless-ack beat the seed wants to show), hiding it (wastes seeded
content), relaxing the RPC (weakens a real security gate for a demo
convenience — never), a guest-shaped consent bypass in the RPC/route (a
role-shaped hole in a security gate — never).

- Failure posture: a consent failure must NOT fail provisioning (the practice
  quiz is the primary loop). Warn server-side like the join-fail path and let
  the start error surface per-quiz as today.
- i18n: none new (existing `consentRequiredStart` copy stays as the fallback).
- Regression: route test asserting `grant_face_consent` is invoked on the guest
  session post-provision; keep a failure-tolerant variant (consent RPC throws
  → still 200 + redirect).
- Cross-check: `grant_face_consent` only writes `consent_given_at` under the
  `app.consent_write` GUC (`0019:567-601`) — no face data involved.

### A2. "Continue as Guest #N" mints a NEW guest instead of continuing

**Bug.** `src/app/join/[code]/demo-confirm-client.tsx:127` wires the Continue
CTA to `provision()` → `POST /api/demo/guest`, and the route unconditionally
`createGuestUser`s (`src/app/api/demo/guest/route.ts:100-109`). A reused phone
thus creates Guest #N+1 while #N orphans (roster bloat, 2× cap burn on shared
booth devices).

**Fix.** Continue performs NO POST:

```tsx
onClick={() => { router.replace("/student/quizzes"); router.refresh(); }}
```

Only "Start fresh" keeps the sign-out → mint sequence. Copy already matches
("Continue as {name}").

- Regression: e59 addition — seed/authenticate an existing-guest session,
  visit `/join/SCAN23`, click Continue, assert landing on `/student/quizzes`
  with the user table delta = 0 (service-role count before/after).

### A3. Join-failure strands the visitor on an empty quiz list

**Bug.** On `joinDemoClass` failure the guest route still returns
`{redirect: "/student/quizzes"}` (`route.ts:147-156`, warn-only). The
signed-in-but-unenrolled guest sees `EmptyState` (both mobile `:235` and
desktop `:464` branches of `student-quizzes-client.tsx`) with no error and no
retry; the "confirm card retries" comment doesn't survive the redirect.

**Fix (two-sided).**
1. Route: on join failure return `{ redirect: "/student/quizzes?join=retry",
   joinError: <typed rpc error> }` (still 200 — the session is real).
2. Quiz-list page (`src/app/(student)/student/quizzes/page.tsx`): when
   `?join=retry` is present AND the list is empty, pass a `joinRetry` prop
   (code `SCAN23` under demo flag) so the client renders a "Retry joining the
   demo" button that POSTs `/api/classes/join {code}` and refreshes on
   success. Reuses the existing `join-confirm-client` POST shape; non-demo
   empty lists are untouched.

- i18n: 3 keys (`demo.joinRetryCta`, `demo.joinRetryTitle`, `demo.joinRetryFailed`).
- Regression: route test (join RPC `error` → payload carries `joinError`);
  client-level e59 variant asserting the retry button appears with the query
  param (mock or flag-gated).

### A4. "Live board" beat needs polling or it goes flat

**Bug.** The results dashboard (`results/page.tsx` + `lecturer_session_view`,
which DOES include practice rows — that half of the plan holds) is a one-shot
RSC read. `results-dashboard-client.tsx` only `router.refresh()`es after
lecturer mutations (`:297,321,360,404`) — no timer, no subscription. The
mirrored big screen sits static while the crowd answers.

**Fix.** Add an opt-in auto-refresh toggle on the dashboard client:
- Default ON, 8s cadence, `router.refresh()` on tick; pause when the tab is
  hidden (`document.visibilityState`), when any dialog is open (reveal/close/
  reset — a mid-dialog refresh races the mutation), and when any row action is
  busy (`busyRows.size > 0`).
- A visible toggle ("Live updates: on/off") so the presenter can freeze the
  board for close/reveal beats. `useEffect` + `setInterval`; cleanup on
  unmount. No new API surface — refresh re-runs the RSC read.
- i18n: 2 keys (`lecturer.results.liveUpdatesOn/Off` or under `demo.*` if
  scoped to the walk-up quiz — prefer lecturer namespace: it's a general
  monitoring feature, demo just pays for it).

- Regression: unit test on the cadence/pause predicates (extract pure
  `shouldRefresh({hidden, dialogOpen, busy})`); e2e: poll-count on a muted
  harness is overkill — assert the toggle renders and defaults on.

### A5. Guest cap (200) sticks once hit — no on-page recovery

**Bug.** Cap check uses the authoritative 98xxxx profile count
(`guest/route.ts:91`). But both reset paths default to purging only guests
older than 2h (button posts no `maxAgeHours`, route clamps to default
`reset-walkup/route.ts:60-63` → `walkup-reset.ts:117`). Cap hit mid-day with
young guests = reset deletes ~nothing, every new visitor gets `demo_full` 503,
no recovery on the page.

**Fix (three parts).**
1. `/demo` preflight gains two rows: live guest count (`countGuestAccounts`)
   and cap state (`n / 200`), rendered amber at ≥80%, red at cap.
2. The reset button gains an explicit age selector (default 2h; options 0/1/2h
   with the "0 = everyone mid-quiz is interrupted" warning text). Route already
   clamps to ≤24h — pass the chosen value through.
3. Cap-full error copy (`demo.atCapacity`) already exists on the visitor side;
   extend `/demo` run-sheet with the escape hatch: "If AT CAP: run the reset
   with 0h between shows, or `npm run demo:reset:walkup -- --max-age-hours=0`."

- Regression: extend `reset-walkup-route.test.ts` (age passthrough + clamp);
  `/demo` page test asserting the count row renders from a stubbed count.

### A6. Roster truncates at 100 while the cap allows 200

**Bug.** `ROSTER_LIMIT = 100` (`src/lib/classes/roster.ts:30,44`) vs
`GUEST_ACCOUNT_CAP = 200` and `RESULTS_SESSION_LIMIT = 200`. Past ~100 guests,
dashboard rows render with `studentName: null` — the "Guest #N (Visitor)"
roster story degrades to "?" exactly when the crowd is biggest.

**Fix.** Raise `ROSTER_LIMIT` to 200 (matching the session limit), keeping the
`+1` overflow probe and the existing `truncated` surfacing. Cost is one
bounded read; 200 rows is the documented session ceiling already.

- Regression: existing roster truncation tests must be updated to the new
  constant (pin the constant, not the literal, to prevent re-rot).

### A7. Showcase second-show lifecycle (currently: none)

**Bug.** Showcase quizzes ship `draft`, `time_limit_sec: 600`
(`seed-demo.mjs:674-705`). Lifecycle is one-way draft→live→closed,
`gestures_enabled` freezes once live, reset scripts never touch the showcase
class, and the 600s timer contradicts the manual's own "never time the demo"
golden rule (gate time counts down). After show #1 there is no documented
second-show path (re-publish impossible, volunteer hits `already_attempted`,
`live_assessment` blocks re-enrollment while a session is active).

**Fix (procedure + seed tweak, no new code).**
1. Seed: set showcase `time_limit_sec: null` on both twins (untimed per the
   manual's golden rule). One-line change each.
2. Documented between-shows showcase procedure (into `EXHIBITION_MANUAL.md`
   §6b and the `/demo` run-sheet): per show, **Duplicate** the showcase quiz
   into the showcase class (verified: `clone_quiz`, `0055:580-688`, preserves
   `gestures_enabled` `:650`, always lands `draft`), publish the fresh copy,
   run the beat, close afterwards. The volunteer's next-show start uses the
   NEW quiz id (no `already_attempted`), and the old copy's sessions stay as
   history. Two extra clicks per show, zero migration risk.
3. Alternative (rejected): `DELETE /api/sessions/[id]/reset` between shows —
   works but voids the history the presenter may want to reference; keep it
   as the contingency, not the procedure.

### A8. Docs + test hardening (no behavior change)

- **e59 extension.** Beyond the existing happy-path + non-demo bounce:
  (a) A2 Continue-without-mint; (b) Start-fresh mints exactly one;
  (c) A1 consent assertion — start the curated assessment as a fresh guest,
  expect 201 not `consent_required`; (d) A3 retry-button appearance. Still
  opt-in (`DEMO_MODE_E2E=1`, demo build) per the existing contract.
- **Run-sheet corrections** (EXHIBITION_MANUAL §6b + `/demo` runSheetBody):
  the crowd-data surface is the WALK-UP QUIZ'S results page
  (`/lecturer/quizzes/<walkup-id>/results`), NOT the gradebook (the gradebook
  page queries published assessments only —
  `gradebook/page.tsx:66-69`; the model itself renders whatever it is fed);
  enable Live updates (A4) before the monitoring beat; QR-origin check (open
  via the public host, verify the printed URL — §B3); guardrail "never enable
  gestures on walk-up quizzes" (face-gate invariant — see Design decisions).
- **AI budget.** `GENERATE_RATE` 10/h is per-user and the demo lecturer is one
  user all day. No code change — procedural: pre-generate the demo draft
  before doors; the `/demo` AI-key ticks stay the gate.

### Part A acceptance

- [ ] `npm run typecheck && npm run lint && npm run check:i18n` green
- [ ] `vitest run` green (new route/unit tests for A1, A2-e59, A3, A5, A6)
- [ ] e59 suite green against a demo build (`DEMO_MODE_E2E=1`)
- [ ] Manual booth rehearsal: 2 phones through the full loop incl. cap-hit
      recovery drill and showcase duplicate-per-show

---

## Part B — tunnel-booth ops (no code changes)

**Thesis.** Serve the booth stack from the laptop (local Supabase + sidecar +
`next start`) and expose it through a Cloudflare tunnel, so guests stay on
their own mobile data. This repo already documents this as the P2 posture
(`next.config.ts` ALLOWED_HOSTS, `request-ip.ts`, `ALLOWED_HOSTS` default
`innovision.zikr-i.uk`). Killed frictions: wifi-joining (hotspot caps ~8–10
clients, DHCP flakiness, guest hesitation), Windows inbound firewall,
`TRUSTED_ORIGINS` CSRF split-brain on LAN IPs, localhost-in-QR, single-bucket
rate limits.

**Non-goals.** This is NOT the production VPS serving demo day (it refuses to
boot a demo image: `prod-guards.ts:86` kill-switch + `PROD_ENV_STRICT=1`;
`build-images.sh:143,220` refuses to build it; a lingering public
guest-mint endpoint invites cap-exhaustion abuse with no self-recovery).

### B1. Night-before build (needs internet, do NOT do this at the venue)

On the booth laptop (and identically on the spare):

```powershell
# 1. Prereqs: Docker Desktop running, repo checked out at the release commit.
#    Record the SHA — it is the rollback anchor.
git rev-parse --short HEAD

# 2. Booth env. Copy .env.local.example → .env.local and set AT MINIMUM:
#    NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY (local seam values
#    from `npx supabase status -o env`), LECTURER_INVITE_CODE=<printed value>,
#    AI_API_KEY + AI_BASE_URL (AI beat), TINYFISH_API_KEY (grounded topic beat),
#    TRUSTED_ORIGINS=https://<tunnel-host>   (see B2 — RUNTIME read, no rebuild)
#    TRUSTED_PROXY_COUNT=<unset|1>            (default: one trusted hop — the tunnel)
#    NEXT_PUBLIC_DEMO_MODE=1                  (build-time; booth image only)
#    NEVER in this file on the booth box: PROD_ENV_STRICT=1.
$env:NEXT_PUBLIC_DEMO_MODE = "1"
npm run demo:prep
```

`demo:prep` runs `supabase start → db reset → seed:demo → face:start →
demo:reset → next build → next start -H 0.0.0.0`. Then STOP the server
(`demo:prep` leaves it running) — the image is now baked. Verify the bake:

- `grep -c SCAN23 .next/required-server-files.json` (demo branch present)
- Start once, open `/demo` as `demo-lecturer@innovision.test` / `Password123!`,
  confirm all ticks green + AI keys + sidecar.

Also pre-generate the AI draft quiz (Part A §A8), and prepare the printed kit:
QR (B3), credentials sheet, run-sheet (B6).

### B2. Tunnel setup (10 min, night before)

```bash
# cloudflared installed + logged in (one-time per machine).
cloudflared tunnel create innovision-booth
cloudflared tunnel route dns innovision-booth <tunnel-host>
# Config: ingress → http://localhost:3000, plus a named rule is NOT needed
# for Supabase — browser-direct calls ride the same-origin /sb proxy.
cloudflared tunnel run innovision-booth
```

Then: `TRUSTED_ORIGINS=https://<tunnel-host>` in `.env.local` (restart `next
start` only — route-handler CSRF reads it per request; server-action
allowlist needs the host baked via `ALLOWED_HOSTS`/`NEXT_PUBLIC_SITE_URL`, so
finalize the hostname BEFORE the B1 build, or rebuild after choosing it).

Decision log: quick-tunnel (`cloudflared tunnel --url`) is acceptable as a
fallback (random host, no DNS wait) but the hostname changes per run, which
re-opens the QR-reprint and action-allowlist questions — named tunnel first,
quick-tunnel only if DNS fails.

### B3. QR + origin verification (the 60-second check that saves the day)

1. Open the demo class page via the PUBLIC host
   (`https://<tunnel-host>/lecturer/classes/<demo-class-id>`), open the QR
   dialog, and READ the printed URL — it must start with
   `https://<tunnel-host>/join/SCAN23`. (The dialog builds from
   `window.location.origin` — a `localhost:` URL here means you opened the
   page wrong, not that the app is broken.)
2. Scan from a phone on MOBILE DATA (wifi OFF): expect the "Join the demo"
   card, not a login wall, not a timeout.
3. Tap through to the quiz list; Start the walk-up quiz; answer one question;
   submit; confirm the Done footer signs out back to `/join/SCAN23`.
4. On the big screen, open the walk-up quiz results page, enable Live updates
   (A4), confirm the guest row appears within one poll tick.
5. Print/screenshot the QR from step 1 as the backup poster.

### B4. Doors-open boot sequence (morning of)

```powershell
npx supabase start
npm run face:start          # wait: docker ps → insightface-service healthy (~90s)
$env:NEXT_PUBLIC_DEMO_MODE = "1"
npx next start -H 0.0.0.0 -p 3000   # serve the B1-baked image; NO rebuild
cloudflared tunnel run innovision-booth
```

Then `/demo` as the demo lecturer: all pre-flight ticks + the `manualChecks`
line (QR from a real phone, 375px completion, presenter camera). Booth-machine
checklist (from PLAN_DEMO_MODE D10): OS/display sleep OFF, plugged in, browser
Memory/Energy Saver OFF, presenter tabs foreground, Windows Update deferred.

Network fallback ladder (only the laptop needs internet, not the guests):
1. Venue wifi/ethernet for the laptop; 2. phone USB-tether to the laptop;
3. if ALL uplink dies → tunnel dies with it; fall back to the documented LAN
   poster (`http://<LAN-IP>:3000/join/SCAN23` + `TRUSTED_ORIGINS` flip +
   firewall rule + guests join a hotspot). Print this poster too — it's the
   contingency, not the plan.

### B5. Between shows (repeat)

1. `/demo` → Reset walk-up (default 2h age; use 0h only if at/near cap — A5).
2. Showcase: Duplicate the showcase quiz → publish the copy (A7); close the
   previous copy.
3. Glance at `/demo` guest-count row; if ≥80% of cap, plan the 0h reset.
4. Keep-alive: nothing needed (local stack, no pausing).

### B6. Run-sheet deltas (print these; they override older poster copy)

- Crowd track: "Scan → Join the demo → play Try InnoVision → Done hands the
  phone back clean." (Uses guests' own data — no wifi step.)
- Big screen: walk-up quiz RESULTS page with Live updates ON (not gradebook).
- Lecturer 10-min: unchanged from PLAN_DEMO_MODE D10, minus the LAN caveats.
- Showcase 5-min: duplicate-per-show (A7); untimed; volunteer enrolls on the
  presenter laptop (localhost = secure context = camera works).
- Guardrail: never enable gestures on walk-up quizzes (guests would hit the
  real face gate and hard-fail — see Design decisions).
- Teardown: `cloudflared` stop, `next start` stop, `npm run face:stop`,
  `npx supabase stop`. Kill the tunnel FIRST (closes the public door);
  nothing persists publicly.

### Part B acceptance

- [ ] Named tunnel serves the booth stack end-to-end from a data-only phone
- [ ] QR encodes the public host; backup LAN poster printed
- [ ] Spare laptop imaged identically (swap ≤10 min)
- [ ] Tether fallback rehearsed once (unplug venue net, confirm tunnel re-converges)
- [ ] Teardown run once night-before (proves the morning boot is clean)

---

## Sequencing + ownership

| Order | Item | Type |
|---|---|---|
| 1 | A1 consent at provisioning | code + test |
| 2 | A2 Continue without mint | code + e59 |
| 3 | A3 join-fail retry | code + test + i18n |
| 4 | A5 cap visibility + age selector | code + test |
| 5 | A4 live-updates toggle | code + test + i18n |
| 6 | A6 roster 100→200 | one-line + test pins |
| 7 | A7 showcase seed + procedure | seed + docs |
| 8 | A8 e59 extension + run-sheet | tests + docs |
| 9 | B1–B2 build + tunnel | ops (night before) |
| 10 | B3–B6 verify + print + rehearse | ops (night before / morning) |

Part A items 1–6 are independent and parallelizable; A7/A8 follow. Part B
needs zero code and can start (tunnel account, hostnames, spare laptop) before
Part A lands. Estimated: Part A ~1–2 dev-days incl. tests; Part B ~2h + print.

---

## As-built notes (2026-09-27 implementation)

- **Gates, all green:** `typecheck` clean · `lint` 0 errors (26 pre-existing
  warnings, none in touched files) · `check:i18n` 1477/1477 parity ·
  `check:env` OK · full `vitest` 137 files / 2554 tests pass · e59 **6/6 pass**
  on a demo-mode build (`DEMO_MODE_E2E=1`, `PLAYWRIGHT_SKIP_BUILD=1`, seeded).
- **e59 already had 4 tests, not 2.** The file grew since the audit read: two
  presenter-side tests (`/demo` anonymous-404 no-oracle; lecturer pre-flight
  + booth reset) already existed and still pass unmodified — the reset test
  exercises the A5 summary shape without changes.
- **A3 i18n is 3 keys, not 2** (`joinRetryCta`, `joinRetryTitle`,
  `joinRetryFailed`) — static label vs failure message needed distinct copy.
- **A5 deviation (documented):** no unit test for the `/demo` page itself —
  server-component RSC pages have no test precedent in this repo; the logic
  is covered by the reset-route age tests + `countGuestAccounts` (existing
  guests tests) + the e59 lecturer control-room test rendering the page.
- **A7 caveat:** the showcase `timeLimitSec: null` edit does NOT update
  already-seeded rows (seed idempotency = reuse); booth builds run `db reset`
  via `demo:prep`, and the seed carries an inline comment saying so.
- **A6 blast radius (all updated + tested):** `ROSTER_LIMIT` 100→200,
  `ROSTER_EXPORT_CAP` 100→200, both client mirrors, all cap comments;
  `gradebook.test.ts` B-F5 and the gradebook-export truncation test now pin
  `ROSTER_LIMIT` instead of literals.
- **`.next` was rebuilt** (demo-mode bake for the e59 run). It is gitignored
  build output; rebuild normally (`npm run build` / `demo:prep`) before any
  non-demo work — a demo-baked bundle mints guest accounts.

## Round-2 audit (2026-09-27, 2 subagents × 2 rounds)

Two further audit rounds ran after implementation: R1-A correctness + R1-B
security (both SHIP, MINORs only), then R2-A adjudication (confirmed all but
one: `resetWarning` 2h-copy downgraded to INFO — the default IS 2h and 0h has
its own alert) + R2-B fresh-eyes. All round-2 must-fixes are folded into the
tree:

- R1-A1/R2-A1: escape-hatch sentence now on all three operator surfaces
  (`runSheetBody` en+ms, manual §6b).
- R1-A2/R2-A2: "first 100" → 200 in `classes/[id]/route.ts:83` comment +
  `user-manual/troubleshooting.md` + `lecturer.md` sources (tracked `dist/`
  HTML regenerates via `python scripts/build-user-manual.py`).
- R2-A10/R1-B5: `TRUSTED_PROXY_COUNT` comment in the guest route now pins
  unset/1 for tunnel, 0 for LAN fallback.
- R2-A4: e59 A3 test asserts a walk-up card before the absence check.
- R2-B MINOR-1: `countGuestAccounts` returns `null` on error; `/demo` renders
  red "unavailable" (`checkGuestCapError` en+ms) instead of green "0 / 200";
  the guest route coalesces to 0 (fail-open posture unchanged).
- R2-B MINOR-2: reset result `<p role="status">`.
- R2-B MINOR-3: `lockRef` re-entry lock on the reset `run()`.
- Citation fix: gradebook assessment-scoping lives in `gradebook/page.tsx`,
  not the model (R2-B INFO-1).
- Explicitly NOT actioned (adjudicated): `resetWarning` 2h copy (INFO —
  default is 2h); dead `joinError` field (INFO — test-pinned contract);
  `/demo` gestures tick (INFO — draft-freeze + reset make it redundant);
  A3-positive e2e (INFO — no UI path exists; jsdom precedent explicitly
  against it); `joinDemoClass` throw-outside-try (INFO — non-throwing client
  contract, latent).

# InnoVision — Prod Testing Map

> Which features get an automated Playwright smoke on prod, which are manual-only,
> and what must never run against prod.
> Companion docs: `docs/TESTING.md` (all lower-env gates), `docs/ARCHITECTURE.md`
> (§7 feature walkthroughs, §9 testing map), `docs/DEPLOY_VPS.md` §8.2 (prod env).

## 0. Rule #1: do NOT run the existing e2e suite against prod

The 83-spec suite in `e2e/` only passes under harness env from
`playwright.config.ts` that must never exist in prod (`src/lib/prod-guards.ts`
fails closed on `PROD_ENV_STRICT=1`):

| Harness | Prod |
|---|---|
| `NEXT_PUBLIC_E2E_FAKE_SEAM=1` + `FACE_MOCK_ENABLED=1` — face verify returns canned verdicts, verifies nothing | Real InsightFace sidecar, `FACE_SPOOF_ENFORCE=1` |
| Mock AI server, mock TinyFish, `AI_STREAM_IDLE_TIMEOUT_MS=3000` | Real AI (spend), real TinyFish, real GLM leg |
| `E2E_RATE_LIMIT_DISABLED=1`, `SIGNUP_RATE_LIMIT=1000` | Real rate limits, join throttling, signup budgets |
| `NEXT_PUBLIC_INTEGRITY_HARDENING_OFF=1` (main suite) | Hardening ON (copy block, fullscreen lockdown) |
| `NEXT_PUBLIC_DEMO_MODE` baked OFF (e59 needs its own build) | `NEXT_PUBLIC_DEMO_MODE=1` rejected in prod build/CI/Dockerfile |

Running the full suite on prod would: mint ~100 users, pollute the DB,
fire real notifications, spend AI caps, hit 429s, block cleanup
(`quiz_has_sessions`), refuse completed-reset (409), and irreversibly reveal
results. The full suite is a **pre-merge gate on ephemeral Supabase** (CI jobs
`e2e` + `probes` + pgTAP `supabase/tests/`); prod gets a separate small smoke.

## 1. Feature map

`Auto (prod)` = safe read-only Playwright smoke. `Manual` = real device/camera/eyes
on a dedicated `SMOKE-*` class. `Lower` = keep in staging/CI
(vitest, pgTAP, `verify:*`, existing e2e) — never run on prod.

| # | Feature (ARCH §) | Auto on prod | Manual on prod | Notes |
|---|---|---|---|---|
| 1 | Login/logout, role gates, URL guards, redirect sanitize | **Yes** — pre-made smoke accounts, `/lecturer/*` vs `/student/*` redirects, logged-out bounce (e29 analogue) | No | No registration on prod (user spam, leaks `LECTURER_INVITE_CODE`); register stays staging (E1a) |
| 2 | i18n EN↔BM, theme toggle, mobile dock/sheets, a11y timer milestones, error boundaries | **Yes** — toggle + reload persistence, no-raw-key sweep, 375×812 render pass (e31/e41/m1 subset) | Spot-check BM copy + dark clay once per release | Zero writes except locale cookie |
| 3 | Notification bell render + deep links | **Yes (render only)** — count loads, panel opens | **Yes** — publish → student bell increments → click-through | Full journey (E30) fires real notifications; manual on smoke class, then mark-read |
| 4 | Class / quiz / gradebook / results list render | **Yes** — SSR load, empty states, `?class=` filter, deadline chips | No | Catches Supabase-pause and RLS regressions |
| 5 | `/join/[code]` + QR dialog render | **Yes (render only)** — malformed-code neutral card, lecturer-notice card, QR SVG present | **Yes** — one real phone scan → confirm-and-join on smoke class (E52) | Never POST joins from automation (enrollment + welcome mail are real) |
| 6 | `/s/[code]` shared practice play | **Yes** — seeded smoke share-link to end screen | No | `answer_student_question` is zero-write by construction — the one safe "play" automation |
| 7 | Health `/api/health` integrity snapshot | **Yes** — lecturer `integrity` block returns; anon denied | Eyeball `flags24h/sealed/submitted` after exam windows | Cheapest prod regression signal (audit-5 O2/O5) |
| 8 | Forgot-password / SSO button surfaces | **Yes (render only)** — button present/absent per `INSTITUTIONAL_EMAIL_DOMAINS`, silent-bounce no-banner (E64) | **Yes** — one real reset email + one real SSO handshake per SSO config change | Never submit reset/SSO from automation (spam, tenant side-effects, rate limits) |
| 9 | Class create/edit/archive/restore, join throttle/lockout | No | **Yes** — archive → student loses visibility → restore (E26), one bad-code lockout probe | Hides data from real students; smoke class only |
| 10 | Manual builder (add/edit/delete/reorder, validation, metadata, windows, retake, shuffle) | No | **Yes** — author 1 quiz on smoke class, edit, publish (E1b/E23) | Locks pinned lower-env via D19–D33, I-Q1–Q13 |
| 11 | Bulk pipe import, duplicate/clone, delete guard, .xlsx + gradebook export | No | **Yes** — import 3 rows, clone, open .xlsx in Excel, zero-session roster row (E18/E43/E44) | Clone copies storage objects; export caps 200 sessions/20k answers |
| 12 | AI generate (file/paste/regenerate), NDJSON stream + cancel | No | **Yes, sparingly** — one paste-mode generation + one regen (E2/E2b) | Real model spend; thin/corpus-fail copy stays staging (E2F) |
| 13 | Web-topic (TinyFish) generation | No | **Yes, sparingly** — one topic run, 3 chips, injection absent | External dependency; pre-demo gate is `eval-grounded-quiz.mjs` (TESTING §7.8) |
| 14 | OCR: Tesseract vs GLM local/remote, multi-file caps | No | **Yes** — one scanned deck via Tesseract; GLM only when its container/key changed (TESTING §7.3) | Latency + spend; e2c stays staging |
| 15 | Question images, avatars | No | **Yes** — upload PNG/JPEG/WebP, player renders via sign route, revoke on unshare (E20/E21) | Magic-byte + 5MB/2MB caps; orphans via `media:cleanup` |
| 16 | Student practice CRUD + share mint/rotate/unshare mid-play | No | **Yes** — mint → recipient plays → rotate → old link neutral → unshare mid-play degrades (E17/E32) | Login-wall redirect preserved |
| 17 | Assessment play: timer, shuffle, skip, short_text, multi, reveal gating, retake | No | **Yes** — click-first full pass incl. reload-resume (E4/E42/E54/E56) | Timer expiry, `quiz_window_closed`, pending labels need real clocks |
| 18 | Face enroll: consent, 3-angle blink + pose gate, dup → pending_review, approve | No | **Yes, with 2 humans** — presenter + volunteer impostor, real lighting (TESTING §7.1–7.2) | Fake-tracker E3/E3b proves state machine only; pose bands need real faces |
| 19 | Face verify: gate Begin, periodic cadence, HMAC/nonce, paused → flagged, unlock/exempt/reset, silence cron, frozen-frame, second-face, outage claim, camera-unavailable | No | **Yes** — wrong-face → paused → flagged → lecturer unlock (E6/E7/E12/E62), one fullscreen-exit pause (E51), one exempt-fallback completion | `prod-guards` exists because a mocked verdict here is a photo/replay bypass |
| 20 | Gestures: calibration, hold-confirm, palm-next, hand-loss pause, gestures-off kill switch | No | **Yes, in demo room** — 1–4 fingers under venue lighting, hand-loss >10s → paused → blink recover (E8/E9b/E53) | WASM + lighting reliability is manual item #1 |
| 21 | Incident clips: record on pause/flag, lecturer playback, prune | No | **Yes** — one pause, watch signed `<video>` in results row; clean sessions upload nothing (E63) | Multipart + magic-byte + private bucket; 1h signed URLs |
| 22 | AI-marking sweep + override adjudication (incl. un-publish on override) | No | **Yes** — short_text → pending → marked, override 0.5→1, student flips to "Awaiting results" (E55/E61) | Ledger caps + worker key + irreversible-reveal coupling; pgTAP 0055–0059 lower-env |
| 23 | Reveal: manual reveal, auto-reveal, reveal-settings, autoclose seal, abandoned | No | **Yes** — reveal once, verify `not_revealed` lifts; sealed ≠ submitted after window (E36/E49) | Reveal is one-way; seal writes audit rows |
| 24 | Copy prevention + fullscreen lockdown (hardening-ON build) | No (harness bakes it OFF) | **Yes** — copy/cut/context blocked, Begin requests fullscreen, Esc → pause POST (E51 choreography, by hand) | e51 never runs on prod; replicate its 2 tests manually |
| 25 | Multi-laptop concurrency, venue Wi-Fi models, Supabase wake, demo kiosk | No | **Yes** — 2–3 laptops one assessment, `/models` on venue Wi-Fi, wake free tier day-before (TESTING §7.4–7.6) | Demo mode (`/demo`, walk-up QR) is staging-build-only — never on prod |

## 2. Prod smoke suite (`e2e/prod-smoke.spec.ts`, project `prod-smoke`)

Read-only pulse against the live deployment. Run as:

```bash
PROD_SMOKE=1 PROD_URL=https://<prod-host> \
  PROD_SMOKE_LECTURER_EMAIL=… PROD_SMOKE_LECTURER_PASSWORD=… \
  PROD_SMOKE_STUDENT_EMAIL=… PROD_SMOKE_STUDENT_PASSWORD=… \
  [PROD_SMOKE_SHARE_CODE=…] \
  npm run test:e2e:prod   # playwright test e2e/prod-smoke.spec.ts --project=prod-smoke
```

`PROD_SMOKE` and `PROD_URL` are required (the file skips without them).
Credentials and `PROD_SMOKE_SHARE_CODE` (a SEEDED share link — never minted
from automation) are optional: each gated test skips individually without
its env, so a bare `PROD_URL`-only run still executes the anonymous half
and never trips the fail-on-fully-skipped reporter. Default projects
`testIgnore` the file, so normal runs never collect it.

| Test | What | Needs |
|---|---|---|
| P0 | Target host is not loopback; runner has no harness kill switches; fake-tracker seams absent from the prod bundle; no `[integrity-gate]` baked warn | — |
| P1 | Anon `/api/health` is liveness-shaped (`ok`, `db.reachable`, `face.available`) with NO `cron`/`integrity` keys (S6) | — |
| P2 | Logged-out bounces (`/student/quizzes`, `/lecturer/classes` → `/login`); login + `/forgot-password` render, never submit | — |
| P3 | Login language toggle flips copy and persists across reload | — |
| P4 | Lecturer login; class + quiz lists render; notification bell renders | Lecturer creds |
| P5 | Lecturer `/api/health` carries `cron.jobs[]` + `integrity.flags24h` | Lecturer creds |
| P6 | Student login; class + quiz lists render; `/lecturer/classes` bounces to `/student/classes` | Student creds |
| P7 | `/join/zz!` (bad charset) renders the neutral card (`not valid`/`tidak sah`, no join CTA); `/join/ZZZZZZ` (well-formed) renders the blind confirm card echoing only the code — the no-oracle contract | Student creds |
| P8 | Seeded `/s/<code>` resolves, first option grades (`aria-pressed`) — zero-write RPC, render + one answer only | Student creds + share code |
| P9 | Account-menu theme toggle flips the stored preference (`data-theme-preference`) and persists across reload (dialog-scoped — a header twin exists) | Either creds |
| P10 | `mobile viewport` describe (375×812 + touch): login renders, no horizontal overflow | — |
| P11 | No raw `segment.token` i18n keys on `/login`, `/forgot-password`, `/join/zz` (email/URL/version scrubbed) | — |

Rules: pre-made `smoke-lecturer` / `smoke-student` accounts (no registration),
no AI generation, no camera/face flows, no joins, no reveals, no deletes —
the health endpoint is called exactly twice (P1 + P5).

## 3. Manual runbook (per release + pre-demo/exam)

Full ordered path: **`docs/MANUAL_TEST_GUIDE.md`** (PDF: `docs/MANUAL_TEST_GUIDE.pdf`,
regenerate with `npm run guide:pdf`) — written for non-technical testers, one
60–90 min session (Quick-check ★ path ≈ 30 min) over a single `Test - <name>
<date>` class, ordered so irreversibles (reveal/close/archive) never force
rework. Testers use pre-made accounts or register their own in step 0. Start
there; the summary below is only the shape.

## 4. Guardrails for anything touching prod

- Separate Playwright project from `chromium`/`mobile`/`chromium-nowebsearch`/
  `chromium-sso`; never reuse the main `webServer` block (it rebuilds + mocks).
- Secrets via env only; never commit smoke passwords or the invite code.
- Rate limits are real: serialize, no retries-burst, no signup loops.
- Data hygiene: prefix everything `SMOKE-`, prefer the seeded share-link for play,
  clean up drafts (never delete quizzes with sessions — 409 is by design).
- Schedule: on deploy + nightly render-only ping; full manual pass before
  exhibitions/exams (`docs/EXHIBITION_MANUAL.md` §6b covers the demo-mode side,
  which stays off prod).

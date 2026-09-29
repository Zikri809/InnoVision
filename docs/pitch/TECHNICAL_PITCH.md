# InnoVision — Technical Pitch

> Companion doc: [BUSINESS_PITCH.md](BUSINESS_PITCH.md) — market, model, and GTM framing
> (YC 12-slide order). Sources: `docs/ARCHITECTURE.md`, `docs/EXHIBITION_MANUAL.md`,
> `docs/TESTING.md`, `docs/COSTS.md`. Honesty tags MEASURED / ESTIMATED / UNVERIFIED apply
> here too.
>
> **Framework:** the technical half follows a *claim → mechanism → receipt* spine — every
> bold claim is immediately followed by the mechanism and the file path where a judge can
> verify it. Skepticism is handled by **prebunking** (inoculation theory: name the objection
> yourself with a weakened, answerable form before the judge hardens around it), never by
> burying weak spots. Delivery rule from the research: one idea per beat, specific numbers,
> demo over screenshots.

## TLDR — the anti-skepticism strategy

The strongest weapon against skeptical judges is already built into the product: **honesty**.
"The browser is never trusted," server-authoritative everything, real code paths in demo mode,
and docs that tag numbers as MEASURED / ESTIMATED / UNVERIFIED. Pitch that engineering
discipline *as* the differentiator instead of inflating claims — and rehearse answers to the
three genuinely weak spots: no published face-match accuracy, no formal privacy-policy page,
and no load test. State all three yourself before Q&A; a judge cannot "gotcha" a concession
you already made.

---

## The pitch spine (in order)

### 1. Hook / problem (60 seconds)

Online assessments are broken in both directions: students cheat (tab-switching, impersonation,
answer leaks), and lecturers can't prove who actually did the work. Existing proctoring is
either invasive cloud services that hoover biometric data, or trivial lockdown browsers that
die the moment you open DevTools. InnoVision is the middle path: browser-based proctored
quizzing where **the browser itself is never trusted**.

### 2. The one-line architecture claim (credibility anchor — judges remember ONE sentence)

Every verdict — face match, score, timer, state transitions, answer correctness — is computed
or re-validated server-side in Postgres functions behind row-level security. Correct answers
never reach the student's browser until the lecturer one-way reveals results. For
gesture-enabled assessments, identity and the answer are committed in **one atomic
transaction** (HMAC-signed proof + face check + grading under one row lock, `commit_answer`,
migration 0067; non-gesture/exempt sessions use the direct grading path). Disabling
JavaScript gets you a paused session, not a passing grade — silence is flagged by a server
cron (`flag_verify_silent_sessions`), not a client heartbeat, and the direct-grading bypass
is closed by revoke (`0067` revokes `answer_question` from `authenticated`: `commit_answer`
is the only entry point).

> If judges remember one sentence, make it this one.

### 3. The three headline features (claim → mechanism → receipt)

- **Continuous 1:1 face matching** — self-hosted InsightFace (ONNX, 512-d templates in
  `profile_face_samples`, pgvector), client re-verifies on a ~30–45 s cadence against the
  student's *own* enrolled 3-angle baseline (never a gallery search of other people's faces),
  blink liveness, random head-turn anti-replay challenge, print/replay spoof detection
  (MiniFASNet), strict-majority-of-frames voting at the 0.5 default threshold (uncalibrated —
  ROC publication gates deployment). The server enforces freshness via nonce rotation + HMAC
  proof + frame-hash replay check, and flags silent sessions via cron. Verification stores
  only templates plus SHA-256 frame hashes — never raw frames; short incident video uploads
  only on integrity events with auto-prune. *Receipt: `supabase/migrations/0039_insightface.sql`
  (samples table + atomic-purge revocation), `0045*` (record_face_check),
  `docker/insightface/`.*
- **Gesture answering** — MediaPipe hand tracking in-browser: hold up N fingers to select
  option N, open palm commits, works for multi-select. Also the demo crowd-pleaser.
  *Receipt: `src/lib/gestures/*` (pure logic unit-tested, browser glue E2E-owned).*
- **Grounded AI generation on commodity LLMs** — generate quizzes from uploaded PDF/DOCX/PPTX
  (multi-leg OCR cascade: native parse → Tesseract → local GLM-OCR → remote, fail-closed) or
  from a topic with grounded web search and *real* citations (only URLs actually fetched).
  The pipeline's value is the grounding + validation, not the model: every generated question
  passes the same Zod schema and DB constraints as hand-authored ones; prompt-injection
  defenses are tested with a literal "IGNORE PREVIOUS INSTRUCTIONS" e2e fixture
  (`e2f-web-generate.spec.ts` + `mock-tinyfish-server.mjs`); spend governors cap OCR cost per
  day (quiz-gen LLM itself is uncapped pass-through — COSTS.md §4).
  *Receipt: `src/app/api/ai/generate-quiz/route.ts`, `src/lib/ai/tinyfish.ts`.*

### 4. Live demo (the exhibition mode is the best asset)

Use the walk-up flow: judges scan a QR, become real guest accounts, play the quiz — and the
presenter control room (`/demo`) fills with their real sessions. Say explicitly:

> "Demo mode adds guest provisioning and seeded data, but everything you just did ran the
> production code path — the mocks that fake face verification are CI-only, and a boot guard
> crashes production if they're ever armed."

That sentence pre-empts the single most common "is this canned?" skepticism. Back it with
three layers if pressed: `src/lib/prod-guards.ts` (5 kill switches + 1 spoof-enforcement key
abort `next start` under `PROD_ENV_STRICT=1` — note the honest caveat: without the strict
flag a misconfigured box only warns, so the VPS runbook pins the flag and CI asserts it),
the CI kill-switch assertion (shared `e2e` leg), and `deploy/build-images.sh`
(refuses to bake any harness flag). Guest budget is engineered, not accidental: 200-account
cap (`GUEST_ACCOUNT_CAP`), 300 mints per IP per 10 min.

### 5. Engineering depth (the "is this real?" slide — all MEASURED 2026-09-27)

- 66 hand-written SQL migrations (0001–0069; three numbers are pgTAP test rounds)
- 2,554 unit tests across 137 files with per-file coverage floors (deleting an assertion fails CI)
- 229 e2e tests across 85 Playwright specs (desktop + mobile projects)
- 13 pgTAP database suites, 265 assertions (RLS, RPC state machines, concurrency guarantors)
- 15 live-SQL security probe scripts against real Supabase
- 53 self-authenticating API routes; 7 pg_cron jobs (autoclose, silence flag, incident prune,
  AI-mark sweep + escalate, verify-silence, notify prunes)
- 6-job CI: boots real Supabase, builds production, fails on type drift and on all-skipped runs
- Migration 0068 fixed all 15 policies Supabase's own RLS performance advisor flagged
- Five internal security red-team rounds, 0 external pentests (`docs/audit/`: 6 files,
  audit-3 ships as ledger + phase4; method headers say "subagent swarms" — quote before/after
  fix deltas, e.g. audit-5 B1–B5 bypasses → migrations 0062–0067, not the round count)

This is what separates the project from wrapper work — lead with it.

### 6. Security & privacy (where skepticism lives — see playbook)

- Consent checkbox **before** the camera ever starts; consent writes restricted to the
  sanctioned RPCs by a database trigger, not the UI; revocation clears consent + enrollment
  and deletes all templates in one transaction (`0039`, audited with purge count) while
  flagging live sessions — completed-session checks are purged, live fail-history is retained
  by design (a revoke cannot launder a live investigation)
- Retention cron jobs; private buckets with 1-hour signed URLs; incident clips upload ONLY on
  a verified→incident status edge (`shouldFlushIncident`) and a clean submit discards them
- Lecturer access via invite code with constant-time comparison; Microsoft institutional SSO
  with a fail-closed domain allowlist; sliding-window rate limiting
- Production boot guard (`prod-guards.ts`) refuses to start if any of five harness
  kill-switches is armed (plus a spoof-enforcement key that must be ON) — enforced again in
  CI, and a third time in the Docker build script

### 7. Deployment reality

Fully self-hosted Docker stack (app + InsightFace sidecar + OCR container) on a VPS — or
entirely on a laptop for exhibitions. No venue-Wi-Fi dependency, no per-student cloud biometric
vendor. Bilingual English/Bahasa Melayu with CI-enforced translation parity (1478/1478 keys).

### 8. Business / roadmap close

Honest sizing: deliberately single-instance, classroom-scale, OCR-leg spend capped
(~$0.06/user/day cap; quiz-gen LLM uncapped pass-through — COSTS.md §4). Roadmap comes from
a documented four-auditor product-gap audit with tracked IDs (`docs/roadmap/`: 8 `PLAN_R_*`
domain plans + `PLAN_GESTURE_OFF_RICH_TYPES.md` + README index — question types, authoring
productivity, class management, results analytics, integrity ops, auth/identity, student QoL,
accessibility platform) — several items already shipped, which shows velocity. The
deployment-hardening track (load tests, Supabase Pro, backups, error tracking) is separate
and gated on funding — do not conflate the two on stage. Close on integrity:

> "We built the system we'd want to be examined by — auditable, revocable, and honest about
> what it can't do."

---

## The skeptic-proofing playbook (prebunk these — say the objection first, then the answer)

1. **"What's your face-match accuracy / false-accept rate?"** — Hardest one. Do **not** invent
   a number; there is no measured FAR/FRR anywhere in the repo, the threshold is the 0.5
   default, and accuracy gates revenue (no institution buys proctoring without it — say that
   translation out loud). The honest pivot: matching is strictly 1:1 against the claiming
   student's own enrollment, so the inspectable claim rests on the *layered stack* (liveness +
   anti-replay challenge + spoof detection + majority voting + server authority), not one
   similarity threshold. Bonus credibility: `scripts/face-threshold-report.mjs` exists to tune
   thresholds empirically from recorded checks — "the tuning harness is built, publishing the
   ROC is a dated milestone in our ask." *Bridge line if cornered: "Judge us on the stack you
   can inspect today, and hold us to publishing the calibration before any institution
   deploys."*
2. **"Where's your privacy policy? Is this GDPR/PDPA-compliant?"** — The genuinely weakest gap
   (no `/privacy` route exists — verified 2026-09-27). Answer with the shipped controls,
   precisely worded: consent precedes the camera and consent writes are trigger-restricted to
   sanctioned RPCs; revocation clears consent + enrollment and deletes all templates in one
   transaction (live fail-history retained by design); verification stores templates + hashes,
   never raw frames; incident video uploads only on integrity events with auto-prune —
   then *concede*: "the formal policy page and DPIA are dated roadmap items, not shipped —
   and they gate the DPO sale." Conceding it yourself, framed as a roadmap item, kills the
   gotcha.
3. **"Does it scale?"** — Concede by design: "single-instance, classroom-scale — that's a
   deliberate constraint, not an oversight. Phase 1 sells single-faculty pilots; the managed
   tier is gated on the load test we're asking you to fund." Point at the demo budget (200
   guest cap, 300 mints per IP per 10 min) as *engineered* limits, and give the one hard
   number: OCR spend capped at ~$0.06/user/day (quiz-gen LLM is pass-through — don't hide
   it). Never say "handles thousands of concurrent users." *Bridge: "Our next funded
   milestone is literally the load test — that's what unlocks the managed-cloud tier."*
4. **"Can't students just disable the anti-cheat JS?"** — The one you should *want* them to
   ask, because the answer is the architecture claim (§2). Follow with the receipt: silence
   detection is a server cron (`flag_verify_silent_sessions`), not a client heartbeat — a
   tampered browser that stops verifying gets flagged by Postgres, not by JavaScript.
5. **"Wi-Fi dies mid-demo?"** — "That's why we present from the all-local laptop stack —
   nothing leaves this room." The exhibition manual has a full troubleshooting table; mention
   it exists.
6. **"What happens if the AI gets garbage input?"** — "Garbage in produces a boring-but-valid
   quiz — same Zod schema, same DB constraints as hand-authored questions, and nothing reaches
   students without lecturer review and per-question regenerate."
7. **"How much of this was AI-built?"** (expect it) — Decide the line in advance; the honest
   one: *"We use AI tooling like everyone — including AI red-team rounds we label as such in
   the audit headers. And 2,554 tests, 66 migrations, and the before/after fix deltas are
   what prove the code is ours. AI doesn't write pgTAP concurrency guarantors; engineers
   do."*

---

## Pre-pitch checklist

- [ ] **Clean the repo tree before any screen share.** `tmp/`, `output/`, `playwright-report/`,
      `.agents/`, and stray artifacts (`invoice_edited.html`, `.tmp_fix_r2.py`) are untracked
      but visible if a judge browses the folder.
- [ ] **Never cite** `docs/HANDOFF.md`, `docs/SECURITY_AUDIT.md`, or `docs/PLAN.md` as current —
      they're marked historical. Point at `docs/ARCHITECTURE.md` and `docs/EXHIBITION_MANUAL.md`.
      (Known wart: one live comment cites the banned doc — `generate-quiz/route.ts:51`
      "documented in SECURITY_AUDIT". If a judge finds it: "stale comment pointing at the
      retired audit — the in-memory-limiter constraint it describes is real and re-documented
      in COSTS.md §2.3/§3." Fix the comment post-pitch.)
- [ ] Dry-run the demo walk-up flow (`npm run demo:prep`, presenter control room at `/demo`,
      "Reset walk-up" between shows) per `docs/EXHIBITION_MANUAL.md`.
- [ ] Fill the Team slide (names + one line each) and put an exact amount + milestone on the Ask.
- [ ] Verify the two [VERIFY] stats (misconduct rate, vendor pricing) with real citations — or
      cut the parenthetical.

The through-line for the whole pitch: **every claim has a file path behind it.** Judges can
smell the difference between engineered confidence and inflated claims — lean on the former.

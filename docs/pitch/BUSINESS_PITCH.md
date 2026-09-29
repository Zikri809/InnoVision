# InnoVision — Business Pitch

> Companion doc: [TECHNICAL_PITCH.md](TECHNICAL_PITCH.md) — architecture, engineering proof,
> and the skeptic-proofing playbook.
>
> **Framework:** YC seed-deck spine (title → problem → solution → traction → model →
> market → team → ask) merged with Sequoia's problem/solution/market/competition order,
> compressed to competition length. Rules from the research: **one idea per slide, ≤30 words
> per slide, specific numbers over adjectives, honesty about stage.** Judges decide on three
> slides — problem, traction, ask — so those three carry the most craft.
>
> **Honesty convention:** numbers are tagged **[MEASURED]** (observed in this repo on
> 2026-09-27), **[ESTIMATED]** (reasoned but unproven), or **[UNVERIFIED]** (needs work
> before we claim it). Do not present an UNVERIFIED number as fact.

## Slide 1 — Title / one-liner

**InnoVision is self-hosted exam-integrity software: server-authoritative proctored quizzes
with consent-first biometrics — so institutions get tamper-evident assessment evidence without
shipping student face data to a third-party proctoring vendor.**

*(Word choice is deliberate: "tamper-evident" (server-authoritative verdicts, HMAC proofs,
audit rows) is MEASURED; "verifiable" implied calibrated accuracy we don't have yet — see
Slide 12. Do not upgrade this word until FAR/FRR ships.)*

## Slide 2 — The problem (the slide judges under-invest in — be specific)

Two failures define online assessment today:

- **Integrity failure.** Remote quizzes are trivially gameable: lock-down browsers die to
  DevTools, answers leak before results are revealed, and nobody can prove *who* answered.
- **Privacy & cost failure.** The commercial answer — cloud proctoring — sends student
  biometrics and screen/video to third-party vendors, bills per exam or per proctor-hour
  [UNVERIFIED — cite a real vendor price page before pitch day], and
  draws recurring student backlash. Institutions want integrity *and* data custody. They
  currently must pick one.

*(Strengthen with one cited misconduct-rate stat and one vendor-pricing data point
[VERIFY — cite real sources before pitch day; do not improvise]. Name a specific person:
"a lecturer with 200 students, one exam week, zero proof of who clicked." Cut both
parentheticals if unsourced — an unsourced problem slide is worse than a short one.)*

## Slide 3 — The product (30 seconds — depth lives in the technical pitch)

A browser-based assessment platform where **the browser is never trusted**: every verdict
(identity match, score, timer, reveal) is computed server-side in Postgres. Students enroll
their face once (consent before the camera starts; face verification stores only 512-d
templates plus SHA-256 frame hashes, never raw frames; short incident video uploads only on
integrity events with auto-prune; one-click revocation clears consent + enrollment and deletes
all templates in one transaction, live fail-history retained by design), then take quizzes
under continuous 1:1 face matching — answering by click or by **holding up fingers to the
camera**. Match threshold is the 0.5 default, uncalibrated — ROC publication gates
institutional deployment (see Slide 12). Lecturers author quizzes by
hand, bulk import, or AI generation from their own lecture files (with real source citations),
monitor sessions live, and one-way reveal results. Everything runs self-hosted under Docker.

## Slide 4 — Why now

- AI tools have made take-home assessment integrity collapse — institutions are actively
  re-shaping assessment around verified in-session work.
- Privacy regulation and student sentiment are hardening against cloud proctoring vendors.
- In-browser ML (MediaPipe, ONNX) got good enough that serious on-device face matching no
  longer needs a GPU cloud pipeline — we run it in a Docker sidecar on a commodity VPS.

*(All three are framing claims [UNVERIFIED] — source one citation each before pitch day
(enrollment-integrity report, proctoring-backlash coverage, on-device ML benchmark), or
soften to "we believe" language. This slide gets the same citation standard as Slide 2.)*

## Slide 5 — Market (beachhead-first; bottom-up, no invented TAM)

- **Beachhead: universities and colleges running blended/online assessment** — starting
  local. The product already ships institutional-grade primitives: Microsoft SSO with a
  fail-closed tenant allowlist, matric-number identity, invite-gated lecturer onboarding, and
  full EN/BM localization. That is a Malaysia-first wedge, expandable to any EN/BM region.
- **Expansion segments**: bootcamps and training providers, professional certification bodies,
  tuition centres — anyone whose credential is only as good as their exam integrity.
- **Bottom-up adoption is built in:** a single lecturer can run one class with an invite
  code before any institutional decision is made — land with one lecturer, expand to faculty.
- **Beachhead SAM (fill before pitch day — tagged math, bottom-up only):**
  *~X Malaysian universities/polytechnics [source] × Y avg faculties × RM Z/faculty/yr
  licence = RM ___/yr beachhead [all inputs UNVERIFIED until sourced].*
- **First three target faculties (name them):** 1. ___ 2. ___ 3. ___.
  "Starting local" is not a beachhead; three named faculties is.
- *(Never top-down "x% of EdTech market.")*

## Slide 6 — Business model (how we make money)

**Phase 1 (now — pilot license):** annual self-hosted license per faculty for
single-classroom pilots. Institution runs the Docker stack on its own VPS — they keep
biometric custody, we keep recurring revenue. Tiers by active-student count (price points TBD
— put RM numbers here before pitch day or cut the tiers line); support + upgrades included.
Cleanly aligned with the "your data never leaves campus" promise.

**Phase 2 (gated — NOT for sale today): managed cloud subscription (per active student/month)**
— unlocks only after load test + Supabase Pro + backups + error tracking ship. Never pitch
Phase 2 as available; pitch it as what the ask funds.

**Deliberately not**: per-exam pricing. It's the incumbents' most resented cost line
[UNVERIFIED — needs a citation like the rest of Slide 2] and our sharpest contrast.

## Slide 7 — Unit economics (per institution)

| Cost line | Number | Tag |
|---|---|---|
| VPS (≥2 vCPU / 4 GB, single instance) | single-instance classroom sizing | **[UNVERIFIED — no load test yet]** |
| Supabase (DB/auth/storage) | free tier today; **$25/mo** removes the free-tier cron-pause integrity gap only — storage overage, backups, error tracking still to cost | [MEASURED — COSTS.md §2.2/2.5/§4] |
| OCR remote leg (document → quiz) | $0.03/1M tokens, capped ≈ **$0.06/user/day** — OCR leg ONLY, a cap not a measurement (tokens/page still OWED) | [MEASURED cap — COSTS.md §2.3] |
| Quiz-generation LLM | provider-configurable (any OpenAI-compatible endpoint, incl. self-hosted at $0); its spend is operator-billed and UNCAPPED | **[TO COST — COSTS.md §4]** |
| Human proctor fees (incumbent cost we don't have) | asserted the dominant line in per-exam proctoring | **[UNVERIFIED — cite or cut]** |

Pitch line: *"Marginal OCR cost per exam is capped cents per user per day; quiz-gen LLM is
operator-billed pass-through — no per-exam proctor, no biometric vendor fee."*
*(The old line — "infrastructure plus cents of AI tokens" — is retired: it folded the
uncosted LLM into the capped OCR number.)*

## Slide 8 — Build evidence, pre-traction (the most scrutinized slide — receipts, not adjectives)

Demand status, stated first: **0 signed pilots, 0 revenue.** Target: 2 faculty pilots next
semester (see Slide 11). Until then the honest signal is **execution velocity**, and the repo
is the receipt [all MEASURED 2026-09-27 — counts verified live: `npx vitest run` =
2,554/2,554; `npx playwright test --list` = 229 in 85 files; pgTAP `plan(N)` sum = 265]:

- **66 SQL migrations** (numbered 0001–0069; 0061/0063/0064 are pgTAP test rounds, not schema)
- **2,554 unit tests across 137 files** under per-file CI coverage floors (deleting an
  assertion fails the build)
- **229 e2e tests across 85 Playwright specs**, plus a fail-closed reporter that fails runs
  where every test skips
- **13 pgTAP database suites (265 assertions)** pinning RLS, RPC state machines, concurrency
- **15 live-SQL security probe harnesses** (`npm run verify:*`) against real Supabase
- **53 self-authenticating API routes, 7 pg_cron jobs**, 6-job CI booting real infrastructure
- **5 internal security red-team rounds, 0 external pentests** (`docs/audit/`: 6 files —
  audit-3 ships as ledger + phase4; method headers say "subagent swarms" — say that out loud
  and quote before/after fix deltas, e.g. audit-5 B1–B5 bypasses → migrations 0062–0067)
- A four-auditor product-gap audit already drove a tracked roadmap with several items shipped
  (`docs/roadmap/README.md` origin note)

Say it in one breath: *"Zero pilots, zero revenue — and 66 migrations, 2,554 unit tests, 229
end-to-end tests, 13 database suites, 15 security probes, 5 internal red-team rounds. That's
the build receipt; the demand receipt is the two pilots in our ask."*

## Slide 9 — Competition (why we win)

| | Cloud proctoring vendors (ProctorU/Meazure, Honorlock, Examity) | Lockdown browsers only (Respondus, Safe Exam Browser) | **InnoVision (pre-deployment)** |
|---|---|---|---|
| Identity matching | Yes — via vendor cloud [UNVERIFIED — cite] | No | Yes — 1:1, self-hosted sidecar (threshold uncalibrated — Slide 12) |
| Where biometrics live | Third-party cloud [UNVERIFIED — cite] | n/a | **Institution's own infrastructure** |
| Cost model | Per exam / per proctor-hour [UNVERIFIED — cite] | License | **Flat infrastructure + capped OCR cents; LLM pass-through** |
| Server-authoritative scoring | Partial [UNVERIFIED — cite or soften to "?"] | No | **Yes — RLS + Postgres functions, one-way reveal** |
| Data revocation | Vendor-dependent | n/a | **Templates purged + consent cleared in one transaction; live fail-history retained by design** |
| Language | English-first | English | **EN + Bahasa Melayu, CI-enforced parity (1478/1478)** |

Positioning line: *"Integrity without surrendering custody of student biometrics."*

## Slide 10 — Team (at pre-revenue, the team IS the bet — founders only, no advisors)

*(FILL BEFORE PITCH DAY — all three judges flagged the blank slide as disqualifying.
Template:)*

- **Name — role:** one receipt line (e.g. "authored migrations 0001–0069 + 13 pgTAP suites",
  "built the gesture + face pipelines", "owns exhibition booth + pilots").
- **Commitment line:** "Full-time from [DATE]" or "Founders commit X hrs/week through the
  pilot semester." No commitment signal = uninvestable by default.
- *(If solo founder: say so and name the gap the ask fills — "solo technical founder;
  first hire/grant funds the pilot-facing half.")*

## Slide 11 — The ask (ONE sentence: amount + instrument + dated milestone — never a range)

*(FILL BEFORE PITCH DAY — pick the venue's line and delete the other two. All three judges
flagged the hedged ask:)*

- **(If grant/competition):** "Asking RM ___ [grant] to sign 2 faculty pilots, publish
  calibrated FAR/FRR, and complete a classroom load test by [DATE] — converting to the first
  paid faculty license at RM ___/yr."
- **(If investor):** "Raising RM ___ [pre-seed, instrument] to convert beachhead pilots into
  the first licensed faculties by [DATE]; spend is engineering + pilot support."
- **(If faculty/pilot pitch):** "Asking [FACULTY] to run one full quiz cycle next semester:
  one class, invite-code onboarding, zero procurement. Success metric: you run a second cycle
  unprompted."

*(Do not say "engineering is already built" anywhere near the ask — it answers "why fund
you?" with "no reason.")*

## Slide 12 — Risks & mitigation (prebunk before the judges do — inoculation wins)

| Risk | Honest status | Mitigation |
|---|---|---|
| No published face-match accuracy (FAR/FRR) | Real gap — GATES revenue: no institution buys proctoring without accuracy numbers | Threshold-calibration harness built (`scripts/face-threshold-report.mjs`, default 0.5 uncalibrated); publish ROC before any deployment claim; Slide 3/9 language stays "matching", never "verified" |
| No load test at classroom scale | Real gap | Single-instance classroom scope is a design constraint; load-test before multi-campus claims |
| Formal privacy policy / DPIA not yet shipped | Real gap — blocks the DPO sale in Appendix A | Consent-before-camera, in-transaction template purge, retention crons shipped; policy page + DPIA are dated roadmap items (put the date here: ___) |
| AI content quality on garbage input | Bounded | Same validation as human-authored questions; lecturer review before publish is the designed workflow |
| Single-instance ceiling | By design | Documented capacity budgets; Phase-2 managed cloud is the scaling answer, gated on the ask's milestones |
| Procurement reality | Acknowledged | Pilot is zero-procurement; institutional conversion is a 6–18 month DPO/finance/academic sale with SLA + DPIA costed in — not a config change |

## Appendix A — Go-to-market (if asked "how do you get customers?")

1. **Exhibition booth → pilot.** The built-in walk-up kiosk mode (QR → live quiz → presenter
   control room) is a sales tool: every booth visitor runs the real product loop. Every event
   is lead generation with a live product attached. (Booth scans are demos, not users —
   never count them as traction.)
2. **Lecturer-led pilots.** One class, one semester, invite-code onboarding, zero procurement.
   Success metric: lecturer runs a second quiz cycle unprompted.
3. **Institutional conversion.** SSO integration and matric-number tooling make rollout a
   config change, not a migration project — but the DPO/finance/academic-office sale is a
   6–18 month cycle needing SLA + DPIA, costed into Phase 2. Sell the privacy posture to the
   DPO, the cost model to finance, the integrity model to the academic office.

## Appendix B — Roadmap (from the shipped audit, not wishful thinking)

From the four-auditor product-gap audit (`docs/roadmap/`, tracked IDs — ask about any of
them and there's a plan file): question types → authoring productivity (incl. question
banks AP-*) → class management (incl. co-teaching + announcements CM-*) → accessibility
platform (AX-*) → results analytics → student QoL → integrity ops. Several already shipped
(QC-*, AU-*, parts of SQ/RA/IO — see `docs/roadmap/README.md` progress board).

Separately, the **deployment-hardening track** (NOT in `docs/roadmap/` — sourced from
`docs/COSTS.md` §4 + `docs/DEPLOY_VPS.md`): load tests, Supabase Pro, backups, error
tracking. It is gated on the ask's milestones, not on auditor IDs — do not conflate the two
tracks on stage.

---

### Numbers cheat-sheet (memorize these six — all MEASURED 2026-09-27)

1. **2,554 unit tests + 229 e2e + 66 migrations + 13 pgTAP suites** — the "is this real?" answer.
2. **~$0.06/user/day OCR-leg cap** — a cap, not a cost; never "worst-case AI cost" (quiz-gen LLM is uncapped pass-through).
3. **$25/mo** — removes the cron-pause integrity gap ONLY; never "full production hardening".
4. **200 guest cap / 300 guest-mints per IP per 10 min** — engineered demo budgets, cite as designed limits.
5. **EN + BM, 1478/1478 translation keys CI-enforced** — the localization wedge.
6. **15 RLS policies remediated in migration 0068** — Supabase's own advisor flagged them; we fixed all of them.

### Forbidden phrases (retired by the judge panel — never say these)

- "Verifiable assessment" → say **"tamper-evident assessment evidence"** (until FAR/FRR ships).
- "Traction" (for test counts) → say **"build evidence, pre-traction"**; demand status is "0 pilots".
- "5 audit waves" → say **"5 internal red-team rounds, 0 external pentests"**.
- "Worst-case AI cost $0.06" → say **"OCR-leg daily cap $0.06; LLM pass-through uncosted"**.
- "Full production hardening $25/mo" → say **"$25 removes the cron-pause gap only"**.
- "Atomic purge of all vectors" → say **"templates + consent cleared in one transaction; live fail-history retained by design"**.
- "Never pixels" → say **"verification stores templates + hashes, never raw frames; incident video only on integrity events"**.

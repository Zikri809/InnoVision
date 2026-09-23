# Audit-5 — Quiz Play / Integrity / Verification subsystems

Date: 2026-09-23
Method: 4 parallel discovery sweeps (Quiz Play, Integrity, Verification, Cross-subsystem
seams) followed by an adversarial verification round (8 top claims, confirm/refute) and a
residual sweep (override/AI-marking, CSRF/limits, shared-quiz, incident clips, gestures,
retakes). Discovery only; implementation tracked in §8.

Live SQL revisions referenced: `start_quiz_session` = 0048:502, `submit_session` =
0055:700, `answer_question` = 0055:89, `enroll_face` = 0047:819,
`flag_verify_silent_sessions` = 0047:502 (unchanged through 0060), `record_face_check` =
0045:151 (amended 0047), `quiz_autoclose` = 0056:25, `pause_session` = 0044:328
(amended 0046:651).

## 1. Round 0 — subsystem map (condensed)

| Subsystem | Critical flows | Entry/exit | Coverage today | Confidence |
|---|---|---|---|---|
| Quiz Play | start/rejoin → answer (first-wins) → submit (idempotent) / pause / recover / seal | Routes map only; SQL RPCs authoritative (`start_quiz_session` 0048, `answer_question`/`submit_session` 0055, seals 0056) | Strong route unit tests (stubbed RPC), e2e e4/e5/e10/e22/e35/e37/e42/e50/e56/e58; no real-SQL concurrency tests | High |
| Integrity | face-check cadence → streak/flag; pause strikes (3-strike); silence cron (1/min); second-face/frozen-frame/spoof advisories; HMAC proof | `record_face_check` (0045/0047), `pause_session` (0044/0046), `flag_verify_silent_sessions` (0047, cron), client pipeline `use-face-pipeline.ts` | Strong pure-lib unit tests + route tests; e2e e6/e16/e51 (e51 opt-in); no pgTAP for cron polarity/replay rules | High |
| Verification | consent → enroll (dup-scan) → gate → per-cycle verify (nonce+HMAC) → baseline compare via InsightFace sidecar | `face/*` routes, `enroll_face`/`record_face_check`/`face_baseline_status`, `verify_proof_secret` in `app_private` | Good route unit coverage (spoof/sentinel/nonce); e2e e1a/e3/e12/e22/e50; HMAC/ledger gates untested in CI; sidecar-5xx path untested | High |
| Seams | verify-fail→quiz degrade; flag→submit block→unlock; submit vs cron-tick race; multi-tab same session; seal at window close; reveal gating | Cross all three (RPC gates + client pipeline state machine) | e7/e50/e36/e38 pin happy journeys; race windows and >2h reveal boundary untested | Medium-High |

## 2. Bypass paths (top priority regardless of ranking)

| # | Bypass | Verdict | Evidence |
|---|---|---|---|
| B1 | **Submit-escape from flagging**: suppress verifies, answer ≥2 post-check questions, submit before next cron tick (≤60s). No writer flags completed sessions; `record_face_check` refuses them; no post-submit scan. | CONFIRMED | `0055:796-814`, `0047:522/630`, `0042:295` |
| B2 | **Unverified start via direct RPC**: `start_quiz_session` has no face-enrollment/consent gate for assessment. Silence-cron backstop needs ≥2 answers → a session answering ≤1 question is never flagged. | CONFIRMED | `0048:502-771` vs `0047:192-200` |
| B3 | **Mid-quiz identity swap**: never-enrolled student mints a session (via B2), then `face/enroll` binds any live face mid-quiz — block fires only if `v_ever_enrolled`. | CONFIRMED | `0047:941-964` |
| B4 | **Zero-answer suppression**: tampered client that never verifies and never answers (reads via second device) is invisible to the silence cron (candidacy keys on answer throughput). | CONFIRMED | `0047:554-589` |
| B5 | **Spoof enforcement convention-only**: `FACE_SPOOF_ENFORCE` absent from the fail-closed prod gate; unset = photo/replay recorded but never enforced. | CONFIRMED (deploy sets it by convention) | `prod-guards.ts:120-183`, `deploy/secrets/prod.env.enc:16` |
| B6 | **Frozen-frame replay with pixel noise**: 1 random-alpha pixel defeats the 3×-identical `frame_hash` rule; looped distinct-frame video also passes. | PARTIAL (pose/spoof/challenges corroborate) | `0047:360-375` |
| B7 | **Multi-device answer splitting** (two people, one account, two devices) — documented deferred D-F4. | Accepted-by-design | `0048:41-58` |

## 3. Must fix before prod

| # | Subsystem | Issue | Location | Risk | Mitigated? | Fix |
|---|---|---|---|---|---|---|
| M1 | Seam | B1 submit-escape: evaluate silence predicates at submit time and write an audit marker; or completed-scan cron arm | `0055:796-814`, `0047:502-707` | P0-class cheat bypass | No | SQL: submit-time silence evaluation + `audit_events` row (implemented §8) |
| M2 | Verification | B2: add enrollment/consent gate to `start_quiz_session` for assessment mode | `0048:502-771` | P0/P1 | Partial (silence cron only) | SQL gate (implemented §8) |
| M3 | Verification | B3: block `enroll_face` whenever any live assessment session exists | `0047:941-964` | P1 | No | SQL change (implemented §8) |
| M4 | Verification | `pending_review` dead end: `reject_face_enrollment` has zero route/UI callers; dup-scan permanently locks honest students; notification links to a page with no review UI | `0010:560-605`, `0047:991-1004`, `play/[sessionId]/page.tsx:278-281` | P1 | No | Lecturer route + UI for approve/reject (implemented §8) |
| M5 | Integrity | Sustained sidecar outage (>~12-15 min) batch-flags honest students: probe budget (5 attempts) exhausts, `face_verify_attempted_at` stales past the 10-min corroboration bound while re-arm keeps the claim fresh-but-uncorroborated | `use-face-pipeline.ts:447-509`, `0047:539-553` | P1 | Partial (reload/transient recovery) | Slow corroboration heartbeat while `unavailable` (implemented §8) |
| M6 | Integrity | B5: add `FACE_SPOOF_ENFORCE !== "1"` to `inspectProdEnv` violations | `prod-guards.ts:120-183` | P1 | Deploy-convention only | Env gate + test (implemented §8) |
| M7 | Verification | No sidecar health monitoring: `/api/health` probes DB only; `/api/face/health` is auth'd + rate-limited (unpollable) | `health/route.ts:217-251`, `face/health/route.ts:22-41` | P1/P2 | Partial | Anonymous sidecar probe in `/api/health` (implemented §8) |

## 4. Should add test for

| # | Gap | Location | Status |
|---|---|---|---|
| T1 | No real-SQL concurrency tests: two concurrent starts (one 201), two concurrent submits (200 + `already_submitted`), start racing seal at `closes_at` | `0048:670-691,740-756` | **Done** — `supabase/tests/0064_concurrency.sql` (7 assertions). Note: a true multi-connection race cannot run under `supabase test db` (connects as non-superuser `postgres`; libpq refuses passwordless dblink). The suite pins the GUARANTORS deterministically: the `one_active_assessment_attempt` partial unique index rejects a duplicate live row (23505), a second start returns `already_attempted` pointing at the same session, and submit is idempotent with a stable score. Documented gap: the advisory-lock race itself needs superuser, which CI does not grant. |
| T2 | No pgTAP suite pinning `flag_verify_silent_sessions` polarity and the 0044 answer-count grace | `0047:502-707` | **Done** — `0063_audit5_test_round.sql` T2a–T2f: 90s answer-freshness, 300s check-staleness, `>=2` post-check answer grace, and the outage-claim exemption (with/without corroboration) all gate flagging exactly as documented. |
| T3 | No e2e for frozen-frame 3× rule; e51 hardening spec opt-in only | `e2e/e51-integrity-hardening.spec.ts:36-40` | **Done** — pinned in pgTAP (`0063` T3) against the REAL RPC with a valid HMAC proof: three identical MATCHED frames share one `frame_hash` and the 3rd pauses the session. Chosen over an opt-in e2e so it runs in the default `supabase test db`. |
| T4 | Replay-after-abort answer dedup, pause double-strike regression, double-click submit inside one tab | `play-client.tsx:831-851,1095-1113`, `pause/route.ts:139-159` | **Covered already** — pause double-strike/dedup is pinned in `face-session-routes.test.ts` (lines 132–148: "duplicate focus signal → 200 WITHOUT a second strike" + recovery re-strikes); `already_answered` is pinned in `sessions-routes.test.ts`; `submitLock`/`inFlightAnswer` are client E2E-only (play-client excluded from vitest coverage by design). No new test needed. |
| T5 | HMAC/attempt-ledger gates untested in CI; secret-unavailable fail-closed paths; secret rotation mid-mint; 429-streak backstop unit test | `0045:79-365` | **Done (SQL layer)** — `0063` T5a–T5d: a proof-less direct call → `proof_required`, a forged proof → `proof_invalid`, a valid proof bound to OTHER frame bytes → `proof_invalid` (no cross-payload reuse), and the attempt ledger records session-scoped rows. Secret-missing → `proof_invalid` is the RPC's own fail-closed branch (code-pinned). Route-side minting is covered by the existing `face-routes` suite. |
| T6 | Two parallel same-nonce verifies → one row + one `nonce_mismatch`; two-tab nonce churn over a long quiz | `0047:235-238`, `outcome.ts:43-44` | **Done** — `0063` T6a–T6c: a genuine verdict rotates `verify_nonce`; a REPLAYED nonce → `nonce_mismatch` (checked BEFORE the proof gate). The `FOR UPDATE` row lock is the serialization (documented in the suite header). |
| T7 | Flag idle >2h stops blocking submit-time auto-reveal — pin the 2h boundary | `0055:828-833`, `0056:78-83` | **Done** — `0063` T7a/T7b: a residual session with fresh `last_activity_at` is inside the 2h blocking set; once staler than 2h it no longer blocks. |
| T8 | Short_text lifecycle with cron jobs dropped → health `degraded`; stranded-pending recovery runbook | `0059_cron.sql:48-49` | **Covered already** — `health-route.test.ts` ("flags a job that has NEVER run and a job missing entirely") pins `cron.ok === false` + `neverRan`/`missing`, which is exactly the dropped-jobs outcome. Runbook lives in `docs/DEPLOY_VPS.md` §12 (referenced from the route). No new test needed. |
| T9 | pgTAP: two concurrent `focus_lost` pauses → exactly one strike | `0044:430-440` | **Done (corrected)** — the RPC increments ONE strike per call (the `FOR UPDATE` lock serializes; it never coalesces). `0063` T9a–T9c pin 2 calls → 2 strikes, the 3rd flags, and `fullscreen_exit` never contributes. The real "one strike per user action" guard is the ROUTE's already-paused coalesce, already pinned in `face-session-routes.test.ts`. |

## 5. Should add observability for

| # | Gap | Location | Status |
|---|---|---|---|
| O1 | No audit/metric for start/submit/seal; all logging is bare `console.*` (no pino/OTel/metrics lib in the repo) | `sessions/route.ts:66,98`, `submit/route.ts:63,97`, `0056:50-60` | **Done** — migration 0062 adds `session_started` (start), `session_submitted` (submit), and `session_sealed` (autoclose seal) `audit_events` rows; pinned in `0063` O1a–O1c. Bare `console.*` in the start/submit/answer routes replaced with structured `logError`. |
| O2 | No flag-rate aggregate: mass false-flag deploy surfaces only as day-bucketed per-session mails | `0047:692-703`, `health/route.ts:62-73` | **Done** — migration 0065 adds `integrity_snapshot(window_hours)` (service-role) returning `flags24h` + `flagsByAction` + `flaggedNow`; surfaced under `/api/health`'s lecturer-only section as `integrity`. |
| O3 | No cross-subsystem correlation: verify-503→cron-flag→answer-409 leaves three independent console sinks; no shared `{sessionId, subsystem, errorCode}` structure | `answer/route.ts:110`, `verify/route.ts:243,343`, `0045:762-772` | **Done** — new `src/lib/log.ts` (`logError(msg, err, {subsystem, errorCode, sessionId})`) emits ONE JSON line; adopted in the answer, verify, start, and submit routes. Unit-tested (`log.test.ts`, 6 cases) with a 100% line floor. |
| O4 | Route-429s never stamp `face_verify_attempted_at` while SQL-throttle 429s do — asymmetric corroboration | `verify/route.ts:95-97 vs 175-196,367` | **Done** — the rate-limit check moved AFTER body parse so a route-429 stamps via `stampVerifyAttempt` (owner-scoped); pinned in `face-routes.test.ts` ("audit-5 O4: a route-level 429 DOES stamp"). |
| O5 | No metrics on abandonment; cron seal count is an unread return value | `0056_lifecycle.sql:50-60` | **Done** — `integrity_snapshot` (0065) exposes `sealed`/`submitted`/`started`/`pendingMarks` for the window, making abandonment and reveal-stranding visible without reading `quiz_autoclose`'s discarded return value. |

## 6. Nice to have

| # | Issue | Location | Status |
|---|---|---|---|
| N1 | No runtime kill-switch for integrity heuristics or verification; thresholds hardcoded; no sidecar-outage/mass-exempt runbook | `0042:292-299`, `0047:502-710` | **Deferred (review later)** — product/ops decision: which thresholds become runtime-configurable and what the runbook says. |
| N2 | Frozen-frame rule: add low-bit perceptual hash (dHash) or RPC-side pose-variance check | `0047:360-375` | **Deferred (review later)** — behavioral change to the replay rule; needs a design pass (dHash vs pose-variance) and threshold tuning. |
| N3 | Zero-answer suppression: parallel cron arm (check-stale >600s, ≥2 total post-check answers) | `0047:554-589` | **Deferred (review later)** — new detection arm; false-positive risk on honest zero-answer readers needs product sign-off. |
| N4 | Multi-device split: per-device token or nonce-lineage interleaving flag — product decision | `0048:41-58` | **Deferred (review later)** — product decision (documented accepted-by-design B7 up to now). |
| N5 | Sidecar circuit breaker/backpressure for gate-rush thundering herd | `insightface-client.ts:66,203-259` | **Deferred (review later)** — infrastructure change; needs load characterisation. |
| N6 | Baseline embedding-model versioning before any sidecar model upgrade | `0039:56-63` | **Deferred (review later)** — process/ops item (migration path for a model upgrade). |
| N7 | Unadjudicated flagged sessions = unbounded student dead-end: escalation digest for flags >N hours | `0056:50-54`, `0048:646-650` | **Deferred (review later)** — overlaps O1/O2 now that flags are auditable; the digest cadence is a product choice. |
| N8 | Incident-clip ceiling 1.2 GB/session vs documented 360 MB; 4-byte magic-byte validation; no cross-session per-user quota | `face/constants.ts:220`, `incident/route.ts:33,155-166` | **Deferred (review later)** — ceiling/quota policy (storage cost vs forensics) is a product call. |
| N9 | Reset launders flagged-session face evidence (cascade deletes `face_checks`); archive metadata into the `session_reset` audit row | `0046:552-645` | **Deferred (review later)** — privacy vs forensics trade-off; needs a retention decision. |
| N10 | Practice answers burn the 30/min per-session answer budget → mid-practice 429s | `answer/route.ts:35,80-82` | **Deferred (review later)** — confirmed still open (one `ANSWER_SESSION_RATE`, mode-unaware). Small fix but a product-behavior change (practice pacing). |
| N11 | Misc P3: raw error-code fallback (`forbidden`) mid-exam; override wastes one GLM call; `recheck_quiz_completion` retake-arm divergence; `/s/[code]` page path unthrottled; `ai_marking_ledger` unbounded; secret-rotation runbook; exam clock burns during `unavailable`; `E2E_RATE_LIMIT_DISABLED` CI assertion; hand-loss flags labeled `auto_flag_focus_loss`; per-call attempt-ledger prune; `(status,mode,last_activity_at)` index for cron cursor | various | **Partially done** — the `(action, created_at)` audit index landed in 0065 (was one of the N11 items). The rest remain **deferred (review later)** as a P3 grab bag. |

## 7. Residual sweep findings (Round 2, new)

| # | Issue | Location | Risk | Status |
|---|---|---|---|---|
| F1 | AI-mark finalization has no runtime recovery if pg_cron is absent: `sweep_ai_marks`/`escalate_stale_marks` registration is swallowed; pending answers permanently block auto-reveal | `0059_cron.sql:48-49`, `0055:834-839` | P2 | **Open** — visible now via `integrity_snapshot.pendingMarks` (O5), but no auto-recovery. |
| F2 | Incident-clip volume ceiling 4× the documented cap (40 × 30 MB = 1.2 GB/session); 4-byte magic validation; no cross-session per-user quota | `face/constants.ts:220`, `incident/route.ts:33,155-166` | P2 | **Open** — same as N8 (deferred). |
| F3 | Lecturer override leaves the AI ledger row claimable → one wasted GLM call per overridden pending answer | `0058_override.sql:79-91`, `0057:225-231` | P3 | **Open** — deferred. |
| F4 | `recheck_quiz_completion` drops the retake-budget arm its comment claims is identical to submit's | `0057:449-472` vs `0055:839-847` | P3 | **Open** — deferred. |
| F5 | `/s/[code]` page path resolves share codes with no rate limit (API budgets bypassable via page renders) | `s/[code]/page.tsx:48-80` | P3 | **Open** — deferred. |
| F6 | Raw error codes can render to students mid-exam in the fallback arm (`forbidden`); i18n catalogs themselves are clean (1396/1396 keys) | `play-client.tsx:1001-1008`, `http.ts:42` | P3 | **Open** — deferred. |
| F7 | `ai_marking_ledger` has no retention (unbounded growth) | `0057:36-62` | P3 | **Open** — deferred. |

## 8. Verification verdicts (Round 2) and implementation status

| Claim | Verdict | Implementation |
|---|---|---|
| 1. Submit-escape (B1) | CONFIRMED | **Implemented** — migration `0062_quiz_integrity_gates.sql`: `session_verify_silent` helper + submit-time silence evaluation writes an `auto_flag_verify_silence` audit row (`via:'submit'`); the autoclose seal arm writes `via:'autoclose_seal'`. Pinned by pgTAP `0062` (I-29). |
| 2. Sustained-outage false flag (M5) | CONFIRMED | **Implemented** — `use-face-pipeline.ts`: slow corroboration heartbeat (every 5 min) after the bounded probe budget exhausts, keeping `face_verify_attempted_at` fresh for a genuine outage; never fires when hidden/terminal; stops on recovery. |
| 3. Spoof fail-open (B5/M6) | CONFIRMED | **Implemented** — `prod-guards.ts`: `FACE_SPOOF_ENFORCE !== "1"` is now an `inspectProdEnv` violation (exempt only for the fully-mocked seam); unit tests added. |
| 4. `pending_review` dead end (M4) | CONFIRMED | **Implemented** — `approve_face_enrollment` + `list_pending_face_enrollments` RPCs (0062 §6–7), route `POST /api/face/enrollments/review`, and the classes-dashboard review panel; pgTAP I-30 + route tests. |
| 5. `start_quiz_session` gate gap (B2/M2) | CONFIRMED | **Implemented** — 0062 §4: assessment starts require consent (`consent_required`) and refuse `pending_review` (`face_enrollment_pending`). Route mapping + client copy + pgTAP I-27. |
| 6. Mid-quiz enroll (B3/M3) | CONFIRMED | **Implemented** — 0062 §5: `enroll_face` refuses while ANY live assessment session exists (`live_assessment`). pgTAP I-28. |
| 7. Multi-tab nonce churn (T6) | PARTIAL (single collision self-heals via GET-refresh retry; sustained racing → silent `ready`) | **Pinned** — `0063` T6a–T6c (replay → `nonce_mismatch`; a genuine verdict rotates the nonce). |
| 8. Reveal 2h boundary (T7) | CONFIRMED | **Pinned** — `0063` T7a/T7b (fresh residual blocks reveal; stale >2h does not). |

### Test + observability round (§4–§5) — evidence

All nine `T` items and all five `O` items are addressed; N-series deferred to review.

| Item | Deliverable | Evidence |
|---|---|---|
| T1 | `supabase/tests/0064_concurrency.sql` | 7 assertions — partial-unique-index rejection of a duplicate live row (23505), second start → `already_attempted` (same session), idempotent submit + stable score. Multi-connection race impossible under `supabase test db` (non-superuser; libpq refuses passwordless dblink) — guarantors pinned instead (documented). |
| T2, T3, T5, T6, T7, T9 | `supabase/tests/0063_audit5_test_round.sql` | 25 assertions across six sections (silence polarity, frozen-frame 3× pause, HMAC proof gates + ledger, nonce replay, 2h boundary, pause strikes). |
| T3 (frozen-frame) | `0063` T3 | 3 identical MATCHED frames share one `frame_hash`; the 3rd pauses — against the REAL RPC with a valid HMAC proof. |
| T4, T8 | (already covered) | `face-session-routes.test.ts` (pause double-strike + recovery re-strike), `sessions-routes.test.ts` (`already_answered`), `health-route.test.ts` (`cron.ok:false` on dropped/missing jobs). |
| O1 | migration 0062 + `0063` O1a–O1c | `session_started` / `session_submitted` / `session_sealed` audit rows. |
| O2, O5 | migration 0065 (`integrity_snapshot`) + `supabase/tests/0065_integrity_snapshot.sql` + `/api/health` | 6 assertions; `flags24h`/`flagsByAction`/`flaggedNow`/`sealed`/`submitted`/`started`/`pendingMarks`; service_role-only grant pinned. |
| O3 | `src/lib/log.ts` + `log.test.ts` | 6 unit cases; JSON `{level,msg,ts,error,subsystem,errorCode,sessionId}`; adopted in answer/verify/start/submit routes; 100% line floor. |
| O4 | `verify/route.ts` + `face-routes.test.ts` | "a route-level 429 DOES stamp `face_verify_attempted_at`". |
| N11 (partial) | migration 0065 | `audit_events(action, created_at desc)` index added (one of the N11 items). |

### Deviations from the audit's literal recommendations

- **M2 narrowed.** The audit recommended requiring `face_enrollment_status = 'enrolled'`
  at assessment start. A hard enrollment requirement was REJECTED: PLAN risk 7
  deliberately accepts camera-off / camera-death students completing assessments
  click-first (enrollment needs a camera; `exempt_face_session` is the safety net),
  and 0047 gate 3 deliberately allowed a first-time mid-session enrollment to break
  the start-before-enroll deadlock. The gate therefore requires **consent** (the
  camera privacy invariant, universally set at registration/SSO-gate) and refuses
  **pending_review**; the exploitable half (mid-session identity swap) is closed by
  M3 instead.
- **M3 accepted consequence.** Blocking enrollment whenever a live assessment exists
  means an honest start-before-enroll student must ask the lecturer for a reset
  before enrolling. This was the deliberate trade for closing full impersonation.

### Implementation plan (as approved) and evidence

| Item | Approach | Files | Verification |
|---|---|---|---|
| M1 | `public.session_verify_silent(uuid)` predicate mirroring the LIVE `flag_verify_silent_sessions` at 0047:502 minus the 90s answer-freshness, quiz-liveness and enrollment terms (documented deviation); `submit_session` (baseline 0055:700) writes an `auto_flag_verify_silence` audit row (`via:'submit'`) before the completion UPDATE, dedupe-guarded on `metadata->>'session_id'`; `quiz_autoclose` (baseline 0056:25) writes the same marker (`via:'autoclose_seal'`) before the seal UPDATE | `supabase/migrations/0062_quiz_integrity_gates.sql` | pgTAP I-29 (marker + dedupe + honest-submit negative + autoclose arm) |
| M2 | `start_quiz_session` (baseline 0048:502) returns `consent_required` when `consent_given_at` is null and `face_enrollment_pending` when `face_enrollment_status = 'pending_review'` — assessment path only, after the practice branch. Hard `enrolled` requirement REJECTED (PLAN risk 7 camera-off click-first; 0047 gate 3 deadlock-breaker) | 0062 §4; `src/app/api/sessions/route.ts` (403 mappings); `student-quizzes-client.tsx` (localized copy); `en.json`/`ms.json` | pgTAP I-27; route unit tests; live probe returned `{"error":"consent_required"}` |
| M3 | `enroll_face` (baseline 0047:819) gate 3 refuses whenever ANY live assessment session exists (`live_assessment`), dropping the `v_ever_enrolled` conjunct; `v_ever_enrolled` retained only for the audit action label | 0062 §5 | pgTAP I-28; `verify-face` D11b |
| M4 | New RPCs `approve_face_enrollment(uuid)` (lecturer, `not_pending` guard, GUC-guarded status write, audits `face_enroll_approved`) and `list_pending_face_enrollments()` (lecturer-scoped, `{student_id, full_name, matric_no, classes}`); route `POST /api/face/enrollments/review` (`{studentId, decision}`, `not_pending`→409); classes-dashboard review panel | 0062 §6–7; `src/app/api/face/enrollments/review/route.ts`; `classes/page.tsx` + `classes-client.tsx`; `face/types.ts`; i18n | pgTAP I-30; new route test file (10 cases) |
| M5 | `use-face-pipeline.ts`: `UNAVAILABLE_HEARTBEAT_MS = 5 min` + `unavailableHeartbeatTimerRef`; the retry budget (`UNAVAILABLE_RETRY_MAX_ATTEMPTS = 5`) exhaustion hands over to `scheduleUnavailableHeartbeat()`; `clearUnavailableRetry()` clears both timers; never fires when hidden/terminal; stops on recovery | `src/components/face/use-face-pipeline.ts` | face unit suites (228 pass) |
| M6 | `ENFORCEMENT_KEYS` in `inspectProdEnv`; `FACE_SPOOF_ENFORCE !== "1"` is a violation unless both `NEXT_PUBLIC_E2E_FAKE_SEAM=1` and `FACE_MOCK_ENABLED=1` | `src/lib/prod-guards.ts` + tests | `prod-guards.test.ts` (34 pass) |
| M7 | `/api/health` returns `face: { available }` for anonymous callers via `insightface.health()`; never fails the endpoint (`ok` stays true); cron stays lecturer-only | `src/app/api/health/route.ts` + tests | health-route tests |
| CI/e2e | `createUser` in the verify harnesses seeds `consent_given_at` (service-role); pgTAP fixtures updated; `verify-face` D11a/D11b restructured | `scripts/verify-*.mjs`; `supabase/tests/0055/0057/0058` | all harnesses green (see below) |

**Evidence run (2026-09-23, local Supabase):** `npx supabase db reset` clean → pgTAP
`208/208`; `npm run typecheck` clean; `npm test` `2451/2451`; `npm run lint` 0 errors;
`npm run check:i18n` parity 1405/1405; CI harnesses — `verify-face` 85/85,
`verify-sessions` 74/74, `verify-quizzes` 83/83, `verify-results` 21/21,
`verify-classes` 36/36, `verify-class-archiving` 17/17, `verify-silence` 12/12.
Playwright e2e not run (invite-gated / needs live seam); M2/M3 compatibility verified
statically (all face specs enroll before Start; `registerUser` checks consent,
`fastRegisterUser` seeds it).

## 9. Convergence statement

Round 1 (4 parallel sweeps) → Round 2 (adversarial verification of all P1 claims + residual
sweep). All 8 verification claims resolved with decisive evidence (7 confirmed, 1 refined);
the residual round added only P2/P3 findings; zero findings remained untraced or
contradicted. Converged after 2 rounds.

## 10. Swept clean (no action)

Submit/grading atomicity (single-txn + seal trigger + finalizer recompute); late-submit
permissiveness (deliberate, D45/E10); SQL gate list vs direct-RPC probing (except M2);
nonce lifecycle & HMAC proof design; flagged→result-release ordering (manual reveal +
in-flight masking); window-close/seal/answer lock ordering; retake slot concurrency
(advisory lock + partial indexes); practice→assessment leakage (mode freeze); CSRF/Origin,
XFF, limiter memory; shared-quiz authz/no-oracle; incident-clip access control; notification
dedupe/growth; gesture answering server-authority; ai-mark-sweep auth/idempotency; consent
revocation mid-quiz (atomic force-flag); verify-after-completion (inert).

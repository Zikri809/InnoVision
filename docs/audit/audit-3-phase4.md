---

## Phase 4 — Implementation status (2026-09-13, fix pass)

All 32 Phase-3-validated findings plus the Round-1/2 candidates adjudicated as
CONFIRMED were implemented in one pass. **Verification at the time of writing:**
`npx tsc --noEmit` clean · `npm run lint` 0 errors (26 pre-existing warnings) ·
**`npx vitest run --coverage` — 0 threshold errors, 117 files / 1808 tests
passing** (this is the CI-blocking gate; `vitest run` alone is not) ·
`npm run lint:workflows` exit 0 · `node scripts/check-env-parity.mjs` exit 0 ·
`node scripts/check-i18n.mjs` exit 0 (1287/1287).

> The fixes were then re-derived by independent reviewers; their findings are
> recorded in the "Post-fix adversarial review" section at the bottom of this
> file. Read that section too — it corrects the claim above (the coverage gate
> was RED when this line was first written) and lists 12 further fixes.

**SQL IS now verified by execution** (see "Live verification" at the bottom of
this file). The four migrations were applied to a local Supabase and all 15
`verify:*` harnesses pass — including the SV6/SV8 pins for the R2-FACE-F1
polarity fix and the R2-RLS-F1 column-grant posture.

### Migrations added

| File | Findings |
|---|---|
| `0047_audit3_face_integrity.sql` | E-F1, E-F3, R2-FACE-F1, H3-RACE-F1, E-F4, H3-RACE-F2, R2-FACE-F2 (via `cron_health()`) |
| `0048_audit3_session_loop.sql` | D-F1, D-F2, D-F3, D-F5, R2-SESS-F3, R2-RLS-F1, R2-NOTIF-N1, R2-NOTIF-N2 |
| `0049_audit3_authoring.sql` | H3-RACE-F3, H3-ATOM-F1, H3-RACE-F4, H3-ATOM-F5 |
| `0050_audit3_auth_hardening.sql` | A-F6, A-F9 |

### Fixed

| Finding | Fix |
|---|---|
| **H3-INFRA-F1** (Critical) | Quoted the unquoted step name at `ci.yml:184`. Verified: js-yaml now parses `jobs=test,integrity-e2e` (29/9 steps). **Recurrence guard added** so this cannot land a third time: `scripts/check-workflows.mjs` + a `lint:workflows` script + a dependency-free `workflow-lint` job + the same check as the first step of the `test` job. |
| H3-INFRA-F2/F3 | Mirrored the webServer build-time env into the `integrity-e2e` job (it was pre-building a seam-less bundle); added an E2E start-time marker + a step-summary reporter that distinguishes a TIMEOUT from a real failure. |
| H3-INFRA-F4 | `FakeSupabase.rpc()` now THROWS on an unmodeled name instead of returning a success-shaped `{data:null,error:null}` (13 seam-only names explicitly allowed). New `fake-supabase-guard.test.ts`. |
| H3-INFRA-F5/F6 | Removed the dead `classes/join` coverage key (its comment was also false — two describe blocks exist); added `src/app/api/classes/**` + the 7 tested-but-untracked modules to `coverage.include` with real floors. Verified: 33 globs / 0 dead keys. |
| H3-INFRA-F7 | `verify:silence` wired into package.json + CI. |
| H3-INFRA-F8 | `src/instrumentation.ts` (`onRequestError`, structured JSON to stderr) + `/api/health` (DB reachability + pg_cron job health via the new service-role-only `cron_health()` RPC). 5 tests. |
| H3-INFRA-F9 | 12 silent `storage.remove().catch(() => {})` sites migrated to a logging helper; the 2 remaining `.catch(() => {})` are non-storage face-verify chains. |
| **R2-FACE-F1** (High) | The silence-cron outage-claim terms are restated as ONE exemption predicate (`fresh AND corroborated`), replacing the four inverted OR-disjuncts. `coalesce(…, false)` on the attempt stamp keeps a NULL from vanishing the candidate. |
| **E-F1** (High) | `face_checks.nonce` added; the pose/spoof trail is now written by `record_face_check` in the SAME statement as the verdict (new trailing `p_poses jsonb default null`), so the audit record is complete the moment a check exists. |
| **E-F3** (Medium) | `attach_frame_poses` DROPPED — the folded write leaves no client-callable pose writer. |
| E-F2-ORDER | The verify-route attempt stamp moved after the frame loop and now fires only for outage-shaped failures (`invalid_frame` excluded — that is the shape a tampered client loops to fake corroboration). |
| E-F4 | `report_face_unavailable`'s re-arm no longer touches `last_activity_at`, so a maintained claim cannot hold auto-reveal open for the whole class. |
| E-F5 | `unavailable` gained a bounded, backoff self-heal retry (5 attempts, 30s×n) so a transient sidecar 5xx no longer ends proctoring for the page-load. |
| E-F6 | The mock seam now emits a memoized production warning (mirrors `hardening-gate.ts`). |
| E-F7 | `enroll` reads the sidecar spoof verdict and rejects a majority-spoofed capture (`spoof_detected` 400) — a poisoned baseline can no longer be planted. |
| **H3-RACE-F1** (Medium) | The tautological `paused_at` guard replaced by `resume_grace_until`, set by a trigger only after a genuinely >300s pause. |
| **H3-RACE-F2** (Medium) | `enroll_face` takes a global transaction advisory lock across (dup-scan → insert), closing the concurrent two-account duplicate-face bypass. |
| R2-FACE-F2 | `cron_health()` exposes each `innovision-*` job's last status/run/return, surfaced by `/api/health`. |
| **D-F1** (High) | Both arms: the client's `quiz_not_live` branch submits instead of dead-ending; `quiz_autoclose` now seals `active`/`paused` sessions of any closed quiz (manual closes included) using the existing seal machinery. |
| D-F2 | `remainingMs` returned from `self_recover_session`'s already-active path and from `unlock_session`; adopted by the flagged poll, the nonce-retry GET, and the GET route. |
| D-F3 | The stale-window seal no longer touches `flagged` sessions and no longer writes `submitted_at`. |
| D-F5 | `pause/route.ts` enum aligned with the RPC (adds `hard_blur`). |
| R2-SESS-F2 | Product call made explicit: `dead` IS terminal for the countdown (documented, with the rationale). |
| R2-SESS-F3 | All three resurrect paths gained a liveness gate and return `quiz_not_live` for a closed quiz. |
| **R2-RLS-F1** (Medium) | Table-level SELECT revoked from `authenticated` on `quiz_sessions` and `session_answers`, re-granted as explicit safe column lists (minus `score` / `is_correct`). The 0012 column-level revoke was a no-op — Postgres ignores a column revoke while a table grant stands. Every production base-table read was audited to use granted columns. |
| R2-NOTIF-N1 | Advisory lock around the completion count + `submitted_at is not null` in the count (completes the seal≠submit rule); the digest is re-evaluated set-based on autoclose. |
| R2-NOTIF-N2 | `prune_expired_notifications` now caps NON-URGENT unread rows at 500/recipient; the urgent tier stays exempt so an unseen integrity alert survives volume. |
| R2-INC-F1/F4/F9/F10 | Clip upload checks `response.ok` and logs the status (a resolved 429/413/500 was silently discarded); `incident_clips` + `session_advisories` reads capped; a flush racing a clean submit now uploads the drained clip; a recorder `onerror` salvages the ring buffer instead of zeroing it. |
| R2-INC-F2 | The incident recorder's enabled gate now excludes `submitted` AND `dead`, and an `enabled`-flip actually stops the recorder and releases the camera. |
| R2-INC-F3/F5/F6/F7/F8 | Covered by the retention/prune fixes plus the validated-path and bucket-limit work already landed. |
| B-F1 | Orphan (unenrolled/removed-student) attempts now get Summary rows built by the same `buildRow` as roster rows, so the matrix, average and integrity counters agree — and they match the per-quiz sheets' existing behaviour. |
| B-F2 | Per-quiz and Summary percent cells both write a 0-1 fraction with a `0%` numFmt (mirrors the per-quiz export), with tests asserting value + numFmt. |
| B-F3 | Every gradebook Summary string cell passes `safeText()` (names, matric numbers, quiz titles) — the formula-injection choke point the docstring declares. |
| B-F4 | The >25-quiz downgrade now emits the promised visible note + `X-Gradebook-Sheet-Detail-Omitted`; `truncated`/`rosterTruncated` are surfaced (+ `X-Gradebook-Columns-Truncated`). |
| B-F5 | `rosterTruncated` uses `>` (truncated only when rows were actually dropped); the test that encoded the off-by-one was rewritten. |
| B-F6 | `rosterTruncated` threaded to the class detail page and rendered honestly ("First 100+ …", count suffix, amber notice per the clay tokens). |
| B-F7 | `sessionsTruncated` added to both reads, detected via `count: "exact"` (so the PostgREST `max_rows=1000` clamp is caught, resolving the NMI); `answersTruncated` surfaced too. |
| B-F9 | Gradebook-export tests 8 → 21: SHEET_BUILD_LIMIT cliff, truncation flags, three 500 arms, empty-class skip, name dedupe/collision, roster truncation, Summary average/footer, and per-quiz cell content + numFmt. |
| **INJ-F1** (Medium) | `sanitizeSheetName` strips leading/trailing apostrophes (and guarantees a non-empty fallback); workbook assembly is wrapped so an ExcelJS throw returns a typed error like the per-quiz twin. Any leading/trailing apostrophe 500ed, not just the 31-char slice. |
| A-F1/H-F4 | Documented the topology dependence in `request-ip.ts`, made `TRUSTED_PROXY_COUNT` explicit, and added a one-time direct-access warning so the degenerate shared bucket is observable instead of silent. |
| A-F2 | `/auth/callback` builds every post-auth Location from `resolveSiteOrigin()` (not the request origin), so a tunnel deployment no longer 307s to an unreachable internal host. |
| A-F3/B-F8 | Bucket eviction is now genuine LRU (hits delete-then-set to refresh order); the sweep is rate-limited to 1/s (R2-TOP-F4). |
| A-F4 | The per-account login budget became a FAILURE counter: only failed sign-ins count, a success clears it, crossing the threshold is logged. Removes the indefinite single-victim lockout. **Residual risk documented in code**: without a per-account gate, one-account guessing is bounded only by the per-IP budget and attribution. |
| A-F5 | `tryCreateAdminClient()` (null-returning) used by the advisory matric lookups in register + matric-capture, so an unset `SUPABASE_SERVICE_ROLE_KEY` degrades an error message instead of blocking student signup / permanently wedging SSO students. |
| A-F6 | `profiles_full_name_len` CHECK (120) + the trigger clamps to the same bound, so a name injected via the public signup API or a direct self-PATCH cannot inflate roster payloads. |
| A-F7 | Middleware replays refreshed auth cookies onto BOTH redirect responses (they were dropped, so a refresh during a redirect was lost). |
| A-F8 | The login bounce preserves the query string (`pathname + search`). |
| A-F9 | `handle_new_user` gained the institutional-domain gate, reading the list from the `app.institutional_email_domains` GUC — the only provisioning chokepoint every path (password signup, OAuth, admin API) must pass. Reads the provider from `raw_app_meta_data` (identities rows do not exist yet at AFTER INSERT). |
| C-F1 | `quiz-sources` paths validated before the service-role sweep (shape + prefix + tenant re-check), matching the question-images gate. |
| C-F2 | The 30-question cap maps to a typed 422 in the add route (mirroring import-questions); the builder gained cap awareness. |
| C-F3 | Window parse and display now agree on one zone, and the labels/helper state it explicitly. |
| C-F4 | `reveal-settings` reordered to CSRF-before-limiter (the sole inverted route). |
| C-F5 | Nullable-field handling made consistent; a null-only PATCH no longer yields a misleading 404. |
| H3-AUTHZ-F1 | DELETE limiter added to `student-quizzes/[id]` (the only unbudgeted mutating handler); PATCH limiters moved before the body parse. |
| H3-AUTHZ-F3 | **Reported, not fixed**: `extract/ocr` GET needs the same `rateLimit()` call as its POST sibling. |
| H3-RACE-F3 | Bulk import gained an in-flight guard + generation tag (mirroring the student path). |
| H3-RACE-F4 | `join_class` locks the class row before the archived gate, so a join cannot commit into a just-archived class. |
| H3-ATOM-F1 | The student generate replace-branch no longer destroys a concurrently appended manual question (generation-scoped delete). |
| H3-ATOM-F3 | **Reported, not fixed**: the lecturer promotion audit insert + verification re-read need error surfacing. |
| H3-ATOM-F5 | Reveal refuses while the quiz is live with in-flight sessions. |
| F-F1 | `regenerate-question` threads an AbortSignal and the `cancelled` branch is reachable (no write on abort). |
| F-F2 | Rate-limit vs read failure distinguished end-to-end; the dialog names the cause and offers a page-level retry that never re-spends the budget. |
| F-F3 | Both OCR engines stream page-by-page (rasterize → recognize → release) instead of materialising the whole deck. |
| F-F4 | The OCR proxy gained a per-user in-flight cap (`glm_busy`); the route's false "H-12 fixed this" comment corrected. |
| F-F5 | The dialog reports contributing-vs-total files and names the skipped ones; provenance is limited to contributing paths. |
| F-F6 | The web corpus gets a reserved share and the citation/payoff count reflects what survived the slice. |
| F-F7 | Decision recorded: the pre-existing title always wins; the AI title is a validation gate only. |
| F-F8 | `parseQuizJson` falls back to extracting a balanced JSON object from prose-wrapped output. |
| F-F9 | Both chat helpers bail at entry on an already-aborted signal. |
| F-F10 | Upstream 429 maps to a distinct retryable code with its own message. |
| F-F11 | Switching to paste mode clears the stale upload state, so provenance cannot reference unused files. |
| G-F3 | Student quiz/question deletes now clean up their storage objects eagerly (mirroring the lecturer twins). |
| G-F7 | Dead `checkMultipartLength` deleted with its tests and stale comments. |
| INJ-F2 | `hostnameOf`'s fallback is sanitized like its siblings and `final_url` is normalized; the forged-envelope vector is closed. |
| INJ-F3 | `sanitizeStorageFilename` preserves a valid extension for dot-only names. |
| H-F1 | Env parity green: `NEXT_PUBLIC_SITE_URL` documented, `NEXT_PHASE` in `ALLOWED_ABSENT`, `TRUSTED_PROXY_COUNT` added; the stale `TRUSTED_ORIGINS` comment corrected. |
| H-F2/R2-TOP-F2 | The middleware matcher is a POSITIVE allowlist; the manifest/robots/sitemap/sw/well-known are never intercepted (29 execution-verified cases). |
| H-F3 | The notification poll no longer stays stopped when the hook mounts hidden; visibility is React state and `nextHealth` receives the current value. |
| H-F6 | `check-i18n.mjs` now scans `tFor(locale)` call sites (proven by a temporary bogus key). |
| H-F7 | `checkBodyLimit` deleted with its tests and every stale reference. |
| H-F8/R2-TOP-F1 | `next.config.ts` origin lists are env-derived (no hardcoded deployment); `TRUSTED_ORIGINS` documented for the LAN posture. |
| R2-TOP-F3 | Reset mail gained a per-email daily ceiling, keeping the enumeration-safe response. |
| R2-TOP-F5 | Matric-capture and reset per-IP budgets raised to the classroom-NAT precedent (30/min). |
| R3-INT-F1 | `microphone=(self)` (the empty allowlist blocked same-origin, so the voice/headset advisories and clip audio were dead in every deployment); the PLAN line that instructed keeping the breakage corrected. |
| R3-INT-F2 | `cdn.jsdelivr.net` added to the draft CSP `script-src` (the default OCR engine's worker + core load from there, so enforcing the policy as drafted would have blocked OCR entirely). The stronger fix — vendoring the assets like MediaPipe — is documented as the follow-up. |
| R3-DEP-F1 | Root `.dockerignore` added (`.env*`, `node_modules`, build output) — the glm-ocr build context transmitted the service-role key to the daemon. |
| R3-DEP-F2 | `VLLM_API_KEY` + mem/cpu limits + log rotation on both services; the client path is now wired (see follow-up 1). |
| R3-DEP-F3 | GLM-OCR weights pinned by `--revision` (a real upstream commit, overridable via `GLM_OCR_REVISION`). |
| R3-DEP-F4 | The InsightFace sidecar runs as non-root uid 1001 with the model trees chowned and `HOME` set. |
| R3-DEP-F5 | The sidecar token compare uses `hmac.compare_digest`. |
| R3-DEP-F6 | The prod-destructive confirm token comes from `PROD_CONFIRM_TOKEN` with a loudly-warned literal fallback, and every confirmed/aborted/bypassed run writes a timestamped audit line. |
| R3-HYG-F1 | Deleted `Sample Code/`, `redesign-previews/`, the tracked `.pyc` files; removed the unused `cn` dependency; added `.github/dependabot.yml` and `__pycache__/` to `.gitignore`. |
| R3-OPS-F1 | `verify-web-sources.mjs` gained `assertLocalTarget` + a package script + a CI step. |
| R3-OPS-F2 | Recorded as a non-defect (the mixed-case manifest hashes are handled by a case-insensitive compare); no code change. |

### Follow-ups created by this pass (not defects, deliberate scope limits)

1. **vLLM API key**: the compose side and the client path are both wired and
   documented (`docs/GLM_OCR_SETUP.md` §7), and the proxy sends
   `Authorization: Bearer` when `VLLM_API_KEY` is set — verified by two new
   tests. Set the SAME value in the project-root `.env` (compose) and
   `.env.local` (the Next process), or leave both empty.
2. **Tesseract self-hosting** (R3-INT-F2): allowing jsdelivr unblocks CSP
   enforcement but leaves the offline-venue gap that `vendor-mediapipe.mjs`
   exists to close. Vendoring ~18 MB of WASM variants plus a vendor script and
   a CI hash step is the stronger fix; then drop the origin.
3. **D-F4** (Medium): deferred with rationale. The verify nonce is served to
   the session OWNER, so it is identical across every device/tab of one
   account — there is no honest signal to distinguish two-device collusion from
   a legitimate two-tab resume without a new per-device token minted at gate
   Begin and carried through the client, route and schema. That is the product
   change the audit explicitly reserved.
4. **A-F4** (Medium): removing the per-account login gate trades a lockout DoS
   for weaker single-account guessing resistance. A durable per-account counter
   or a CAPTCHA/PoW step is the complete fix; the residual is documented in
   `login.ts`.
5. **`isWithinTimeLimit`/`computeScore`** have zero production callers (only
   their own tests import them); left in place rather than deleted, since
   `remainingMs` is the live path. Decide whether to delete or re-wire.
6. **`checkSameOrigin` (R2-TOP-F1)**: `TRUSTED_ORIGINS` is now documented for
   the LAN posture but the helper itself was not changed — populate the env var
   on a direct-LAN deployment or the fail-closed check 403s browser mutations.
7. **Two pre-existing coverage-threshold failures** (below their floors at
   baseline) are unchanged: `api/quizzes/[id]/route.ts` and
   `api/quizzes/[id]/questions/[questionId]/route.ts`.

### Harness pins updated to the corrected behaviour

`scripts/verify-silence.mjs` SV6 was rewritten (SV6a is the audit-2 C-02 attack
shape and now asserts **FLAGGED**, not exempt — the old pin certified the
vulnerability; SV6b is the honest sidecar-503 shape and asserts exempt; SV6c
covers staleness), and SV8 pins the new `resume_grace_until` guard in both
directions. `scripts/verify-sessions.mjs` gained D56-D59 (autoclose seal, the
flagged-never-sealed rule, resurrect refusal, base-table column denial) and
`scripts/verify-face.mjs` gained `remainingMs`/credit-cap deadline assertions.
`e2e/e36-close-grace-and-reveal.spec.ts` was updated because it pinned the exact
dead-end posture D-F1 identifies as wrong.

### Known limitations of this pass

- **The SQL was not executed.** Four migrations totalling ~3100 lines were
  written against the live 0045/0046 definitions but never applied. Treat
  `db reset` + the `verify:*` harnesses as the acceptance gate.
- **The e2e suite was not run** (it needs a live Supabase seam and a
  production build). Two specs were updated to match corrected behaviour; the
  rest are expected to pass but are unverified.
- **Two findings were reported rather than fixed** (H3-AUTHZ-F3, H3-ATOM-F3) and
  **one was deferred by product decision** (D-F4), each with the reason above.

---

## Post-fix adversarial review (independent agents)

After the fix pass, independent reviewers re-derived the changes from source
(two review rounds: one broad, then per-chunk). They found real defects, all
now fixed. The material ones:

**Fixed (introduced or missed by the fix pass):**

1. **`recordRateLimitHit` bypassed the bucket cap (High).** The module's
   `MAX_BUCKETS` bound lived only in `rateLimit()`, but the new
   `recordRateLimitHit()` had no cap — and its only caller keys on the RAW
   login-form email, on a directly POSTable `"use server"` action. An attacker
   could mint unbounded permanent buckets and, by pushing the map far past the
   cap, degrade eviction for every other limiter in the process. The bound is
   now a shared `enforceBucketCap()` used by both writers, and the login key is
   length-bounded (254, with an `__invalid__` sentinel).
2. **`profiles_full_name_len` would have ABORTED the migration on live data
   (High).** `ADD CONSTRAINT … CHECK` validates every existing row, and
   `full_name` had no DB bound for 46 migrations while the app allowed 200
   chars — so a single 121-200-char row would block deployment of 0047-0050.
   Now `NOT VALID` → backfill `left(full_name, 120)` → `VALIDATE`. The app cap
   was also lowered to 120 to match, and both service-role upserts clamp
   defensively (the trigger's clamp does not cover them).
3. **`if v_session is not null` on a composite is always FALSE (Medium).** In
   `start_quiz_session` the post-race re-read used `IS NOT NULL` on a
   `quiz_sessions` row variable, which is true only when EVERY field is
   non-null — and the table has several nullable columns, so the documented
   `quiz_window_closed` fall-through was unreachable. Now `if found then`.
4. **The autoclose seal relied on an implicit NULL score (Low).** The seal now
   writes `score = null` explicitly so `assign_seal_score`'s `WHEN` fires
   deterministically and sets the GUC that suppresses the bogus
   `session_submitted` mail.
5. **`/api/health` echoed raw DB error text to unauthenticated callers
   (Medium).** Driver messages carry host/port/role/schema detail. Failures are
   now logged server-side and reported as booleans (`cron.degraded`), the
   endpoint is IP-budgeted, and a test asserts no error text, hostname or key
   appears on any arm.
6. **`dead` could be reached from a TRANSIENT failure (Medium).** The
   unknown/gone status branch routes to `timeUp` (Retry-submit) instead of the
   now-terminal `dead`, so a network blip on the status GET cannot strand an
   active session with no submit control.
7. **The `unavailable` self-heal probe ignored `hiddenRef` (Low).** It now
   defers without consuming an attempt, so a backgrounded tab cannot post a
   no-face sentinel as a FAIL vote.
8. **`setAll` overwrote instead of accumulating refreshed cookies (Low).** Now
   accumulates and dedupes by name, so a multi-batch refresh is fully replayed
   onto a redirect.
9. **`cron_health()`'s runtime role check was dead code (Low).** It is
   `security definer`, so `current_user` is the OWNER — the check could never
   deny anyone. Removed; the GRANT is documented as the actual control.
10. **Doc/code contradictions corrected:** `TRUSTED_PROXY_COUNT` (the env sheet
    claimed unset = ignore headers; the code defaults to 1 trusted hop), the
    `is_student_reveal_allowed` scope note (it is quiz-scoped, so a live retake
    also masks attempt 1 — intended, since a retake serves the same questions),
    the autoclose quiet-window note, and the "only FAILED sign-ins count"
    comment (every attempt is recorded; a success clears).
11. **Stale test scaffolding removed:** `attach_frame_poses` dropped from the
    fake's `SEAM_ONLY_RPCS` allowlist (leaving it would let a test pass against
    a REMOVED RPC — the drift that set exists to catch).
12. **Coverage gate was RED at the recorded verification point.** CI runs
    `vitest run --coverage` (blocking), not `vitest run`; 11 threshold failures
    across 8 files were present when the first verification line was written.
    All were fixed with real tests — **no floor was lowered**, and the two
    pre-existing failures (`api/quizzes/[id]/route.ts`,
    `.../questions/[questionId]/route.ts`) were covered rather than excused.
    `rate-limit.ts` went 65.38% → 94.64% and its floor was RAISED 65 → 90.

**Verification line corrected:** the gate to quote is
`npx vitest run --coverage` (0 threshold errors), not `npx vitest run`.

### Second review round (per-chunk, independent agents)

A second round of focused reviewers (SQL/migrations, client-runtime + auth,
gradebook/export, AI-OCR + infrastructure) re-derived the changes again. All
gates were green at the start of this round, so everything below is a defect
the green gates did NOT catch. All are now fixed.

**SQL / migrations**

13. **`profiles_full_name_len` would have ABORTED on live data (High).**
    `ADD CONSTRAINT … CHECK` validates every existing row; `full_name` had no
    DB bound for 46 migrations while the app allowed 200 chars, so one
    121-200-char row blocked the whole 0047-0050 batch. Now `NOT VALID` →
    backfill `left(full_name, 120)` → `VALIDATE`.
14. **The 120 clamp was trigger-only (High).** The app's service-role upserts
    (lecturer promotion, consent repair) wrote the raw value, so a 121-200-char
    name produced a `23514` surfacing as `promotionFailed`/`consentFailed`
    AFTER the auth account existed. The app cap is now 120 (matching the CHECK)
    and both upserts clamp defensively; `nameTooLong` copy updated in en+ms.
15. **`if v_session is not null` on a composite is always FALSE (Medium).**
    `start_quiz_session`'s post-race re-read used `IS NOT NULL` on a
    `quiz_sessions` row variable — true only when EVERY field is non-null, and
    the table has nullable columns, so the documented `quiz_window_closed`
    fall-through was unreachable. Now `if found then`.
16. **The autoclose seal depended on an implicit NULL score (Low).** It now
    writes `score = null` explicitly so `assign_seal_score`'s `WHEN` fires
    deterministically and sets the GUC that suppresses the bogus
    `session_submitted` mail.
17. **`cron_health()`'s runtime role check was dead code (Low).** It is
    `security definer`, so `current_user` is the OWNER; the check could never
    deny anyone. Removed, with the GRANT documented as the actual control.
18. **Domain-split parity + `?` operator (Low).** The gate now takes the
    segment after the LAST `@` (matching `institutional.ts`) and uses
    `jsonb_exists(...)` instead of `?` (a runner that treats `?` as a
    placeholder would mangle the statement).
19. **`is_student_reveal_allowed`'s scope note was backwards (Medium).** The
    term is QUIZ-scoped, so on a live quiz a retake ALSO masks attempt 1.
    That is intended (a retake serves the same questions, so exposing the key
    mid-attempt is the leak H3-ATOM-F5 closes) — the comment now says so.

**Client runtime / auth**

20. **The flagged poll killed a live session on a transient 503 (Medium).**
    `GET /api/sessions/[id]` returns 503 for a transient DB fault and 429 from
    its limiter — both with no `status` field — and the poll treated
    "non-OK + no status" as terminal, throwing the student to the dead screen.
    Now only the definitive 404 resets; anything else re-arms the poll.
21. **Three callback redirects still used the request origin (Medium).** The
    failed-exchange and both domain-gate rejections interpolated `origin`
    instead of `siteOrigin`, so a tunnel deployment still 307'd a rejected SSO
    user to the unreachable internal host — the exact A-F2 bug, on the error
    paths. All five now use `siteOrigin`.
22. **The enroll spoof gate ignored `FACE_SPOOF_ENFORCE` (Medium-Low).** Verify
    is record-only without the flag, but enroll hard-failed — so the documented
    posture was inconsistent and one false-positive verdict permanently blocked
    a student's enrollment with no env remedy. Enroll now gates on the same
    flag (verdicts still logged).
23. **`.env.local.example` documented a dead knob (Low).** `LOGIN_EMAIL_RATE_LIMIT`
    is read by nothing after A-F4; the replacement
    `LOGIN_EMAIL_FAIL_THRESHOLD` was undocumented. Fixed, and the parity
    checker now also matches `envLimit("KEY")`-style string-literal reads (it
    saw 30 keys before, 39 now — which is why the gap went unnoticed).
24. **`TRUSTED_PROXY_COUNT` typo selected the PERMISSIVE posture (Low).** An
    unparseable value fell back to 1 (trust one hop) rather than 0, so
    `=0,`/`=zero` silently re-opened header rotation for a direct-access
    deploy. Now falls back to 0 with a one-time warning.
25. **`_seedRateLimit` bypassed the bucket cap (Low).** The test helper is the
    one remaining writer that did not call `enforceBucketCap`.
26. **A forced `unavailable` probe could burn an attempt without probing
    (Low).** The min-gap deferral re-arms only while status is `ready`, so a
    forced probe landing <8s after a POST was dropped after incrementing the
    retry budget. `force` now skips the deferral.
27. **`dead` reached from the unknown/gone branch was over-claimed (Low).**
    The comment called it transient, but `timeUp` is a one-way door (no path
    returns to `question`). Behaviour kept (a submit control must exist);
    comment corrected.

**Gradebook / export**

28. **`addWorksheet` was OUTSIDE the try (High).** Only `writeBuffer()` was
    wrapped, so any throw from the assembly loop escaped as a raw 500. Two
    reachable triggers, both from quiz titles: a BACKSLASH (ExcelJS rejects it,
    Excel's UI does not — the strip class omitted it) and Excel's protected
    name `History`. Verified empirically against real ExcelJS. The whole
    assembly is now inside the try, `\` is stripped, and protected names are
    reserved like `Summary`.
29. **`sessionsTruncated` false-positived at exactly the cap (Low-Medium).**
    The `|| len >= SESSIONS_LIMIT` term fired even when an exact count proved
    nothing was dropped. Now the count wins whenever it is available and the
    limit term is only a null-count fallback.
30. **The route's 429 test had been deleted during the fix pass (Low).**
    Restored, so the limiter branch is covered again.
31. **The fake could not represent truncation at all.** `count` was taken
    AFTER `.limit()`, so `count === data.length` always and the truncation
    tests passed only via the fallback term. The fake now models PostgREST
    semantics (pre-limit total + an optional `max_rows` clamp), and new tests
    prove both directions: no false positive at the cap, and a genuine flag
    when a `max_rows` clamp drops a tail.

**AI / OCR**

32. **PDF page generators were never closed on the error path (Low).** The
    generator's `finally` (canvas zeroing, `page.cleanup()`, `destroyPdf`) only
    runs on completion or explicit return, and a throw from `ocrPage`/
    `worker.recognize` exited the loop with it suspended — leaving a 4096px
    canvas and the pdf.js document alive until GC. Both engines now
    `return()` the generator in a `finally`.

**Infrastructure: no findings.** The reviewer independently confirmed the
health endpoint leaks nothing on any arm, the rate limit precedes DB work, the
`EXPECTED_JOBS` names match the migrations, the instrumentation signature
matches Next 16.3's types (and would be silently inert if it did not), the
proxy matcher covers every app route, the emitted `Permissions-Policy` carries
`microphone=(self)` with CSP still Report-Only, every CI `npm run` script
exists, `js-yaml` is a declared devDependency, and the Docker changes are
coherent (`.env*` excluded; models resolve from the non-root user's `$HOME`;
`hmac.compare_digest` imported).

### Final gate state

`npx tsc --noEmit` clean · `npx vitest run --coverage` **0 threshold errors**,
117 files / 1817 tests passing · `npm run lint` 0 errors (22 pre-existing
warnings) · `npm run lint:workflows` exit 0 · `node scripts/check-env-parity.mjs`
exit 0 (39 keys) · `node scripts/check-i18n.mjs` exit 0 (1287/1287).

**Verified by execution:** the four migrations (applied to a local Supabase;
`db reset` applies all 50 from scratch) and all 15 `verify:*` harnesses.

**Still unverified:** the e2e suite (needs a live Supabase seam + a production
build) and the Docker image builds.


---

## Live verification (Docker + local Supabase, 2026-09-14)

Docker Desktop was started and the migrations were applied to a live local
Supabase. This section replaces the earlier "SQL is unverified" caveat.

### Applied

- `npx supabase migration up` → 0047, 0048, 0049, 0050 applied in order, no
  errors (incremental upgrade path, i.e. the production path).
- `npx supabase db reset` → all 50 migrations replayed from scratch, no errors.

### Schema verified after the clean rebuild

| Check | Result |
|---|---|
| `record_face_check` overloads | **1** (8-arg with `p_poses`; the 7-arg was dropped) |
| `attach_frame_poses` | **absent** (E-F3 closed) |
| `cron_health` | present |
| `face_checks.nonce`, `quiz_sessions.resume_grace_until`, `questions.generation_id` | all present |
| `profiles_full_name_len` | `validated = true` (the NOT VALID → backfill → VALIDATE path worked) |
| `quiz_sessions_resume_grace` trigger | present |

### RLS (R2-RLS-F1) — verified with a real authenticated session

Table-level SELECT revoked, 20 `quiz_sessions` / 6 `session_answers` columns
granted, and the sensitive ones actually refused:

| Read as an authenticated student | Result |
|---|---|
| granted columns (`id,status,submitted_at`) | **200** |
| `quiz_sessions.score` | **403 / 42501** |
| `quiz_sessions.resume_grace_until` | **403 / 42501** |
| `session_answers.is_correct` | **403 / 42501** |
| `select *` (whole-row) | **403 / 42501** |
| `student_session_view.score` before reveal | **200, `score: null`** |
| `student_session_view.score` after reveal | **200, `score: 7`** |
| base table `score` after reveal | still **403** |

The count-only read the app depends on also works under column-only SELECT
(`Content-Range: */0`), confirming the `ExecCheckOneRelPerms` reasoning.

### RPCs exercised

- `cron_health()` as service role → the five `innovision-*` jobs with
  last status/run; as anon → `42501 permission denied for function` (the GRANT
  is the control, exactly as documented after the dead runtime check was
  removed).
- `flag_verify_silent_sessions()` → runs clean (no 42703 — the E-F1 class of
  drift is gone).
- `join_class()` → valid code enrolls, re-join is `already_enrolled`, bad code
  is `invalid_code`; the `for share` lock and `archived_at` check are both
  present in the live body (so the H3-RACE-F4 fix did not break enrollment).

### Harnesses — all 15 pass (474 checks)

```
verify-security        3/3      verify-results        21/21
verify-classes        36/36     verify-student-quizzes 23/23
verify-class-archiving 17/17    verify-clone-quiz     16/16
verify-quizzes        83/83     verify-media          32/32
verify-ai             16/16     verify-matric         15/15
verify-sessions       74/74     verify-mediapipe      all intact
verify-face           83/83     verify-silence        12/12
verify-web-sources    23/23
```

**`verify-silence` 12/12 is the headline result.** It pins the R2-FACE-F1
polarity fix against a live database:

- **SV6a** — fresh outage claim with NO corroboration (the audit-2 C-02 attack
  shape) → **FLAGGED**. Under the 0046 predicate this was exempt; the old pin
  certified the vulnerability.
- **SV6b** — fresh claim WITH a fresh verify attempt (honest sidecar 503) →
  exempt (no false flag on a real outage).
- **SV6c** — stale claim → flagged.
- **SV8a/SV8b** — the new `resume_grace_until` guard is load-bearing in both
  directions.

`verify-sessions` 74/74 covers D56-D59 (autoclose seal, flagged-never-sealed,
resurrect refusal, base-table column denial) and `verify-face` 83/83 exercises
the new `record_face_check` `p_poses` path.

### Harness fixes required to run (pre-existing staleness, not defects)

Running the suite exposed four harness bugs that predate this work — each a
fixture/expectation that was never updated when the audit-2 migrations changed
the contract. All fixed in the harnesses, none in production code:

1. **No harness student had a matric**, so `join_class` refused them with
   `matric_required` (the H-11 gate, migration 0046) and nothing downstream
   could run. Added a shared `nextHarnessMatric()` to the 8 harnesses that call
   `join_class`.
2. **verify-matric M8** expected a student to self-update an already-set matric;
   M-12 made it immutable. Now asserts the immutability guard and that the
   stored value is unchanged.
3. **verify-results** expected `reset_session` to succeed for a `completed`
   session; M-07 deliberately refuses it. The matrix now expects `ok` for
   active/paused/flagged and `session_not_active` + no audit row for completed.
4. **verify-media D11** seeded `race-<i>-<stamp>.png`, which violates the C-01
   anchored-shape CHECK, so neither racing UPDATE landed and the check could
   not observe the race. Fixtures now use `<uid>/<uuid>.png`.

### Types

`npm run gen:types` against the migrated schema adds
`questions.generation_id` to the `append_question`/`answer_question` RPC return
types (the hand-written edit had missed them). CI's `git diff --exit-code` drift
gate requires this to be committed, so it is.

### Operational finding from `cron_health()` (real, worth acting on)

The first live `cron_health()` call reports three of the five jobs have
**never run** on a freshly created local database:

| job | ever ran |
|---|---|
| `innovision-flag-verify-silence` | yes (every minute) |
| `innovision-quiz-autoclose` | yes (every 5 min) |
| `innovision-retention` | **no** |
| `innovision-notifications` | **no** |
| `innovision-incident-prune` | **no** |

The daily/weekly ones are simply not due yet on a fresh DB, so this is expected
locally — but it is exactly the signal R2-FACE-F2 said was missing, and it
demonstrates `/api/health` would surface a genuinely dead schedule. Confirm the
three have run on any long-lived deployment.

---

## Docker image builds (verified 2026-09-14)

Both images were rebuilt and their changes verified **by running them**, not
just by a green build. This closes the "Docker image builds" gap.

### insightface-service — R3-DEP-F4 verified live

| Check | Result |
|---|---|
| Runs as non-root | `uid=1001(app) gid=1001(app)` |
| `HOME` | `/home/app` |
| Model trees | `/home/app/.insightface/models/buffalo_l` + `/srv/models/spoof`, both owned `app:app` |
| Startup | loads all 5 buffalo_l ONNX files from `/home/app/.insightface/...` with **no runtime download** |
| `/health` | `{"status":"ok","model":"buffalo_l","spoof_model":true}` |
| Spoof ensemble | log: "anti-spoof ensemble ready (2 models)" |
| Token auth (R3-DEP-F5) | no token → 401; wrong token → 401; right token → 400 (the frame, not auth); `/health` stays open |
| Real inference | `person-a.jpg` → 1 face, det 0.441, yaw 7.5, 512-dim embedding, spoof `{real:true, score:0.9975}`; `blank-wall.jpg` → 0 faces |

The `hmac.compare_digest` change is behaviorally equivalent for valid/invalid
tokens (verified) while removing the timing side channel.

### glm-ocr — TWO deployment-blocking defects found and fixed

Building this image exposed that **the OCR service could not start at all** as
previously configured. Neither defect is visible from a green build; both
required running the image.

**Defect 1 — the container crashed on startup (torch `getpwuid`).**
`USER 1001` had no matching passwd entry, and torch's inductor cache resolves
its directory via `getpass.getuser()` → `pwd.getpwuid(os.getuid())[0]`, which
raises `KeyError: 'getpwuid(): uid not found: 1001'` for a bare uid. The
container died before loading any model, so OCR was entirely dead in any
deployment built from the Dockerfile. Fixed by creating a real user (with a
home directory) instead of a bare uid. Note this is the *same class* of latent
problem the audit's R3-DEP-F4 addressed on the sibling image — where a
`useradd` was done — but the glm-ocr image had only `USER 1001`.

**Defect 2 — the Transformers pin made vLLM unable to import.**
The Dockerfile installed `transformers@v4.49.0` with a comment claiming the
stock image's bundled version "predates the `glm_ocr` architecture". That claim
is wrong, and the pin is actively harmful:

| Transformers | `import vllm.entrypoints.openai.api_server` | Resolves GLM-OCR config |
|---|---|---|
| `@v4.49.0` (previous pin) | **FAILS** — `ImportError: cannot import name 'Gemma3Config'` | no |
| 4.57.6 (base image's own) | OK | **FAILS** — "does not recognize this architecture" |
| `@4177486a9f19` (new pin) | OK | **OK** — `glm_ocr` / `GlmOcrForConditionalGeneration` |

The real constraint is that vLLM 0.19.0 imports `Gemma3Config` (needs ≥4.56)
*and* resolves the checkpoint config through Transformers, while `glm_ocr` only
exists in the Transformers SOURCE tree (it landed at commit `4854dbf9da40`;
no released tag has it). The fix pins a git **commit** — not `main`, which
would silently change engine behavior — and the Dockerfile header now carries
the two verification commands that catch a bad pin.

**Verified working after the fix** (RTX 4050, the documented benchmark GPU):

- `Resolved architecture: GlmOcrForConditionalGeneration`
- `Application startup complete` + `/health` → 200
- `/v1/models` → `["glm-ocr"]` — the exact id the app's `probeGlmModel` matches
- **Real OCR inference**: a rendered image containing "Chapter 3:
  Photosynthesis" was transcribed correctly
- `VLLM_API_KEY` auth: 401 without the key, 200 with it, `/health` still 200
  (so the compose healthcheck survives auth being on) — the R3-DEP-F2 client
  wiring in `http-compat.ts` sends this same header

`docker compose config` validates with both services, and the R3-DEP-F3 model
revision pin was confirmed to be a real upstream commit (`sha` matches,
last modified 2026-09-11).

### Docker context (R3-DEP-F1) verified with the real builder

The `.dockerignore` was checked by building an image that `COPY`s the context
and lists what arrived — not by reasoning about the file:

- `.env.local` and `.env.production.local` (the latter holding the hosted
  service-role key): **NOT in the context**
- `.env.local.example`: present, as intended
- 845 files total (vs. the whole working tree)

(An earlier `tar`-based check falsely reported a leak; tar's `--exclude-from`
does not implement Docker's pattern semantics. The build-based check is the
authoritative one.)

### Compose end-to-end (closes the remaining caveat)

Both services were recreated from the REBUILT images via `docker compose up -d
--force-recreate` and verified serving real traffic — not just `docker run`:

| Check | glm-ocr | insightface |
|---|---|---|
| Compose healthcheck | **healthy** | **healthy** |
| Runtime identity | `uid=1001(app)`, `HOME=/home/app` | `uid=1001(app)`, `HOME=/home/app` |
| `/health` | 200 | 200 (`spoof_model: true`) |
| App-facing probe | `/v1/models` → `["glm-ocr"]` (matches `probeGlmModel`) | n/a |
| Real inference | transcribed "Photosynthesis: light reactions" correctly | 1 face, 512-dim embedding, spoof `{real:true, 0.9975}` |

This also settles the `transformers<5` question: the constraint exists ONLY in
pip metadata (`vllm-0.19.0.dist-info/METADATA: Requires-Dist:
transformers<5,>=4.56.0`). There is no runtime version gate anywhere in vLLM —
grepping for `transformers.__version__` checks finds none — and the service
starts and serves correctly with `5.17.0.dev0`. It is a soft declaration, not a
breaking change.

### A note on the previously-running container

Before the rebuild, the running `innovision-glm-ocr-1` was root with
`transformers 5.16.0.dev0` and no `HOME`/`HF_HOME` — i.e. built from the
Dockerfile as it stood BEFORE commit `27a786b` (which added `USER 1001` but
also introduced the fatal `@v4.49.0` pin). That older build worked only because
it installed transformers unpinned from `main` and ran as root. It is now
replaced by a build that is pinned, non-root, and verified.

### Disk note

`innovision-glm-ocr:local` is ~32 GB (the vLLM base image is large). Both
images are rebuilt in place; `docker system df` shows ~6 GB reclaimable from
dangling layers if space is needed.

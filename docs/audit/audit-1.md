# Audit 1 — InnoVision Production-Readiness Audit (3 Rounds)

> **Date:** 2026-09-12 · **Method:** subagent swarms, all role-prompted *senior software production engineer*.
> Round 1 = 5 parallel domain audits (auth/sessions · quiz/media/AI · face/integrity/play · practice/results/notify/i18n · frontend/ops).
> Round 2 = 5 parallel red-team attackers challenging every Round-1 claim line-by-line.
> Round 3 = 4 parallel critics: (a) re-verify survivors, (b) cross-domain composition attacks, (c) fresh-eyes hunt in thin zones, (d) harness/fix-verification critique.
> **Standing rule, all rounds:** docs not trusted; every claim verified against code + `supabase/migrations/0001–0044`. No code changed — audit only.
> **Verdict: NOT READY for general usage.** True blockers are fewer than Round 1 claimed (~5 P0s, not ~15) but load-bearing: identity-verification bypass, permanent silence-cron kill-switch, frozen-frame presence fraud, scoreless seals, practice-corpus enumeration.

---

## 1. Confirmed P0 — ship-blockers (survived all 3 rounds)

### P0-1 · Direct-RPC similarity forgery + unlimited forge loop (self-pass, absence/proxy fraud)
- **Evidence:** `record_face_check` verdict is a pure function of caller-supplied `p_similarities` (`0044:220-233`, strict majority ≥ 0.5, only `p_subject = auth.uid()` check at `:230-233`); granted to `authenticated` (`0020:362-365`, `0044:317-320`). Nonce is owner-READable (`0008:77-79` + `:141-143` policy, `0032:663` view, `GET /api/sessions/[id]` returns it, play page selects it). No RPC-side throttle — route limiter (`verify/route.ts:75-77` → in-memory `rate-limit.ts:1-13`) does not bind direct PostgREST; 0044's 2 s check is advisory-only (`constants.ts:115-120`). Harness itself forges similarities (`verify-face.mjs:159-174`) and admits the residual (`:57-59`).
- **Exploit:** SELECT nonce → `rpc(record_face_check, {p_similarities:[1.0,1.0], p_subject:self, p_nonce:fresh, p_frames:['a','b']})` → `matched:true` + new nonce → loop. No camera, no sidecar. Self-pass only (cross-uid fails) — sufficient for "verified present while absent".
- **Fix:** service-role-only `record_face_check` (route calls via service client with verified uid); or HMAC(frame_hash|nonce) minted post-sidecar, verified in RPC. Add SQL-side attempt throttle (enroll's 3/10 min is the template, `0039:242-251`).
- **Decisive test (live-SQL):** student direct-RPC `[1,1]` with sidecar-virgin frames → must error; today `matched:true`. Tight PostgREST SELECT+forge loop → must hit 429; today zero 429s.

### P0-2 · Frozen-frame presence fraud via `video.pause()` / srcObject-swap (corrected mechanism)
- **Evidence:** `captureFrame` gates only `disposed/hidden/readyState<2` (`face-tracker.ts:384-407`); no `video.paused/seeking/srcObject-identity/currentTime-stall` checks; `captureBestFrame` inherits (`:465-535`); `detectLoop` pose gate same hole (`:686-689`). Server replay signals advisory-only (`0044:238-252`, verdict `:230-233` ignores them). NOTE: original `track.enabled=false` theory REFUTED — that yields black frames → FAIL (in-file comment `:353-356` correct); `video.pause()` keeps `readyState≥2` with last good frame.
- **Exploit:** enroll honestly → `video.pause()` in devtools → periodic verifies POST identical good frame → `matched:true` forever (`suspected_replay=true` rows accumulate, status stays `active`). Gate/recovery blink/turn (`pipeline:809,825,1086`) do not cover passive periodic (`:390-397`).
- **Fix:** reject in `captureFrame` when `paused||seeking||srcObject!==sharedStream||readyState<2||videoWidth==0`; server: 3rd consecutive identical-hash → `paused`. Honest jittered 30–45 s captures never hash-collide 3× (JPEG noise + luminance resample `:754-768`). Carve-outs: exempt mock-seam frames + nonce-retry resends (same `payloadFrames` resent at `pipeline:505-530`) or E2E self-incriminates (fake tracker returns identical markers every capture).
- **Decisive test:** stub video `{paused:true, readyState:4, videoWidth:640}` → `captureFrame()` must resolve `null`; today dataURL.

### P0-3 · `face_unavailable_at`: write-once permanent silence-cron exemption (self-granted kill-switch)
- **Evidence:** set-if-null, never cleared (`0009:770-773`, `0022:613-616`; zero `= null` clears anywhere incl. unlock/self-recover/exempt/record_face_check). Cron requires `IS NULL` twice (`0044:776,855`; same `0042:65,123`). Single-fire notice dedupe hides repeats (`0022:619-628`, `face_unavailable_reported:<session>`).
- **Exploit:** one `report_face_unavailable(own session)` (no live/status/evidence gate, `0022:600-616`) → suppress all verifies, answer forever → cron skips every tick. Later honest verifies don't clear it either.
- **Fix:** clear on every successful `record_face_check` commit (or 10-min expiry / per-window re-report); re-flag stale-unavailable sessions with flowing answers.
- **Decisive test (live-SQL):** report → one successful verify → silence + answers + 300 s → must flag (or column NULL); today still set, cron skips.

### P0-4 · Retake stale-seal banks permanent NULL score + bogus lecturer mail
- **Evidence:** seal UPDATE sets status/submitted/activity but no `score` (`0032:249-255`; honest submit scores at `:452-461`; column nullable `0008:39`). Dead branch `:267-271` (`v_session` never nulled → always `already_attempted`, `quiz_window_closed` unreachable except race). Seal fires `notify_session_terminal` → bogus `session_submitted` + feeds `quiz_completed_all` DISTINCT count (`0022:450-457`, `0032:554-639`); NULL permanent via submit idempotency (`0032:411-446`).
- **Scenario:** answer 8/10 → window passes → next start seals `completed/NULL` + lecturer gets "submitted" mail + gradebook em-dash (`gradebook.ts:146`, `export.ts:400-403`); 8 real answers preserved but unscored, no RPC left to materialize them.
- **Fix:** compute `score=count(is_correct)` inside seal; suppress/retarget terminal trigger for seals (distinct `session_sealed` type or guarded marker).
- **Decisive test (live-SQL):** stale active + 2 correct past `closes_at` → start → assert `score=2` + zero `session_submitted` for sealed id; today NULL + one bogus row.

### P0-5 (downgraded context) · Submit without live/enrolled/archived gate — P1, fix = seal, NOT block
- **Evidence:** `submit_session` checks auth/role/ownership + active/paused only (`0032:377-395,448-450`); answers require live + `can_student_view_quiz` + `closes_at` + timer (`0037:217-251`); `record_face_check` re-added live/enrolled gate (`0044:150-153`).
- **Adjudicated posture (R3):** do NOT hard-block submit on `quiz_not_live` — that strands honest close-mid-exam / timer-expiry-while-paused evidence. Keep submit permissive (seal-with-score); gate the **reveal/notification consequences** instead.
- **Decisive test:** start live+enrolled → close/unenroll → answer must be `quiz_not_live`, submit completes with correct score but `results_revealed_at` unchanged by this submit.

---

## 2. Confirmed P1 — must-fix before general usage

| # | Finding | Key evidence | Fix (one line each) |
|---|---------|--------------|---------------------|
| 1 | Shared-practice bulk enumeration: any authed user dumps all `share_code`s + corpus + keys + images without a code | `0023:130` full-column SELECT grant + `:142-145` shared-visible policy; `resolve` no-oracle bypassed (`:481-501`); player view code-less (`:302-308`); Branch B UUID-only (`0028:125-140`); `answer_student_question` open to any authed (`:469-470`) | Creator-only table SELECT (drop shared arm `:142-145`); code-gated RPC/view for shared reads; column-restrict `share_code` out of shared SELECT |
| 2 | Manual single-add uncapped past 30 → breaks cap invariant, bricks AI-append (422 forever) | `append_question` no count (`0037:408-475`, `0004:432-490`) vs bulk cap (`0037:542,562-564`, `v_max_quiz_cap=30 :512`) | `SELECT count(*)` under existing `quiz_append:` lock → `quiz_question_limit_exceeded` at ≥30 |
| 3 | Timer-credit asymmetry + stale `paused_at` inheritance (exam-time inflation, solo or lecturer-assisted) | unlock uncapped (`0044:577-581`) vs self-recover `least(…,120s)` (`:498-504`); exempt never clears `paused_at` (`:707-717`) while flag path does (`:392-394`); re-pause preserves stale (`:421-429`); `fullscreen_exit` counted-never-flagged (`:380-381`) | `paused_at=null` in exempt + `least(…,120s)` cap in unlock; return credited-seconds + new deadline on every recover, client adds (not freezes) |
| 4 | Incident TOCTOU: unlocked check → slow privileged insert, post-submit clips land | user-client check (`incident:49-60`) → buffer/sniff (seconds) → admin upload+insert, no re-check (`:119-133`), `maxDuration=60` | RPC-gated insert (`FOR UPDATE` + insert) or post-upload re-select + discard/400 |
| 5 | Body caps header-only + chunked bypass; heaviest endpoints parse-then-check | `http.ts:66-75` falls through without `content-length` (pinned as intended `http.test.ts:119-120`); join/start/verify/enroll/advisory/pause no cap (`sessions/route:38-56`, `join:27-49`, `pause:62` unbounded `text()`); verify/enroll 413 runs AFTER `request.json()` (`verify:79-95`, `enroll:72-89`); incident `formData()` buffers after spoofable pre-check (`:64-77`) | `readCappedJson()` streaming helper everywhere + pre-parse frame bound; bound pause text; stream-safe incident limit |
| 6 | Retake auto-reveal livelock: `allow_retake` + `auto_reveal` never reveals | budget term has no time component (`0032:475-489`); claimed 2 h bound (`:357-360`) covers active only, not completed-with-budget; no event re-evaluates after last submit | Time-bound budget hold or `quiz_autoclose`-style sweeper flipping reveal after 2 h inactivity regardless of residual budget |
| 7 | Gradebook export 500 on legitimate titles (sheet-name collision) | `sanitizeSheetName` no dedupe/case-fold/`Summary` reservation (`gradebook-export:296-299`); `addWorksheet` throws (`:275-276`) with no try/catch (sibling per-quiz route has one) | Dedupe post-sanitize (` (2)`, ` (3)` in 31-char budget), reserve `Summary` |
| 8 | Secondary-omission → 1-vote pass (temporal-robustness collapse) | secondaries omitted on capture failure (`pipeline:750-762`, timeout `constants:137`); majority-over-submitted (`vote.ts:47`, `0044:230-233`) | Quorum policy with carve-outs: exempt `start`/flagged-poll/mock-seam/single-`""` sentinel callers (`pipeline:291-298,418`), or low-confidence advisory instead of fail |
| 9 | Empty gradebook `in.()` 400/503 (every new class) | no empty guard (`gradebook/page:80-87`, `export:91-107`); house guards exist 3× elsewhere (`student-quizzes:50`, `gradebook-export:208-210`, per-quiz export `:153-160`) | Early return on `quizIds.length===0` |
| 10 | AI cancel mid-save zombie (commit + dead socket, retry duplicates student append) | pre-RPC checkpoint only (`generate-quiz:554-557`); RPC takes no `AbortSignal` (`:589-592`); post-commit abort sends `done`-never-delivered, not `cancelled` | Post-commit abort honesty + student-append idempotency key (`generation_id`, `ON CONFLICT DO NOTHING`) |
| 11 | Advisory-lock namespace split (replace vs append vs reorder-no-lock) | `quiz_replace:` vs `quiz_append:` vs none (`0025:92`, `0037:454`, `0004:355-421`); no UNIQUE on `(quiz_id,order_index)` → dup ordinals | Single `quiz_write:` namespace + lock in `reorder_questions` |
| 12 | Expired-session 401 mid-exam: generic error, no login-resume (honest harm at scale) | no 401 branch in play/join clients (`play-client:689-699,824-835`, `student-classes:43-75`); GETs 404 for logged-out (`sessions/[id]:48`, `question-images:34`) | 401 branch → `sessionExpired` copy (exists unused `en.json:74`) + `login?redirect=` preserving local answers; 401/404 discipline in GETs |
| 13 | Timer honest-surprise: client freezes full pause, server credits 120 s → mid-answer 403 | client halts in paused (`play-client:434-450`); server deadline `started_at+limit+5s` (`0037:242-251`) | Return credited-seconds + deadline on recover/unlock; client adds |
| 14 | Notification poll wipes `loadMore`; badge double-counts; optimistic mark-read never rolls back on throw | replace-not-merge (`use-notifications:104-110`); unconditional +1 (`:69-74`); only `{error}` handled (`:161-194`) despite own throw-comment (`:85-88`) | Merge into `prev` under `LIST_CAP`; id-seen guard; try/catch + rollback |
| 15 | `quiz-sources` orphans have NO sweeper; question-DELETE orphans images; quiz-DELETE orphans everything | `media-cleanup.mjs` covers images/avatars only; question DELETE no `remove` (`questions/[questionId]:153-159`); quiz DELETE zero storage calls (`quizzes/[id]:182`) | Track + sweep on catch/delete; storage sweep in quiz/question delete |
| 16 | Fullscreen-farm invisible in gradebook (detection-evasion multiplier) | gradebook select drops pause counters (`gradebook-export:93-97`: only `face_fail_streak/focus_pause_count/attempt`) while per-quiz export has all three | Project `fullscreen/hand/face_fail` counts through gradebook select → model → matrix |

## 3. Killed / downgraded (do NOT fix as P0)

- **Closed-reveal silent — REFUTED.** Fixed in `0024:33-38,251-257` (no status term). Only one-time backfill gap (P3).
- **Verify-before-consent leak — REFUTED** (P3 hygiene at most). `consent NULL + baseline present` unreachable: atomic purge (`0039:411-417`) + direct-edit guard (`0019:371-378`) + baseline gate precedes sidecar (`verify:120-127`).
- **`requireStudentQuizOwner` 403 — REFUTED** (P3 docs). Role known pre-lookup → no oracle; in-role misses still 404; house pattern shared with `quizzes/guards`.
- **AI PG-errors → 500 — REFUTED as route-reachable** (P3 defense-in-depth). Zod-validated before save (`quiz-prompt:459-469`, `quiz-schema:57-58,158-183`); direct-RPC abuse only.
- **Clone-image "fail-closed leaks" — REFUTED as stated** (first half). Copy-fail→NULL creates nothing; update-fail sweeps (`duplicate:190-211`).
- **Kill-switch fail-open, per-process limiter as P0, CSP-enforce-now, auto-logout-401, Redis-everywhere** — all one notch too heavy; minimal patches in §2 achieve the property without regressing vision/e2e/exam flows.
- **Retake-budget manufacture / resurrect-void — INFEASIBLE.** Latest-terminal-wins + advisory lock + spawn gates (`0032:148-150,226-228,305-307`) hold; adjacent scoreless-seal harm real (P0-4).

## 4. Composition chains (Round 3b — the exam-fraud menu, cheapest breaks)

1. **Stealth unproctored exam:** forged verify <300 s resets BOTH silence predicates (committed row advances `max(checked_at)` + zeroes post-check count, `0044:786-811,861-876`) → answer freely, never flagged. **Minimal arm instead:** single `report_face_unavailable` → zero verifies forever (§P0-3). Break: P0-1 + P0-3 fixes.
2. **Banked time + dead-quiz score:** exempt (stale stamp) → re-pause (preserved) → unlock (uncapped from original) → answer banked → close/archive → answers 409 but submit completes. Solo variant: `fullscreen_exit` cycling + 120 s/recover, zero flag risk. Break: exempt `paused_at=null` + unlock cap.
3. **Practice-corpus theft:** enumerate shared rows/codes (`0023`) → player view harvest → per-question grading for keys → image-route URLs. Assessment/gradebook legs INFEASIBLE (owner gates hold). Break: creator-only SELECT.
4. **Reset evidence-laundering (lecturer-mediated):** `reset_session` hard-DELETEs session+answers+checks (`0022:533`), retake starts clean; wipe visible only as aggregate marker. Break: soft-void (`voided` marker, excluded from representative, visible on timeline).

## 5. Harness verdict (Round 3d — what "green" actually proves)

- **FakeSupabase is route-mapping stubs by design (`:10-16`) — all 5 drift entries CONFIRMED** (pause counts focus-only; no credit/clock; unlock/exempt role-only incl. missed ownership gate; start no budget/attempt/void; submit no auto-reveal/retake-gating). **Rule: RPC-semantics fixes verify ONLY via `verify-*.mjs` live; fake-based vitests for D1–D5 are KILLED** (fail for the wrong reason; pass for the wrong reason — incl. `flagged→session_not_active` string-match via wrong path).
- **0-gates hide the riskiest code:** face/hand trackers, `insightface-client` (live fetch/timeout/validation unpinned; route tests `vi.mock` the module → assert mock behavior only), both OCR engines (Tesseract zero CI pins; GLM only `sanitizeGlmText` + `e2c` skipped in CI → engine path untested anywhere in CI), `use-question-image` hook (Node-testable cache/timing, no test file).
- **Tested-but-ungated = unenforced:** duplicate/export/import/reveal/reveal-settings + 0-gated-but-tested quiz routes + guards/http/middleware have real tests with no floor — deleting assertions stays green. `camera.ts` (gated 80, mocked mediaDevices) proves browser-only can be gated; hooks could follow.
- **E2E blind spots:** invite-gated `test.skip` in ~50 files → fully-skipped green proves nothing (CI safe via `ci.yml:16,42`; local vacuous); `E2E_RATE_LIMIT_DISABLED=1` → no e2e ever asserts 429 (unit `_seedRateLimit` proves bucket math, not key/wiring — the 2026-09-04 outage seam); e51 hardening-ON only in dedicated job + `.env.local` leak can re-bake kill-switch even under `INTEGRITY_E2E=1`; `pipeline.test.ts` mocks both OCR engines → engine-selection path unmeasured.
- **Zero live pins:** 0042 silence cron + 0044 grace/advisory-touch (`last_activity_at` untouched), 0033 `session_unlocked` RPC dedupe/never-fail, 13-type notification dedupe matrix (only a handful pinned), prune functions, `lecturer_session_view` new columns.
- **Top-5 harness fixes (safety/effort):** (1) live pins for silence/grace/advisory-touch; (2) floors under tested-but-ungated route files; (3) fail on fully-skipped runs + split e51 skip signals; (4) unmock one InsightFace boundary test (determinism/orthogonality/timeout/validation); (5) `.env.local.example` parity check (11 keys missing: rate limits, both `NEXT_PUBLIC_*` seams, `TRUSTED_ORIGINS`, `AI_STREAM_IDLE_TIMEOUT_MS`).

## 6. New P2 backlog (file as issues)

`quiz_completed_all` never re-fires after reset (key + `ON CONFLICT DO NOTHING`, `0022:222-231`); representative tiebreak ignores `id` + terminal-shadows-active on retake (`export.ts:253-272`); retention/backfill forgot `session_unlocked`/`quiz_closed` urgency + closed+revealed backfill (`0022:715-772,820-834`); `check-i18n` blind to all `tFor`/dynamic keys → typo'd workbook keys ship raw (`check-i18n.mjs:82-108`, `messages.ts:15-31`); Bidi strip title-only (prompts/options spoofable); sheet `%`-format inconsistency; practice end-screen denominator counts unavailable; answer key in `sessionStorage`; `x-forwarded-host` CSRF/host-poisoning (`http.ts:130-135`, `sso.ts:67`, `reset.ts:74`); `/sb/*`+`/api/*` middleware exclusions honor-system, no lint; client drops 429/401 signals (`play-client:562-565`, `student-classes:55`); amber dark-mode drift (5 sites); `openJoinDrawer` locale/900 ms race; end-screen desktop/mobile contract fork; P1-15 leftovers (publish-idempotent pre-limiter, regen ignores cancel, student stream omits `refine`, reveal-settings no closed gate, over-cap clone warning, shared-image 300 s residue).

## 7. Fix order (cheapest chain-breaking first)

1. Service-role-only `record_face_check` + SQL throttle (kills P0-1 + Chain 1 stealth arm).
2. `captureFrame` paused/seeking/srcObject guards + consecutive-replay → `paused` with mock/retry carve-outs (kills P0-2 + Chain 1 frozen arm).
3. Clear/expire `face_unavailable_at` (kills P0-3 + Chain 1 minimal arm).
4. Seal-score + seal-notification honesty (kills P0-4 + Chain 2 banking).
5. Creator-only `student_quizzes` SELECT + hide `share_code` (kills §2.1 + Chain 3).
6. Exempt `paused_at=null` + unlock 120 s cap + recover-deadline return (kills Chain 2/Chain 6).
7. Single-add 30-cap under lock; lock-namespace unify; cancel honesty + idempotency key.
8. Harness §5 top-5 (silence live pins; floors; skip-guard; unmocked boundary test; env parity).

*Rounds 1–3 transcripts retained in session history. Audit only — no code changed.*

---

## 8. Rounds 4–8 — continued until convergence (no new P0/P1 for two consecutive rounds)

Stop rule honored: keep attacking (new claims, fix proposals, unexamined surface) until a full round yields no new P0/P1 **and** names no further unexamined surface. R7 yielded 0 new P0/P1 but named 3 seams → scoped R8. R8 yielded 0 new P0/P1 and named nothing further → **EXHAUSTED, audit closed.**

### Round 4 — attack the new, attack the fixes, hunt the unseen (4 agents)
- **New P0s confirmed:** `face_unavailable_at` write-once exemption (P0; worse than claimed — also unthrottled via direct RPC; weakened: silence-cron-only, first-report-visible). Stale-seal NULL + bogus `session_submitted` (P0; generality narrowed — seal needs quiz still live + `closes_at` passed + autoclose 5-min race; quorum-mail weakened to quorum-only). Retake auto-reveal livelock (P1; close LOCKS it permanently short of manual reveal).
- **Kills:** dead-branch direction `0032:267-271` INVERTED (composite-NULL semantics → returns `quiz_window_closed`, not `already_attempted`); "seal, don't block" KILLED as-implemented → re-filed P1 (H1–H5: removed/closed/archived submit participates in ungated irreversible global reveal; H1 exhibit: removed last-fresh submitter flips `results_revealed_at` for everyone).
- **Downgrades:** shared-enumeration P1→P2 (authed-only, self-shared practice corpus, revocable); single-add-uncapped P1→P2 (publish/export unbroken, one replace recovers); sheet-collision CONFIRMED P1 (ExcelJS throws case-insensitive, no try/catch, single `Summary`-titled quiz suffices); poll-wipe P1→P2 (heals next poll, badge absolute-overwritten); reset-laundering P1→P2 (attribution survives `0022:535-541`, lecturer-mediated only).
- **Fix trials:** F1 service-role-only **KILLED** (bricks 100% honest verifies — `auth.uid()` NULL under service_role at six gates `0044:116-184`; replacement: HMAC proof + SQL throttle, keep user client). F2 replay-guards NEEDS (3 honest identical-hash producers: E2E markers, nonce-retry resend, settle/low-fps bursts; 5-condition predicate specified). F3 clear-on-verify NEEDS (flapping race, marginal-pass laundering, dedupe ratchet; streak-2 + re-key predicate specified). F4 creator-only SELECT HOLDS narrowly (12-reader inventory; SQ-D2c becomes the regression pin). F5 quorum≥2 **KILLED** (post-unlock livelock unlock→400→paused→…; replacement: pad-don't-omit at route/pipeline).
- **Fresh surface:** 4 NEW P1 (login NO limiter — lone outlier among auth actions; palm-next skip; commitHold phantom commit; matric-capture layout-only bypass) + 4 P2 (callback fail-open on empty env; signup lockout vs SSO classroom fix; multi-practice invisible on phones; cleanups unscheduled) + cleared-with-reason list (timer boundary, shuffle determinism, derive clock, bell probes, institutional edges, invite compare, shared throttles, list-order, camera/hand-loss/HoldConfirm pures, host-poisoning already filed).

### Round 5 — attack R4-new P1s, H1, HMAC (3 agents)
- **Login P1 CONFIRMED** (GoTrue sees server egress IP — no per-attacker control; 6-char floor; stuffing, not brute force).
- **Palm-next P1 KILLED→P3** (rearm gate `gesture-layer:336-349` kills sustained re-fire; residual: `goNext` closure-`phase` vs `phaseRef`).
- **CommitHold P1 KILLED→P3** (per-frame backstop `gesture-layer:354-361` clears commit incl. pause path contradiction; survivor: total-tracker-stall only).
- **Matric P1→P2** (chain confirmed end-to-end; "unscorable" REFUTED — exports key by `student_id`, NULL matric = admin join gap, no impersonation).
- **H1 WEAKENED but P1 STANDS** (links a/c confirmed; b narrowed to last/only/fresh-last — own session excluded post-UPDATE; d narrowed to auto-reveal-opt-in OFF-by-default; e confirmed double-enrollment gate + realistic non-malicious auto-submit path).
- **HMAC NEEDS amendments, direction HOLDS** (frame_hash recompute rule; order pin exempt→gates→nonce→proof→verdict; throttle 40–60/session/10 min — 3/10 min would self-DoS honest 100+-verify exams; `DEFAULT NULL` migration grace + mock/FakeSupabase/harness path; SECRET plumbing).

### Round 6 — attack F1 + H1-narrowed + final surface (2 agents)
- **F1 P1→P2** (increment-before-branch confirmed `0044:378,433-439`; but honest duplicates never reach server — 2 s stamp both directions + status guards + hand-loss latch; fire-once, no retry; self-DoS only).
- **H1 P1→P2** (no excluding term `0032:475-499` + no cascade on unenroll `0008:34-35` confirm mechanism; but opt-in-rare proven — creation route never sets the column `classes/[id]/quizzes/route:70-88`; 3 rarities stacked + nearly-imminent outcome).
- **Final surface: 2 NEW P1 + 8 P2.** P1-A ms consent omits footage clause (chain: `register.ts:312` → enroll skips card `:46,479` → gate silent `:95`; clips carry mic multiplex `recorder:128-131`); P1-B advisory mic hot post-submit (hooks pre-early-return `:287-418`, no `setEnabled(false)`, discard camera-only; RMS never stored — over-collection overstatement reserved for R7). P2s: wake-lock never re-acquires; advisory report no-timeout/no-guard; PATCH-null 200-no-op; notif poll override unclamped; question-image no-timeout/cache/retry; DateTimePicker English suffixes; sweeps unscheduled; login brute-force uncodified. Certified-clean: hooks caps, UI contracts (`data-day` ISO, datetime-local, Base UI slots), results/quizzes/sessions libs (no div-by-zero, feed order, draft reducer, parser caps, AnswerSchema, timer boundary), compose/docker/CI (loopback, pins, non-root glm), messages (error copy, aria discipline), TODO grep (only fixture strings).

### Round 7 — attack R6 P1-A/P1-B + top P2s + closure (2 agents)
- **P1-A → P2** (absent confirmed, chain holds incl. enroll `:707` short in BOTH locales; but locale-scoped notice gap, one-line copy fix using existing `ms.json:899` translation — not a general ship-blocker).
- **P1-B → P2** (mounted + enabled confirmed; but no audio stored/transmitted, post-submit POSTs server-rejected `0044:960-968` — harm = indicator-on + 250 ms CPU).
- **P2-3 → P3** (nulls never reach DB; lock evaluated-and-passed; 200-vs-400 wart). **P2-4 → P3** (needs JS execution; no stored-XSS vector; non-additive capability; `pollMs:0` claim factually wrong — falsy fallback). **P2-7 SPLIT** (incident leg KILLED — scheduled `0042:301-309` + `0021:508-515`; media leg → P3 — slow/inert accumulation).
- **Closure probes clean:** timer boundary, shuffle determinism + freeze, invite compare, TODO grep. **No new P0/P1 in R7** — but 3 unexamined seams named → scoped R8.

### Round 8 — scoped final: quiz-sources lifecycle, notif-channel RLS, sidecar auth (2 agents)
- **Quiz-sources:** cross-user write/trample CERTIFIED-CLEAN (owner-folder RLS `0029:41-47`, probed live MEDIA-D9); read/download CERTIFIED-CLEAN (triple-layer Zod + tenant-prefix + RLS, fail-closed, no oracle); browser issuance CERTIFIED-CLEAN (no signing exists — server-side `download()` only, 2 call sites); retention = KNOWN P1-15 (not re-graded) with fix-design warning (naive referenced-set sweep would nuke legitimately-unreferenced student prefixes). **3 NEW P2:** P2-8.1 unbounded per-user fill (segment 2 unbound, dialog caps client-only); P2-8.2 schema-valid semantic injection survives (bias/URLs pass `AiQuizSchema` + `auditSelfContained`; file path has no envelope scrub); P2-8.3 provenance over-count + duplicates + silent multi-file drop (under-count fixed by 0041; `[A,A]` double-bills, claimed-but-unparsed paths attested).
- **Notif-channel RLS: CERTIFIED-CLEAN** (sole SELECT policy binds `auth.uid()` `0022:76-80`; deny-by-default grants `:84-86`; spoofed-filter/direct-SELECT/UPDATE/DELETE/INSERT all fail; mark-read RPCs AND ownership; assumption stated: Realtime RLS authorization active, platform default).
- **Sidecar: CERTIFIED-CLEAN as shipped** (loopback publish `compose:87-88`; server-only client; CORS-silent; gallery-free 1:1 oracle — no `/detect`/`/enroll`/`/compare`; 0039 DB restrictions hold; token wiring consistent; `/health` open is documented-intentional; Dockerfile root + compose `.env` split-brain noted as hygiene).
- **No new P0/P1. No further surface named → EXHAUSTED.**

## 9. Final ledger (all rounds adjudicated)

**P0 ship-blockers (5):** direct-RPC similarity forgery (+unlimited loop, §1/P0-1); frozen-frame via pause/srcObject-swap (§1/P0-2); `face_unavailable_at` permanent exemption (§1/P0-3); stale-seal NULL + bogus mail (§1/P0-4); submit-consequence gating deferred to P1 (§1/P0-5 posture: seal, gate reveal).
**P1 must-fix (~14 live):** login limiter; matric gate (P2 operationally, P1 by audit); reveal-consequence enrollment/archived gates (H1 narrowed); auto-reveal livelock; incident TOCTOU; body-cap streaming; seal-score honesty; share-enumeration (P2 by use, P1 by fix); single-add cap (same); sheet-collision 500; cancel honesty + idempotency; lock unification; 401 recovery; timer recover-deadline; poll-merge; quiz-sources orphans; fullscreen-farm gradebook blindness; ms consent copy (P2); mic indicator (P2).
**Fix corrections (binding):** NO service-role RPC switch (bricks auth) — HMAC proof + per-session 40–60/10 min SQL throttle with pinned order exempt→gates→nonce→proof→verdict and `DEFAULT NULL` migration grace; NO RPC quorum reject — pad-don't-omit; replay→paused only under the 5-condition predicate; clear-unavailable only on streak-2 non-exempt commits + notice re-key; share fix keeps RPC/view play paths (SQ-D2c becomes pin).
**Harness (binding):** fake-based RPC-semantics tests are VOID (live `verify-*.mjs` only); add silence/grace/advisory-touch live pins (currently zero); floors under tested-but-ungated routes; fail on fully-skipped runs; unmocked InsightFace boundary test; env parity check; schedule media sweep (+quiz-sources coverage); fix `registerUser`/`fastRegisterUser` helper holes.
**Kill count (anti-inflation):** 1 P0-claim refuted outright (closed-reveal silent), 1 mechanism corrected (frozen-frame), 1 sub-claim inverted (dead-branch direction), 5 P1s killed→P3 (palm-next, commitHold, PATCH-null, poll-override, sweep-incident-leg), 7 P1s weakened→P2 with confirmed mechanisms.

*8 rounds (19 agents). No code changed. Surface exhausted per stop rule: R7 + R8 consecutive with zero new P0/P1 and nothing left named.*

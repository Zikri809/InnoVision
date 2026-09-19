# Audit — PLAN_GESTURE_OFF_RICH_TYPES implementation (post-implementation critic)

> **STATUS: FIXED + RE-VERIFIED (rounds 3–4).** The findings below were the
> round-1/2 record; every BLOCKER and MAJOR was then fixed and re-audited by
> three fresh verification agents (round 3), whose residual findings were fixed
> in turn and re-verified by a final agent (round 4). Round 4 verdict:
> **0 blockers, 0 majors.** Full gate state at close: `tsc --noEmit` clean ·
> **2376 unit tests / 127 files** · **7 pgTAP suites / 195 assertions** (all
> PASS) · `check:i18n` 1385/1385 · `check:sealed` green (CI-wired) · coverage
> gates pass. See **§8 "Fix & verification record"** at the end for the
> per-finding disposition and the residual MINORs that remain by design.

- **Spec:** `docs/roadmap/PLAN_GESTURE_OFF_RICH_TYPES.md` (v5.0, "SHIPPED")
- **Scope audited:** working-tree implementation — `supabase/migrations/0051–0060`,
  `supabase/tests/` (6 pgTAP suites), `src/**` changes (gesture layer, quiz UI,
  routes, Zod schemas, worker, i18n), `e2e/e53–e58`, unit tests.
- **Method:** 6 parallel domain critics (round 1: SQL/migrations, security/privileges,
  client/UI, API/Zod/i18n, scores/lifecycle, test coverage) → 3 round-2 verification
  auditors that re-read every contested file:line and returned VERIFIED / REFUTED /
  DOWNGRADED with quoted evidence → fix wave → 3 round-3 verification auditors
  (SQL/DB, client/UI, test/gate) → residual fixes → 1 round-4 final verifier.
- **Round-1/2 verdict: 2 BLOCKERs, 13 MAJORs, ~30 MINORs.** Nothing below is
  speculative; every item carries file:line evidence. A note on one overclaim: the
  round-2 test-gap auditor closed with "final blocker list: EMPTY" — that judgment
  covered only its own T-items and is **overruled** here: V1 and W1 below are code
  defects verified by dedicated verifiers with quoted breakage, and they stood as
  BLOCKERs (both now fixed).

---

## 1. BLOCKERs (must fix before calling this done)

### B1 — `append_question` rewrite is not the live 0045:1463 body (order corruption + P0001 + 503s) — VERIFIED round 2 (V1)
- **Files:** `supabase/migrations/0055_rpc_reshape.sql:506–539` vs live
  `supabase/migrations/0045_integrity_p0_forgery_fraud.sql:1489–1542`
  (diff confirmed via `tmp_audit/append_question.base.sql` vs `.new.sql`).
- **Spec:** §2 "BASELINE: the LIVE 0045:1463 revision … all carried verbatim".
  `0055:483–484` even claims "carried verbatim" — false.
- Three arms, all confirmed:
  1. `order_index`: live `coalesce(max(order_index),-1)+1` (0045:1524–1526) →
     new `count(*)` (0055:524–526,536). After any delete/reorder, `count ≠ max+1`:
     duplicate `order_index` (silent ordering corruption; no unique guard catches it).
  2. Normalization dropped: live sorts/dedups `p_correct_indices` + `nullif(p_explanation,'')`
     (0045:1532–1538) → new inserts raw (0055:532–538). Unsorted lecturer input that used
     to succeed now throws `P0001 invalid_correct_indices` from
     `questions_correct_indices_guard` (0037:98–107, which demands canonical form).
  3. Error strings renamed and consumers still map the OLD ones:
     `not_owner`→`not_quiz_owner` (0055:511), `quiz_not_found` /
     `questions_locked_quiz_not_draft` collapsed to `quiz_not_draft` (0055:514–519),
     `quiz_question_limit_exceeded`→`quiz_question_cap` (0055:545).
     Consumer `src/app/api/quizzes/[id]/questions/route.ts:87–95` maps
     `"not_owner" | "quiz_not_found"` → 404, `"questions_locked_quiz_not_draft"` → 409-path,
     `"quiz_question_limit_exceeded"` → 422 — `"not_quiz_owner"` does NOT contain
     `"not_owner"`, new `quiz_not_draft` / `quiz_question_cap` match nothing → those
     paths fall through to **503 internalError**. Sibling `import-questions/route.ts:177–183`
     maps both owner/draft spellings but still only the old cap string → cap still 503s there.
- (`clone_quiz` is clean: verbatim + `gestures_enabled`/`answer_key`/`max_score` appends only.)
- **Fix:** restore `coalesce(max)+1`, sort/dedup + `nullif`, and the live error strings
  (or map both spellings in the two routes).

### B2 — Override replay guard fabricates success after a failed first attempt — VERIFIED round 2 (W1), agreed by 2 round-1 critics
- **File:** `src/app/api/sessions/[id]/override/route.ts:106–115`.
- `recordRateLimitHit(replayKey, …) > 1` returns `{ok:true}` 200 **before** the RPC,
  and `recordRateLimitHit` (`src/lib/classes/rate-limit.ts:138–152`) records
  unconditionally. If the first call 404s (`not_owner`/`not_found`, :134), 400s (:135–141),
  503s (:122–125) or 500s (:150–151), the hit stays; an identical retry within 60 s
  sees count 2 → **200 `ok:true` for a mark never written**. No outcome tracking, no
  `resetRateLimit` on error arms. Silent grade-integrity lie to the lecturer.
- **Spec:** §5/S10 (replay digest must suppress replays of a *succeeded* write).
- **Fix:** record the replay key only after `payload?.ok === true`, or
  `resetRateLimit(replayKey)` on every non-ok arm.

---

## 2. MAJORs (should-fix; ship-stoppers for a strict gate)

### M1 — AI spend caps are dead: worker never books tokens/usd — VERIFIED round 2 (W5)
- `src/lib/ai/marking-worker.ts:324–330` (success) and `:337–346` + `:288,:313,:320`
  (failures) push `{ok, score, confidence, rationale}` with **no `tokens`/`usd`**;
  `ChatResult` ok arm (`src/lib/ai/client.ts:39–45`) is `{ok:true; text}` — `completion.usage`
  never read. `finalize_ai_mark` coalesces absent keys to 0 (`0057:554–555`), so
  `check_mark_spend` (`0057:109–122`, caps 50k tokens / $5) sums zeros forever; the
  sweep spend-block arm (`0057:192–209`) never fires. I-24's "tokens reconciled"
  (`0057_sweep.sql:196–200`) passes only because the *test* hand-injects `tokens:150`.
  Unbounded GLM spend behind a control reporting healthy. **Amplifier:** M9 (ANSWER 2× over
  spec) widens the queue feeding this.
- **Fix:** read `completion.usage` in `chatCompletions`, extend `ChatResult`, forward
  `tokens`/`usd` in every `FinalizeRow`.

### M2 — Lecturer session-detail surface not migrated; override UI absent — round 1 security M3, uncontested
- `src/app/(lecturer)/lecturer/quizzes/[id]/results/[sessionId]/page.tsx:105–109` projects
  only `id, type, prompt, options, order_index` from `lecturer_questions_view` — drops
  `answer_key`, `explanation`, `image_path`, `max_score`; `short_text` rows show empty options,
  no rubric. `AnswerRow` (`:24–31`) lacks `answer_text/skipped/mark_status/mark_score/attempt_version`;
  `session-detail-client.tsx` (320 lines) is the pre-plan component (verdict chips from
  `is_correct` only, no short-text branch, no rationale, no override dialog).
  `override-mark-dialog` (frozen testid, §0/D-30): **zero hits** in `src/` + `e2e/`.
  RPC (0058) + route exist → adjudication is API-only; `needs_review` rows are unresolvable
  from the specified UI.
- **Fix:** extend the page projection + `AnswerRow`, render short-text/mark states +
  rationale (plaintext), add the override dialog with `data-testid="override-mark-dialog"`.

### M3 — EndScreen mobile accordion drops `short_text` answers — VERIFIED round 2 (W3; downgraded BLOCKER→MAJOR, scores unaffected)
- Wide `renderRow` has the `isShortText` branch (`end-screen.tsx:266–284`, typed answer +
  rubric); mobile `renderAccordionRow` (`:352–483`) computes `isShortText` (`:355`) but uses
  it only for `answered` (`:360–361`) — the panel (`:421–472`) unconditionally renders
  `b.options.map`, i.e. an empty list for `short_text`. Student's answer + rubric invisible
  on phones. E-55 (desktop viewport) cannot catch a mobile-only regression.
- **Fix:** mirror the `:266–284` `isShortText ? … : …` branch inside `AccordionContent`.

### M4 — U-65's four v4.9 invariants have zero tests — VERIFIED round 2 (T2)
- `TYPE_HAS_FINGER_INPUT` (`play-client.tsx:71,1471`), `holdProgress ⇒ isHandActive`
  (`:271,:509`), `HandLoss`-never-fires-when-disabled (boot gate `gesture-layer.tsx:527–532`):
  `*.test.*` grep → **no files found**. `hold-confirm.test.ts` / `hand-loss.test.ts` cover only
  pre-existing logic. These are the exact regressions §7/R3/R6 was written against.
- **Fix:** `play-client` armed-matrix unit (type × phase × answered → armed) + GestureLayer
  `enabled=false` render/boot test.

### M5 — E-60 gate does not exist — VERIFIED round 2 (T3)
- No `select *` scan, lecturer-view diff, `NOTIFY` check, or `EXPECTED_JOBS↔cron.job` tie in
  `package.json`, `docs/TESTING.md`, `scripts/`, or `.github/workflows/ci.yml`.
  "Verified clean at handover" is manual. `health-route.test.ts:113–127,205–219` mocks both
  sides (7-job fixture vs constant) — a DB-vs-constant drift (8th live job, constant still 7)
  never surfaces.
- **Fix:** CI step with the `select *` scan (user clients) + view column diff + `NOTIFY`
  presence + `EXPECTED_JOBS` vs `cron.job` count.

### M6 — `already_submitted` recompute (C5-7/L10) completely untested — VERIFIED round 2 (T6b), agreed by 2 critics
- `grep already_submitted supabase/tests/` → zero hits. Implementation exists and is correct
  (`0055:724–765`, recompute + unrevealed→`score:null` arm), but a regression to "return stored"
  or a leak of a provisional score passes everything. Highest-risk new lines in `submit_session`.
- **Fix:** pgTAP: override/finalize → re-`submit_session` → assert recomputed (incl. 0.5) score
  with the null arm preserved.

### M7 — ANSWER budget not tightened + per-session secondary missing; AUTHOR not migrated — VERIFIED round 2 (W7), agreed by 2 critics
- `answer/route.ts:25` = `{limit:120, /min}` per-user only; spec §7: **60/min + per-session
  secondary**, explicitly a "deliberate TIGHTENING" over live 120s (test even pins 120 at
  `sessions-routes.test.ts:366`). `short_text` rides ANSWER with no separate cap → 120 long
  answers/min/user each queue a GLM call; combined with M1 (dead caps) = unbounded marking
  spend. AUTHOR routes (`questions/route.ts:24`, `[questionId]/route.ts:26`) = 120/hour vs spec
  30/min — fail-safe direction (15× stricter sustained) but 4× burst-looser; spec-letter deviation.
  (SUBMIT 10 / OVERRIDE 30 / HEALTH 30 match.)
- **Fix:** `ANSWER_RATE={limit:60,…}` + per-session secondary key; AUTHOR: apply spec or amend
  spec to bless 120/hour (SOTA sibling `student-quizzes/shared/answer/route.ts:18` already 60/min).

### M8 — Practice re-answer after skip (A5-5) untested at every level — VERIFIED round 2 (T6f)
- Implementation exists (`0055:184–186,212–231,434–451` resets); E-56 is assessment-only
  (skip terminal, `:90–93`); route SHORT tests are shape-only; no skip→answer practice test
  anywhere. The `23514 skip_shape` regression A5-5 fixes has no guard.
- **Fix:** practice-mode test: skip → answer same question → 200 + `skipped=false`.

### M9 — `quiz_status_transition` drops the INSERT must-start-draft guard — VERIFIED round 2 (V2)
- `0056:304–306` (`if TG_OP='INSERT' then return NEW`) vs baseline `0034:77–83`
  (`quiz_must_start_draft`); header claims additive-only. Direct/service-role
  `INSERT … status='live'` bypasses `cannot_publish_empty_quiz`. Backstop removal, low
  exploitability (routes insert draft) — MAJOR, not BLOCKER.
- **Fix:** restore the 3-line INSERT arm in 0056.

### M10 — Mobile per-quiz sheet renders provisional percents as final — round 1 lifecycle M2, uncontested
- `gradebook-mobile.tsx:325–343` shows `cell.percent` with no `pendingCount` check; distribution
  bar (`:288–318`) counts provisional percents. Desktop (`gradebook-client.tsx:433–443`) and the
  mobile per-student sheet (`:237–242`) correctly chip pending. Partially-marked session
  (e.g. 5/5 resolved + 5 pending) leaks "100%" as a grade. Model is right; one surface ignores it.
- **Fix:** pending-chip gate in the per-quiz sheet + exclude pending cells from the bar.

### M11 — Class average bakes in provisional percents; all-pending student reads "not attempted" — round 1 lifecycle M6/M7, uncontested
- `gradebook.ts:173–184` includes pending cells in `averagePercent` (test `gradebook.test.ts:429–449`
  *pins* 75 from a 100%-provisional + 50% cell — locked-in, contradicts the chip's honesty rationale;
  spec silent → needs a spec line either way). `buildRow` excludes pending from `cumulativePercent`
  (`:232–241`) → null → desktop `t("notAttempted")` (`gradebook-client.tsx:462–469`): a student who
  attempted everything but awaits marks reads as absent. Cumulative cell needs a pending state.
- **Fix:** decide average semantics + spec line; pending-state cumulative cell.

### M12 — I-24 gaps: lease re-claim, spend-fail arm, pg_net-absent commit, digest/v_all_done re-fire unasserted; deadlock guard structural — VERIFIED round 2 (T6c + round-1 SQL M6/M7/M8)
- Suite proves claim/finalize/escalate lifecycle honestly (32 assertions, all real) but never:
  ages a `marking` row past the 5-min lease to prove re-claim (only proves fresh rows are NOT
  re-claimed, `:129–139`); forces `check_mark_spend` exception → `mark_rate_limited`; exercises the
  pg_net-absent commit path (`0057:272–277`); asserts `quiz_completed_all` / `v_all_done` re-fire
  after finalize/escalate (fixture never submits — session stays `active`, so recompute/recheck
  claims are half-exercised; finalize→reveal covered only via I-20). Deadlock assertions
  (`:374–382` `pg_get_functiondef LIKE '%ai_mark_sweep%'`) are honestly labeled structural
  approximations — a comment containing the string passes; lock *order* unproven. Related:
  epoch-guard test (`:286–298`) passes the *post-override* epoch, so the `mark_status` arm, not
  the `attempt_version` arm, produces the discard — epoch never independently exercised; stale-token
  test never asserts the ledger row stays `marking` with token intact.
- **Fix:** aged-claim test, spend-exception test, submit-then-finalize/escalate digest test,
  true-epoch test (old epoch + still-pending), ledger-stays-`marking` assertion.

### M13 — Replay-guard test vacuous + SHORT-11 disjunction — VERIFIED round 2 (T5)
- `override-route.test.ts:162–175` admits "fake's rpcResult seam cannot count calls" — deleting
  `recordRateLimitHit` keeps 200+200 green; the guard's core claim (no second RPC) unpinned.
  `sessions-routes.test.ts:1203–1213` (SHORT-11) asserts `[200,400].contains(status)` — passes on
  either outcome, guards neither. Both worse than no test (green on deleted guards).
- **Fix:** count `supabase.rpc` calls in the fake (or assert the rate-limit bucket); pin SHORT-11
  to one status.

---

## 3. Downgraded / contested items (adjudicated — kept, at lower severity)

| # | Item | Adjudication |
|---|---|---|
| D1 | `quiz_reveal_once` GUC bypass allows any change, not just →NULL (0058:156–161, no `NEW IS NULL` term) | VERIFIED code, **LOW**: only setter is the override txn itself (`0058:46`, txn-local) + sole write is →NULL (`:111–114`). Defense-in-depth; add `and NEW.results_revealed_at is null`. |
| D2 | Lock-order "§11.4 pinned everywhere" false — escalate/finalize/override take quizzes LAST (0057:381–382, :669–670; 0058:53→59–65→111–114) | Wording VERIFIED-false, **deadlock risk REFUTED (INFO)**: all three writers share `ai_mark_sweep` (`0057:169,324,545`) and serialize; sweep↔submit/override share only Q; submit↔escalate↔finalize↔override all sessions-first (matches `submit_session` 0055:698–701→825–829). Fix the §11.4/0057:19–23 prose, not the code. |
| D3 | `student_results` assessment branch reads stored score, not D10 SUM (0055:943–944) | VERIFIED, **LOW**: every post-migration score writer uses the SUM (submit ×2, seal, escalate, finalize, override) — stored == live SUM; pre-migration rows have no `mark_score` so COUNT≡SUM. Strict-spec deviation only. |
| D4 | FC-5 "route must read `student_question_view` + enforce coupling route-side" | Observation VERIFIED (route has zero `.from()`), **hole REFUTED (LOW/docs)**: definer RPC rejects both cross-type directions fail-closed with correct 400s (0055:250–251,323–333,402–405; route maps all four, :127–134). RPC-side is strictly stronger (no TOCTOU). Amend plan lines 700–704 to RPC-authority; fix the contradicting `validation.ts:17–20` comment thread. |
| D5 | Spend-blocked `marking` rows keep `claim_token` (0057:203–209) → in-flight finalize overwrites | VERIFIED, **LOW-latent** (dormant while M1 keeps caps at 0; becomes MAJOR the day booking lands). Add `claim_token=null` to `:203–209`. |
| D6 | EndScreen ring/fraction use `total` not `resolved`, no clamp, resolved=0 → "0%" (`:534,:619–622` vs correct `pct` at `:87–89`; `gradebook.ts:226` returns null) | VERIFIED with nuance, **MEDIUM**: needs manual early reveal with pending to diverge (auto-reveal requires zero pending); self-heals. `ScoreRing` self-clamps (`score-ring.tsx:17`). Fix ratio/label + null-state. |
| D7 | Mobile accordion border ignores `markState` (`:379–381` vs wide `:222–228`) | VERIFIED, **MEDIUM**: pill itself is markState-aware (`:386–394`), so border contradicts pill rather than wholly mislabeling. Copy the wide ternary. |
| D8 | Raw NUMERIC-string scores reach EndScreen uncoerced (play page `:353`, sessions envelope `:201–215`, session-detail `:100–103`) | VERIFIED as type-safety hole, **LOW**: all current consumers use `/`, `!= null`, `??`, interpolation — JS coerces silently, no visible corruption. Latent (`===`, `+`, strict JSON). Wrap with `coerceScore`. |
| D9 | D-31 route test missing (zero `short_text` hits in `student-quizzes-routes.test.ts`) | VERIFIED gap, **LOW not blocker**: route uses `StudentQuestionInputSchema` (`[id]/questions/route.ts:51–54`) which rejects `short_text` (`validation.ts:293–299`); QT1-9/10 prove the path for multi. Add QT1-11. |
| D10 | `attempt_version` ungated pre-reveal (0060:93) = override-existence oracle | VERIFIED, **LOW**: only override bumps it (0058:84; finalize only guards), so `1→2` leaks *that adjudication happened*, never the value (marks stay gated). Gate it with the reveal CASE or document intent. |
| D11 | NOTIFY pgrst only in 0054 (`:71`), none in 0055–0060 | VERIFIED, **LOW hosted / MEDIUM self-hosted (VPS)**: hosted auto-invalidates; VPS stale-cache → new RPCs/views 404 until restart. House precedent never NOTIFYs per-file (0054 is the lone exception). Append to 0060 or a 0061 repair. |
| D12 | NaN/non-finite `coerceScore` guard untested (zero `NaN\|Infinity` in `derive/gradebook/export` tests) | VERIFIED gap, **MEDIUM-LOW**: helper byte-exact (`derive.ts:50–54`), string-coercion pinned, but the "never NaN→NaN%" property itself unpinned. Add cases. |

---

## 4. MINORs (fix opportunistically; each one line–few lines)

- **n1** `0059_cron.sql` single-statement check asymmetric: sweep asserts `not like '%;%select%'`
  (`0059_cron tests :58–61`, A6-2), escalate has no mirror. Both single-`SELECT` today (`0059:37,45`).
- **n2** `0058_override` no-stamp test pins `last_activity_at` (`:217–220`, D4) but never
  `submitted_at`. Implementation writes neither — pin both.
- **n3** Weak token assertion `isnt(token,'')` (`0055_submit_pending.sql:247–250`) passes vacuously
  on NULL-ish; use `ok(token IS NOT NULL)`.
- **n4** Bare `select escalate_stale_marks();` discards the count (`0057_sweep.sql:335`); first
  escalation's `2` never directly pinned (second is, `:358–360`).
- **n5** `0054_privs` gaps: no `anon` EXECUTE checks for sweep/escalate/recheck/check_spend (only
  finalize has one, `:134–135`; implementation correctly revokes all four — test omission only);
  no barrier-view projection assertions (§11.5 "re-expose exactly what they claim" untested).
- **n6** `finalize_ai_mark` session-vanished arm (`0057:572–580`) sets `failed` without bumping
  `attempts` → reclaim loop if ever reached; unreachable (`ON DELETE CASCADE`, `0057:39`) — dead
  code should close as `needs_review`/`marked` or bump `attempts`.
- **n7** Practice upserts reset `mark_score/marked_at` but not `mark_metadata`
  (`0055:364–373,442–451`) — harmless (practice never mints metadata, D12) but a future writer
  leaks stale rationale into practice reads.
- **n8** Misleading "FIVE arms" header (`0057:133–149`): claim CTE has three (`:218–227`, correct
  per §6); two `>=3` arms are quiz-lock discovery only (`:174–180`). Next editor will "fix" the CTE.
- **n9** Stale baseline citation: spec §1 says `clone_quiz (0035:62)`; live is `0046:444` (M-25) —
  implementation cites correctly (`0055:9`), spec table needs the bump. Same class: `0052:60–61`
  `SET NOT NULL` is a redundant no-op (0004 already NOT NULL) + extra ACCESS EXCLUSIVE lock.
- **n10** `assign_seal_score` + `quiz_reveal_once` keep default PUBLIC EXECUTE (trigger-only, bodies
  error outside trigger context — not exploitable; spec blesses it). Uniform
  `REVOKE … FROM public,anon,authenticated` would remove the surface.
- **n11** `0052` suite holes: no `gestures_enabled DEFAULT true` pin, no `answer_key >500` rejection,
  no `mark_metadata`-JSONB smoke (constraints exist, tests don't).
- **n12** `correctIndices` ceiling is 5 not 4 (`quizzes/validation.ts:109` `.max(MCQ_OPTIONS_MAX)`);
  saved by the OOB arm (`:206`) — bound disagrees with the D1 cap it claims to mirror.
- **n13** `hasNonWindowFields({gesturesEnabled:null})` frozen-correct but unpinned
  (`updates.test.ts:136–142` covers booleans only).
- **n14** S10 "cross-pod benign" overclaims: cross-pod replay double-executes (two epoch bumps, two
  audit rows); *score* deterministic-benign, epoch/audit trail not idempotent.
- **n15** i18n bypass: `session-detail-client.tsx:125–129` hardcodes Langkau/Skipped/Betul/Correct
  via locale ternary — second localization path `check:i18n` can't see.
- **n16** Type lie: play page `QuestionRow.type` omits `"short_text"` (`page.tsx:25`) while the view
  returns it and `play-client.tsx:45` includes it; saved by `as QuestionRow[]` cast (`:253`).
  (Also the second R8 union the spec names.)
- **n17** Lecturer breakdown projections drop `mark_score`/`mark_metadata`/`marked_at`/`attempt_version`
  (`results/page.tsx:164–167`, `load-insights.tsx:130–133`, `gradebook-export:317–320`) —
  secure direction (under-exposure), but lecturers can never see the adjudicated 0/0.5/1 value.
- **n18** Duplicate-route stale comment (`duplicate/route.ts:209–211` says USER client, code correctly
  uses admin — `image_path` revoked by 0054).
- **n19** `sync-migrations.sh:245,364` + `DEPLOY_VPS.md:423,1347` still say "five schedules"
  (load-bearing spots all moved 5→7; doc-only).
- **n20** `marking-worker` `finalize('[]')` likely errors on `FOREACH NULL` (`0057:669`; worker/route
  never send `[]` — direct-RPC-only, fail-closed). Guard it.
- **n21** Short-text confirm + Skip announce "Answer NaN confirmed" to screen readers
  (`play-client.tsx:719` sets `scalar=undefined`; announcer `:992–996` reads `scalar!+1`
  unconditionally). New-path a11y bug.
- **n22** Practice oracle warning suppressed on resumed answers (`question-card.tsx:230`
  `!answer.seeded` gate vs seeded badge `:113–143` still revealing correctness) — "warning on
  every answer" holds for fresh answers only.
- **n23** `failed` mark state falls through to red ✗ in both EndScreen renderers (`markState` maps
  only pending/needs_review/skipped, `:207–213,:365–371`; no `failedCell` key) — transient
  infra failure attributed to the student until escalation.
- **n24** U-58 `clearPracticeAttempts` leaves `"0"` tombstones (`practice-oracle.ts:103` `setItem`
  not `removeItem`; test asserts `read==0` only). Assert removal or document intent.
- **n25** Builder 5th-multi UI cap (`quiz-builder-client.tsx:967`, `edit-question-dialog.tsx:579`)
  has no click test (DB I-25 + Zod U-QT1-6b cover below; UI cap itself unpinned).
- **n26** E-53/E-55/E-56 vs `fullyParallel` global sweep: E-55 bypasses the sweep (deliberate,
  sacrifices cron-path e2e); pgTAP parks via temp tables. e2e isolation rule undocumented.
- **n27** `docs/TESTING.md:289` pgTAP counts stale (37/30 vs actual 33/32; sum still 150 by double
  drift). Also missing E-60 row, missing anon-variant note (M12/I-23 gaps).
- **n28** Pending-text 401-stash asymmetry: `StashedDraft` carries indices only
  (`play-client.tsx:94–98,:915–918`) — typed answer lost across login bounce, multi draft survives.
- **n29** EndScreen poll reads only `pending_count` (`:108–115`); `revealed`/`score` static RSC props —
  "poll stops on revealed/score" unsatisfiable client-side (keeps polling, needs reload to clear).
- **n30** `play-client.tsx:377–392` `practiceAttempts` lazy-init seeds current question only; other
  questions read 0 until next bump (harmless today, misreports exhausted questions).
- **n31** Dead `onSkip` prop on `QuestionCard` (`:31,:49`) — never rendered by design.
- **n32** Sweep POSTs pre-commit despite "after the claim" comment (`0057:275–291` inside claim txn;
  benign — pg_net enqueue is ms, worker holds no txn — but comment false, locks held across POST).
- **n33** Discarded rows closed as `marked` with no "discarded note" (`0057:631–637`; DDL has no note
  column) — R3-MIN3's note half unimplemented; discarded-vs-applied indistinguishable.
- **n34** Override of a pending answer orphans its ledger row (0058 never touches ledger: stays
  queued/claimable, burns a model call, then epoch-discards). Self-healing but wasteful; close as
  `needs_review` / NULL the token on the overridden key.
- **n35** Practice re-answer wipes a practice override (`0055:442–451` resets `mark_score=NULL`) —
  probably acceptable, undocumented.
- **n36** E-53 "keyboard-only" fiction: zero `keyboard.*` events in `e53` (`:114` clicks `^A`); face
  camera-refcount (D6) unasserted. E-58 threshold-via-`setItem("3")` (wrong constant passes),
  ms copy skipped (`:128–131`), Try-again clear untested. E-54: edit-dialog round-trip + post-reload
  skipped-chip navigation missing. (E-53 R18 zero-boot incl. seam, E-54 wire-shape exactness,
  E-56 denominator, E-57 clone+409-triple all solid — see §6.)
- **n37** `SweepSchema.rows.max(50)` vs sweep `LIMIT 10` (documented operator bound — noted only).
- **n38** Desktop `{cell.percent}` renders blank not "—" if null-without-pending
  (`gradebook-client.tsx:445–447`; unreachable — null percent ⇒ null cell — defensive only).

---

## 5. Edge × coverage matrix (final)

| Edge | Covered-by | Gap |
|---|---|---|
| 5th multi blocked, on AND off | I-25 DB + U-QT1-6b Zod | UI Add-option click — n25 |
| `short_text`+options rejected every layer | U-60-2 + I-25 + E-54 wire | — |
| Empty-trim rubric / answerKey | U-60-3 + I-25 blank/null | 501-char answerKey at DB — n11 |
| 501-char answer / rubric | U-SHORT + U-60-4 + I-25 answer_text | answerKey 501 DB — n11 |
| `answerText` on mcq | RPC rejects (0055:402–405) | explicit route/fake case — M4-context/D4 (wrong code family in fake) |
| Double-submit | I13 409 + I-S15 | — |
| Re-answer after skip, practice (A5-5) | — | **M8** |
| Skip on already-graded → `already_answered` | fake code path only | route test — §2/M13-context |
| Skipped chip, practice | — | E-54 assessment-only — n36 |
| All-pending resolved=0 → null | gradebook U-63 | export all-pending — minor |
| 0.5+1.0=1.5 NUMERIC | I-20 + E-55 | — (catches int4 rounding) |
| Override NULL/bad/over-max/foreign/no-row | I-21 all five + route mappings | replay — **B2/M13**; over-max pgTAP — §2 |
| Finalize epoch + claim-mismatch discard | I-24 + worker U-M4 (rpc uncalled) | true-epoch + ledger-stays-marking — M12 |
| Crashed-worker lease re-claim | — | **M12** |
| attempts≥3 escalation | I-24 + idempotent | — |
| Spend-cap fail-closed on exception | code only (0057:97–121) | **M1/M12** |
| pg_net absent commit path | code only (0057:272–277) | **M12** |
| Bearer missing/mismatch 401 | I-AI-1 (4 cases, worker uncalled) | — |
| non-null→NULL w/o GUC rejected | I-21 (with GUC reset, non-vacuous) | — |
| Last-writer-wins | comment only (0058:104) | by design, documented |
| localStorage null/throw/corrupt | U-58-6/7/8 | tombstones — n24 |
| i18n parity 1373 + render | `check:i18n` (keys) | ms render + new-key render — n36 |
| Health EXPECTED_JOBS 7 | I-22 + health fixture | constant↔DB tie — **M5** |
| select-* audit | — | **M5** |
| `?? true` vs `?? false` | U-61-2 (lib) | create-route — T6a/LOW |
| data-day ISO / datetime-local / a11y names | calendar en-CA + helpers + picker | `override-mark-dialog` — **M2** |
| Invite gate + clone discipline | all E-53–E-58 | — |
| Flakiness (15s poll, 1-min cron) | E-53 poll ON-case; E-55 bypasses sweep | tradeoff — n26/M12 |

---

## 6. Verified CORRECT (do not re-litigate; round-2 confirmed)

SQL: FS-1 filenames + D8 enum split; 0052 shape package (incl. `options '{}'`/NOT NULL convention,
3-way `questions_correct_shape`, short-text/rubric/pending/skip CHECKs, D11 practice guard —
guard extension correctly *omitted*, 0037 ELSE arm already covers); 0053 FS-2/C2
(drop views + seal trigger → NUMERIC → verbatim recreations + re-GRANTs; 0055 drops seal fn only
after; 0056 re-creates trigger verbatim); 0054 REVOKE-first seal with exact §3 column lists
(questions incl. `max_score` excl. keys; answers excl. all mark columns; sessions withholds `score` +
`resume_grace_until`; ledger grant deferred to 0057); 0055 DROPs (exact live arities) + D2-5 gate;
`answer_question` gates verbatim + skip-terminal + short_text-pending epoch-1 key + A5-5 resets on
every practice upsert; `submit_session` A7-3 + D10 + L4 `v_all_done` term; `student_results` practice
SUM + `pending_count` + reveal-gated rich keys; seal A7-3/D10; 0056 lifecycle CREATE-OR-REPLACE
(autoclose L4/L5 terms, notify L5 exclusion, FS-8 freeze list — modulo M9's dropped INSERT arm);
0057 ledger DDL/UNIQUE/CHECKS/lease/token/day, sweep index (A5-10/A6-3), RLS + service-only (C3),
pg_net-vs-cron block split (A6-6), `check_mark_spend` fail-closed, sweep leaf + quiz-order + 3-arm
claim + SKIP LOCKED 10 + attempts/token/day on claim + post-commit-intent POST + Vault bearer
(modulo n32 comment), escalate predicate/order/close/re-fire (A6-9), recheck both arms, finalize
leaf + sessions-first + token-first + malformed→failed + 0.55 needs_review + A7-4 `is_correct` +
epoch/pending guard + R3-MIN3 close (modulo n33 note) + failure→failed-for-retry + D10 + recheck +
FS-6 service-only, `student_pending_count` own-session ungated (FS-4, agreed not an oracle);
0058 override full chain (C9 → reason → GUC → C8 sessions-lock → C10 join + rowcount → L8 mark write →
D10 → in-txn re-publish → audit; no stamps; EXECUTE authenticated-with-lecturer-gate);
0059 two schedules 1-min/5-min pinned single-statement, pg_cron-first, no pg_net (A7-1/A6-2);
0060 six views append-LAST + re-GRANTs, FC-1 flag on both student quiz views, FS-12/S1 gating
(agreed sound), owner predicates via `is_lecturer_of_quiz` (D2-16/S3), keyless
`student_question_view`, full `lecturer_answers_view`, terminal `pending_count` (A5-11);
pgTAP hygiene (plans match hand-counts 22/33/26/32/23/14, BEGIN…ROLLBACK, fixed-UUID fixtures,
global-sweep parking, honestly-labeled structural deadlock assertions).

Security: no PUBLIC-EXECUTE forgery surface (all definers locked; trigger-only pair blessed);
lecturer reads migrated to `lecturer_questions_view`, all `questions` writes on admin
(6-site 42501 class closed); fence maps BOTH U+0060+U+201B → U+02BB with hierarchy + strict parse +
500/300 caps; rationale has no HTML sink; E-60 `select *` scan manually clean on sealed tables
(user clients explicit-column; admin-scoped otherwise) — automation missing (M5).

Client: GestureLayer disabled state (init, branch order pre-`off`, boot-effect-only gate incl. seam,
no early-return-before-effect, holdProgress/isHandActive invariant, face gate untouched);
R6/B6-7/B7-5 arming (set, both gates, palm-next exception, mapFingers guard, empty-options no-crash);
badge map + `shortText.label`; B5-1 widget (testid, 500, placeholder, pendingText mirror,
trim-gated Confirm, `{answerText}` POST, resume echo, action-zone arm); skip (testid, phase-only,
terminal, graded-0 row, full resume plumbing, precedence, exclusivity); pending banner top-level
two-state continuing poll (mobile-only bug stays fixed); practice `needs_review` never Incorrect;
builder authoring (Selects, rubric swap, `options:[]` on type-switch — `[""]` bug stays fixed,
PATCH `answer_key` via admin, 4-cap both surfaces, toggle + `?? true` + diff-PATCH + live-409 +
opt-out helper); edit-dialog union/SelectContent/draft; oracle semantics (keying/3/degradation/clear,
advisory, bump/clear wiring); i18n 1373/1373 all §8 keys namespaced, FC-10/X2-9 placements.

API/Zod: QuestionInputSchema arms (global min/max moved, short_text 0-options + 1..500 rubric,
index-key rejection, answerKey-on-others rejection, legacy bounds intact); AnswerSchema
exactly-one-of-four + trim/cap; updates `?? true` + frozen + carve-outs + 409 + create default;
coerceScore byte-exact + applied at model layer; override posture (house order, digest shape,
Zod ladder, 404 collapse); sweep route (fail-closed bearer, justified CSRF exemption, 60/min,
pre-model-call token re-verify, 45 s abort, strict parse, failure finalization, post-worker
escalation separation).

Scores/lifecycle: all live score *writers* D10 (submit ×2, practice branch, seal, escalate,
finalize, override — no COUNT writer survives; `v_score NUMERIC` ×3; lecturer view aggregation-free);
practice 0.5 survival; reveal gating everywhere (v_all_done, autoclose reveal + digest, notify
count, finalize + escalate recheck); override suppression structural (AFTER UPDATE OF status —
status-unchanging score UPDATE cannot fire notify; I-21 count assertion real); two-phase
(stateless worker calls, no open txn/locks; separate escalation incl. route-level post-worker call;
day=CURRENT_DATE; spend-exceeded → failed+attempts+1); cron pair + shared leaf (D13) + 7 agreed in
all three load-bearing spots (health, sync var, DEPLOY table); I-20/I-21/I-22/I-24 real assertions
(queue shape, skip resolution, 1.5 unrounded, is_correct set, reveal release, token discard,
retry-then-escalate, GUC on/off) with exemplary anti-vacuity devices (GUC reset, residue parking).

Tests solid: U-60, U-SHORT, I-20, I-21, I-22 (each would fail on its named bug); worker fence/strict/
A6-4 pins; sweep-route auth posture; E-53 R18 zero-boot; E-54 wire exactness; E-56 denominator
(`/ 2` + `/ 1`×0); E-57 clone+freeze triple; contracts (data-day en-CA, datetime-local strings,
5 of 6 frozen testids, invite gates, clone discipline, vitest floors, TESTING §3.1).

---

## 7. Fix order (priority)

1. **B1** append_question restore (order + normalization + error strings) + route-mapping test.
2. **B2** replay-key success-gating + RPC-count test (M13 half).
3. **M1** token/usd booking (caps live) + spend-exception test (M12 half).
4. **M7** ANSWER 60 + per-session secondary (with M1 live, spend path bounded).
5. **M6 + M8 + M4** pgTAP/route/unit: already_submitted recompute, practice skip→answer, armed-matrix.
6. **M2 + M3** session-detail migration + mobile accordion short_text (+ D7 border, n23 failed-state).
7. **M5** E-60 CI gate (scan + diff + NOTIFY + jobs tie) + D11 terminal NOTIFY.
8. **M9–M13 + D-series** (INSERT arm, mobile sheet, average/cumulative semantics + spec lines,
   I-24 hardening, SHORT-11 pin).
9. MINORs n1–n38 opportunistically; spec-table bumps (clone_quiz 0046:444, §11.4 wording,
   FC-5 RPC-authority, TESTING counts, "five schedules" prose).

*Convergence statement: round 2 verified or refuted every round-1 claim above with file:line
evidence; the D-table records all adjudicated downgrades. No open "critic vs critic" dispute
remains — only the fixes.*

---

## 8. Fix & verification record (rounds 3–4)

### 8.1 Round 3 — three parallel verification agents

Every fix was re-read against the working tree with quoted evidence.

**SQL/DB verifier — all FIXED, no regressions:**

| Finding | Disposition | Evidence |
|---|---|---|
| B1 append_question | FIXED | `0055:550-566` — `coalesce(max(order_index),-1)+1`, sort+distinct normalization, `nullif(p_explanation,'')`, live error strings `not_owner`/`quiz_not_found`/`questions_locked_quiz_not_draft`/`quiz_question_limit_exceeded`; route mappings at `questions/route.ts:90-103` pinned by `quizzes-routes.test.ts:938-962` |
| B2 replay guard | FIXED | `override/route.ts:154-158` stamps only under `payload?.ok === true`; read-only `recentHitCount` (`rate-limit.ts:172-180`); `override-route.test.ts` asserts `rpcCalls` 1 (replay) / 2 (failed-then-retry) |
| D1 reveal GUC | FIXED | `0058:164-170` now requires `NEW.results_revealed_at is null` |
| D3 student_results | FIXED | `0055:980-985` — one live D10 SUM, no mode branch, `v_session.score` never read |
| D5 spend-block token | FIXED | `0057:203-213` `claim_token=null`; vanished-session arm bumps `attempts=3` |
| M9 INSERT arm | FIXED | `0056:304-315` restores `quiz_must_start_draft` verbatim |
| D11 NOTIFY | FIXED | terminal NOTIFY in 0054/0055/0057/0058/0060 |
| M1 usage booking | FIXED | `client.ts` both arms carry `usage`; `marking-worker.ts:314-341` books tokens/usd on success+failure; U-M5 pins 150→$0.0000045 etc. |
| M12 I-24 hardening | FIXED (5/5 enumerated) | lease re-claim §1b, ledger-stays-`marking` §2, true-epoch §6b, submitted-session digest/v_all_done §9 incl. honest 2h hold, low-conf uses `tok2` |
| M6 already_submitted | FIXED | `0055_submit_pending.sql` §7 (re-reveal then recompute; null arm with GUC) |
| M8 practice skip | FIXED | `0061_practice_skip.sql` (12 assertions, real RPC) |

**Client/UI verifier — all FIXED except three residuals (since fixed):**

| Finding | Disposition | Evidence |
|---|---|---|
| M3 mobile accordion short_text | FIXED | `end-screen.tsx:447-465` mirrors the wide branch; `ol > li` holds |
| D7 border / n23 failed state | FIXED | `:401-407` markState ternary; `failedRow` en+ms |
| D6 ring/fraction/pct | FIXED | resolved denominator, clamp ≤100, null → neutral label |
| n29 poll stop | FIXED | stops on `completed && pending_count===0 && revealed===true`; envelope carries both |
| M2 session-detail + override dialog | FIXED | full projections; `override-mark-dialog` testid; error mapping; `coerceScore` used |
| M10/M11 gradebook | FIXED | average excludes pending; `hasPending` cumulative label; mobile sheet chip + bar exclusion |
| D8 coerceScore | PARTIAL → FIXED | sites covered; whitespace pin added round 4 |
| M7 budgets | FIXED | 60/min + per-session 30/min; AUTHOR 30/min; seeds updated |
| n21/n22/n24/U-65 | FIXED | announcer key, seeded-warning gate, `removeItem`, arming predicates + 6 tests |
| E-53 keyboard | FIXED | focus + `keyboard.press("Enter")` |
| E-58 real limit | **DEFECT → FIXED** | stale "View quizzes" locator after "Back to quizzes" (link only exists on /student/classes) removed round 4 |
| mark_score coercion | **DEFECT → FIXED** | `coerceMarkScore` added for dialog preset + display (NUMERIC arrives as string) |

**Test/gate verifier — gate verified with documented limits; three docs defects (since fixed):**

| Finding | Disposition | Evidence |
|---|---|---|
| E-60 gate | VERIFIED + CI-wired | `scripts/check-sealed-tables.mjs`; `package.json:20`; `ci.yml:97`; allowlist reasoned; defeats named evasions, documented regex limits (computed access/destructured `from`/const table names) |
| M4/U-65 | VERIFIED | extracted predicates consumed by play-client + gesture-layer; 6/6 tests |
| M13 replay | VERIFIED non-vacuous | deleting the guard or stamping on entry both fail the suite |
| D-31/QT1-11 | VERIFIED | POST+PATCH short_text → 400 via `StudentQuestionInputSchema` |
| M12/I-26 | VERIFIED | 195/195 pgTAP pass |
| D12 | VERIFIED | every arm pinned incl. blank string |
| Coverage floors | **GAP → FIXED** | `gesture-arming.ts` floor added; proven to bite |
| Docs truth | **STALE → FIXED** | running total 182→195; E-60 row rewritten as CI-wired; four "five schedules" spots → seven; plan-doc bumps applied |

### 8.2 Round 4 — final verifier

Confirmed, with exact gate outputs: E-58 flow coherent (locator removed), `coerceMarkScore`
used everywhere, D12 whitespace pinned, AUTHOR seeds 30, E-53 import clean, gesture-arming
floor bites, all docs truthful, full gates green. **Zero blockers, zero majors.**
One MINOR residual found and fixed: the export artifacts (`export-workbook.ts`,
`gradebook-export` summary + per-quiz sheets, quiz `export` labels) wrote the provisional
resolved-percent for partially-pending sessions, contradicting the on-screen pending chip —
now they write the neutral `pendingLabel` (pinned by a new workbook test; `numFmt` withheld
on label cells).

### 8.2b Deployment-readiness fix (post-audit, 2026-09-19)

The audit's §6/§8 fixes were code-complete, but a deploy review found the AI
marking feature would be **non-functional on a fresh host**: `sweep_ai_marks()`
runs inside Postgres and reads `ai_mark_worker_url` / `ai_mark_worker_key` from
the DATABASE, yet nothing provisioned them and the deploy docs did not mention
them. Without them the sweep claims rows and never POSTs → `short_text` stays
`pending` → `v_all_done` blocks → the quiz never auto-reveals.

Fixed end-to-end:

| Layer | Change |
|---|---|
| Route | `expectedSweepKey()` (`ai-mark-sweep/route.ts`) — bearer is `AI_MARK_WORKER_KEY`, falling back to `SUPABASE_SERVICE_ROLE_KEY`; pinned by 4 new tests (precedence, fallback, whitespace-as-unset, unconfigured) |
| Migration | `0057` reads the URL from `app.settings` **or** the new Vault secret `ai_mark_worker_url`; key already read Vault-first |
| Deploy script | `deploy/sync-migrations.sh` §6b-ii provisions both into **Vault** (primary; `app.settings` fallback for hosts without Vault), idempotent (delete-then-create), quote-injection guarded, and WARNS (never dies) so a config gap cannot block a schema deploy |
| CI | `deploy.yml` `migrate` job passes `SITE_ORIGIN` (URL default) + optional `AI_MARK_WORKER_URL` var / `AI_MARK_WORKER_KEY` secret; both default to existing values so a standard deploy sets nothing new |
| Env | `.env.local.example` (env-parity now 51 keys) and `deploy/secrets/prod.env.example` document both, with the "DB settings, not app env" rationale |
| Docs | `DEPLOY_VPS.md` new **Step 5b** — the provisioning commands, the verify query, and the silent-failure warning |

Verified: the provisioning SQL executes against the local Supabase Vault and the
sweep's read path resolves the value; `bash -n` clean; `check-workflows` /
`check-env-parity` / `check-sealed` / `check-i18n` green; 2379 unit tests; 195
pgTAP assertions.

**No dashboard step is required** — the CI `migrate` job already runs arbitrary
SQL via `supabase db query --linked`, which is how the settings are written.

### 8.3 Residual items (accepted, documented)

- **Export pending percent**: fixed for the cell/summary paths; the `Score`/`Total`
  columns still show the D10 partial score (the plan's §4 explicitly keeps the score
  sum; the percent + per-answer cells carry the pending signal).
- **M12 two arms remain code-only**: no pgTAP forces `check_mark_spend`'s exception arm
  or the pg_net-absent commit path (both fail-safe by construction; single-transaction
  pgTAP cannot model them honestly).
- **Sealed-table scan is a drift alarm, not a sandbox**: computed access
  (`supabase["from"]`), destructured `from`, and const table names evade the regex —
  documented in `docs/TESTING.md` E-60.
- **Lecturer results dashboard** shows the live D10 partial score without a pending
  indicator (self-heals as marks resolve; gradebook/EndScreen/export carry the chip).
- **MINORs by design**: cross-pod replay epoch/audit non-idempotence (score deterministic),
  `attempt_version` ungated pre-reveal (metadata oracle only — documented), trigger-only
  definers keep PUBLIC EXECUTE (bodies error outside trigger context), `mark_metadata`
  not reset on practice re-answer (practice never mints metadata), session-detail mobile
  failed-row uses a neutral dash rather than text.

### 8.4 Final gate state (at close)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 127 files / **2379 tests** passed |
| `npx vitest run --coverage` | exit 0 (St 78.8% / Br 74.9% / Fn 81.6% / Ln 80.1%) |
| `npx supabase test db` | 7 suites / **195 assertions** — PASS |
| `node scripts/check-i18n.mjs` | 1385/1385 parity, all references validated |
| `node scripts/check-sealed-tables.mjs` | passed (CI-wired) |
| E2E (e53–e58) | invite-gated; specs verified by reading; not run in this environment |

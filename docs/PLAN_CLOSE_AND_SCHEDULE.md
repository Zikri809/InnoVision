# Executed Plan — Quiz Close, Availability Windows & Retakes (QC-1..QC-4)

> **Status:** EXECUTED — shipped 2026-08-28, migrations
> **0030_quiz_lifecycle_windows.sql · 0031_closed_reveal_recovery.sql ·
> 0032_retake_policy.sql** (route/UI/test surface listed in the
> Implementation log at the bottom; read for context and invariants —
> verify details against `supabase/migrations/` + `src/`).
>
> Domain: the quiz state machine and its edges — closing (QC-1),
> closed-before-reveal recovery (QC-2), availability windows (QC-3),
> retakes (QC-4). Built on migrations 0004/0007/0016 (quiz state
> machine), 0008/0009/0011/0020 (sessions & integrity), 0012/0024
> (reveal model), 0017 (archiving), 0022 (notifications). Reveal
> semantics are owned by docs/PLAN_REVEAL_RESULTS.md (v4, IMPLEMENTED)
> — this plan did not weaken them (the §2/§8/§9/§10/§11 corrections it
> owed are recorded in the Implementation log).

---

## 0 · Codebase ground truth (verified 2026-08-27)

Facts every item below builds on — re-verify at pre-flight, cite drift in the
log:

- **State machine.** `quiz_status` = `draft | live | closed`
  (`0004_quizzes.sql:16-18`). The FINAL trigger definition is
  `0016_ai_append_and_sources.sql:15-80` (redefined over 0004→0007→0016 — do
  not cite 0004 as current; ANY redefinition must carry the full 0016 body
  forward, including the same-status advisory-lock branch at 0016:44-54):
  closed→*anything* rejected (`closed_quiz_cannot_transition`, 0016:58-61);
  live→draft rejected (`live_quiz_cannot_reopen`); draft→live requires ≥1
  question (`cannot_publish_empty_quiz`). live→closed is currently allowed by
  the trigger but **unreachable**: no route/UI writes `status='closed'`
  (verified across `src/`; the only status writer is
  `publish/route.ts:68` → `'live'`).
- **What hard-stops at close today (matters for stragglers):**
  - `submit_session`: NO quiz-status gate (final def `0024_audit_fixes.sql:
    260-425`) — submissions on closed quizzes succeed and score (deliberate,
    0008:455-457 "timer stops ANSWERS, not submits").
  - `answer_question`: ALREADY close-gated TWICE — `q.status='live'` check +
    `can_student_view_quiz` (final def `0012_results_reveal.sql:199-208`,
    both fold to `quiz_not_live`; route maps to 409 at
    `answer/route.ts:98-100`). A mid-question student whose quiz closes gets
    a dead screen on their next answer and can only hit Submit.
  - Face verification: `record_face_check` requires `can_student_view_quiz`
    (live-only, `0021_integrity_audit_fixes.sql:332-335`) → face checks
    hard-stop at close; pause/unlock/advisory RPCs have no quiz-status gates
    and keep working. Inconsistent posture, documented below in QC-1.
- **Reveal (binding, v4).** Reveal route
  `src/app/api/quizzes/[id]/reveal/route.ts:54,67` requires `status='live'`
  (pre-check 409 `quiz_not_live` + `.eq("status","live")` on the guarded
  UPDATE). Auto-reveal flip in `submit_session` (`0024:368-378`) has **no**
  status term — F8b deliberately allows auto-reveal on closed quizzes.
  **Doc-vs-code divergence:** `PLAN_REVEAL_RESULTS.md §8` still shows the
  flip bounded to `status='live'`; 0024 supersedes it (code wins per repo
  authority rules) — §8 must be corrected when QC-2 ships. The
  `reveal_once_only` trigger (`0012:57-62`) fires only on *changing a
  non-null* value — **first-time reveal on a closed quiz is trigger-legal**;
  only the route gate blocks it.
- **Visibility after close.** `student_quiz_view`
  (`0017_class_archiving.sql:36-49`) filters `q.status='live'` (plus
  archived-class exclusion) → closed quizzes vanish from student lists;
  `can_student_view_quiz` (`0017:52-68`) likewise. The reveal-gated score
  views (`student_session_view` 0012:88-99, `student_answers_view`
  0012:102-112) have **no status term** — they gate purely on
  `is_student_reveal_allowed` (0012:26-41), so closed+revealed scores DO flow
  through them. The stranded surfaces are: the reveal ROUTE (above), the play
  RSC / `end-screen.tsx` which read quiz metadata off the live-only
  `student_quiz_view`, and `resolve_question_image` student arm
  (`0028_media.sql:94-116`, closed requires revealed).
  `student_results` RPC (final def `0028:182-258`) already has NO status term
  — closed+revealed works there TODAY.
- **Sessions.** `quiz_sessions` (0008:32-45): `session_status` =
  `active | paused | flagged | completed`; NO attempt ordinal anywhere.
  `start_quiz_session` (final def `0017:74-199`) returns typed JSON errors,
  single no-oracle `quiz_not_live` folded WITH `not_enrolled` to 404 at
  `sessions/route.ts:75-77`. Assessment uniqueness via `one_assessment_attempt`
  partial unique index `(quiz_id, student_id) WHERE mode='assessment'`
  (0008:54-55); the `unique_violation` handler (0017:169-182) re-selects
  WITHOUT status/ordering — arbitrary row under duplicates (only safe today
  because ≤1 row can exist; NOT safe under QC-4 multi-attempts).
  NOTE: there is NO advisory lock on the assessment path — the per-(quiz,
  student) `quiz_start` lock (0017:116-119) is practice-only.
- **reset_session** (final def `0022_notifications.sql:497-574`) DELETEs the
  session row; FK cascade wipes session_answers, face_checks, AND
  `session_advisories` + `incident_clips` (on-delete-cascade, 0020) —
  evidence loss beyond what its comments claim (IO-5 cross-ref).
- **Notifications machinery.** `notification_type` enum is a FIXED 12-value
  list (`0022:32-37`) — **no `quiz_closed` member**; adding one requires
  `alter type … add value` (0026 is the repo precedent for enum repair) plus
  client-side inventory (`NOTIFICATION_TYPES` union in
  `src/lib/notifications/types.ts:6-19`; unknown types are silently DROPPED
  by `mapRawRow`, types.ts:60-68; copy.ts, bell icon/link resolver too).
  Dedupe: `notifications_recipient_dedupe_key UNIQUE NULLS NOT DISTINCT`
  (0022:48-51); function pattern `notify_quiz_live` (0022:116-140), trigger
  WHEN-clause pattern (0022:435-440); repeatable-event keys carry epochs
  (e.g. `'student_joined:'…|| extract(epoch…)`, 0022:282-284). Digest trigger
  `quiz_completed_all` (0022:216-222) counts completed SESSION rows against
  enrollment count — breaks under retakes (QC-4 consumer).
- **Scheduler precedent.** pg_cron = try/`raise notice` skip pattern
  (`0019_robustness_fixes.sql:809-816`), jobs currently prune-only; pg_cron
  has NO E2E seam (schedule-driven; Playwright cannot await it).
- **Route conventions.** Preamble order: UUID → `requireQuizOwner`
  (class-ownership via `classes!inner(lecturer_id)`,
  `src/lib/quizzes/guards.ts:30-112`; single no-oracle 404 first, so no
  status leaks to non-owners) → `checkSameOrigin` → state checks →
  `rateLimit` → typed errors from `src/lib/http.ts`. Publish idempotency:
  200 on same-status (BEFORE rateLimit — do NOT copy this quirk in new
  routes); 409 `quiz_closed` on closed→live; DB exception strings mapped via
  `error.message.includes(...)` (`publish/route.ts:77-82`).
- **UI conventions.** Status chips canonical map:
  `src/lib/quizzes/labels.ts:17-22` (80%-gated unit tests); results dashboard
  does NOT reuse it (inline status ternary at :276; its :26-31 map is the
  per-session DisplayStatus, a different enum) — reuse `labels.ts`, don't
  duplicate. Confirm dialogs: inline Radix `<Dialog>` destructive variant +
  reopen cool-down (reset pattern, results-dashboard-client.tsx:548-575);
  `src/components/ui/` has popover.tsx but NO calendar primitive; display tz
  convention `Intl.DateTimeFormat(en-US|ms-MY, { timeZone:
  "Asia/Kuala_Lumpur" })`; no date library in package.json. Play page RSC
  reads via `student_quiz_view` and calls `notFound()` when the row vanishes
  (`play/[sessionId]/page.tsx:157-196`) — reload-after-close = truthful 404.
- **Test infra.** Route tests: Vitest (node env, no component tests) +
  `fake-supabase.ts` (1,261 lines; emulates update/rpc/views/embedded joins;
  `makeOwnerContext({ quizStatus })` supports `"closed"`). Its write seams
  (`updateError`/`countError`) produce ERRORS, never 0-row successes — a CAS
  race (guard-read vs write interleaving) CANNOT be emulated in the fake;
  that class of test belongs in the SQL harnesses. Verify harnesses:
  `npm run verify:quizzes` / `verify:results` against local Supabase — the
  SOLE authority for RPC/RLS/CAS semantics (sequential guarded-update probes
  in the D-numbered section, e.g. D24 at verify-quizzes.mjs:446-458;
  two-fire concurrency probes at verify-results.mjs:337-355). No
  clock-control mechanism exists in either
  harness or Playwright — boundary-time tests MUST use relative instants
  (seed `now() - interval '1 minute'` etc.). E2E: Playwright, e2e/eNN-*.spec.ts
  (e35 seeds closed via service-role seam, e35-quiz-closed.spec.ts:71; no
  UI-close helper exists in helpers.ts yet). Next migration number: **0030**;
  schema changes require `npm run gen:types` (CI enforces drift).

---

## QC-1 · Lecturer "Close quiz" action (HIGH)

**Problem:** `quizzes.status: draft → live → closed` exists in the DB
(quiz_status_transition trigger; closed→live rejected) but NO route or UI
writes `status='closed'` — the only status writer in `src/` is
`publish/route.ts:68` (`draft→live`). The i18n keys `closeQuiz`/`closing`/
`statusClosed` (en.json:308) and the closed-status chip (`labels.ts`,
consumed at quiz-builder-client.tsx:498-500) exist but nothing invokes them.
Lecturers cannot end an exam window or stop late starters.
`e2e/e35-quiz-closed.spec.ts` already asserts closed-state behavior but must
seed `closed` via the service-role seam (:71) because nothing in the app can
produce it.

**Design sketch**
- Route: `POST /api/quizzes/[id]/close` — preamble mirrors publish:
  `isUuid` → `requireQuizOwner` → `checkSameOrigin` → `rateLimit`
  (`quiz-close:{uid}`, 30/hr like publish) → typed errors.
  **Deliberate deviation from publish:** the idempotent short-circuit goes
  AFTER the rate limiter (publish puts its own before it, creating an
  unthrottled path on live quizzes — don't inherit that).
- Semantics:
  - `owner.quiz.status === "draft"` → **409 `quiz_not_live`**
    (owner-only surface; no oracle since requireQuizOwner 404s others first).
  - `owner.quiz.status === "closed"` → idempotent **200 `{ quiz }`**
    (mirrors publish's 200-based idempotency).
  - `owner.quiz.status === "live"` → compare-and-swap UPDATE:
    `.update({ status: "closed" }).eq("id", id).eq("status", "live")` with
    `.maybeSingle()`. On 0 rows, RE-FETCH the quiz: now-closed → 200
    (concurrent close won); gone (concurrent delete from another tab) → 404.
    Never fabricate a 200 `{quiz}` for a nonexistent row.
  - Fallback mapping for trigger-raised
    `closed_quiz_cannot_transition` / `quiz_not_draft_edit` → 409, parity
    with publish's error mapping (publish/route.ts:77-82).
- **DB side (migration 0030, shared with QC-3 if shipped together):**
  - `alter type public.notification_type add value 'quiz_closed';`
    (**BLOCKER if forgotten**: inserting an unlisted enum value raises
    22P02 inside the AFTER-trigger, rolling back the close UPDATE itself —
    the route would 503 forever and the QC-3 cron would retry-fail
    silently.)
  - `notify_quiz_closed()` function + trigger (function body follows
    `notify_quiz_live`, 0022:116-140; trigger WHEN-clause
    `old.status is distinct from new.status and new.status = 'closed'`,
    WHEN-clause
    `old.status is distinct from new.status and new.status = 'closed'`,
    pattern 0022:435-440); dedupe_key `'quiz_closed:' || new.id::text`;
    recipients = enrolled students in NON-archived classes (mirror the
    `archived_at is null` exclusion its template `notify_quiz_live`
    carries, 0022:123-126).
  - Client notification inventory IN SCOPE (all of it, or notifications are
    silently dropped): `NOTIFICATION_TYPES` union + `mapRawRow`
    (notifications/types.ts), copy keys × en/ms (copy.ts), bell icon,
    pinned/digest classification, link resolver. Note in-app only — the
    bell on a LIVE quiz disappearing may confuse; link target = results
    dashboard entry or class page (decide copy at implementation).
  - Doc updates in the same commit (repo convention): PLAN_NOTIFICATIONS
    §0 (un-CUT `quiz_closed`), §1 matrix row, §3.1 payload whitelist,
    §3.4 dedupe-key table, D10 note.
- UI: Close button on builder Questions-card header (next to Publish,
  quiz-builder-client.tsx:854-861) and on the results dashboard hero;
  rendered only when `status === "live"`. Reuses `lecturer.builder.closeQuiz`
  + `closing` + `statusClosed`; new keys go in BOTH locales and
  `npm run check:i18n` gates the commit. Confirm dialog: inline Radix
  `<Dialog>` destructive variant with cool-down guard (reset pattern) + a
  busy/disabled submit-lock so double-click yields ONE flip; copy states the
  honest straggler semantics (below): "Students already taking the quiz can
  submit what they have; they cannot answer further questions." After
  success: `router.refresh()`.
- Stragglers — explicit decisions (each verified against current SQL):
  1. **Submit-only grace.** `submit_session` has no status gate → an
     in-flight student can SUBMIT after close and scores normally.
     `answer_question` is ALREADY close-gated (0012:199-208) — no code
     change; the confirm-dialog copy must reflect that answering stops, not
     claim students "finish" freely.
  2. **Face verification freezes at close** (record_face_check requires the
     live-only view, 0021:332-335): a flagged student post-close cannot pass
     face unlock. ACCEPTED for v1: such sessions stay flagged pending
     lecturer review (results dashboard still shows them; lecturer reveals
     when satisfied or resets via reset_session, accepting IO-5 evidence
     loss). Documented here and in ARCHITECTURE.md at move-out.
  3. **New starts blocked free-of-charge:** `student_quiz_view` live-only
     removes the card from lists; `start_quiz_session` folds closed into
     `quiz_not_live` (0017:97-106) → 404. Defense-in-depth verify probe
     still required (view predicates drift across migrations).
  4. **Reload-after-close for an in-flight student → truthful 404** (play
     RSC queries `student_quiz_view`; row gone → `notFound()`,
     play/page.tsx:157-196). Accepted UX; pinned by test.

**Tests**
- Route tests (`close-route.test.ts` in
  `src/app/api/quizzes/[id]/__tests__/`, fake-supabase style):
  draft→409 `quiz_not_live`; live→200 `{quiz}` with `status:'closed'`
  persisted in the fake; closed→200 idempotent (via pre-check branch); 401
  / 403 (non-owner lecturer) / 404 (bad uuid) / 429 (rate limit via
  `_seedRateLimit`, asserted BEFORE the idempotent short-circuit) / 403
  CSRF each mapped; unknown update error → 503 `internal`.
  Add a per-file coverage key for the new route in `vitest.config.ts`
  (recent route additions each carry one; 60/60/60/70 mirroring the session
  routes is the consistent choice).
  NOTE the true concurrent-CAS race is NOT emulatable in the fake (its
  write seams error rather than no-op; guard-read and write hit the same
  table store) — it is covered by the verify probe below instead.
- Verify harness (`scripts/verify-quizzes.mjs`, next D-number), sequential
  guarded-update pattern (D24 precedent :446-458): guarded
  `.update({status}).eq('status','live')` from client A after client B
  closes → 0 rows updated, no exception, final status `closed`; plus
  live→closed allowed by trigger; closed→live/draft rejected
  (`closed_quiz_cannot_transition`); close preserves `results_revealed_at`;
  in-flight probe: active session survives close, `answer_question` →
  `quiz_not_live`, `submit_session` → completes + scores;
  `notify_quiz_closed` fires exactly once across double-close (dedupe holds).
- Unit probe: `record_face_check` on closed quiz → `quiz_not_live` (pins
  freeze decision).
- E2E: new `closeQuiz(page)` helper in `e2e/helpers.ts` (pattern:
  `revealQuiz` :584-595). Extend `e35-quiz-closed.spec.ts` as ordered serial
  tests: create → publish → UI Close (dialog appears; cancel keeps live;
  confirm flips chip) → student list hides quiz → `POST /api/sessions` →
  404 → republish → 409 `quiz_closed`; THEN the existing service-role flip
  assertions (skip-gate narrowed to those). Mid-session scenario: student
  starts, lecturer closes (service-role seam), student clicks an option →
  `quiz_not_live` toast path (existing mapping pinned at
  sessions-routes.test.ts:800-814 covers the API half), student submits →
  completes; student reloads play page → truthful 404. Stale-tab case:
  second lecturer context opened before close clicks Publish after the
  close → 409 surfaced inline.

---

## QC-2 · Closed-before-reveal recovery (HIGH, small)

**Problem:** Closing before revealing permanently strands assessment results.
The reveal route is live-only (`reveal/route.ts:54` 409 + `:67`
`.eq("status","live")`), the play RSC/end-screen read quiz metadata off the
live-only `student_quiz_view`, and PLAN_REVEAL_RESULTS §2/§11 declared
closed-recovery out of scope. But `reveal_once_only` (0012:57-62) only fires
on changing a non-null value — first-time reveal on closed is TRIGGER-LEGAL;
the lock is route + reachability, not the DB.

**Design sketch — both halves:**
1. **Recovery surface (DB + route):**
   - Relax `reveal/route.ts`: allowed for live OR closed. Pre-check becomes
     `status === "draft"` → 409 `quiz_not_revealable`; drop the
     `.eq("status","live")` term from the guarded UPDATE (the
     `.is("results_revealed_at", null)` guard carries one-way idempotency;
     `reveal_once_only` stays the backstop). Keep the practice-mode 409.
   - Student reachability for closed+revealed: score/is_correct flows ALREADY
     work via `student_session_view` / `student_answers_view` /
     `student_results` (none has a status term — verified). What's missing is
     QUIZ METADATA for the play/results pages, which join the live-only view.
     Add `student_closed_revealed_quiz_view` (security_barrier): columns
     identical to `student_quiz_view`, predicate
     `q.status='closed' and public.is_student_reveal_allowed(q.id)
      and c.archived_at is null`   -- archived-class parity with 0017/0028
     The play/end-screen pages read metadata from whichever view matches
     (closed-revealed falls back to the new view); closed-unrevealed keeps
     rendering the truthful 404/no-score paths. `resolve_question_image`
     already permits closed+revealed (0028:94-116) — no change.
   - Column secrecy unchanged: revealed-gated only; closed-unrevealed stays
     fully opaque; barrier views never leak beyond projections.
2. **Prevention (UI):** QC-1's close dialog counts completed-unrevealed
   sessions; if >0 show "N submitted but results aren't revealed —" with a
   **Reveal first, then close** primary CTA (calls reveal → then close; both
   idempotent/CAS-guarded so either ordering converges) and Close-anyway as
   secondary destructive. Lecturer retains the choice; dialog data comes
   from the dashboard payload (one count), not a new RPC if avoidable.

**Edge cases pinned explicitly:**
- Reveal racing close/auto-close: house-pattern concurrency probe (see
  Tests) asserts exactly-one `results_revealed_at` flip in either order —
  close→reveal (route relaxation) and reveal→close both converge to
  closed+revealed; `reveal_once_only` never fires (it only guards CHANGES to
  non-null values, and both writers guard `.is("results_revealed_at",null)`).
- Auto-reveal on closed quizzes already ships (0024 F8b) — untouched.
- Required doc updates (same commit): PLAN_REVEAL_RESULTS §2 ("only offered
  while LIVE"), §9 (dashboard button visibility), §10 (route contract),
  §11 (out-of-scope note), AND the §8 correction (flip predicate no longer
  `status='live'` — already superseded by 0024 F8b regardless of QC-2).
  Cross-ref: SQ-2's closed-quiz cards consume this same view family.

**Tests**
- SQL/verify probes (`verify:results` + `verify:quizzes`):
  closed+unrevealed → `student_results` `not_revealed`, image resolution
  denies, new view excludes the quiz; closed+revealed → `student_results`
  breakdown complete, score flows via both sealed views, new view exposes
  metadata; archived-class closed+revealed → excluded everywhere;
  `student_quiz_view` remains live-only EVEN when revealed (per-surface
  visibility, not global); re-reveal attempt → trigger raises
  `reveal_once_only`.
- Concurrency probe (verify-results.mjs:337-355 two-fire pattern): manual
  reveal vs manual close, and reveal vs submit_session auto-flip — assert
  convergent terminal states, typed losers, zero exceptions leaked.
- Route tests (UPDATE EXISTING — one current ID BREAKS):
  `reveal-routes.test.ts:65-70` "rejects revealing a non-live quiz" (closed
  fixture) MUST FLIP to: closed → 200 `{revealed:true}`; draft → 409
  `quiz_not_revealable`; second click → `{already:true}`. Widen
  `lecturerCtx` status type cast (:24) to include `"closed"`. Rename
  "reveals only when live" (:72-76) to its new invariant. Non-owner → 404
  no-oracle unchanged. Face-verify closed gate untouched
  (face-routes.test.ts:642-648 stays green — QC-2 must not touch it).
- i18n: dialog copy + student-facing strings in en/ms;
  `npm run check:i18n` in the same commit.
- E2E: close unrevealed → dialog offers reveal-first → confirm → completing
  student sees score+breakdown; close-anyway → student sees truthful
  pending state → lecturer reveals later from dashboard → results reachable
  via direct session URL / SQ-2 entry point once it lands.

---

## QC-3 · Availability windows (`opens_at` / `closes_at`) (HIGH)

**Problem:** No scheduling concept anywhere (verified: no scheduling column
exists in any migration). Published quizzes run indefinitely; lecturers must
manually publish/close (QC-1 gap). Blocks deadline UX (SQ-1 consumes these
columns read-only) and reminder notifications (PLAN_NOTIFICATIONS defers
`quiz_reminder` pending scheduler infra).

**Core visibility decision (resolves the SQ-1 contradiction and the
in-flight-grace hole together):** the `student_quiz_view` WHERE predicate is
NOT extended with window terms. Window-out quizzes REMAIN VISIBLE with their
window columns projected; only NEW SESSION STARTS are gated by the RPC.
Reasons: (a) SQ-1 verbatim needs past-window-grey and "Upcoming" strip —
both impossible if the view filters windows out; (b) filtering the view
would yank the play page out from under an in-flight session at `closes_at`
(reload → 404) purely due to cron lag; (c) start-gating is airtight at the
RPC boundary without any cron dependency. Closing (status='closed', QC-1/
cron) is what removes a quiz from student lists — windows only control
STARTS and are displayed as chips/deadlines.

**Design sketch**
- **Migration 0030** (shared with QC-1, or 0031 if QC-1 landed first —
  whichever item ships second absorbs its bits into the higher number):
  - `alter table quizzes add opens_at timestamptz, add closes_at
    timestamptz;`
  - CHECK: `closes_at is null or opens_at is null or closes_at > opens_at`.
    Both nullable — windowless manual publish/close stays valid forever.
  - **Edit-lock integration:** `opens_at/closes_at/max_attempts` are NOT
    added to the `quiz_not_draft_edit` frozen-field list (0016:33-42) —
    scheduling is deliberate live-quiz management. Redefine
    `quiz_status_transition` carrying the FULL 0016 body forward verbatim
    (including the same-status advisory-lock close-check, 0016:44-54) plus a
    comment pinning why window fields sit outside the freeze.
  - **`answer_question` gains the only new runtime window gate** (final def
    `0012_results_reveal.sql` — redefined again here): after the existing
    live checks, reject when
    `q.closes_at is not null and clock_timestamp() >= q.closes_at` →
    error `quiz_window_closed` (use `clock_timestamp()` per house timer
    convention, 0008:362-377). This BOUNDS in-flight answering on untimed
    quizzes (`time_limit_sec is null` would otherwise answer forever past a
    deadline when pg_cron is absent/best-effort). Dominance: the gate sits
    BEFORE the existing time-limit check in the function body, so a timed
    quiz past both deadlines surfaces `quiz_window_closed` first — terminal
    either way; pin the choice in a test (or move the gate after the timer
    if `time_expired` must win). **Route mapping REQUIRED or students get
    503s:** `answer/route.ts:92-114` falls through unknown codes to
    `internalError` — map `quiz_window_closed` → 409 (schedule state, not
    identity — same family as `quiz_not_live`) plus the client dead-screen
    branch mirroring the existing `quiz_not_live` toast path; pinned by a
    `sessions-routes.test.ts` case.
  - `submit_session` stays status-free and window-free (grace = submit-only,
    consistent with QC-1 decision 1).
  - Zod: extend `UpdateQuizSchema` / `CreateQuizSchema`
    (`src/lib/quizzes/validation.ts:129,145`) with nullable datetime fields
    + `superRefine` cross-field `closes_at > opens_at`; mass-assignment
    allow-list must admit ONLY these fields — `status` stays stripped.
  - PATCH route (`api/quizzes/[id]/route.ts`): allow-listed window fields
    bypass the blanket `notDraft()` 409 when the diff contains nothing else;
    title/mode/time-limit on a live quiz still 409 (field-scoped bypass,
    keeping quizzes-routes.test.ts:550-568 green). Closed-quiz window PATCH
    → also allowed (harmless: quiz unreachable by students; trigger doesn't
    block since fields aren't frozen) — pinned by test so the behavior is
    chosen, not accidental.
  - `start_quiz_session` (0017 redefined): window checks inserted AFTER the
    enrollment check (NOT before — putting them before enrollment hands
    unenrolled probers a 409-vs-404 existence/window oracle; the existing
    no-oracle folding of `quiz_not_live`/`not_enrolled` to 404 at
    sessions/route.ts:75-77 depends on failing identity checks first).
    Distinct typed errors for ENROLLED students:
    `quiz_not_open` (before opens_at) / `quiz_window_closed` (at-or-after
    closes_at) → sessions route maps both to **409** (they are schedule
    state, not identity; enrolled callers legitimately see them, and SQ-1
    copy requires distinguishing messages).
  - `student_quiz_view`: ADD `opens_at, closes_at` to the projection
    (SQ-1 renders chips; QC never filters on them here).
  - **Auto-close pg_cron** (pattern 0019:809-816): job
    `innovision-quiz-autoclose`, every 5 min:
    `update quizzes set status='closed' where status='live' and closes_at
    is not null and closes_at <= clock_timestamp();` Best-effort; the RPC
    start-gate guarantees correctness if cron lags/vanishes. The flip fires
    `notify_quiz_closed` (QC-1 trigger) with natural dedupe — 0 rows on
    retry, no duplicate notifications. In-flight students keep submitting
    under QC-1's submit-only grace until they finish.
  - **Optional `quiz_reminder`** (only if cron lands reliably; Phase-B
    energy): same cron run inserts per eligible enrolled student at
    `closes_at - interval '24h'`; dedupe_key carries the WINDOW EPOCH —
    `'quiz_reminder:' || quiz_id || ':' || student_id || ':' ||
    extract(epoch from closes_at)::bigint` — so a moved deadline re-reminds
    (house epoch-key pattern, 0022:282-284) instead of being permanently
    silenced by the recipient-dedupe constraint (0022:48-51).
  - UI: datetime inputs in EditQuizDialog + create form; list-card window
    chips for lecturers; deadline chips for students are SQ-1's consumption
    of the newly projected columns. Parse/format lives in a new
    `src/lib/format/window.ts` helper (input string ⇄ instant ⇄ localized
    display, `Asia/Kuala_Lumpur` convention) so the browser-tz conversion
    edge is UNIT-testable (node Vitest env can't execute the client
    component).
  - Store timestamptz (UTC instants); convert once at the client boundary;
    DB CHECK compares instants, never wall-clock strings.

**Tests**
- Migration probes (`verify:quizzes`): CHECK rejects `closes_at <=
  opens_at` when both set; single-NULL window accepted; gen:types run
  regenerates `database.ts` (CI drift gate).
- Start-gate matrix (verify + fake-supabase — REQUIRES extending the
  `_startQuizSession` stub (fake-supabase.ts:470-532, currently live-check
  only) and `makeOwnerContext` seeding (:1245-1257), per the file's
  lockstep discipline header): `quiz_not_open` before window;
  `quiz_window_closed` at/after close — seeded RELATIVELY
  (`now() - interval '1 second'` etc.; absolute boundary equality is
  untestable, Postgres `now()` is transaction-stamped and unpinnable);
  NULL-window unaffected; window-after-enrollment ORDERING probed by an
  unenrolled caller against a windowed quiz → must fold to 404, never
  expose `quiz_not_open`.
- `answer_question` close-boundary probe: unanswered question after
  `closes_at` → `quiz_window_closed` (relative seed); completed submission
  afterwards still succeeds (grace preserved).
- Cron probe: invoke the autoclose function directly — closes live windowed
  quizzes, skips NULL-window/draft/closed, idempotent on re-run. (pg_cron
  SCHEDULE itself stays cron-owned — the E2E/verify layer triggers the
  function, mirroring how 0019's prune is exercised.)
- Route tests: field-scoped PATCH bypass (windows on live/closed → 200;
  title on live → 409 `quiz_not_draft`); invalid window → 400
  `invalid_body`; mass-assignment (`I-M18` extension): `opens_at` admitted,
  `status` stripped; sessions route maps the two new codes to 409.
- Unit coverage: `src/lib/format/window.ts` — add `src/lib/format/**` to
  vitest `coverage.include` (currently absent — the file would otherwise be
  ungated) + threshold entry (~80/70); cases include a KL-tz and a
  non-KL-tz `Intl` environment pin.
- E2E: lecturer creates windowed quiz (future opens_at) → student sees
  upcoming/locked chip, start → 409 copy; window edited to present → start
  succeeds; closes_at passes → student still SEES the card (grey/past
  state per SQ-1) but start → 409 and answers hard-stop; autoclose function
  triggered via service-role seam → card disappears (cron lag-safe
  assertion); `page.clock` fakes BROWSER time only where relevant — never
  DB predicates.
- Unlikely scenarios pinned: lecturer extends `closes_at` after passing →
  starts re-open (documented consequence); reminder does NOT refire for the
  old epoch (key includes closes_at epoch); reminder DOES refire after
  deadline moved (new epoch).

---

## QC-4 · Retake policy / attempts > 1 (MEDIUM, large — schedule last)

**Problem:** `one_assessment_attempt` partial unique index
(`0008_sessions.sql:54-55`) = one *current* assessment attempt per student
per quiz. Only remedy is lecturer `reset_session` (0022:497-574) which
DELETEs the row — cascading away answers, face_checks, AND
`session_advisories`/`incident_clips` (evidence loss; IO-5).

**Design sketch**
- New per-quiz field `max_attempts int not null default 1 check
  (max_attempts between 1 and 3)`; like windows, editable on live quizzes
  (outside the 0016 edit-freeze list, comment-pinned). Lowering below a
  student's completed-count is allowed but never deletes anything —
  enforcement happens at START time only.
- Sessions gain `attempt int not null default 1`. Index swap:
  drop `one_assessment_attempt`; add unique `(quiz_id, student_id, attempt)
  where mode='assessment'` PLUS partial unique
  `(quiz_id, student_id) where mode='assessment' and status in
  ('active','paused','flagged')` — preserving the one-ACTIVE-attempt
  invariant across window edges.
- Representative attempt = LATEST completed (`order by started_at desc
  limit 1`, matching `student_results` 0028:210-214 and practice
  precedent). NOT best-score — decided. De-scope option (recommended v1):
  `allow_retake boolean not null default false` with fixed
  max-2-attempts/latest-counts semantics (avoid the word "best-of":
  highest-score-wins is explicitly NOT the policy) — smaller blast radius;
  defer configurability.
- `start_quiz_session` changes: for assessment with a completed history —
  spawn new attempt (`attempt = max(existing)+1`) only when
  `allow_retake/max_attempts` permits; resume-or-`already_attempted`
  pre-checks must select among NON-completed rows specifically
  (`status in ('active','paused','flagged')`), never an unfiltered pick.
  **The `unique_violation` handler (0017:169-182) MUST be rewritten the
  same way**: its re-select currently takes an arbitrary row with no
  status filter or ordering — with multiple attempts it can return the
  COMPLETED attempt-1 row and hand the client a dead session id. Also
  extend the `quiz_start` advisory lock (currently practice-only,
  0017:116-119) to cover assessment spawn, or explicitly document that the
  pair of partial indexes alone closes the race (indexes make the loser
  fail loudly — acceptable, but SAY which invariant you rely on).
- **Full consumer inventory REQUIRED at pre-flight** (every surface assuming
  one-row-per-(quiz,student)):
  - `submit_session` auto-reveal "all done" predicate (0024:358-366): fine
    structurally (active/paused/flagged still block), BUT between a
    completed attempt and its unstarted retake NOTHING blocks → auto-reveal
    fires EARLY. Policy decision required at pre-flight: either accept
    early-reveal (retake-after-reveal then shows scores — pedagogically odd
    for assessments) or extend the predicate to ALSO stay unfinished while
    a recently-completed student (≤2h, matching the staleness idiom) has
    retake budget left. Write the chosen SQL down before coding.
  - `quiz_completed_all` digest trigger (0022:216-222) counts completed
    SESSION ROWS vs enrollment — a student's SECOND attempt alone satisfies
    the inequality. Must become `count(distinct student_id)`.
  - `student_results`/end-screen (latest-completed already well-defined);
    sealed views (pass-through, multiplicity per student); lecturer
    dashboard rows (attempt # chip); Excel export — EXECUTED doc
    PLAN_MATRIC_EXCEL_EXPORT §2.3 assumes ≤1 assessment session per student
    and must be updated in the same change; RA-1 gradebook (already hedges
    "if QC-4 ships").
  - Stale-paused stranding: QC-3 makes windows live-editable; a `paused`
    session from a PREVIOUS expired window sits behind the one-active index
    and its timer is already blown (every answer → `time_expired`) —
    remedy-free except reset_session (destroys evidence). Policy required:
    EITHER start-spawn treats a non-completed session predating a PASSED
    `closes_at` as void-completable (mark `completed`, unscored or scored-
    as-is, freeing the slot) OR reset-before-retake gets a documented,
    evidence-preserving variant. Decide at pre-flight; the naive
    "just extend the unique index" silently locks these students out.
- Integrity timeline stays per-session (each attempt its own chain);
  `verify_nonce` per session is naturally per-attempt.

**Tests**
- Index probes (verify): two completed attempts coexist; concurrent second
  ACTIVE attempt rejected (`unique_violation` → `already_attempted` mapping
  intact); attempt column strictly increments; practice untouched.
- Regression guard: default config (`allow_retake=false` / max_attempts=1)
  behaves byte-identically to today across ALL session route test files
  (sessions/routes/results/face suites) — the swap must be invisible until
  enabled.
- Violation-handler unit pins: duplicate insert race returns the
  RESUMABLE (non-completed) session id, never a completed one.
- Auto-reveal under retakes: per the pre-flight policy decision above —
  probe each side of the chosen predicate; reset-then-resubmit never
  re-fires reveal (existing 0012-era probe re-run).
- `quiz_completed_all`: seed student with 2 attempts → digest fires once,
  based on distinct students.
- Stale-paused matrix: expired-window paused session + retake permitted →
  chosen policy behavior asserted (slot freed, no evidence destroyed).
- Representative-selection: seed 2 completed attempts → `student_results`
  breakdown/export row = latest; lecturer dashboard shows both with attempt
  chips.
- E2E: attempt 1 complete → Retake CTA appears → attempt 2 → both rows
  visible; disabled-retake quiz shows none.

---

## Pre-flight log

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- 2026-08-28: QC-4 reconciled against working tree @ HEAD (post-0030/0031);
  migration will be **0032**. Verified drift since the 2026-08-27 audit:
  start_quiz_session's FINAL def is now 0030:136-271 (window gating carried
  forward — redefinition must carry the FULL 0030 body, incl. quiz_not_open/
  quiz_window_closed AFTER enrollment); answer_question final def is
  0030:280-426 (closes_at gate carried forward — retake work must NOT strip
  it); submit_session final def remains 0024:260-422. unique_violation
  handler still re-selects without status/ordering (0030:248-257);
  assessment path still lockless (practice-only advisory lock 0030:191-194).
  one_assessment_attempt unchanged (0008:54-55; 0011 references only).
  fake-supabase: _startQuizSession at :470-543 (live+window checks,
  assessment one-attempt branch), makeOwnerContext :1259-1289 (no retake
  fields seeded — lockstep extension required). Student client already
  handles already_attempted with AND without session_id
  (student-quizzes-client.tsx:66-75) — resume vs completed notice both
  reachable. Export is ALREADY retake-safe: selectRepresentativeSessions
  (src/lib/results/export.ts:139-158) picks newest-wins per student and the
  export route orders started_at DESC — PLAN_MATRIC_EXCEL_EXPORT §2.3 needs
  only a doc note, no code change. student_results (0028:210-214) already
  latest-completed. lecturer_session_view final def 0021:196-207 (attempt
  column must be APPENDED last); ResultsSessionInput + derive.ts consume the
  view pass-through (attempt chip is UI-only additive). quiz_completed_all
  counts session ROWS (0022:216-232) — must become count(distinct
  student_id). Auto-reveal predicate (0024:358-366) unchanged.
  **Policy decisions (plan-required, recorded here):**
  1. Auto-reveal under retakes: EXTEND the predicate — while the
     JUST-SUBMITTING student still has retake budget remaining (completed
     assessment attempts < max_attempts when allow_retake), the quiz stays
     unrevealed (subject to the same ≤2h freshness idiom — once the
     student's completion goes stale, the quiz is reveal-eligible).
     Rationale: early-reveal then showing scores before a retake is
     pedagogically wrong for assessments; scoping to the SUBMITTER (not
     every enrolled student) prevents a non-retaking student from holding
     the quiz unrevealed forever. [AMENDED during implementation — the
     per-student-universal variant permanently blocked reveal whenever ANY
     student left budget unspent.]
  2. Stale-paused stranding: start-spawn treats a NON-COMPLETED assessment
     session (active/paused/flagged) whose quiz window has PASSED (closes_at
     not null and clock_timestamp() >= closes_at) as VOID — mark it
     completed (scored as-is), freeing the slot; evidence preserved (no
     delete). Rationale: its timer is blown (every answer → time_expired /
     quiz_window_closed) so the session is unrecoverable except by
     evidence-destroying reset; auto-voiding is the documented,
     evidence-preserving variant. UNCONDITIONAL (implementation refinement):
     budget is not consulted — a dead slot behind the one-active index is
     remedy-free regardless of retake config, and the spawn gate still
     returns quiz_window_closed (a passed window cannot birth a new
     attempt), so sealing only affects the stranded session's own state.
     [AMENDED during implementation — the budget-gated variant left the
     no-budget dead slot stranded, the exact outcome the decision rejected.]
  3. Config surface: de-scoped per plan recommendation — `allow_retake
     boolean not null default false` + fixed `max_attempts int not null
     default 1 check (max_attempts between 1 and 3)`, editable on live
     quizzes (outside the 0016 freeze list, comment-pinned in the 0032
     trigger redefinition). "best-of" explicitly NOT the policy:
     representative attempt = LATEST completed.
  Test seams: next D-number in verify-sessions is D52; verify-quizzes
  continues the QC-1/2/3 numbering with QC-4 probes. e2e helpers has no
  retake helper (createAssessmentQuizWithQuestions + service-role seam
  suffice for the retake journey).

- 2026-08-27: reconciled against working tree @ 446d387 (post-0029); next
  migration will be 0030. Verified: trigger final def is 0016 (not 0004);
  publish preamble + its rate-limit/idempotency-order quirk; reveal route
  live-only gate + guarded UPDATE; student_quiz_view live-only (0017);
  student_results/sealed views have NO status term (0012/0028);
  submit_session has NO status gate (0024 F8b); answer_question IS
  double-gated on live (0012:199-208); record_face_check gated via
  can_student_view_quiz (0021:332-335); no route writes 'closed';
  notification_type enum LACKS 'quiz_closed' (needs alter-type + full
  client inventory); closeQuiz i18n keys pre-staged (en.json:308);
  makeOwnerContext supports "closed"; fake write seams cannot emulate CAS
  races (verify-harness territory); no clock pinning in harnesses
  (relative-instant technique required); e35 seeds closed via service role;
  pg_cron pattern 0019; notify/trigger patterns 0022:116-140/:435-440;
  quiz_completed_all counts session rows (0022:216-222); start_violation
  handler picks arbitrary rows (0017:169-182) and assessment path has no
  advisory lock. Three-way review (security / test-architecture /
  doc-consistency) applied: BLOCKER enum gap, grace=submit-only reframing,
  QC-3 redesigned to start-gating + projected columns (resolves SQ-1 Upcoming/grey-state
  contradiction and in-flight unbounded-answering hole),
  window checks placed after enrollment check (oracle), archived-class term
  for closed-view, QC-2/QC-4 cross-doc update duties recorded
  (PLAN_REVEAL_RESULTS §2/§8/§9/§10/§11; PLAN_MATRIC_EXCEL_EXPORT §2.3;
  PLAN_NOTIFICATIONS §0/§1/§3.1/§3.4/D10). Note: ARCHITECTURE.md §7.4
  already advertises a close route — reconcile at move-out.

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

- 2026-08-27 (in-progress implementation): QC-1 + QC-2 + QC-3 implemented.
  Migration `0030_quiz_lifecycle_windows.sql` (windows + CHECK + index,
  `notification_type` gains `quiz_closed`, `notify_quiz_closed` trigger,
  `quiz_autoclose()` + pg_cron `innovision-quiz-autoclose` every 5 min,
  `start_quiz_session` window gating after enrollment,
  `answer_question` closes_at hard stop, `student_quiz_view` + window
  projection, `quiz_status_transition` full-0016 carry-forward with
  window-freeze pin). Migration `0031_closed_reveal_recovery.sql`
  (`student_closed_revealed_quiz_view` — QC-2's student reachability half).
  `npm run gen:types` run. New route `POST /api/quizzes/[id]/close`
  (CAS + re-fetch distinguishing concurrent close vs delete); reveal route
  relaxed to live-or-closed (draft → 409 `quiz_not_revealable`,
  CSRF-before-ratelimit order); PATCH windows-only bypass of the draft lock
  (field-scoped; `buildQuizUpdates` practice time_limit wipe proven inert by
  `NULL is distinct from NULL` + 0014 invariant); sessions route maps
  `quiz_not_open`/`quiz_window_closed` → 409; answer route maps
  `quiz_window_closed` → 409. UI: builder close button + confirm dialog
  (in-modal errors, cool-down, busy lock, unrevealed warning + reveal-first
  CTA — both dashboard AND builder), dashboard close + reveal-first CTA,
  edit dialog window datetime inputs (metadata fields disabled for
  non-draft; windows editable on any status; live quizzes get a settings
  entry via the window/schedule chip), create-form window inputs, window
  chip (`formatWindow`). Play client treats `quiz_window_closed` like
  time_expired (timeUp + auto-submit → submit-only grace is REACHABLE).
  Notifications client: `quiz_closed` type/copy/icon/link. i18n en+ms.
  Tests: close-route.test.ts (13), reveal-routes updated (closed → 200),
  sessions-routes window mappings (6 new), quizzes-routes PATCH windows (4),
  validation window cases (7), window.test.ts (12); fake-supabase window +
  live-gate stub lockstep.   verify-quizzes extended (QC-1/QC-2/QC-3 probes
  incl. CAS 0-row, unenrolled window-oracle fold, 3-col route payload,
  closed+revealed view matrix; 69/69 pass). e35 extended with an app-driven
  UI-close serial test + `closeQuiz` helper (dialog-scoped confirm selector,
  poll-based settle against UI-unmount races). NEW `e2e/
  e36-close-grace-and-reveal.spec.ts`: (1) mid-session close journey —
  student mid-quiz, lecturer closes, next answer dead-screens
  (`quiz_not_live` toast), API submit still succeeds (submit-only grace),
  completed session URL renders score via the QC-2 fallback; (2)
  reveal-first-then-close journey — close dialog warns "N submitted but
  results unrevealed", CTA reveals + closes, student's session URL shows
  score + breakdown via `student_closed_revealed_quiz_view`. The e36 spec
  caught and fixed a REAL product bug: the play RSC's questions guard ran
  before the completed-EndScreen branch, so a completed session on a closed
  quiz rendered "quiz has no questions" instead of its results (EndScreen
  branch reordered; `total` falls back to breakdown length). E2E verified:
  e35+e36 at repeat-each=2 with zero flakes (8/8).
  QC-4 NOT implemented (its own pre-flight inventory is mandatory first).
  Review rounds: 3 subagent rounds (security/SQL, adversarial/concurrency,
  verification sweep) — all HIGH/MED findings fixed. Known accepted edges
  (documented, not defects): closed+revealed quizzes are reachable via bell
  deep-link/direct URL only (list stays live-only by design; SQ-2 owns a
  list surface); a `results_revealed` bell item for a since-reset session
  falls back to the quiz list (cosmetic dead-end); live window-editing
  bypass is now UI-reachable via the schedule chip. ARCHITECTURE.md §7.4/
  §7.5/§7.9/§7.10 + §4 views table need the move-out doc-update commit.

- 2026-08-28: QC-4 implemented. Migration `0032_retake_policy.sql`:
  quizzes.`allow_retake` (default false) + `max_attempts` (default 1,
  CHECK 1..3) — deliberately OUTSIDE the edit-freeze list (0032's
  quiz_status_transition redefinition pins why, full-0030 carry-forward);
  quiz_sessions.`attempt` int default 1 + backfill; index swap
  `one_assessment_attempt` → `one_assessment_attempt_per_attempt`
  (unique quiz_id, student_id, attempt WHERE assessment) +
  `one_active_assessment_attempt` (unique quiz_id, student_id WHERE
  assessment AND status active/paused/flagged) — one-ACTIVE invariant
  preserved, completed attempts coexist under retakes.
  `start_quiz_session` redefinition (full-0030 carry-forward incl. window
  gating AFTER enrollment): assessment path now takes the per-(quiz,
  student) advisory lock; resume pre-check selects among NON-completed
  rows only; a stale non-completed session from a PASSED window is SEALED
  completed (unconditional — evidence preserved, spawn window-stopped;
  budget-gated variant rejected during implementation because a no-budget
  dead slot is the exact stranding the plan rejected); spawn computes
  attempt = max+1 under budget (completed count < max_attempts when
  allow_retake); unique_violation handler re-selects the RESUMABLE
  session with explicit ordering — never a completed row; the
  budget-exhausted branch carries the LATEST completed session_id
  (byte-identical legacy 0008 shape — the client lands on the completed
  EndScreen, e5's pinned journey; the no-id variant was corrected after
  the E2E gap audit caught it). Practice path unchanged (rejoin-or-insert,
  attempt=1 projected).
  `submit_session` redefinition: auto-reveal "all done" gains the
  retake-aware term — the SUBMITTING student's own budget (not every
  student's) holds the reveal within the existing 2h freshness window
  (per-student-universal variant rejected: a non-retaking student would
  hold the quiz unrevealed forever). `notify_session_terminal`
  redefinition: quiz_completed_all counts DISTINCT students (retake-safe
  digest). Views gain appended columns: student_quiz_view + allow_retake/
  max_attempts; student_session_view + attempt; lecturer_session_view +
  attempt (appended-last, Postgres order constraint). gen:types run.
  Routes: PATCH /api/quizzes/[id] accepts allowRetake/maxAttempts (retake
  fields join the windows-only live-quiz bypass, field-scoped);
  POST /api/classes/[id]/quizzes accepts them (assessment-only defaulting
  — practice force-defaults false/1 at the create boundary). Validation:
  QuizFieldsSchema + allowRetake/maxAttempts (Zod bounds mirror the DB
  CHECK; MAX_ATTEMPTS_MIN/MAX exported). UI: edit-dialog retake fieldset
  (assessment-only, live-editable, checkbox + 1-3 attempts stepper +
  helper copy), create-form retake row, results-dashboard attempt chip
  ("Attempt #N" when >1), student list copy ("Up to N attempts — latest
  counts"). i18n en+ms (7 keys × 2 locales + create-form 2 keys).
  `buildQuizUpdates` passes retake fields through (inert on practice —
  RPC reads them on the assessment path only); QuizInfo + QuizRow types
  extended; ResultsSessionInput/Row gain `attempt?`. Export: NO code
  change needed — selectRepresentativeSessions already implements
  latest-wins (verified); PLAN_MATRIC_EXCEL_EXPORT §2.3 doc updated to
  name the retake semantics explicitly.
  Tests: updates.test.ts U-M14..U-M17 (4), validation.test.ts retake
  cases (3), quizzes-routes QC-4 PATCH (4: live-bypass persisted,
  closed-bypass, field-scoped 409, out-of-range 400); fake-supabase
  lockstep (attempt on seeded rows, retake fields in makeOwnerContext).
  verify-sessions D52-D55 (43/43): D52 retake spawn/attempt-increment/
  budget-exhaustion/practice-untouched; D53 stale-sealing (passed window
  → completed + window-stopped; windowless keeps already_attempted);
  D54 submitter-scoped auto-reveal (budget outstanding → not revealed;
  final submit → reveal); D55 digest distinct-student counting (two
  attempts by one student don't fire; second distinct student fires
  exactly once). All other harnesses re-run green: quizzes 69/69,
  results 18/18, face 36/36, classes 36/36, student-quizzes 21/21,
  matric 15/15, media 32/32, security 3/3, class-archiving 17/17.
  Deviations from the original sketch (all recorded in the pre-flight
  log with reasons): auto-reveal scoped to the submitter's budget;
  stale-sealing unconditional (not budget-gated); representative
  attempt = latest completed (plan's recommendation adopted);
  `allow_retake` fixed-config de-scope adopted (no per-attempt config).
  ARCHITECTURE.md §7.5/§7.9/§7.10 + §4 views table updated in this
  change-set.

- 2026-08-28 (E2E gap audit + hardening): 3-subagent audit of the E2E
  suite against QC-1..4 (slices: close/reveal, windows/retakes,
  pre-existing-41-specs staleness). Real defects found & FIXED:
  (a) e35/e36's republish-poll burned the 30/hr publish rate budget
  (repeat-each shares the lecturer bucket) → settle now reads quiz
  status via the service-role DB; (b) createClass helper's /create/i
  selector was ambiguous vs the "Create a class" empty-state tile
  (strict-mode race) → exact match; (c) e38's global quiz_autoclose()
  RPC raced parallel repeat-each instances (it closes EVERY past-window
  quiz) → per-quiz seam flip, cron semantics stay verify-owned;
  (d) stale comments citing the dropped one_assessment_attempt index
  (helpers.ts, e13); (e) REAL UI BUG: results dashboard never rendered
  the attempt chip — the RSC projection omitted `attempt` (results/
  page.tsx) and derive.ts dropped it from row assembly; caught by e37.
  Coverage gaps FILLED: e37 retake journey (edit-dialog enable on live
  quiz, attempt-2 spawn, attempt chip, budget exhaustion → latest
  EndScreen redirect, retake copy flip); e38 window journey
  (create-form window inputs, not-open notice + 409, live edit-dialog
  opens_at pull, window-closed notice, terminal close hides card) +
  mid-session window close (answer 409 captured via waitForResponse
  fail-fast, auto-submit EndScreen, idempotent re-submit 409
  already_submitted with stored score — the ROUTE maps idempotent
  re-submits to 409, not 200, per submit/route.ts:76-86); e36 third
  test close-anyway→later-reveal (stranded 404 pinned per QC-1
  decision 4 — the closed+unrevealed session URL truthfully 404s,
  then the same URL renders score+breakdown after the dashboard
  reveal). Fail-fast discipline added per review: fail-fast
  editable/enabled assertions before clicks (no actionability-timeout
  stalls), waitForResponse for transient-observable contracts, seam
  read-back polls before provoking RPCs. All 4 lifecycle specs green
  at repeat-each 2 (16/16, zero flakes) + representative untouched
  specs re-run green (e5/e13/e15/e1b). Audit items ACCEPTED as
  documented-not-fixed: student window chips (SQ-1's owner), cancel
  path/stale-tab inline 409 (MED, client-only), violation-handler pin
  (harness-only; advisory lock makes the race near-unreachable),
  quiz_closed bell click-through (SQL + client inventory verified;
  bell timing is Realtime/poll-gated).
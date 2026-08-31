# Roadmap Plan — Student Quality of Life

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec.
>
> Domain: the student journey end to end — onboarding, visibility, failure
> states, small friction. Auditors verified every citation below against the
> code Aug 2026; re-verify at pre-flight (paths will drift).

---

## SQ-1 · Deadlines / upcoming visibility (HIGH — depends on QC-3 columns)

**Problem:** Zero deadline concept surfaced to students. New quizzes known
only via bell or page visits. QC-3 (`opens_at/closes_at`) is the producer of
this data.

**Design sketch**
- Consume `quizzes.opens_at/closes_at` (read-only in this domain) via
  `student_quiz_view` → add fields.
- Quiz cards: "Due Fri 14:00" chip (localized via Intl.DateTimeFormat with the
  established `Asia/Kuala_Lumpur` + locale-tag helper), sort-by-deadline
  default, amber "closing soon" (<24h) styling, grey "closed" state when past
  window but quiz still status-live (rare under cron lag only).
- Optional: "Upcoming" strip above list summarizing next 3 deadlines.

---

## SQ-2 · Results entry point on quiz cards (HIGH — ships with RA-7)

**Problem:** Completed/revealed assessments unreachable from quiz list —
students rely solely on transient bell item probing `/play/{sessionId}`
(src/components/notifications/notification-bell.tsx:207); notification rolls
out of the ~20-item window → results effectively gone from student UI forever.

**Design sketch (reconciled 2026-08-28 — see Pre-flight log)**
- Server-side join of latest completed session per visible quiz in
  `src/app/(student)/student/quizzes/page.tsx`: one extra `student_session_view`
  select (`id, quiz_id, status, score, attempt, started_at, submitted_at`)
  filtered `.in("quiz_id", quizIds)` + `.in("status", ["completed"])`,
  ordered `started_at DESC, id DESC` (same tie-break discipline as the
  export feed) — RLS = own sessions only, cheap. Pick latest attempt per
  quiz in memory.
- **Flagged sessions (pre-flight DECISION, aligned with RA-1):** flagged
  sessions are NOT eligible for the chip — filter is completed-only. A
  flagged student's card stays unchanged (they keep today's bell/play-RSC
  path); the gradebook (RA-1) still shows their score to the lecturer. The
  divergence is documented in both plans as intentional.
- **Important scope fact (review finding):** `student_quiz_view` is LIVE-only
  (`q.status = 'live'`, 0032_retake_policy.sql:653) — a quiz that closes
  disappears from the list entirely. The chip therefore exists only while the
  quiz is live; once closed, students reach results via the bell or a
  bookmarked `/play/{sessionId}` (closed+revealed recovery via
  `student_closed_revealed_quiz_view` on the play RSC, 0031). This is a
  deliberate v1 boundary: card chips cover live quizzes; post-close access is
  the play RSC's existing job.
- **Reveal gating (pre-flight DECISION):** the quiz list does NOT currently
  select `results_revealed_at` — ADD it to the `student_quiz_view` select
  (column already projected in the view since 0012/0030/0032; generated type
  at src/lib/types/database.ts:1178 — **no migration**). Card state:
  - no completed session, or an ACTIVE attempt exists (active attempt blocks
    a new start via the `one_active_assessment_attempt` partial index) →
    unchanged (Start/Resume card as today; an active retake attempt must
    shadow a completed attempt 1 — Resume wins over View results);
  - completed + `results_revealed_at` set (auto_reveal_on_complete sets the
    timestamp inside `submit_session`, 0032:491-499; single source of truth =
    the timestamp, never client-side math) → "Completed · View results"
    linking `/play/{sessionId}` (RSC at src/app/play/[sessionId]/page.tsx:245
    already renders the EndScreen for completed sessions — verified; score
    render stays server-gated via `student_results` + view reveal predicate);
  - completed + NOT revealed → "Completed · awaiting results" chip with
    `role="status"`, NOT a link (student EndScreen for unrevealed assessment
    is score-less anyway — linking adds nothing; avoids implying scores
    exist).
- Practice quizzes (`mode = 'practice'`) keep current behavior — no results
  chip (practice already shows its own end screen inline).
- i18n keys en+ms same commit — namespace is `student.quizzes.*` (there is NO
  top-level `quizzes` namespace; the client uses `useTranslations("student.quizzes")`,
  student-quizzes-client.tsx:42): `cardCompletedAwaiting`, `cardViewResults`
  in both src/messages/en.json and src/messages/ms.json.
- Accessibility: chip is a real `<Link>` with accessible name including quiz
  title; awaiting chip is text with `role="status"`, not a dead link.

**E2E matrix (e40-student-results-entry.spec.ts — e18 conventions ONLY
(e34 has NO fail-fast budget — do not copy it), FAIL-FAST per user
requirement: module-level `const fast = expect.configure({ timeout: 5_000 })`,
`testInfo.setTimeout(90_000)`, `test.skip(!LECTURER_INVITE_CODE, …)`, no
`networkidle`, no fixed `waitForTimeout` sleeps — use `expect.poll` with a
bounded timeout where polling is needed. A broken step fails in ~5s, not
after the global 15s × retries):**
  1. student completes UNTIMED quiz, lecturer reveals → quiz list card shows
     "View results" whose accessible name INCLUDES the quiz title
     (`getByRole("link", { name: new RegExp(quizTitle) })` — identical
     "View results" ×N links must not pass) → click lands on EndScreen WITH
     score visible;
  2. completed but NOT revealed → "awaiting results" chip with
     `role="status"`, NOT a link (assert no anchor role with that name);
     after lecturer reveals + list revisit (poll via `expect.poll`, bounded)
     → chip becomes link (transition case);
  3. auto-reveal-on-complete quiz, SINGLE-student class → link appears
     without any lecturer action (multi-student classes delay the flip until
     the last active session terminates — 0032:466-501; pin the
     single-student precondition);
  4. retake-allowed quiz attempted twice → card links to the attempt-2
     session; assert session-derived metadata on the EndScreen (submitted
     time/duration), not just score, since `student_results` is quiz-keyed
     and a wrong-attempt link could pass a score-only assertion;
  5. practice quiz completion → NO results chip (unchanged practice flow);
  6. student who never attempted → card unchanged (Start), no chip;
  7. retake quiz with completed attempt 1 + ACTIVE attempt 2 → card shows
     Resume/Start, and NO "View results" link (`toHaveCount(0)`) — an active
     attempt shadows the completed one;
  8. TIMED quiz expired by countdown (e10b choreography: auto-submit, no
     Finish click) → after reveal the card still becomes "View results" and
     renders the auto-submitted score;
  9. ms locale → chip copy renders in Malay (e31 convention: switch locale,
     assert localized string + no raw keys);
  10. flagged session (3 face-fails) → card shows NO chip at all (pinned
      decision; gradebook divergence documented in RA-1).

**Tests (unit/route):** page-level narrowing helper unit test (latest
completed session per quiz; `started_at DESC, id DESC` tie-break; active-
attempt shadowing) in `src/app/(student)/student/quizzes/page.test.ts` or
colocated lib module; no route changes, no migration → no SQL harness probe
(existing `verify:results` continues to cover the reveal predicate).

**Shared E2E helper additions (both specs need them; add to
e2e/helpers.ts first):** `completeQuiz(page, { answers })` returning the
session id (parse from `/play/[uuid]` URL, e36 pattern); `enableRetakes(
lecturerPage, quizId, maxAttempts)` (extract e37's settings-dialog flow);
auto-reveal toggle via lecturer-authenticated `request.patch` on
`/api/quizzes/[id]/reveal-settings`; `currentSessionId(page)` extraction;
`flagCurrentSession(page)` wrapping `setFaceVerifyMode` +
`waitForFlaggedOverlay`. Do NOT replicate `expectNoAnswerPost`'s fixed
`waitForTimeout` window — that pattern is forbidden by the fail-fast
requirement.

---

## SQ-3 · Fix practice "Try Again" (MEDIUM, tiny)

**Problem:** Practice-mode Try Again handler identical to Back-to-Quizzes
(`play-client.tsx:620–622`, `end-screen.tsx:122–126`). Shared-player's retry
works properly (`student-quiz/player-client.tsx handleRetry:185`).

**Fix sketch:** POST fresh session start inline and route into it (reuses
start RPC crash-safe rejoin semantics) OR relabel honestly if decided not
worth it — decide at pre-flight, do not leave misleading copy either way.

---

## SQ-4 · Class-card drill-down filtering (MEDIUM, small)

**Problem:** Every class card Links to `/student/quizzes` globally with no
filter (`student-classes-client.tsx:188–209`) — badge implies scoping that
doesn't exist.

**Design sketch**
- `?class=<id>` param support: server page validates membership (RLS provides)
  and filters view rows; removable filter chip rendered atop quiz list;
  hero stat tile links with same param.

---

## SQ-5 · Camera-permission differentiated errors (MEDIUM — pairs with AX-7)

> **Pre-flight reconciled 2026-08-29 @ 99a06a3:** Evidence verified with
> corrections. (a) AX-7's taxonomy UTIL lands in THIS batch (shared kernel —
> implemented here, AX-7 doc references it): new pure
> `classifyCameraFailure(err): CameraFailure` in `src/lib/vision/camera.ts`
> covering NotAllowedError (permission), NotFoundError/OverconstrainedError
> (no device), NotReadableError (device busy), SecurityError (insecure
> context), plus absence of `navigator.mediaDevices` — file today throws
> undifferentiated English strings (camera.ts:113). Pure + Node-testable;
> camera.test.ts's injected-navigator pattern extends directly. (b) PLUMBING
> correction: the plan cites `use-face-tracker.ts:196–230`, but boot-failure
> funneling actually happens via `onUnavailable` callbacks (lines :87, :120,
> :143, :158, :190, :228) which drop the error object — the util needs a
> thread: camera.ts throws typed `CameraFailureError`, use-face-tracker
> captures the LAST failure reason into a `failureReason` return field
> (defaulting to "unknown" for health-probe/timeout paths, which are NOT
> camera-permission failures and must NOT claim they are). (c) ENROLL SURFACE:
> plan said "enroll page" — actual file is
> `src/app/(student)/student/face/enroll/face-enroll-client.tsx`; generic
> panel at :421–432 (`statusUnavailable` + retry) gains a classified variant
> with per-cause copy + browser-settings hint (NotAllowedError) and a
> "raise hand / continue click-first" reassurance. (d) ASSESSMENT SURFACE:
> faint chip confirmed at face-verifier.tsx:73–84 (`offlineChip`) — replaced
> with a clearer degraded banner (non-blocking, role=status, dismissible
> details) naming the cause; the face-unavailable REPORT to the lecturer
> (`/api/sessions/[id]/face-unavailable`, play-client.tsx:226–234) is
> UNCHANGED — classification is student-facing copy only, no RPC/payload
> changes. (e) All copy en/ms in the same commit.

**Problem:** All tracker boot failures collapse to generic unavailable
(`use-face-tracker.ts:196–230`, enroll equivalent); browser-API rejection
names discarded. Blocked-camera students retry forever.

**Design sketch (shared implementation lives with AX-7's camera util work;
this item is the student-flow surface)**
- Enroll page: distinct panels for permission-denied (with per-browser site-
  settings hint copy) vs no-device vs insecure-context.
- During assessment: degraded-proctoring banner replacing today's faint chip
  (`face-verifier.tsx:77`) so students know face checks are failing + to raise
  hand to invigilator.
- All copy i18n'd en/ms both.

---

## SQ-6 · Unload guard during timed assessments (LOW-MED)

**Problem:** No `beforeunload` anywhere; accidental tab close near deadline
can cost an exam.

**Design sketch:** scoped listener active while phase === question && timed:
standard confirm-on-navigate-away string; must NOT trigger on SPA answer/verify
fetches (those are fetch API — unaffected natively). Test via E2E dialog
dismiss path on Chrome.

---

## SQ-7 · First-login onboarding checklist (MEDIUM)

**Problem:** Post-registration = raw empty states; face enrollment discovered
worst-case mid-exam as blocking redirect (`face-gate.tsx:86`).

**Design sketch**
- Persistent dismissible card atop `/student/classes`: Join a class → Set up
  your face → Try a practice quiz, steps auto-checking off derived from real
  state (enrollments count, profiles.face consent/enrollment, practice exists).
- Persist dismissal locally (or profile field if trivial) until all complete.

---

## SQ-8 · Enrollment pre-flight guidance (LOW-MED, pairs AX-14)

Problem/sketch as audit finding #14: checklist card BEFORE Start button
(lighting, duration ~30s, why 3 angles); remove dead hardcoded EN fallbacks.

## SQ-9 · Keyboard shortcuts in click-first player (LOW)

Digits 1–5/A–E map to options; Enter advances feedback. Global keydown owner =
PlayClient; ignore while gesture overlay holds focus; announce mapping hint
subtly once. Mirrors finger glyphs already displayed.

## SQ-10 · Misc student fixes bundle (LOW, batch together)

- Hero subtitle duplicated verbatim (`my-quizzes-client.tsx:152–154`) — add
  distinct description key en/ms.
- Dead-end error panels get Reload buttons (`load-state.tsx`, play errorPanel
  :304) — small client island.
- Stale-card start 404 gets specific "quiz no longer available" toast + list
  refresh instead of `errorGeneric` (`student-quizzes-client.tsx:78–81`).
- Shared-link login context notice (`?message=shared-quiz` param pattern).
- Offline banner via online/offline events + single auto-retry of last
  idempotent failed answer (assessment answers are documented idempotent/
  retry-safe).
- Progress dots strip in HUD (passive answered-state markers).

## Pre-flight log

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- 2026-08-31: SQ-3 + SQ-1 + SQ-4 reconciled against the current main (post
  QT-1, 0f8f6f1); implemented same day. Corrections: play client lives at
  src/components/quiz/play-client.tsx (try-again handlers at :737–744, not
  :620–622); the shared player's handleRetry (student-quiz/player-client.tsx
  :185) is a STATELESS reset, NOT a template for session retry — the real fix
  POSTs /api/sessions (practice rejoin select matches active/paused only,
  0032:182–187, so a completed attempt yields a fresh 201). No migration
  (0038 taken by AU-2); start route untouched. Dead-end root cause pinned:
  all-answered resume seeds initialIndex=-1 → feedback on Q1 → Next strands
  on Q2's question phase (selectOption early-return :342, Confirm requires
  !answered :893, Next requires feedback :917); fix = allAnswered feedback
  button acts as Finish→submitNow. e45:216/:599 PINNED the broken Try Again
  (asserted /student/quizzes) and were updated by this change. SQ-1/SQ-4: NO
  migration — student_quiz_view already projects opens_at/closes_at/class_id
  (0034:35-38); page select extended, sort+filter extracted to pure
  list-order.ts (unit-pinned); ZERO RSC searchParams precedent existed —
  pattern established here (Next 15 async searchParams, in-memory filter,
  invalid id → empty list, RLS backstops); formatDue added to
  src/lib/format/window.ts (weekday variant of the house formatter); on-screen
  numerals mean copy is "Due {date}" (Intl weekday+date+time, ms-MY/en-US).
  e46 added (fail-fast e18 convention).

- 2026-08-29: SQ-5 reconciled against 99a06a3; no migration needed; scope
  refined per the reconciled block above (taxonomy util lands here as the
  AX-7 shared kernel; onUnavailable error-drop plumbing corrected; surfaces
  pinned to face-enroll-client.tsx:421 and face-verifier.tsx:73; lecturer
  face-unavailable report intentionally UNCHANGED).
- 2026-08-28: reconciled against d1cfcb9 (post AU-1); SQ-2 pre-flight DONE —
  no migration needed (results_revealed_at already projected in
  student_quiz_view; generated type at src/lib/types/database.ts:1178 — the
  earlier :543 citation was the quizzes TABLE row, corrected); verified
  notification-bell path is src/components/notifications/notification-bell.tsx
  (bell href line 207) and /play/[sessionId] RSC renders completed-session
  EndScreen at src/app/play/[sessionId]/page.tsx:245; quiz list page is
  src/app/(student)/student/quizzes/page.tsx (student_quiz_view select today
  lacks results_revealed_at — add to select, not schema); i18n namespace
  corrected to student.quizzes.* (no top-level quizzes namespace exists);
  student_quiz_view is LIVE-only (0032:653) → closed quizzes leave the list,
  so card chips cover live quizzes only — voided the original closed-quiz E2E
  cases and replaced with active-attempt shadowing, timer auto-submit, a11y
  name, and flagged-session cases; RA-7 ships in the same change; E2E
  fail-fast convention pinned (e18 pattern ONLY — e34 has no budget; 5s
  expect, 90s test timeout, skip-without-invite-code, no fixed sleeps) per
  user requirement.

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

- **2026-08-28 — SQ-2 (results entry point on quiz cards) SHIPPED** (as
  RA-7's student-side design; ships together with RA-1 in RESULTS_ANALYTICS).
  No migration (0033 remains the next number).
  - What shipped: `src/app/(student)/student/quizzes/page.tsx` adds one
    `student_session_view` read (completed sessions of the visible quiz ids,
    `started_at DESC`) and `results_revealed_at` to the `student_quiz_view`
    select; latest completed session per quiz picked in memory (first-wins
    under the DESC feed).
  - Card states (student-quizzes-client.tsx): completed + revealed →
    "View results" `<Link>` to `/play/{sessionId}`, accessible name includes
    the quiz title; completed + not revealed → `role="status"` "Completed ·
    awaiting results" chip, not a link; never-attempted/practice/active-
    attempt cards unchanged. Flagged sessions are NOT chip-eligible
    (documented divergence — RA-1 gradebook shows their scores).
  - i18n: `student.quizzes.cardCompletedAwaiting` / `cardViewResults` in
    en+ms.
  - Deviations: original plan cited SQ-3 as the design owner (wrong — fixed
    at pre-flight to SQ-2); closed-quiz chip behavior deliberately out of
    scope (student_quiz_view is live-only; closed-quiz access stays with the
    bell/play RSC via 0031 recovery — documented in the design section).
  - Tests: E2E `e40-student-results-entry.spec.ts` (2 tests: reveal
    transition + retake/awaiting coexistence card contract), fail-fast e18
    convention; shared helpers added to `e2e/helpers.ts` (`completeQuiz` by
    option text, `startQuizByTitle`, `currentSessionId`,
    `configureRetakesOnCreate`, `setAutoReveal`, `flagCurrentSession`,
    `loadWorkbook` — some reserved for later specs).

Note: SQ-1, SQ-3..SQ-10 remain PLANNED — this plan does NOT move out until
the whole domain ships (roadmap README Step 3).

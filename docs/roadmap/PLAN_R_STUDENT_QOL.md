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

## SQ-2 · Results entry point on quiz cards (HIGH)

**Problem:** Completed/revealed assessments unreachable from quiz list —
students rely solely on transient bell item probing `/play/{sessionId}`
(notification-bell.tsx:196); notification rolls out of the ~20-item window →
results effectively gone from student UI forever.

**Design sketch**
- Server-side join of latest completed session per visible quiz in
  `student/quizzes/page.tsx` query (one extra select against sessions of those
  quiz ids under RLS = own sessions — cheap).
- Card state suffixes: "Completed · awaiting results" / "Completed · View
  results" linking into session EndScreen/review (reuse existing result views'
  reveal predicates; never render score client-side that server didn't already
  gate).

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

- (none yet)

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

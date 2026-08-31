# Roadmap Plan — Results, Analytics & Reporting

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec.
>
> Domain: how lecturers consume outcomes — aggregate views, analytics, exports,
> dashboard interactivity. Builds on PLAN_MATRIC_EXCEL_EXPORT.md (xlsx model,
> roster join, matric uniqueness 0027) and Phase-8 dashboard.

---

## RA-1 · Cross-quiz class gradebook (HIGH)

**Problem:** Single export is per-quiz xlsx (`GET /api/quizzes/[id]/export`,
`src/lib/results/export.ts`). No aggregated student × quiz matrix; no cumulative %
anywhere. End-of-term mark submission requires merging N workbooks by hand.

**Design sketch (reconciled 2026-08-28 — see Pre-flight log)**
- Pure-read feature (no mutation surface — lowest risk class of feature):
  RSC page `src/app/(lecturer)/lecturer/classes/[id]/gradebook/page.tsx`
  (route-group `(lecturer)` layout, sibling of `[id]/page.tsx`), rows = enrolled
  students (join `student_roster_view` via `getClassRoster`, honoring
  ROSTER_LIMIT=100 at `src/lib/classes/roster.ts:30`), columns = quizzes of the
  class (limit 50, newest-last presentation order = created_at ASC for a
  chronological mark-sheet).
- Owner guard: replicate `classes/[id]/page.tsx:31-43` — direct `classes`
  select with `.eq("lecturer_id", user.id)` + `.maybeSingle()` → `notFound()`;
  role-lecturer redirect first (lines 27-29). No new RPC needed.
- Cell source: `lecturer_session_view` rows for the class's quiz ids
  (`.in("quiz_id", ids)`), ONE representative session per (student, quiz) using
  the SAME policy as the export (`selectRepresentativeSessions` — review found
  it module-private; **export it** from `src/lib/results/export.ts:139` for
  reuse + unit tests). The "latest terminal wins" property is ORDER-DEPENDENT:
  the loop keeps the first terminal row, so the gradebook read/sort MUST
  replicate the export route's feed order `started_at DESC, id DESC`
  (api/quizzes/[id]/export/route.ts:120-121) — pin the tie-break or retake
  cells are nondeterministic. Handles QC-4 multiple attempts (sessions carry
  `attempt` since 0032) without new SQL.
- **No migration.** All required reads already exist: `lecturer_session_view`
  (0032 projection incl. `score`, `attempt`), `student_roster_view`, `quizzes`,
  `questions`. Next migration number stays 0033 for whichever item lands first.
- Question counts per quiz (cell percent + column header "score/total"):
  one `questions` select of `quiz_id` only, grouped in memory (≤50 quizzes ×
  question count, hard `.limit(5_000)`).
- **Reveal-visibility policy (pre-flight DECISION):** show scores regardless of
  reveal state (lecturers already see the full matrix in the per-quiz dashboard
  regardless of reveal, ARCHITECTURE §7.9) but mark each COLUMN with an
  "unrevealed" dot/label when `quizzes.results_revealed_at IS NULL` so the
  lecturer knows what students can't see yet. `results_revealed_at` is already
  on `quizzes` (0012) — project it in the quiz select.
- **Column policy (pre-flight DECISION):** columns = **published
  (`status != 'draft'`) ASSESSMENT-mode quizzes only** — drafts are junk
  columns (0 sessions, misleading unrevealed dot) and practice quizzes are
  always-revealed self-study, not mark-submission data. Class-detail fetches
  up to 200 quizzes (classes/[id]/page.tsx:55-60); gradebook caps at 50
  columns from that same filtered list, chronological (created_at ASC), with
  a truncation flag when the filtered set exceeds 50.
- **Flagged sessions (pre-flight DECISION):** gradebook cells show the
  flagged session's score (representative-session policy treats flagged as
  terminal, same as export); the student-facing card (SQ-2) deliberately
  shows NO results chip for flagged sessions — flagged students keep today's
  UX (bell/play RSC). The surfaces are documented as intentionally divergent.
- Percent cells: `score / questionCount` rounded to whole %, null (em dash)
  when no representative session or quiz has 0 questions. Footer row =
  per-quiz class averages over attempted cells only; end column + summary
  row = per-student cumulative % over attempted quizzes (never dividing by
  zero quizzes — hide the column when the class has none).
- Export: `GET /api/classes/[id]/gradebook-export` — one workbook: summary
  sheet (matrix mirror) + one sheet per quiz reusing `buildExportModel` +
  `buildWorkbook` per quiz (session/answer reads per quiz reuse the export
  route's read shape: `lecturer_session_view` newest-first limit 200 +
  `lecturer_answers_view` in sessionIds limit 20k). Guard chain mirrors
  `api/quizzes/[id]/export/route.ts`: isUuid → class-owner check →
  `rateLimit` (same 10/min EXPORT_RATE semantics) → `checkSameOrigin` → typed
  errors, no admin client, RLS-only reads. Column cap: skip quizzes beyond 50
  with a truncation flag on the summary sheet (reuse `truncatedWarning` label
  pattern from `WorkbookLabels`). **Scale guard (review finding):** ≤50
  quizzes × (sessions + answers + xlsx build) is the heaviest request in the
  app — serialize quiz builds sequentially, and if the class exceeds 25
  assessment quizzes return the summary-sheet-only workbook with the
  truncation flag set (per-quiz sheets dropped), keeping the request bounded.
- Scale note: wide classes (20+ quizzes) need horizontal scroll — mind AX
  finding #10 (hidden scrollbars); sticky first column (student names) so
  labels never scroll away.
- i18n: new `Gradebook` namespace keys in BOTH en/ms same commit
  (`gradebook.title`, `gradebook.colCumulative`, `gradebook.footerAverage`,
  `gradebook.notAttempted`, `gradebook.unrevealed`, `gradebook.exportButton`,
  workbook labels reuse the existing `workbook.*` strings where identical).

**Tests:** pure model unit tests in `src/lib/results/gradebook.test.ts`
(Node-testable, no DB): representative-session policy incl. multiple attempts
AND the `started_at DESC, id DESC` tie-break, percent math incl. zero-question
quiz, cumulative-% math incl. 0 attempted, orphan session (session without
roster row) placement, column/row sorting; route test for `gradebook-export`
with `fake-supabase.ts` semantics (owner 404, rate-limit, header parity vs
matrix model); SQL harness probe is NOT needed (no new RPC/RLS — existing
views already verified by `verify:results`/`verify:matric`); E2E
`e39-gradebook.spec.ts` — **e18 conventions ONLY** (do NOT copy from e34,
which has no fail-fast budget): module-level
`const fast = expect.configure({ timeout: 5_000 })`, per-test
`testInfo.setTimeout(90_000)`, `test.skip(!LECTURER_INVITE_CODE, …)`, no
`networkidle`, no fixed `waitForTimeout` sleeps (use `expect.poll` with a
bounded timeout where polling is needed). Cases (expanded per E2E review):
  1. two published assessment quizzes, two students, both complete (one quiz
     revealed, one not) → matrix scores + cumulative % correct per student,
     unrevealed column labeled, export downloads a workbook whose sheets =
     Summary + 2 quiz sheets and whose summary cells match the on-screen
     matrix (ExcelJS parse, e18 pattern); rows = 2, no cross-contamination;
  2. never-attempted student renders em-dash row + Not started on export;
     **and** a student with only an abandoned/stale session
     (`staleActiveSession` helper) also renders em-dash — never a fabricated 0;
  3. retake-allowed quiz answered twice → cell shows the LATEST terminal
     attempt (attempt 2 score), not attempt 1 (`enableRetakes` helper, e37
     choreography);
  4. class with zero published quizzes → empty-state panel (no matrix, no
     export button), no crash; **zero-students class** → empty body, footer
     averages absent, no "NaN"/"Infinity" anywhere in page text;
  5. non-owner lecturer: direct-URL gradebook PAGE → notFound(), AND
     `GET /api/classes/[otherClassId]/gradebook-export` → uniform 404
     (no-oracle); student role hitting the page → redirect `/student/classes`;
  6. draft quiz and practice quiz exist in the class → NEITHER appears as a
     column (`toHaveCount(0)` on their titles in the header row);
  7. flagged student (3 face-fails, `waitForFlaggedOverlay`): gradebook cell
     SHOWS the flagged score; column unrevealed label logic unaffected;
  8. ms locale: switch locale (e31 cookie convention) → gradebook heading +
     em-dash/not-attempted copy localized; e31-style raw-key leak sweep over
     the gradebook URL passes;
  9. archived class (e26 choreography): gradebook still renders read-only and
     export still downloads (pins the dispute-audit posture).

---

## RA-2 · Item analysis on-dashboard (MEDIUM)

**Problem:** Choice-distribution and answer-key data already computed for xlsx
(`buildExportModel` sheets 2–3, `lib/results/export.ts`) but rendered nowhere
on-screen. Lecturer must download Excel to find the question that stumped the
class.

**Design sketch**
- Collapsible "Question insights" section on the results dashboard fed by the
  SAME model (compute server-side in `results/page.tsx`, pass serializable
  props — consistent with RSC convention).
- Per-question bar: % correct + per-option pick distribution (renders as tiny
  inline bars, not charts lib — no new dependency).
- Degenerate-question hint styling (e.g., <30% correct or distractor never
  picked) to draw the eye.

**Tests:** unit test for derived stats; snapshot-ish component test optional.

---

## RA-3 · Live-updating monitoring dashboard (MEDIUM)

**Problem:** Results/monitoring page static — derives staleness only at load
(`deriveSessionDisplayStatus`, `lib/results/derive.ts:261+`). During live exam
lecturer must manually reload. Notification bell polls independently but
doesn't refresh the page.

**Design sketch**
- Lightweight polling while any row displays `in_progress`: 30s
  `router.refresh()` inside a client island wrapper; pause when
  `document.hidden` (mirror bell poll state machine in
  `use-notifications.ts`); stop entirely when zero in-progress rows.
- Prefer polling over Realtime subscription initially (bell already chose
  polling fallback; realtime on quiz_sessions would be the v2 upgrade).
- Respect integrity posture: no audio/distracting alerts — subtle updated-at
  timestamp text.

**Tests:** component test with fake timers asserting refresh cadence +
visibility pause.

---

## RA-4 · Export additions (LOW but trivial: CSV now)

**Problem:** XLSX only; CSV was marked "can be added later from the same
model" in PLAN_MATRIC_EXCEL_EXPORT.md non-goals.

**Design sketch**
- `?format=csv` (or Accept-header) on existing export route reusing
  `buildExportModel`; RFC-4180 quoting, BOM for Excel opening UTF-8 matrics.
- Skip PDF report cards until requested (new dependency + CSP template work
  not justified yet).

**Tests:** route test for CSV contract + header parity with xlsx sheet 1.

---

## RA-5 · Filter/sort/search + "Needs attention" queue on results (MEDIUM)

**Problem:** Dashboard renders rows verbatim from comparator
(`assembleResultsRows`, `derive.ts`); no filter by DisplayStatus, no name
search/sort, no combined view of flagged + face_unavailable + high-advisory
students before remediation decisions.

**Design sketch**
- Client-side filtering only (rows already fully client-held, limit 200):
  filter tabs over DisplayStatus counts (reuse tile numbers), name search box,
  click-to-sort key columns.
- "Needs attention" toggle = union of flagged, face_unavailable, pending
  incident review — one click to triage.
- Preserve expand-per-row clip/timeline behavior during filtering.

**Tests:** component tests for filter/set logic.

---

## RA-6 · Not-attempted roster group on dashboard (MEDIUM)

**Problem:** Phase-8 D11 promised read-only "Not attempted" group; current
RSC passes only session rows (`results/page.tsx:244–256`); roster prop exists
for class-detail client but not results-dashboard-client. Only xlsx models
not-started rows (`export.ts:285–288`).

**Design sketch**
- Pass roster into results-dashboard-client; collapsed section listing
  enrolled-without-session names (+matric if CM roster work lands first).
- Cheap nudge: per-student nothing yet (no messaging channel exists until CM
  announcements) — display-only for v1, link target = class detail.

**Tests:** derive-test for roster-minus-sessions diff (unit-extractable).

---

## RA-7 · Per-quiz results entry point from quiz list (HIGH — pairs with STUDENT_QOL SQ-2)

**Problem:** Student-side gap. Completed/revealed assessments are unreachable
from the quiz list — students rely solely on transient bell items probing
`/play/{sessionId}` (`src/components/notifications/notification-bell.tsx:207`).
When the notification rolls out of the ~20-item window, results are effectively
gone from student UI forever. Lecturer-side entry is already fine (class
detail → quiz → results).

**Cross-reference (corrected at pre-flight):** the design lives in
STUDENT_QOL **SQ-2**, not SQ-3 (SQ-3 is the practice "Try Again" fix — the
original pointer here was wrong). RA-7 is implemented together with SQ-2 in
the same change; see `PLAN_R_STUDENT_QOL.md` §SQ-2 for the design and E2E
matrix. Nothing further lives here.

(Placeholder retained so sequencing table in roadmap README stays stable.)

---

## RA-8 · Session detail: review-and-adjust surface (MEDIUM, deferrable)

**Problem:** Only remediation for mis-keyed question is destructive Reset
(deletes answers + face checks — see IO-5). No lecturer ability to annotate
a flagged case as reviewed, no score override, no private case notes.

**Design sketch**
- Defer score override (touches secrecy/reveal math; needs its own plan doc
  when scheduled). Minimal slice: `session_case_notes` — audited definer-RPC
  append-only note per session, rendered in expanded timeline; marks case
  reviewed without changing grades.

**Tests:** RPC harness probe (append-only enforced, owner-guarded).

---

## Pre-flight log

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- 2026-08-31: RA-2 reconciled against the current main and implemented same
  day. Corrections: the results RSC is src/app/(lecturer)/lecturer/quizzes/[id]/
  results/page.tsx and does NOT read answers/questions rows today — two new
  reads added (questions full projection mirroring the export route;
  lecturer_answers_view with a 20k ANSWERS_LIMIT cap + truncation flag). The
  session feed gained the export route's `id DESC` secondary order so the
  representative-session pick is deterministic here too. Security note upheld:
  insights pass as a SEPARATE serializable prop (QuestionInsightsModel);
  ResultsSessionRow is untouched. Design refinement: instead of duplicating
  distribution math, the export model's normalization + distribution loop
  were EXTRACTED verbatim into normalizeExportQuestions/computeDistributions
  (export.ts) and buildQuestionInsights (insights.ts) reuses buildExportModel
  + summarizeQuestionStats — screen = workbook by construction. LOW_CORRECT_
  THRESHOLD=30 + never-picked-distractor hints (key options excluded from the
  distractor check). e18 extended with the on-screen parity assertions.

- 2026-08-28: reconciled against d1cfcb9 (post AU-1); RA-1 pre-flight DONE —
  migration will be 0033 only if a schema change emerges (current design needs
  NONE: lecturer_session_view already carries score+attempt since 0032,
  results_revealed_at on quizzes since 0012); ROSTER_LIMIT verified at
  src/lib/classes/roster.ts:30; route-group path is
  src/app/(lecturer)/lecturer/classes/[id]/…; export guard/rate-limit shape
  re-verified against api/quizzes/[id]/export/route.ts; RA-7 cross-reference
  corrected SQ-3 → SQ-2; RA-7/SQ-2 scheduled to ship together with RA-1;
  E2E convention pinned: fail-fast 5s expect budget + 90s test timeout +
  skip-without-LECTURER_INVITE_CODE (e18 pattern, user requirement).

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

- **2026-08-28 — RA-1 (cross-quiz class gradebook) SHIPPED** (+ RA-7 via SQ-2
  in STUDENT_QOL). No migration (0033 remains the next number).
  - What shipped: RSC page
    `src/app/(lecturer)/lecturer/classes/[id]/gradebook/page.tsx` +
    `gradebook-client.tsx` — student × quiz matrix, published-assessment
    columns only (drafts/practice excluded), chronological, sticky name
    column, unrevealed column markers (`results_revealed_at` null),
    per-quiz class-average footer row, per-student cumulative % column,
    truncation flags (>50 quizzes / ≥100 roster), empty states for
    zero-quizzes and zero-students classes. Link added on class detail.
  - Pure model: `src/lib/results/gradebook.ts` (`buildGradebookModel`,
    `GRADEBOOK_QUIZ_LIMIT = 50`); representative-session policy reuses
    `selectRepresentativeSessions` (now exported from `src/lib/results/export.ts`)
    under the pinned feed order `started_at DESC, id DESC` — flagged sessions
    are score-bearing (documented divergence from the student card).
  - Export: `GET /api/classes/[id]/gradebook-export` — Summary sheet (model
    mirror) + compact per-quiz status/score sheets; guard chain isUuid →
    requireClassOwner → rateLimit(10/min) → checkSameOrigin; RLS-only reads;
    >25 quizzes → summary-only workbook (scale guard).
  - Deviations from the original sketch: no SQL harness probe (no new
    RPC/RLS — existing views verified by verify:results/verify:matric);
    per-quiz export sheets carry status/score/percent rows rather than the
    full answer-key/distribution sheets (full detail stays in the per-quiz
    export); guarded via `requireClassOwner` (the sketch's "class detail
    pattern" formalized).
  - Tests: `gradebook.test.ts` (14 unit tests); `gradebook-export-routes.test.ts`
    (8 route tests incl. 404 no-oracle, CSRF, 429 rate limit, workbook
    parity); E2E `e39-gradebook.spec.ts` (3 tests, fail-fast e18 convention).
  - Pre-flight log entry above records the review round (correctness + E2E
    coverage audits) and the decisions it pinned.

Note: RA-2..RA-6, RA-8 remain PLANNED in this doc — this plan does NOT move
out until the whole domain ships (roadmap README Step 3).

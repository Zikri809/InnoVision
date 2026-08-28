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
`lib/results/export.ts`). No aggregated student × quiz matrix; no cumulative %
anywhere. End-of-term mark submission requires merging N workbooks by hand.

**Design sketch**
- Pure-read feature (no mutation surface — lowest risk class of feature):
  RSC page `/lecturer/classes/[id]/gradebook`, rows = enrolled students
  (join enrollments like existing roster, honoring ROSTER_LIMIT=100 currently
  in `lib/classes/roster.ts:30`), columns = quizzes of the class.
- Cell source: sessions with score, revealed-or-auto-revealed ONLY? Decide
  policy at pre-flight — recommend showing scores regardless of reveal state
  for LECTURERS (they already see full matrix in per-quiz dashboard
  regardless of reveal, per ARCHITECTURE §7.9), but flag hidden-from-students
  cells visually so lecturer knows what's been communicated.
- Column header shows quiz title + max score; footer row = per-quiz averages.
- Export: single workbook, one sheet per quiz + summary sheet (reuse
  `buildExportModel` per quiz); CSV variant comes free under RA-4.
- Guard: class-owner semantics identical to class detail page
  (`classes/[id]/route.ts` pattern).
- Scale note: wide classes (20+ quizzes) need horizontal scroll — mind AX
  finding #10 (hidden scrollbars).

**Tests:** SQL harness verifying aggregate correctness incl. multiple
attempts if QC-4 ships; route/page test; E2E smoke.

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

## RA-7 · Per-quiz results entry point from quiz list (HIGH — pairs with STUDENT_QOL SQ-3 mirror)

**Problem:** Covered on lecturer side? Not quite — see also student-side
mirror. Lecturer list links to results naturally, but keep RA item focused on
**student-visible** result access missingness handled in STUDENT_QOL SQ-3.
RA-7 kept as explicit cross-reference to avoid duplicate design drift:
design lives THERE.

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

- (none yet)

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

# InnoVision Roadmap — Master Index & Workflow

> **Origin:** Consolidated output of the Aug 2026 four-auditor product-gap audit
> (student UX, lecturer UX, accessibility/i18n, product strategy).
> Every finding was verified against the codebase by its auditor before being
> recorded here.
>
> **Status:** PLANNED — none of this is implemented until its plan moves out.

---

## What lives in this folder

Implementation plans, grouped by domain so related work shares one design and
one migration review:

| Plan | Domain | Items |
|---|---|---|
| [PLAN_CLOSE_AND_SCHEDULE.md](../PLAN_CLOSE_AND_SCHEDULE.md) ✅ shipped | Close/edit/schedule/retake quizzes, reveal recovery | QC-* (moved out 2026-08-28) |
| [PLAN_R_RESULTS_ANALYTICS.md](PLAN_R_RESULTS_ANALYTICS.md) | Gradebook, item analysis, exports, dashboard QoL | RA-* |
| [PLAN_R_AUTHORING_PRODUCTIVITY.md](PLAN_R_AUTHORING_PRODUCTIVITY.md) | Bulk import, duplication, question banks | AP-* |
| [PLAN_R_QUESTION_TYPES.md](PLAN_R_QUESTION_TYPES.md) | Multi-select, short answer, per-student shuffling | QT-* |
| [PLAN_R_STUDENT_QOL.md](PLAN_R_STUDENT_QOL.md) | Student journey friction, onboarding, failure states | SQ-* |
| [PLAN_R_AUTH_IDENTITY.md](PLAN_R_AUTH_IDENTITY.md) | Forgot password, SSO institutional login | AU-* |
| [PLAN_R_CLASS_MANAGEMENT.md](PLAN_R_CLASS_MANAGEMENT.md) | Roster ops, co-teaching, announcements | CM-* |
| [PLAN_R_INTEGRITY_OPS.md](PLAN_R_INTEGRITY_OPS.md) | Flagged/unlock flow, enrollment review, retention, quotas | IO-* |
| [PLAN_R_ACCESSIBILITY_PLATFORM.md](PLAN_R_ACCESSIBILITY_PLATFORM.md) | Dark mode, contrast, a11y, mobile, vision payload, i18n hygiene | AX-* |

Cross-cutting note: quiz **availability windows** (QC-*) and their display as
**deadline chips** (SQ-*) are one schema change consumed by two domains — QC
owns the columns/triggers, SQ references them read-only. Same for the
**unlock notification** (IO-2 produces the event; SQ references nothing extra,
the bell just renders a new existing-machinery type).

---

## MANDATORY WORKFLOW — follow in order, every time

### Step 0 — Pick an item, not a vibe
Each item below carries a stable ID (`QC-3`, `AX-1`, …) plus severity and
effort. Work happens per-item (or per tightly-coupled item cluster). If you
start working and discover the item is entangled with another domain, split
the record: keep the implemented half here only until it ships.

### Step 1 — UPDATE THE PLAN AGAINST THE CURRENT CODEBASE **before** writing any code (required)

This roadmap was authored 2026-08-27 from a point-in-time audit. The codebase
WILL drift. Before touching anything:

1. Re-read the relevant walkthrough section in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)
   and skim its neighbors for changed invariants.
2. Verify every concrete claim in the item you're about to build:
   - file paths and line references cited under *Evidence*;
   - migration numbers (check `supabase/migrations/` for the real next NNNN);
   - RPC names in `src/lib/types/database.ts`;
   - i18n keys cited (run `npm run check:i18n`);
   - test-file names and the E2E seams they assume.
3. Edit the plan in place: strike stale claims, correct paths, fill in the
   actual next migration number, adjust effort if the surface grew/shrank.
4. Add a dated line to the item's **Pre-flight log**:
   `- YYYY-MM-DD: reconciled against <commit-ish>; migration will be NNNN; noted …`
   Items without a current Pre-flight log entry must NOT be implemented.

If behavior covered by an already-shipped doc would change, flag it now —
the same change updates THAT doc too (see repo doc conventions in
[`docs/README.md`](../README.md)).

### Step 2 — Implement using repo conventions
- Mutations = `/api/**` route handlers with the standard preamble
  (guard → CSRF → rate-limit → body-cap → Zod → typed errors); never trust
  the client; no-oracle 404s.
- Schema changes = new `supabase/migrations/NNNN_*.sql`; then `npm run gen:types`.
- RLS + definer-RPC ownership for every sensitive write; column-revoke secrets.
- Copy through `useTranslations`/`getTranslations` in BOTH en/ms — add keys in
  the same commit or CI fails.
- Tests alongside: Vitest units/route tests (use `fake-supabase.ts`
  semantics), `verify:*` SQL harness where RLS/RPC contracts matter, Playwright
  spec when a user journey changes.

### Step 3 — MOVE OUT the plan once the item/domain cluster is fully implemented
When everything under a plan doc is shipped AND merged:

1. `git mv docs/roadmap/PLAN_R_<DOMAIN>.md docs/PLAN_<FEATURE>.md`
   renaming to the repo's flat executed-plan naming (e.g.
   `PLAN_R_QUIZ_LIFECYCLE.md` → `PLAN_CLOSE_AND_SCHEDULE.md` — pick a name
   describing what SHIPPED, not what was planned).
2. Replace the top status banner with the repo-standard `EXECUTED` banner
   including the date and migration range.
3. Append an **Implementation log** section (create it even if partially
   pre-seeded during dev): for each item — what actually shipped, migrations
   added, new RPCs/views/policies, API routes, UI surfaces, test additions
   (unit/route/E2E names), verify-harness IDs, and ANY deviation from the
   original design with its reason.
4. Update the follow-along index rows in THIS readme: mark the domain row
   moved-out (title → ✅ shipped, link to `../PLAN_*.md`) so the table stays
   truthful while other domains remain.
5. Update [`docs/README.md`](../README.md) ("Executed plans" table) and
   ARCHITECTURE.md sections whose data flow changed.
6. Run the full gate before declaring done:
   ```bash
   npm run lint && npm run typecheck && npm run test && npm run check:i18n
   ```
   plus any new/affected `npm run verify:*` harnesses against local supabase.

### Step 4 — DELETE this roadmap folder when empty
When every plan has been moved out, this README has no live rows left, and no
`PLANNED` items remain anywhere in it: delete `docs/roadmap/` entirely. Its
purpose is fulfilled; history continues to live in the executed `docs/PLAN_*.md`
files. Deleting the last `ROADMAP_*` row from `docs/README.md`'s pointer back
here completes the lifecycle.

> Hard rule: this folder MUST NOT become long-term documentation. Anything
> still relevant after moving out belongs in ARCHITECTURE.md or a plan doc.
> The end state of the roadmap is deletion, not stagnation.

---

## Progress board

Update as work proceeds (keep honest; this mirrors reality, not intention):

| Plan | State | Shipped as | Log |
|---|---|---|---|
| QUIZ_LIFECYCLE | ✅ shipped | [../PLAN_CLOSE_AND_SCHEDULE.md](../PLAN_CLOSE_AND_SCHEDULE.md) | QC-1..QC-4 (2026-08-28) |
| RESULTS_ANALYTICS | 🔶 partial — RA-1 shipped | — | RA-1 + RA-7 via SQ-2 (2026-08-28) |
| STUDENT_QOL | 🔶 partial — SQ-2 shipped | — | SQ-2 (2026-08-28) |
| AUTHORING_PRODUCTIVITY | 🔲 planned | — | — |
| QUESTION_TYPES | 🔲 planned | — | — |
| AUTH_IDENTITY | 🔶 partial — AU-1 shipped | — | AU-1 (2026-08-28) |
| CLASS_MANAGEMENT | 🔲 planned | — | — |
| INTEGRITY_OPS | 🔲 planned | — | — |
| ACCESSIBILITY_PLATFORM | 🔶 partial — AX-1, AX-2 implemented (unreviewed/uncommitted) | — | AX-1 + AX-2 (2026-08-29) |

> Partial states: implementation logs live inside each domain plan doc
> (Pre-flight + Implementation log sections). A plan doc moves out (Step 3)
> only when its whole domain ships.

## Suggested sequencing (by leverage ÷ cost, audit recommendation)

1. ~~AU-1 forgot password~~ ✅ (2026-08-28)
2. ~~QC-1 close quiz + QC-2 reveal recovery~~ ✅ (2026-08-28)
3. ~~QC-3 availability windows~~ ✅ (2026-08-28)
4. ~~RA-1 gradebook + RA-7 per-quiz results entry point~~ ✅ (2026-08-28, RA-7 shipped as SQ-2)
5. AX-1 dark mode + AX-2 contrast (implemented 2026-08-29, pending review/commit)
6. IO-2 flagged-unlock notification + SQ-5 camera messaging
7. Then depth: QT shuffling (cheap) → AP-1/AP-2 authoring → QT-1 multi-select → AU-2 SSO

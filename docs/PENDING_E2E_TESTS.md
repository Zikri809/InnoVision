# Pending E2E Tests — Student Classes Redesign

> Created 2026-09-09. These specs are **code-complete but NOT verified against a
> full Playwright run** — the e2e harness needs a fresh `next build`, and the
> build lock was held by concurrently running suites (dev server + other e2e
> projects). Run them once the redesign work lands and the machine is free.
> Clear entries from this file as each passes.

## Lecturer classes page (redesign round 2, 2026-09-09)

`lecturer/classes/classes-client.tsx` received the same treatment as the
student page:

- **A2 row cards** — avatar + title + quiz count + **join-code chip** + chevron;
  whole card is the tap target.
- **Create form** — mobile/tablet (<lg) opens it in a ResponsiveModal from the
  header "New Class" button (the e2e helper's exact-match target, unchanged);
  desktop ≥lg keeps the sticky sidebar card. The page-level FAB was dropped as
  redundant: the dock's center "+" already opens the New class/New quiz sheet.
- **Per-instance input ids restored** (`class-title-desktop` / `class-title-mobile`)
  — a shared id made both labels resolve to the hidden desktop input, breaking
  `getByLabel("Class title")` inside the dialog. This was the original code's
  documented guard; do not regress it.
- `helpers.createClass` (mobile branch: `getByRole("dialog").getByLabel("Class
  title")` + "Create class" exact) verified working against the live dev
  server; create flow (drawer + sidebar) and archive-via-PATCH verified
  manually. `lecturer.classes.cancelBtn` i18n key added (en/ms).

## Status

| Spec | Status | Last result |
|---|---|---|
| `e2e/e1-classes.spec.ts` (test 1 — join via empty-state CTA) | ✅ PASSED (chromium) | 2026-09-09 |
| `e2e/e1-classes.spec.ts` (test 2 — wrong-code alert, rejoin toast, two-class roster isolation) | ⚠️ FAILED — infra, not assertion | 2026-09-09 |
| `e2e/e1b-manual-quiz.spec.ts` | ⏳ PENDING | — |
| `e2e/e2-ai-generate.spec.ts` (student join segment) | ⏳ PENDING | — |
| `e2e/e24-network-failure.spec.ts` (inline join segment) | ⏳ PENDING | — |
| `e2e/e26-archive-lifecycle.spec.ts` (archived-class rejoin segment) | ⏳ PENDING | — |
| `e2e/m1-mobile-journeys.spec.ts` (mobile join + zero-state segment) | ⏳ PENDING | — |

## Why the e1 test-2 failure is infra, not the redesign

The failure at `e1-classes.spec.ts:91` happened while the Playwright webServer
log showed repeated:

```
ENOENT: no such file or directory, open '.next/build-manifest.json'
ENOENT: ... '.next/server/pages/500.html'
```

i.e. a **concurrent build wiped `.next` out from under the running prod
server** (another suite's `next build` + the Turbopack dev server were active
at the same time). The spec never reached its assertions on a stable server.
Re-run on a quiet machine before treating it as a real regression.

## What changed in these specs (the contract to preserve)

Join-by-code moved from an always-rendered inline form into a single
`ResponsiveModal` (vaul drawer <sm, dialog ≥sm) opened from:

- **mobile FAB** — scroll-aware, hidden while scrolling down (`Join a class` exact aria-label)
- **section-header button** — desktop ≥sm (`Join a class` exact)
- **empty-state CTA** — zero classes (`Enter a join code`)

Specs patched to open the surface before filling:

- `helpers.ts` — `openJoinDrawer()` (FAB → CTA → header fallback) +
  `joinClass()` now opens the drawer first; submit anchored to `/^join class$/i`
- `e1` — zero-state test uses the CTA; isolation test clicks the header button
  and re-clicks it between joins (drawer unmounts after the success beat)
- `e1b` / `e2` / `m1` — zero-state joins via the CTA
- `e24` / `e26` — classes-exist joins via the FAB/header button

Unchanged contracts that the redesign preserved (do not regress):

- `getByLabel("Join code")` — lives on the `input-otp` hidden input
- submit button name `Join class` (exact) and `/^join class$/i`
- inline `role="alert"` error strings ("That join code is not valid.", the
  archived-class string in e26)
- class-card link accessible name starts with `View quizzes` (sr-only span in
  the A2 row card) — 11 specs click `getByRole("link", { name: /View quizzes/i })`
- zero-state still asserts NO "0 classes"/"0 live" text (m1)

## Also pending (UI, low risk — verified manually in-browser instead)

- Scroll-aware FAB duck/return — verified live via synthetic window scroll
  (hidden at y≥scroll-down, returns on up/top); unit-level, no spec exists.
- Malay (`ms.json`) strings — new keys `joinCta`, `cancelBtn`,
  `joinDrawerSubtitle` added; no e2e asserts Malay copy.

---

# Pending E2E Tests — Student Quizzes Hub Mobile Redesign (Flavor 1)

> Added 2026-09-09. The quizzes hub got a dedicated mobile layout (<640px,
> early-return branch in `student-quizzes-client.tsx`): large title + live
> count line, one-line face pill, hairline list rows with clay glyph tiles,
> inline amber due chips, trailing actions. Desktop markup untouched
> (`isMobile` gate via `useMediaQuery("(max-width: 639px)")`). Typecheck, lint
> and `next build` all green.
>
> One chromium run was attempted 2026-09-09 under concurrent-build conditions
> (manual `npm run build` + Turbopack dev server + the Playwright webServer
> rebuild racing): **5 failed / 1 passed**, and every failure died in
> `helpers.ts openJoinDrawer()` (the classes-page join flow) with the same
> `.next`-wipe signature documented above — the specs never reached the
> quizzes page. Treat as infra, not regression. **e5-assessment-lock PASSED**
> in that same run (its assertions include the disabled "Awaiting results"
> button on the completed card). Re-run the rest on a quiet machine.

## Status

| Spec | Status | Last result |
|---|---|---|
| `e2e/e5-assessment-lock.spec.ts` | ✅ PASSED (chromium) | 2026-09-09 (concurrent-build run) |
| `e2e/e46-deadline-chips-class-filter.spec.ts` (both tests) | ⏳ PENDING — infra-failed in join flow | 2026-09-09 |
| `e2e/e40-student-results-entry.spec.ts` (both tests) | ⏳ PENDING — infra-failed in join flow | 2026-09-09 |
| `e2e/e37-retake-journey.spec.ts` | ⏳ PENDING — infra-failed in join flow | 2026-09-09 |
| `e2e/m1-mobile-journeys.spec.ts` (mobile project — dock → class quizzes → Start → submit) | ⏳ PENDING — not run | — |
| `e2e/e48-mobile-nav-and-drawers.spec.ts` (dock nav segment) | ⏳ PENDING — not run | — |
| Broader Start-clickers (`e10`–`e25`, `e38`, `e3`…) | ⏳ PENDING — desktop viewport, desktop markup untouched; low risk | — |

## The contract the mobile redesign preserves (assertions above depend on it)

- **Rows are `<li>`** — every spec's `locator("li").filter({ hasText: <quiz title> })` works.
- **Start button** — name `Start` (en) / `Mula` (ms) exact; disabled while starting (`Starting…`/`Sedang memulakan.`).
- **Completed + unrevealed + no retake** → single **disabled** button `/awaiting results|menunggu keputusan/i` (e5/e37/e40); with retake → Start button + `role="status"` awaiting chip, count 1, and NO `View results` link (e37).
- **Completed + revealed** → link `/view results|lihat keputusan/i` with aria-label `View results - {title}` (e40's `RegExp('View results.*' + title)`).
- **Deadline chip** — text `/^due |^tamat /i` inside the quiz's `li`, amber tone carries the `amber` class (e46 asserts `toHaveClass(/amber/)`); chip removed when ≥24h out or undated.
- **Class filter chip** — `/showing:|paparan:/i` visible when filtered, gone after removing via `/remove class filter|buang penapis kelas/i` (e46).
- **Empty state** — `/no quizzes available yet|belum ada kuiz tersedia/i` on foreign-uuid `?class=` (e46).
- **Mobile-only copy changes** — hero subtitle "Pick a quiz and wave your answer" and the stat chips no longer render <640px; no spec asserts them (verified by grep). `heroTitle` "Available quizzes" still renders (large title) — e2/e1b/e4/e5b assert it at desktop viewport anyway.
- **New i18n keys** — `student.quizzes.enrollPillSub` (en: "Be ready for test day" / ms: "Sedia untuk hari penilaian"); no spec asserts it.
- **Face pill** — mobile banner became a link to `/student/face/enroll` with text `Enroll your face`/`Daftar wajah anda`; e3's "Enroll your face" assertion targets the enroll page heading, not this hub, so it's unaffected.

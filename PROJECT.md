# Project: E2E Test Backlog Clearance, Redesign Stabilization & Gap Coverage

## Architecture
- **E2E Test Engine**: Playwright test harness running against local Next.js instance on port 3001 with mock AI server (port 8787) and mock TinyFish server (port 8788).
- **Projects**:
  - `chromium`: Desktop Chrome (1280×720) executing all desktop `e*.spec.ts` test suites.
  - `mobile`: iPhone X emulation (375×812, touch enabled, mobile user agent) executing mobile `m*.spec.ts` test suites.
- **Environment Invariants**:
  - `NEXT_PUBLIC_E2E_FAKE_SEAM=1` enabling biometric camera mocks and deterministic test seams.
  - Isolated server runs to prevent `.next` directory wipes and file-lock concurrency collisions.
  - Supabase database fixtures with lecturer invite gating.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | ResponsiveModal Join Stabilization | Fix 900ms auto-dismiss modal race condition in `helpers.ts::joinClass` and `e1` | M1 | Survey 2 |
| 2 | EndScreen Breakdown Listitem Selector | Fix `ol > li` selector mismatch in `e42` and `e45` on desktop VList | M1 | Survey 2 |
| 3 | Archive Lifecycle Empty State Join | Fix missing "Join a class" button in `e26` by using `openJoinDrawer` | M1 | Survey 2 |
| 4 | Mobile Navigation Modal Interception | Fix dialog backdrop click interception in `m1-mobile-journeys` | M1 | Survey 2 |
| 5 | Batch Question Sheet Closure | Fix batch sheet obscuring background elements in `m1-my-quizzes` | M1 | Survey 2 |
| 6 | i18n Parity Namespace Collision Fix | Fix shadowed `t` variable in `dock-fab-actions.tsx` for `check-i18n.mjs` | M1 | Survey 2 |
| 7 | Full Redesign Spec Verification | Execute and verify all 21 pending redesign suites in chromium and mobile projects | M1 | Survey 1 & 2 |
| 8 | Mobile Play Surface Chrome Spec | Implement `e2e/m2-mobile-play-chrome.spec.ts` covering sticky header, timer, info modal, bottom dock, ScoreRing, verdict accordion | M2 | Survey 3 |
| 9 | Mobile Gradebook Spec | Implement `e2e/m3-mobile-gradebook.spec.ts` covering summary meter, quiz chips, per-quiz distribution, per-student sheets | M2 | Survey 3 |
| 10 | Mobile Authoring Workflows Spec | Implement `e2e/m4-mobile-authoring.spec.ts` covering accordion, reviewed checklist filter, bottom sheet batch composer | M2 | Survey 3 |
| 11 | Mid-State Interruptions Spec | Implement `e2e/e50-session-reload-interruptions.spec.ts` covering paused and flagged session reloads and polling | M2 | Survey 3 |
| 12 | Non-Owner Lecturer 404 Security | Implement `e2e/e51-non-owner-security-404.spec.ts` checking class detail, builder, results, and session detail routes | M3 | Survey 3 |
| 13 | Builder-Surface Close Dialog | Implement `e2e/e52-builder-close-dialog.spec.ts` covering cool-down guards and reveal-first prompt | M3 | Survey 3 |
| 14 | Archive-While-Mid-Play Termination | Implement `e2e/e53-archive-mid-play.spec.ts` covering 409 quiz_not_live, UI dead state, and reload 404 | M3 | Survey 3 |
| 15 | Post-Login Redirect Preservation | Implement `e2e/e54-redirect-preservation.spec.ts` covering ?redirect= sanitization and deep-link routing | M3 | Survey 3 |
| 16 | Upload/Question/Option Boundary Caps | Implement `e2e/e55-authoring-boundary-caps.spec.ts` covering bulk import 512KB/30-cap, student 50-cap, option count caps | M3 | Survey 3 |
| 17 | Backlog Documentation Update | Update `docs/PENDING_E2E_TESTS.md` status tables, path map, and scenario coverage | M4 | Survey 1 |
| 18 | Quality Gates & Integrity Forensics | Static typecheck, linter, i18n check, regression check, and forensic audit | M4 | Survey 1, 2, 3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Stabilize & Verify Redesign Specs | Fix helper/spec selectors and verify all 21 redesign suites exit 0 in Playwright | none | COMPLETED |
| M2 | Tier A Mobile & Interruption Coverage | Implement m2, m3, m4, and e50 test suites and verify exit 0 | M1 | PLANNED |
| M3 | Tier B Targeted Scenario Coverage | Implement e51, e52, e53, e54, and e55 test suites and verify exit 0 | M1 | PLANNED |
| M4 | Backlog Docs & Final Forensic Audit | Update PENDING_E2E_TESTS.md, typecheck, lint, i18n, regression check & audit | M2, M3 | PLANNED |

## Interface Contracts
### Test Selectors & DOM Representation
- `end-screen.tsx`: Desktop renders `<VList role="list"><div role="listitem">`, Mobile renders `<Accordion render={<ol />}><li role="listitem">`. All test specs querying breakdown question cards MUST use `locator('[role="listitem"]')`.
- `student-classes-client.tsx`: Modal auto-dismisses in 900ms. All test join flows MUST call `await expect(page.getByRole("dialog")).toHaveCount(0)`.
- `playwright.config.ts`: Projects configured:
  - `chromium`: `testIgnore: ["**/m*.spec.ts", "**/e2f-web-generate-flags.spec.ts"]`
  - `mobile`: `testMatch: ["**/m*.spec.ts"]`

## Code Layout
- `e2e/helpers.ts`: Core helper functions (joinClass, openJoinDrawer, createClass, auth, etc.)
- `e2e/e*.spec.ts`: Desktop Playwright test suites (run in project `chromium`)
- `e2e/m*.spec.ts`: Mobile Playwright test suites (run in project `mobile`)
- `src/components/layout/dock-fab-actions.tsx`: Mobile docking and FAB action triggers
- `docs/PENDING_E2E_TESTS.md`: Living backlog and E2E coverage documentation

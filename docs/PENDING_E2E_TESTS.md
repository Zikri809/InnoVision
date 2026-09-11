# E2E Path Map — Mobile & Desktop

> Created 2026-09-09. Full inventory of every user path in the app, mapped to
> the e2e specs that exercise it, **grouped mobile vs desktop**, then layered
> with **scenario-level coverage** (error/edge/alternate paths, state-machine
> transitions, cross-cutting concerns) so the map covers everything a user
> could actually do — not just the happy paths. Supersedes the per-redesign
> sections at the bottom of this file (kept for history — they hold per-spec
> contract notes and known-broken selectors still relevant when clearing
> entries).
>
> **Structure:** PART 1 mobile paths · PART 2 desktop paths · PART 3
> error/edge scenarios (student/shared + lecturer) · PART 4 state-machine
> transitions & interruptions · PART 5 cross-cutting (i18n, theme, a11y,
> touch, network, uploads, clipboard) · PART 6 consolidated gap list ·
> PART 7 audit method. Historical per-redesign sections follow.
>
> Reading key: ✅ covered (a spec walks this path) · 🟡 partially covered /
> covered only incidentally · ⏳ spec exists but currently pending/broken
> (see per-redesign sections below) · ❌ NOT covered — no spec walks this
> path · ⚠️ covered but the assertion depends on copy/selector that may have
> drifted. Coverage verdicts consider the branch the path actually renders:
> a desktop-viewport spec never exercises a `<sm` mobile composition even
> if the route matches.

## How mobile vs desktop actually branches (verified in code)

- **Playwright projects** (`playwright.config.ts`): project `chromium`
  (Desktop Chrome 1280×720) runs every `e2e/*.spec.ts` except `m1-*` and
  `e2f-web-generate-flags` — i.e. **all `e*` specs run the DESKTOP
  viewport**. Project `mobile` (iPhone X descriptor on chromium: 375×812,
  hasTouch, mobile UA) runs **only `m1-*.spec.ts`** via testMatch.
  `e48-mobile-nav-and-drawers.spec.ts` runs in the desktop project but calls
  `page.setViewportSize({375, 812})` inside tests 2–3, so it *simulates*
  phone compositions from the desktop project. Project
  `chromium-nowebsearch` runs only the flag-off `e2f-web-generate-flags`.
- **`useMediaQuery` is SSR-false** → first paint is always the mobile
  composition; desktop branch hydrates in.
- **Breakpoints**: `sm` (640px) is the dominant branch on most surfaces
  (`ResponsiveModal` = vaul drawer <640 / dialog ≥640; mobile dock and FABs
  are `sm:hidden`). `lg` (1024px) only on `/lecturer/classes` create form
  and the play surface's `isWide` (`min-width:1024px` or landscape≥640).
  `md` (768px) splits the builder's inline add-question card vs sheet.
- **JS early returns** (`useMediaQuery("(max-width: 639px)")` → `if
  (isMobile) return <mobile JSX>`): `student-quizzes-client.tsx`,
  `my-quizzes-client.tsx`, `editor-client.tsx`, `quiz-builder-client.tsx`,
  `gradebook-client.tsx` (component swap, `(min-width: 640px)`).
- **Students have a 4-tab dock, no FAB; lecturers have a 2-tab dock with a
  center "+" FAB** (New class / New quiz action sheet). Dock renders
  `sm:hidden` on both role shells; student dock tabs: Classes, Quizzes, My
  Quizzes, Face enroll. Language/theme toggles live in the topbar only ≥sm;
  below sm they are rows inside the account ResponsiveModal (drawer <640).

---

# PART 1 — MOBILE (phone viewport, <640px; `mobile` project + phone-branch coverage)

> Project `mobile` currently runs only `m1-mobile-journeys.spec.ts` and
> `m1-my-quizzes.spec.ts` (4 tests total). Everything else below is either
> covered incidentally by `e48`'s viewport switch, pending per the
> per-redesign sections, or **not covered** (❌). Every recently redesigned
> mobile composition is verified **manually in-browser only** (393×852) —
> noted per path.

## 1.1 Shared shell (all mobile pages)

| # | Path | Covered by | Verdict |
|---|---|---|---|
| M1 | Student dock renders 4 tabs, correct active state | `m1-mobile-journeys` test 1; `e48` test 2 | ✅ |
| M2 | Dock tab navigation → each tab routes | `m1-mobile-journeys` test 2 (Class Quizzes); `e48` test 2 (Quizzes + My Quizzes) | ✅ (face-enroll tab tap ❌ — only reached via in-page links) |
| M3 | Lecturer dock: 2 tabs + center "+" FAB; no Archived tab | `e48` test 3 (invite-gated, phone viewport) | ✅ |
| M4 | Lecturer FAB → DockActionSheet → **New class** (POST + refresh) | ❌ | ❌ no spec |
| M5 | Lecturer FAB → **New quiz** → class picker → `/lecturer/classes/[id]?newQuiz=1` → create modal auto-opens | ❌ (deep-link open also ❌) | ❌ no spec |
| M6 | Account sheet (drawer <640): language + theme rows present; Escape closes | `m1-mobile-journeys` test 3 | ✅ |
| M7 | Language switch from the account sheet flips page copy (mobile) | ❌ (e31 runs desktop viewport; topbar toggle) | ❌ mobile-only placement |
| M8 | Theme switch from the account sheet persists (mobile) | ❌ (e41 desktop only) | ❌ mobile-only placement |
| M9 | Avatar upload / remove via account sheet (drawer branch) | ❌ (e21 desktop popover) | ❌ |
| M10 | Notification bell → bottom **drawer** sheet (vaul <640), open/navigate/mark-read | `m1-mobile-journeys` test 4 (open/close + empty state only) | 🟡 — no mobile navigation-from-row or mark-all-read on mobile |
| M11 | Dock slides off-screen while a text input is focused (`useKeyboardOcclusion`) | ❌ | ❌ no spec |
| M12 | Sign out from the account sheet on mobile | ❌ | ❌ |
| M13 | AppUserMenu matric card / biometric consent row (drawer branch) | ❌ | ❌ |

## 1.2 `/student/classes` (mobile composition)

| # | Path | Covered by | Verdict |
|---|---|---|---|
| M14 | Zero state: "Enter a join code" CTA visible; NO "0 classes/0 live" stat cards; hero renders | `m1-mobile-journeys` test 1 | ✅ |
| M15 | Join via empty-state CTA → drawer → OTP input → success | `m1-mobile-journeys` test 2 | ✅ |
| M16 | **Scroll-aware JoinFAB**: hidden while scrolling down, returns on scroll-up/top; opens join drawer | ❌ (verified manually in-browser only) | ❌ no spec |
| M17 | Join via FAB when classes exist | ❌ (desktop header-button join covered by e1) | ❌ mobile entry point |
| M18 | Wrong code → inline `role="alert"` in drawer (mobile drawer) | ❌ (e1 test 2 runs desktop viewport) | ❌ |
| M19 | Already-enrolled 409 toast (mobile) | ❌ | ❌ |
| M20 | Class card tap → `/student/quizzes?class=<id>` | ⏳ `e46` covers the link target but runs desktop; mobile card = whole-tile link | 🟡 |

## 1.3 `/student/quizzes` (mobile early-return branch — "Flavor 1" rows)

| # | Path | Covered by | Verdict |
|---|---|---|---|
| M21 | Mobile rows render (large title, live-count line, face pill, hairline rows) | ❌ no mobile-viewport spec reaches this page | ❌ |
| M22 | **Start** button → `/play/<sessionId>` (mobile row action) | ⏳ `m1-mobile-journeys` test 2 does this | ⏳ pending (see Quizzes Hub section) |
| M23 | Completed + revealed → "View results" link (mobile) | ❌ mobile; e40 desktop only | ❌ |
| M24 | Awaiting-results state on mobile — **row ends at the text; the disabled button only exists ≥sm** (behavioral divergence!) | ❌ | ❌ (e5's disabled-button assertion is desktop-only markup) |
| M25 | Deadline chip (amber <24h) on mobile rows | ⏳ `e46` asserts `toHaveClass(/amber/)` but at desktop viewport | 🟡 |
| M26 | Class filter chip + "Showing:" line + remove-filter (mobile) | ⏳ e46 (desktop viewport) | 🟡 |
| M27 | Empty state on foreign `?class=` uuid (mobile) | ⏳ e46 (desktop viewport) | 🟡 |
| M28 | Mobile face-enroll pill → `/student/face/enroll` | ❌ (desktop banner covered in e3's hub segment) | ❌ |
| M29 | Desktop-only "My Classes" dashed card absent on mobile | ❌ (asserted nowhere, mobile or desktop) | ❌ |

## 1.4 `/play/[sessionId]` session player (mobile: sticky header, info sheet, fixed action bar, gesture PIP)

| # | Path | Covered by | Verdict |
|---|---|---|---|
| M30 | Answer → Next/Finish via fixed bottom action bar (completeQuiz) | ⏳ `m1-mobile-journeys` test 2 | ⏳ pending |
| M31 | Practice feedback chip + explanation (mobile layout) | ❌ (e4 desktop) | ❌ |
| M32 | Sticky compact header: progress strip + timer chip render; timer counts down (mobile) | ❌ (e10 desktop sidebar HUD) | ❌ |
| M33 | Info (ⓘ) button → quiz-info ResponsiveModal (mode/time/cam status) — **mobile-only component** | ❌ | ❌ no spec |
| M34 | Gesture calibration mobile layout: camera hero + overlaid CalibrationHud + fixed dock (Continue/Skip) | ❌ (e9/e9c run desktop ≥lg card; mobile verified manually) | ❌ |
| M35 | Gesture calibration **Skip** on mobile → "Gestures unavailable" → click-first quiz | ❌ (e9c desktop viewport) | ❌ |
| M36 | Gesture hold-to-answer + palm-next with **PIP camera** (mobile video container) | ❌ (e8/e45 desktop sidebar camera) | ❌ |
| M37 | Hand-loss pause + blink recovery (mobile chrome) | ❌ (e9b desktop) | ❌ |
| M38 | Face gate: Begin + blink on mobile | ❌ (e3/e12 desktop) | ❌ |
| M39 | Pause overlay + flagged overlay render in mobile action-bar layout | ❌ (e6 desktop) | ❌ |
| M40 | Timed expiry auto-submit (mobile timer chip path) | ❌ (e10 desktop) | ❌ |
| M41 | Multi-select toggle + Confirm answer (mobile action bar) | ❌ (e45 desktop) | ❌ |
| M42 | Reload resume (practice checkpoint) on mobile | ❌ (e4 desktop) | ❌ |
| M43 | EndScreen mobile layout: ScoreRing + praise + stacked buttons (Try again first) + verdict Accordion | ❌ (e45/e42/e36 run desktop VList; mobile verified manually in-browser) | ❌ |
| M44 | EndScreen accordion: wrong rows open on load, tap-to-expand closed correct rows, options/explanation mount on expand | ❌ (verified manually only) | ❌ no spec |
| M45 | "Try again" → new session; "Back to quizzes" → `/student/quizzes` (mobile) | ⏳ e45 flow at desktop; mobile buttons stacked but same names | 🟡 |
| M46 | Breakdown rows are `ol > li` on mobile (Base UI accordion render) | ❌ | ❌ |

## 1.5 `/student/my-quizzes` + editor (mobile early-return)

| # | Path | Covered by | Verdict |
|---|---|---|---|
| M47 | Zero state + Create CTA → `/new` → editor | ⏳ `m1-my-quizzes` test 1 | ⏳ pending |
| M48 | Card-tap routing: playable → `/play/student/<id>`; 0-question → editor | ⏳ `m1-my-quizzes` tests 1–2 | ⏳ pending |
| M49 | FAB intercepts click → **create drawer** (in-place) → POST → editor; FAB hide-on-scroll-down | ⏳ `m1-my-quizzes` partially (CTA path tested; FAB-drawer + scroll-hide not asserted) | 🟡 |
| M50 | ⋯ action drawer: Edit / **Share** (mints `/s/<code>` link panel) / Delete confirm-in-drawer | ⏳ `m1-my-quizzes` test 2 | ⏳ pending |
| M51 | Share panel: Copy link + toast; WhatsApp link; **Regenerate** two-step; **Unshare** | ⏳ partially (copy + minted link); WhatsApp/Regenerate/Unshare ❌ | 🟡 |
| M52 | Editor mobile: hero band chips, action strip state swap (empty→Generate primary; has questions→Add question primary + ⋯) | ❌ (verified manually only) | ❌ |
| M53 | Editor mobile: add-question **bottom Sheet**, stays open for batch authoring, form without radios | ❌ | ❌ |
| M54 | Editor mobile: accordion question rows (single-open, chevron, option rows, green key highlight) | ❌ | ❌ |
| M55 | Editor mobile: reviewed checklist toggle + localStorage persistence + All/To-review filter + progress | ❌ | ❌ |
| M56 | Editor mobile: settings drawer (title+description only, pinned footer) | ❌ | ❌ |
| M57 | Editor mobile: edit-question ResponsiveModal (radios kept here) + delete AlertDialog + ⋯ move up/down | ❌ | ❌ |
| M58 | Editor mobile: Generate with AI (sheet surface) | ❌ (e19 desktop) | ❌ |
| M59 | Self-play `/play/student/[quizId]` on mobile: sticky Next, wrong-feedback banner | ❌ | ❌ |
| M60 | Self-play **results** mobile: ScoreRing + praise + verdict accordion (wrong rows open) | ❌ (verified manually only) | ❌ |

## 1.6 `/student/face/enroll` (mobile)

| # | Path | Covered by | Verdict |
|---|---|---|---|
| M61 | Consent → capture → 3 angles → enrolled (mobile status line under video instead of in-frame HUD) | ❌ (e3 desktop HUD branch) | ❌ |
| M62 | Result drawer (processing → success/pending) on mobile | ❌ | ❌ |

## 1.7 Lecturer surfaces on mobile (phone width — mostly desktop-composition pages)

| # | Path | Covered by | Verdict |
|---|---|---|---|
| M63 | `/lecturer/classes` mobile: New Class → ResponsiveModal (vaul drawer) → create | ⏳ `createQuizWithQuestions`/`createClass` mobile branches exercised inside `m1` lecturer-context + e1 flow; dedicated mobile test ❌ | 🟡 |
| M64 | `/lecturer/classes` mobile: A2 row cards, compact stat pills, archived chip | ❌ | ❌ |
| M65 | `/lecturer/classes/[id]` mobile: Quizzes/Students segmented tablist switch | ❌ | ❌ |
| M66 | `/lecturer/classes/[id]` mobile: quiz-row ⋯ menu (Results/Duplicate), "+" opens create modal, join-code copy pill | ❌ | ❌ |
| M67 | `/lecturer/classes/[id]` mobile: quiz-create ResponsiveModal (segmented mode control, pinned footer) | ⏳ exercised via `createQuizWithQuestions` mobile branch in m1 lecturer ctx | 🟡 |
| M68 | `/lecturer/quizzes/[id]/builder` mobile: accordion question rows, reviewed circles + filters, footer publish bar, add-question bottom Sheet (<md), hero action strip + ⋯ menu | ⏳ `createQuizWithQuestions` walks the <768px add-sheet branch inside m1 ctx; the rest ❌ | 🟡 |
| M69 | `/lecturer/quizzes/[id]/builder` mobile: Generate with AI drawer incl. web-augment toggle | ❌ (e2/e2f desktop; e2f has a 360×640 no-overflow check only) | 🟡 |
| M70 | `/lecturer/classes/[id]/gradebook` mobile: `GradebookMobile` — summary card, quiz chip strip → per-quiz sheet, student rows → per-student sheet | ❌ (e39 runs the desktop table) | ❌ |
| M71 | `/lecturer/quizzes/[id]/results` mobile: expansion, ⋯ actions (Unlock/Exempt/Reset), reveal dialog — single responsive layout | ❌ (e13/e14/e25 desktop) | ❌ |
| M72 | `/lecturer/quizzes/[id]/results/[sessionId]` mobile: read-only, flat hero <sm | 🟡 (e25 reads the score number; layout-agnostic) | 🟡 |
| M73 | `/lecturer/classes/archived` mobile: search, restore dialog | ❌ (e26 desktop; cosmetic-only mobile differences) | ❌ |
| M74 | `/lecturer/quizzes` + `/lecturer/quizzes/[id]/insights` mobile: no mobile variant exists (documented) | — | n/a (by design) |

## 1.8 Auth + utility pages (single-layout, mobile-relevant only as smoke)

| # | Path | Covered by | Verdict |
|---|---|---|---|
| M75 | `/login` on mobile (single card; password show/hide toggle) | ✅ `e48` test 1 (375×812 viewport) | ✅ |
| M76 | `/register` role radio / matric / invite-code / consent on mobile | 🟡 (registerUser runs desktop viewport; layout has no mobile branch) | 🟡 |
| M77 | `/matric-capture` gate bounce + capture on mobile | ❌ (e47 desktop; page has no mobile branch) | 🟡 |
| M78 | `/s/[code]` shared play on mobile (inherits player's lg split) | ❌ | ❌ |
| M79 | `/dashboard` role redirect + `/login`/role guards on mobile | n/a (server redirects, viewport-agnostic — e1a/e29/e33 cover) | ✅ |

**Mobile bottom line:** the `mobile` project's 4 tests cover the student
shell (dock, account sheet, bell drawer), the classes zero-state + join CTA,
one full join→quizzes→play→submit journey, and the my-quizzes hub
create/play/share/delete. Everything else marked ❌ has **no spec at that
viewport** — notably the scroll-aware FABs, the play surface's entire mobile
chrome (info sheet, action bar, PIP gestures, calibration dock, EndScreen
accordion, ScoreRing), the mobile gradebook composition, and the my-quizzes
editor's mobile accordion/sheet/review workflow.

---

# PART 2 — DESKTOP (≥sm/≥lg; project `chromium`, all `e*` specs)

> The desktop suite is broad. Below, every route with its paths and the
> specs that cover them; ⏳ marks specs currently pending/known-broken per
> the per-redesign sections at the bottom of this file.

## 2.1 Auth & gates (shared)

| Path | Specs | Notes |
|---|---|---|
| `/` landing → login/register links, redirect-if-authed | e34-error-boundary (home return) | light coverage |
| `/login` (+ `?redirect=`, `?message=` banners, password toggle) | e1a, e29, e33, e34-forgot | ✅ |
| `/register` (roles, consent gate, matric, invite code, language) | e1a, e33, e47 (matric), registerUser helper (all) | ✅ |
| `/forgot-password` → `/reset-password/confirm` (guards, generic no-oracle, BM copy) | e34-forgot-password | ✅ |
| `/dashboard` role redirect hub | e1a, e33, e47 | ✅ |
| `/matric-capture` gate (bounce, reserved/malformed reject, valid capture) | e47 ⏳ (seam-dependent) | ⏳ |
| URL guards: role bounce, auth bounce, foreign `/play/<id>` 404 | e29, e33 | ✅ |

## 2.2 `/lecturer/classes` + archived

| Path | Specs | Verdict |
|---|---|---|
| Create class (sidebar ≥lg form; header-button modal — e2e helper exact-match target) | e1, e2, e1b, e2b, e2c, e2d, e2f, e13, e16, e22, e38, e42, e46 (helper `createClass`) | ✅ (e1 test-2 pending on infra) |
| Class cards → class detail; join-code chip; quiz counts | e1, e26, e44, e30 | ✅ |
| Archived stat tile / pill / empty-state link → `/lecturer/classes/archived` | e26 (archived page: search filter, restore dialog, roster preserved) | ✅ |
| Archive class (confirm → PATCH → archived page) | e26 | ✅ |
| `/lecturer/classes/archived`: search, clear, restore confirm | e26 | ✅ |

## 2.3 `/lecturer/classes/[id]` (desktop: both section cards, inline quiz-create form)

| Path | Specs | Verdict |
|---|---|---|
| Join-code copy (desktop card) | ❌ | ❌ no spec asserts clipboard here |
| Create quiz inline form (mode, availability window via DateTimePicker, time limit, retake+attempts, shuffle) | e1b, e2, e37 (`configureRetakesOnCreate`), e38, e42, e46 (`setDateTime`) | ✅ |
| Quiz rows → builder / results; Duplicate dialog (destination picker) | e44 (also class-to-class row action) | ✅ |
| Gradebook link → gradebook | e39 | ✅ |
| Roster shows joined students | e1 | ✅ |
| Archive/restore from class detail | e26 | ✅ |
| `?newQuiz=1` auto-open (desktop) | ❌ | ❌ |

## 2.4 `/lecturer/classes/[id]/gradebook` (desktop table)

| Path | Specs | Verdict |
|---|---|---|
| N×M matrix: per-quiz + cumulative %, unrevealed EyeOff badges, averages, em-dash | e39 | ✅ |
| Search / status filter / sort / clear | ⏳ e39 (partially asserted) | 🟡 |
| Export xlsx (Summary + per-quiz sheets parity) | e39 | ✅ |
| Quiz column header → results | 🟡 asserted indirectly | 🟡 |
| Non-owner 404 / student redirect | e39 | ✅ |

## 2.5 `/lecturer/quizzes` hub (desktop)

| Path | Specs | Verdict |
|---|---|---|
| Search + clear + count; card routing draft→builder, live/closed→results | 🟡 (dock-tap target in e48 test 3; search/filter not asserted) | 🟡 |
| Class tag / archived icon / status-mode badges | 🟡 incidental | 🟡 |

## 2.6 `/lecturer/quizzes/[id]/builder` (desktop: paper rows, inline add card ≥md, gutter icons)

| Path | Specs | Verdict |
|---|---|---|
| Manual authoring (MCQ / true_false / multi_select, options, correct key, explanation, images) | e1b, e20, e45 | ✅ (student-side `addQuestion` helper needs radio→Select update ⏳) |
| AI generate dialog (upload/paste, OCR picker, stream states, review, append/replace, cancel, 429, idle-abort) | e2, e2b, e2c (GLM-OCR, self-skip), e2d, e19 (student analog) | ✅ |
| Web-augment (toggle, focus hints, degrade, cancel, partial fetch, ms locale) | e2f, e2f-flags (flag-off project) | ✅ |
| Bulk import (mixed paste, invalid-line reject, file upload, persistence) | e43 | ✅ |
| Duplicate (builder toolbar) | e44 | ✅ |
| Metadata edit (inline title dblclick, settings dialog, mode switch, caps, post-publish lock) | e15 | ✅ |
| Question mutations: option-delete key clamp, reorder + end-guards, delete confirm, publish disable-at-0, double-click idempotency | e23 | ✅ |
| Regenerate question | e2b | ✅ |
| Publish → Live; close quiz (reveal-first CTA, close-anyway, idempotent) | e1b, e35, e36 | ✅ |
| EditQuestionDialog (option surgery, image replace/remove) | e20, e28 (lecturer parity test) | ⏳ e28 pending selector updates |
| Retake enable on live quiz | e37 | ✅ |
| Shuffle toggle persist | e42 | ✅ |
| QuizSourcesCard provenance | 🟡 incidental (e2f source chips) | 🟡 |

## 2.7 `/lecturer/quizzes/[id]/results` + `[sessionId]` (desktop)

| Path | Specs | Verdict |
|---|---|---|
| Session rows: statuses (completed/flagged/abandoned/in-progress), scores, face-check summary, incident clips, expansion | e13, e25, e16 | ✅ |
| Export xlsx (3 sheets, distribution, insights panel) | e18 | ✅ |
| Reveal (dialog, one-way) | e40, e5b, e36, helpers `revealQuiz` | ✅ |
| Close quiz + cool-down + reveal-first | e35, e36 | ✅ |
| Unlock flagged / Face-exempt (reason required) / Reset (confirm, keeps row on cancel) | e7, e14, e5b, e41b | ✅ |
| Status filter chips | 🟡 | 🟡 |
| Insights entry card → `/insights` (low-correct badges, distribution bars) | 🟡 via e18's insights panel, not the route | 🟡 |
| Per-session detail: score tile, ✓/✕ option verdicts | e25 | ✅ |

## 2.8 `/student/classes` (desktop ≥sm: header button join)

| Path | Specs | Verdict |
|---|---|---|
| Join via header button → drawer/dialog → OTP → success | e24, e26 (helpers `openJoinDrawer`) | ⏳ pending (infra) |
| Wrong-code alert; rejoin toast; roster isolation | e1 (test 2) | ⏳ pending (infra) |
| Join via empty-state CTA (zero state) | e1, e1b, e2, m1 | ✅/⏳ |
| Hero live-quizzes stat card → `/student/quizzes` | 🟡 incidental | 🟡 |
| Class card → `?class=<id>` | e46 | ✅ |

## 2.9 `/student/quizzes` (desktop: hero, stat cards, card grid)

| Path | Specs | Verdict |
|---|---|---|
| Start → `/play/<id>`; 409 resume; disabled Start while starting | e5, e37, e40, e1b, e2, e38, e46, helper `startQuizByTitle` (≈20 specs) | ✅ |
| Awaiting-results disabled button; retake coexistence; View results link (aria-label w/ title) | e5, e37, e40 | ✅ |
| Deadline chips (amber <24h), ms locale, sorting | e46 | ✅ |
| Class filter chip + remove | e46 | ✅ |
| Empty state (foreign uuid) | e46 | ✅ |
| Face-enroll banner → enroll page | e3 | ✅ |
| Hero title "Available quizzes" | e1b/e2/e4/e5b | ✅ |

## 2.10 `/play/[sessionId]` (desktop ≥lg: sidebar HUD, inline actions, wide camera)

| Path | Specs | Verdict |
|---|---|---|
| Click answer → feedback (practice) / keyless ack (assessment) → Next/Finish → EndScreen | e4, e5, e10, e11, e45, helper `completeQuiz` | ✅ |
| Multi-select toggle + Confirm + gesture commit | e45 | ✅ |
| Practice checkpoint resume (reload → Q2); completed-URL replay; Try again fresh session | e4, e27, SQ-3 contract | ✅ |
| Timer: countdown, role=timer, assertive announcement, expiry auto-submit; late-answer 403 | e10 | ✅ |
| Answer secrecy (no correct_index/explanation over network; keyless 409) | e11 | ✅ |
| Face gate (Begin+blink), consent, timed-gate auto-submit, re-enroll | e3 | ✅ |
| Continuous verification: reload-before-Begin, Q-transition verify, periodic, mismatch→pause | e12 | ✅ |
| Pause/flag cycles: 3 fails → flagged, no self-recover; blink recover | e6, e22 (timed pause clock integrity) | ✅ |
| Unlock → rotated nonce re-verify → answer → EndScreen; bell deep-link | e7, e41b | ✅ |
| Gesture calibration Continue/Skip; hold-to-answer; accidental-lock reset; hand-loss pause; palm-next; 5-option no-palm | e8, e9, e9b, e9c, e45 | ✅ |
| Integrity advisories: window blur, second face, looked away → lecturer sees chips | e16 | ✅ |
| Availability window: not-open 409, mid-session close 409 auto-submit | e38 | ⏳ seam-dependent |
| Quiz closed: start 404, dead screen; close grace: submit 200, stranded reveal | e35, e36 | ✅ |
| Shuffle: order plan, canonical answers, resume slot, breakdown order | e42 | ⏳ seam-dependent |
| EndScreen desktop: score, breakdown VList, verdict rows, Back to quizzes | e45, e42, e36, e5, e27, e38 | ⏳ (see End Screen sections; e45 line 218 needs rewrite) |
| Network failure UX: abort answer retry, abort submit resume | e24 | ⏳ pending (infra) |

## 2.11 `/student/my-quizzes` + editor (desktop: cards, inline add form, gutter icons)

| Path | Specs | Verdict |
|---|---|---|
| Create → editor; share/unshare; delete cascade; share dialog (copy) | e17, e32 | ✅ |
| Share rotate ("New code" invalidates old), unshare mid-play 404 fatal | e32 | ✅ |
| Self-play: answers, feedback, results; checkpoint resume + corrupt-checkpoint fallback | e27, e17 | ✅ |
| Question images: staged upload, preview, render in play + share, validation, drag-drop, edit-dialog remint | e20 | ⏳ helper update pending |
| Student AI generate (paste text, append) | e19 | ⏳ helper update pending |
| Editor mutations: reorder, delete, option-surgery clamp, lecturer parity | e28 | ⏳ tests 1–2 need selector updates; test 3 likely green |
| Practice quizzes lifecycle incl. login-wall redirect back to `/s/<code>` | e17 | ⏳ helper update pending |
| Editor desktop gutter: tooltips, move up/down end-guards | e28 (needs gutter selectors) | ⏳ |

## 2.12 `/play/student/[quizId]`, `/s/[code]`, `/student/face/enroll` (desktop)

| Path | Specs | Verdict |
|---|---|---|
| `/s/[code]`: login-wall redirect back, play shared quiz, invalid/revoked neutral screen, unshare mid-play | e17, e32 | ✅ |
| Self-play results desktop: VList review, disc grammar | — (no spec; grep-verified no assertions) | 🟡 gap, low risk |
| Face enroll: consent, angles, revoke, result modal, camera-failure retry | e3 | ✅ |
| Notification bell (desktop popover): join/publish notifications, row navigate, mark-all | e30 | ✅ |
| Theme toggle (topbar ≥sm): cycle, persist, no FOUC, BM labels | e41 | ✅ |
| i18n switch EN↔MS + raw-key sweep | e31 | ✅ |
| Error boundary (dev route, Retry/Return home) | e34-error-boundary | ✅ |
| Avatar upload/remove (popover branch) | e21 | ✅ |
| InsightFace real-model smoke | insightface-smoke (FACE_SMOKE-gated, API-only) | ✅ opt-in |

**Desktop bottom line:** the desktop suite is comprehensive across
lecturer create→author→publish→results, the full session player
(click/gesture/face/timer/window/close), and student quiz consumption.
Pending desktop items are the selector/helper updates and infra re-runs
documented in the per-redesign sections below — not unmapped flows.

---

# PART 3 — Scenario audit: errors, edges, alternate paths (per surface)

> Every non-happy-path branch read out of the client components, mapped to
> the specs that assert the user-visible result. "NONE" = no spec asserts
> that result anywhere. ⚠️ = a spec covers the area but the specific branch /
> copy may not be asserted. This layer answers "what happens when the user
> *doesn't* do the happy path".

## 3.1 Student classes (`student-classes-client.tsx`)

| Scenario (trigger → user-visible result) | Coverage |
|---|---|
| Join POST 409 already-enrolled → toast "You are already enrolled in that class." | ✅ e1 |
| Join with wrong code → inline `role="alert"` "That join code is not valid." | ✅ e1 |
| Join network throw → generic "Something went wrong" alert | ❌ |
| Join success → toast + drawer auto-dismiss (900ms) + roster refresh | ⚠️ e1 (text asserted; 900ms timing not) |
| Join button disabled until 6 chars; double-submit lock | ⚠️ (same OTP pattern asserted for matric in e47 only) |
| Cancel / Escape drawer → error state cleared | ❌ |
| Zero classes → EmptyState + join CTA | ✅ e1, m1 |

## 3.2 Student quizzes hub (`student-quizzes-client.tsx`)

| Scenario | Coverage |
|---|---|
| Start 409 `already_attempted` + session_id → redirect into existing session | ⚠️ e37 (API contract); UI branch unreachable by click per e5 |
| Start 409 `already_attempted` w/o session_id → per-card "Completed" status | ❌ |
| Start 409 `quiz_not_open` → inline "isn't open yet" alert | ✅ e38 |
| Start 409 `quiz_window_closed` → inline "window has closed" alert | ✅ e38 |
| Start 404 / network throw → generic inline alert | ❌ (e35 asserts the API 404 only) |
| Zero live quizzes empty state | ✅ e26, e46 |
| Face-enroll banner (desktop) / pill (mobile) | ⚠️ (downstream gate covered by e3; the banner itself not) |
| Disabled "Awaiting results" button (completed+unrevealed, no retake) | ✅ e5, e37 — **desktop-only markup; mobile rows end at the text** (M24) |
| Retake: awaiting chip + Start coexist; budget exhaustion redirects to last EndScreen | ✅ e37, e40 |
| "View results - {title}" link after reveal | ✅ e40 |
| Deadline chips: due chip, amber <24h, ms "tamat", removed ≥24h/undated | ✅ e46 — grey "Closed" chip (cron lag) ❌ |
| Retake meta lines ("Unlimited tries" / "Up to N attempts" / "One attempt only") | ⚠️ e37 ("One attempt only" only) |
| Class filter chip + "Remove class filter" | ✅ e46 |
| Double-start guard ("Starting…" disabled) | ❌ |

## 3.3 My Quizzes hub + `/new` (`my-quizzes-client.tsx`)

| Scenario | Coverage |
|---|---|
| Create drawer: empty title → "Give your quiz a title first." + focus | ❌ |
| Create POST fail → inline alert | ❌ |
| 0-question card routes to editor; "No questions yet" | ✅ m1-my-quizzes (mobile); desktop disabled-Play ❌ |
| Delete: "cannot be undone" warning, Cancel returns, success toast | ⚠️ m1 (cancel+warning); success toast not asserted |
| Share mints link; Copy → "Copied!" toast | ✅ m1 (clipboard grant + toast) |
| Unshare → "Sharing stopped." toast + dialog force-close | ⚠️ e32 (API + link-death asserted; toast/dialog-close not) |
| Rotate two-step ("New code" → Confirm) kills old link | ✅ e32 |
| Share dialog spinner ("Preparing your link…") when no code yet | ❌ |
| `/new`: empty-title guard, POST-fail, "Submitting…" double-submit lock, maxlength 200/500 | ❌ all |

## 3.4 Student editor (`editor-client.tsx`)

| Scenario | Coverage |
|---|---|
| Add at 50-question cap → banner "A quiz can hold up to 50 questions." + Generate disabled | ❌ |
| AI merge over cap → capNotice toast | ❌ |
| Zod localized validation (prompt required, ≥2 options, duplicates, pick correct) | ❌ (server-side only, indirectly) |
| Add POST fail → page banner with dismiss ✕ | ❌ |
| Staged image upload fails after create → question kept + "edit the question to try again" toast | ✅ e20 |
| Edit dialog save fail → in-dialog alert | ❌ |
| Committed image mint/remove failure → uploadFailed/removeFailed | ❌ |
| Delete confirm: Cancel disabled while busy ("Loading…") | ⚠️ e28 (confirm asserted; busy-disable not) |
| Reorder boundary-disabled (first/last) | ⚠️ e28 (reorder exercised; end-guard disabled state not) |
| Option bounds: min 2 (remove disabled), max 5 (Add hidden); true_false locks inputs | ❌ (lecturer TF-lock partially in e45/e1b) |
| Mobile "To review" filter all-reviewed → "Everything reviewed!" empty state; localStorage persist + corrupt-storage fallback | ❌ |
| Settings sheet: empty-title guard + PATCH fail alert | ❌ |

## 3.5 Session player `/play/[sessionId]` (`play-client.tsx` + overlays)

| Scenario | Coverage |
|---|---|
| Answer 403 `time_expired` → timeUp + auto-submit | ✅ e10 (API); UI transition ⚠️ via e38/e10 |
| Answer 409 `already_answered` → answered, no key leak | ✅ e11, e45 |
| Answer 409 paused → "session is paused" error copy branch | ⚠️ e12 (409 + overlay asserted; this copy branch not) |
| Answer 409 flagged → "flagged for review" copy branch | ❌ (flagged overlay covered by e6/e7; this branch not) |
| Answer 409 completed → terminal dead screen | ❌ |
| Answer 409 `quiz_not_live` (closed) → dead "no longer available" | ✅ e36 |
| Answer 409 `quiz_window_closed` → timeUp + grace submit | ✅ e38 (practice); **assessment-mode variant ❌** |
| Answer 404 (lecturer reset mid-flight) → D13 "attempt was reset" dead screen | ✅ e5b |
| Submit 409 `already_submitted` → terminal end state | ⚠️ e38 (API idempotency; UI branch not) |
| Submit fail → inline "Retry submit" destructive button | ⚠️ e24 (timeout copy + reload-resume; the Retry-submit button itself not) |
| Timer hits 0 → "Time's up" notice + auto-submit | ⚠️ e10 (notice copy not asserted) |
| 0 questions / broken RSC → "no questions yet" alert | ❌ |
| Try again degraded fallback → `/student/quizzes` | ❌ (happy path ✅ e4/e27/e45) |
| Multi palm-commit with 0 pending → "Select at least one option" | ❌ |
| Timer milestones (10m/5m/1m/30s announcements, red flip ≤30s) | ❌ (e10 asserts one 30s announcement only) |
| Quiz info sheet (mobile-only): mode/time/cam status | ❌ |
| Face-unavailable degraded banner ("answers still count") | ❌ |
| Hand-loss warn chip | ✅ e9b |

## 3.6 Face gate + enroll (`face-gate.tsx`, `face-enroll-client.tsx`)

| Scenario | Coverage |
|---|---|
| Gate: no consent → consent card, Begin disabled | ⚠️ e3 (register-level consent; in-gate card branch partial) |
| Gate: enrolled=false → "Go to enrollment" button | ⚠️ (pre-enroll blocking covered; button branch not) |
| Gate: resume banner "N of M answered" + remaining-time chip | ❌ |
| Gate: withholding Begin until timer expiry auto-submits 0/N | ✅ e3-E13 |
| Paused overlay: focus-lost variant copy ("You left the exam window") | ✅ e16-A; other variant copy ⚠️ |
| Flagged overlay "Check again" click | ⚠️ (overlay + poll covered e7/e41b; the click not) |
| Enroll: camera boot failures ×5 (permission/no_device/busy/security/unsupported) body+hint+Retry | ❌ all |
| Enroll: capture timeout / max attempts → failed + Try again | ❌ |
| Enroll: `pending_review` outcome → "Sent for review" dialog | ❌ |
| Enroll: consent revoked → camera-off overlay + toast | ⚠️ e3 (API 403 asserted; visuals not) |
| Enroll: double-click Start re-entrancy lock; lighting chips | ❌ |
| Re-enroll replaces embedding | ✅ e3 |

## 3.7 Self-play + `/s/[code]` (`player-client.tsx`, `shared-quiz-client.tsx`)

| Scenario | Coverage |
|---|---|
| 0 questions → "no questions yet" + Back | ❌ |
| Answer 404 `unavailable` → skip; all unavailable → fatal screen | ✅ e32; per-row "—" review rendering ⚠️ |
| Answer non-ok/malformed → alert + options re-enabled | ❌ |
| Corrupt checkpoint → fresh start; Retry clears checkpoint | ✅ e27 |
| Checkpoint save failure (storage full/private) → silent loss | ❌ |
| Invalid/rotated share code → neutral screen | ✅ e17, e32 |
| Landing 0 questions → Start hidden | ❌ |
| Community banner + "Anonymous" creator fallback | ❌ |

## 3.8 Auth pages (login/register/forgot/reset) + matric

| Scenario | Coverage |
|---|---|
| Wrong credentials → "Invalid email or password." | ✅ e1a |
| Login `?message=check-email` / `sso-domain` / `sso-error` banners | ❌ all |
| `?redirect=` sanitized (open-redirect) | ✅ e33; **positive deep-link redirect honored ❌** |
| Register: password <6 guard | ❌ (e34 covers reset-parity only) |
| Register: invite-code required / invalid | ⚠️ e33 (invalid rejected; empty-code copy not) |
| Register: duplicate email generic error; consent gate | ✅ e1a |
| Forgot: generic no-enumeration confirm; reset confirm guards; expired recovery | ✅ e34; request-error branch ⚠️ |
| Matric gate: bounce, reserved, invalid, success | ✅ e47 |
| Matric: captureOwnMatric throw → generic alert | ❌ |

## 3.9 Shell: user menu + notification bell

| Scenario | Coverage |
|---|---|
| Avatar: >2MB reject; bad type; upload/remove/render | ✅ e21; POST/DELETE failure branches ❌ |
| Sign-out failure → "Could not sign out" alert | ❌ |
| Matric "—" + "Temporary" chip (system-assigned); consent-not-given chip | ⚠️/❌ |
| Bell: empty state | ✅ m1 (mobile sheet); desktop popover ❌ |
| Bell: >20 unread → "Mark all as read?" confirm dialog | ❌ |
| Bell: dead notification target → mark-read + safe redirect | ❌ |
| Bell: 99+ badge clamp; aria-live delta; digest grouping; load-more | ❌ all (1-unread badge + row navigate ✅ e30, e41b) |

## 3.10 Lecturer classes + archived (`classes-client.tsx`, `archived-classes-client.tsx`, `class-detail-client.tsx`)

| Scenario | Coverage |
|---|---|
| Create-class POST fail (400/409 dup title) / network → inline alert | ❌ all |
| Create double-click → one POST (submitLock); "Creating…" disabled | ❌ |
| Zero active classes → EmptyState + archived shortcut link | ❌ |
| Archived hero chip/card link variants | ❌ |
| Restore: PATCH fail banner; global double-restore lock; dialog Cancel | ❌ (confirm path ✅ e26) |
| Archived page: 0 archived empty state; search no-match + Clear search | ❌ (e26 uses search to find, not to miss) |
| Class detail: create-quiz POST fail; window-order 400 mapping; hours clamp on create form | ❌ all |
| Join-code copy toast / clipboard-denied error | ❌ |
| Archive dialog fail branch; restore-from-detail (vs list) | ⚠️ e26 (dialog + restore via list) |
| 0 quizzes / 0 students empty boxes; draft hides Results link | ❌ |
| `?newQuiz=1` deep link + param strip | ❌ |
| Back link targets archived vs active based on `archived_at` | ❌ |

## 3.11 Gradebook + quizzes hub

| Scenario | Coverage |
|---|---|
| Export fail → error toast, button re-enabled | ❌ (success ✅ e18/e39) |
| >50 quizzes truncation notice (GRADEBOOK_QUIZ_LIMIT) | ❌ |
| 0 students / search no-match + Clear filters | ❌ (0 published quizzes ✅ e39) |
| Status filter + 7 sort keys + live visible-count line | ❌ (helpers unit-tested; no e2e drives the selects) |
| Mobile composition (summary meter, chip strip, per-quiz/student sheets, distribution bar) | ❌ entirely (e39 = desktop table) |
| Hub: zero state; search no-match; draft→builder vs live→results routing; archived-class tag | ❌ all |

## 3.12 Builder (`quiz-builder-client.tsx` + dialogs)

| Scenario | Coverage |
|---|---|
| Inline title: empty/max-length/unchanged guards; save-fail 409→refresh, 404→redirect | ❌ (happy + Escape ✅ e15) |
| Add-question POST fail → error band | ❌ |
| Multi-select blocked >4 options (`multiOptionCap`); mcq add-option hidden at 5 | ⚠️/❌ (e45 pins 4-option authoring; cap error not asserted) |
| maxLengths (prompt/option/explanation 2000/500/2000) | ❌ |
| **Builder-surface close dialog** (cool-down guard, reveal-first CTA, close-anyway, in-dialog error) | ❌ — e35/e36 drive the *results-dashboard* dialog only |
| Close/publish visibility gating (draft-only vs live-only controls) | ❌ |
| Mobile reviewed-checklist + all-reviewed empty state + corrupt localStorage | ❌ (mobile-only composition) |
| Publish fail band (409 no_questions / quiz_closed / 429) | ⚠️ (API contracts e23/e35; UI band not) |
| Bulk import: file >512KB; 30-cap quizFull; server errCap/errRateLimited; 11 other problem codes; reset-on-close | ❌ (mixed paste, atomic reject, file happy path ✅ e43) |
| Duplicate: archived-destination 409; rate-limit; toast "Open draft" action; double-submit | ❌ (happy + Cancel ✅ e44) |
| EditQuizDialog: client+server windowOrderError; metadataLocked disabled UI; sub-minute warning; maxAttempts clamp; empty-diff no-PATCH | ❌ (2h clamp, Escape, mode flip ✅ e15; windows ✅ e38) |
| Regenerate: steering, 500-cap, error/already_running/409-on-live, Cancel | ❌ (happy ✅ e2b) |
| Generate dialog: file >25MB, >5 files, >50MB total, empty-text, GLM failure family, low-density advisory, 20-min timeout, saved_refresh_failed, count clamp 3–30, Cancel-button aborts | ❌ (unsupported type ✅ e2; stream states + cancel ✅ e2d; degrades ✅ e2f) |

## 3.13 Results dashboard + session detail

| Scenario | Coverage |
|---|---|
| Export/reveal/close/unlock/exempt/reset error branches | ❌ all (success paths ✅ e14, e18, e36, e7) |
| Close/reveal/reset cool-down guards (confirm disabled after one attempt) | ❌ |
| Reset 404-idempotency mapped to success | ❌ (flow ✅ e5b) |
| Status filter chips (zero-count hidden, narrows rows) | ❌ |
| Attempt #N chip; advisory chips (second face / looked away / voice / headset) | ⚠️/❌ (advisory chips surfaced by e16; the dashboard chips not asserted) |
| Incident clip cards + playable `<video>` | ❌ entirely |
| Insights: hidden-when-0-questions; insights page `notFound()` at 0 questions | ❌ (card + degenerate subtitle ✅ e18) |
| Session detail: flagged/abandoned status pill; total=0 panel; Skipped verdict; null-name fallback | ❌ (completed + ✓/✕ ✅ e25) |

## 3.14 Cross-cutting permission/ownership edges

| Scenario | Coverage |
|---|---|
| Non-owner lecturer → 404 on class detail / builder / results / session detail | ❌ (gradebook only ✅ e39; foreign /play ✅ e29) |
| Student → lecturer URLs and back | ✅ e29, e33 |
| Error boundary page + Return home | ✅ e34-error-boundary |
| profileSettingUp / quizLoadError play-page guard panels | ❌ |

---

# PART 4 — State machines & interruptions

> Transitions read from the API route handlers + migrations + client phases
> (`quiz_status: draft|live|closed`, `session_status: active|paused|flagged|
> completed`, client phases `question|locked|feedback|submitting|submitted|
> timeUp|dead`). Every row is desktop-viewport coverage unless noted.

## 4.1 Quiz lifecycle

| From → To (trigger) | Student sees | Lecturer sees | Coverage |
|---|---|---|---|
| draft → live (Publish ≥1 question) | Card appears, Start enabled | Chip flips Live | ✅ e1b |
| live → live (idempotent re-publish 200) | — | No change | ❌ |
| draft publish with 0 questions → 409 `no_questions` | — | Button disabled (e23) | ⚠️ (API contract e35; fail band ❌) |
| closed → live attempt → 409 `quiz_closed` | Card stays hidden | "Closed" chip | ✅ e35 |
| live → closed (Close; CAS; draft→409; closed→200 idempotent) | Card disappears; Start 404 | Close unmounts | ✅ e35; **builder-surface close dialog ❌ (dashboard only)** |
| unrevealed → revealed (Reveal; one-way; closed+unrevealed recoverable) | "Awaiting results" → "View results" → scored EndScreen | "Results revealed" chip; idempotent `{already:true}` | ✅ e36, e40; **double-reveal idempotency ❌; reveal-on-practice 409 ❌; `results_revealed` bell row ❌** |
| auto-reveal on last submit (`auto_reveal_on_complete`) | As reveal | As reveal | ❌ — `setAutoReveal` helper exists (helpers.ts:951), **no spec calls it** |
| × practice/assessment mode (frozen once live) | Mode copy + gate | Row actions | ✅ e1b/e4/e5/e15 |
| × retakes (enable on live; budget exhaustion) | Chip + Start coexist; exhausted Start → last EndScreen | Attempt #2 chip | ✅ e37, e40 |
| × shuffle (per-session order; reload-stable; canonical answers) | Permuted; resume re-derives | Toggle in settings | ✅ e42; **toggle driven through dialog UI ❌ (seeded via service-role)** |
| × window before/within/after (`opens_at`/`closes_at`) | "not open" / normal / "window closed" | Window chip; cron autoclose | ✅ e38; **stale-session void-sealing on start ❌** |
| × time limit (+5s grace) | Countdown, auto-submit | Time chip | ✅ e10, e22, e15 |

## 4.2 Session lifecycle

| From → To (trigger) | Student sees | Lecturer sees | Coverage |
|---|---|---|---|
| start → active (practice rejoin returns existing) | Play page | "In progress" row | ✅ e4+, many; **explicit rejoin-after-tab-close ❌** |
| active → paused (face mismatch / hand loss / window blur) | Pause overlay, answers blocked | In-progress + fail counters | ✅ e12, e9b, e16-A, e22 (clock integrity) |
| paused → active (blink self-recover; timer extended; nonce rotated) | Overlay clears, resumes | — | ✅ e9b, e16-A, e22 |
| paused/active → flagged (3rd strike) | "Assessment flagged"; no self-recover (403); 8s poll; submit 409 | Row Flagged + Unlock; `session_flagged` bell | ✅ e6, e16-A, e7 (403), e14; **flagged∩timeUp Retry-submit interplay ❌** |
| flagged → active (lecturer Unlock; re-verify before clearing) | Overlay clears after re-verify | Unlock UI + `session_unlocked` bell | ✅ e7, e14, e41b |
| any → completed (submit; idempotent) | EndScreen (awaiting release until reveal) | Completed row + score | ✅ e4, e5, e10, e36 |
| any → deleted (lecturer Reset) | Mid-flight 404 → D13 dead screen; fresh Start works | Row gone; audit row; `session_reset` bell | ✅ e5b (flow + audit); **reset-then-direct-URL 404 page ❌; `session_reset` bell row ❌** |
| any → time-expired (countdown → auto-submit; late answer 403) | "Time expired" chip; Retry-submit if auto-submit failed | Completed score-as-is | ✅ e10 |
| >2h inactive → Abandoned (display-only derivation) | (tab reopen resume untested) | Abandoned badge + face summary | ✅ e13; **mid-state mobile viewport ❌** |
| face unavailable (boot fail/5xx) | Passthrough play continues | "Camera unavailable" marker | ✅ e13 (marker); **mid-quiz degradation overlay ❌** |
| → exempt (lecturer Face-exempt, reason required) | Gate/verify skipped | Row action + refresh | ✅ e14; **student-side exempt reload state ❌** |

## 4.3 Close/reveal/archive interruptions while student holds the tab

| Trigger | Student sees | Coverage |
|---|---|---|
| Close mid-session → next answer | 409 `quiz_not_live` → dead screen | ✅ e36, e35 |
| Close mid-session → in-flight submit | Grace: submit 200 (submit-only grace) | ✅ e36 |
| `closes_at` passes mid-session → next answer | 409 window-closed → Retry-submit → grace | ✅ e38 (practice); **assessment variant ❌** |
| Unlock while parked on flagged screen | Poll clears overlay | ✅ e7 |
| Reveal while student on list | Chip → View results | ✅ e40 |
| **Archive while student mid-play** | Answers → `quiz_not_live` dead screen (implied) | ❌ — e26 archives with student idle only |

## 4.4 Class / share / identity lifecycles

| Transition | Coverage |
|---|---|
| active → archived → restored: student loses class+quizzes, rejoin blocked ("This class has been archived"), restore re-exposes with roster preserved | ✅ e26 |
| Share: unshared → shared (idempotent re-share same code) | ✅ e17 (mint); **idempotency assertion ❌** |
| Share: rotated (old code dies atomically) | ✅ e32 |
| Share: unshared mid-play → 404 `unavailable` → fatal screen; reload → neutral | ✅ e32, e17 |
| Face: not enrolled → enrolled (re-enroll replaces) | ✅ e3 |
| Face: consent granted/revoked/re-consent | ✅ e1a, e3 |
| Face: `pending_review` (gate treats as not enrolled) | ❌ |
| Matric: null matric → capture bounce → success | ✅ e47 |

## 4.5 Navigation / interruption scenarios

| Scenario | Landing | Coverage |
|---|---|---|
| Refresh mid-quiz, gate not begun | Gate re-renders (not bypassable) | ✅ e12 |
| Refresh mid-quiz, active (both modes) | Resume at first unanswered; shuffle re-derived | ✅ e4, e11, e42 |
| **Refresh while paused (server-seeded)** | Pause overlay directly | ❌ |
| **Refresh while flagged** | Flagged overlay + poll resumes | ❌ |
| Refresh on completed | EndScreen directly; closed+revealed fallback | ✅ e4, e36 |
| Foreign /play/<id> / non-UUID | 404 no-oracle | ✅ e29; **lecturer-visits-/play redirect ❌; reset-then-direct-URL ❌** |
| **Browser back mid-quiz** | No guard; endpoints idempotent | ❌ |
| sessionStorage checkpoint present / corrupt / absent | Resume / fresh / fresh | ✅ e27; **storage-full branch ❌** |
| Try again → new session (409 fallback → existing; degraded → list) | New session | ✅ e4/e27/e45; **degraded fallback ❌** |
| Aborted answer/submit (network) | Retry records once / reload-resume completes | ✅ e24 |
| Logged-out on /play, /student/* | /login (share link preserves redirect) | ✅ e29, e17 |

---

# PART 5 — Cross-cutting dimensions

| Dimension | Behavior | Coverage |
|---|---|---|
| **i18n** | Login/auth toggle + persistence; forgot/reset BM; theme labels; quizzes chips + full ms play journey; generate dialog BM | ✅ e31, e34, e41, e46, e2f, e2d |
| i18n | Raw-key leak sweep — **EN locale only** (e31 test 3 never flips to ms) | ⚠️ partial |
| i18n | Builder, bulk-import, duplicate, results dashboard, session detail, gradebook, class detail, archived, dock FAB, face enroll, face gate/overlays, play HUD toasts, calibration, my-quizzes share/sqPlayer, notifications, matric, account menu, media fields — **ms rendering asserted by NO spec** | ❌ (parity is 1222/1222 — copy exists, untested) |
| **Theme** | Toggle cycle, persist, FOUC, BM labels (login + dashboard only) | ✅ e41 |
| Theme | `dark:` variants exist in ~39 files (class-detail amber pattern, gradebook, results, play, end-screen, builder…); **no spec renders any surface in dark** | ❌ |
| **A11y** | Play milestone sr-only region; role=timer; gesture-unavailable chip; sr-only "View quizzes" link name | ✅ e10, e9c, 20+ specs |
| A11y | Escape-close asserted across drawers/dialogs/sheets | ✅ m1 ×3, e48, e2d ×4, e2f, e21, e47, e15 |
| A11y | Dialog focus traps (Tab cycling); dock keyboard activation; live-count regions (gradebook/hub/builder/classes/editor); bell aria-live delta; auth aria-live wrappers; `common.aria.your*Choice` sr-only lines | ❌ all |
| **Touch** | Mobile-project journeys (dock, join, play, submit); nav drawers; password toggle; 360×640 overflow | ✅ m1, e48, e2f |
| Touch | `:active` press physics / `pointer:coarse` branches; scroll-aware FAB hide/show; `useKeyboardOcclusion`; safe-area insets; wake lock (enroll) | ❌ all |
| **Network** | route.abort answer/submit/generate; AI idle-abort; 429 already_running; web-search 5xx/401/partial degrades; 500 on image upload keeps field | ✅ e24, e2d, e2f, e20 |
| Network | 429 UX everywhere else (signup/reset — raised harness-wide; import/duplicate/generate errRateLimited; class join) | ❌ (limits disabled in harness by design) |
| Network | 401 expired-session mid-use; 500 on data APIs (gradebook loadError); offline/reconnect | ❌ |
| **Uploads** | Avatar 2MB + bad type + render/remove | ✅ e21 |
| Uploads | Question image: type/5MB/drag-drop/remove/500-keeps/edit-replace/signed-URL | ✅ e20 (17 tests) |
| Uploads | Generate dialog: unsupported .exe; multi-file count | ✅ e2; **25MB file / 5-file / total-bytes caps, uploadError ❌** |
| Uploads | Bulk import file happy path (.txt/.csv) | ✅ e43; **>512KB gate ❌** |
| **Clipboard/permissions** | Share "Copy link" (grants perms + toast) | ✅ m1 (only clipboard assertion in suite) |
| Clipboard | Class-detail join-code copy / copy-denied; share copy at desktop width; WhatsApp handoff | ❌ |
| Permissions | Camera permission *denial* (enroll cameraFailure.* family; play-gate degraded card) | ❌ — specs only use the fake-tracker seam; no deny simulation |
| **Data display** | Results + gradebook Excel export (ExcelJS parse); insights panel; avatar render; session detail score/✓/✕ | ✅ e18, e39, e25, e21 |
| Data | Incident clips UI; gradebook 5-bucket distribution bar; end-screen praise tiers; `aria.your*` badges; sqPlayer results; Skipped verdict | ❌ all |
| **i18n parity note** | `play.end.verdict*` keys **do not exist** — session-detail verdict words ("Correct/Wrong/Skipped") are hardcoded locale ternaries in `session-detail-client.tsx:123-129` (code with no i18n key). The `nav.*` checker warnings for `dock-fab-actions.tsx` are false positives (namespace mis-attribution). | ⚠️ code gap, not test gap |

---

# PART 6 — Consolidated gap list (priority-ordered)

> Merged from the path map (Part 1–2 ❌s) and the scenario audit (Parts 3–5
> NONEs). Tier A = user-visible flows a user will realistically hit; Tier B =
> error/edge branches worth one cheap spec each; Tier C = known low-value /
> harness-limited.

## Tier A — user-facing flows with zero coverage

1. **Play surface mobile chrome** (M30–M46): sticky header/timer chip, info
   sheet, fixed action bar, gesture PIP + calibration mobile dock, EndScreen
   ScoreRing + verdict accordion. *Suggested: `m2-mobile-play.spec.ts`.*
2. **Refresh while paused / flagged** (4.5): server-seeded overlay states
   never reloaded. *Add to e6/e12 as reload steps.*
3. **Mobile gradebook composition** (3.11): chip strip, per-quiz/student
   sheets, distribution bar — zero coverage at any viewport.
4. **My-quizzes editor mobile workflow** (M52–M58): accordion rows,
   add-question sheet, reviewed checklist + filters, settings drawer.
5. **Builder mobile composition** (M68): accordion + reviewed checklist +
   footer publish bar + add-sheet (only the <768px add-sheet branch is
   exercised, inside m1's lecturer context).
6. **Incident clips in results dashboard** (3.13): expand + playable video
   never touched.
7. **Scroll-aware FABs** (M16, M49): hide-on-scroll-down / return — verified
   manually only, no spec at any viewport.
8. **Lecturer dock FAB actions** (M4–M5): New class / New quiz deep-link
   (`?newQuiz=1` auto-open + param strip also ❌).
9. **Camera permission denial UX** (3.6): the whole `cameraFailure.*` family
   + play-gate degraded card — specs only use the fake-tracker seam.
10. **Face enroll failure paths** (3.6): capture timeout, max attempts,
    `pending_review` outcome, camera boot failures.
11. **Class detail mobile tab switcher + ⋯ menus + create modal** (M65–M67).
12. **Mobile notification actions** (M10): row-navigate + mark-all-read in
    the drawer branch.
13. **Share drawer desktop width + WhatsApp handoff** (3.3/Part 5).
14. **`/student/quizzes` mobile awaiting-state divergence** (M24): the
    disabled "Awaiting results" button does not exist <sm — any future
    mobile spec must not copy e5's assertion verbatim.

## Tier B — error/edge branches (cheap, high-value)

15. **Auto-reveal on complete** (4.1): `setAutoReveal` helper exists and is
    unused — one spec closes the loop end-to-end.
16. **Assessment-mode mid-session window close** (4.3): e38b is practice-only.
17. **Non-owner lecturer 404s** on class detail / builder / results /
    session detail (3.14).
18. **Builder-surface close dialog** with cool-down + reveal-first CTA (3.12).
19. **Flagged ∩ timeUp interplay**: Retry-submit under flagged overlay (4.2).
20. **Archive-while-mid-play** student dead screen (4.3).
21. **`?redirect=` positive deep-link honored post-login** (3.8).
22. **Bulk-import caps**: >512KB, quiz-full 30-cap, server errCap/429 (3.12).
23. **Generate dialog caps**: >25MB file, >5 files, total-bytes, empty-text,
    low-density advisory, saved_refresh_failed (3.12).
24. **Editor 50-question cap** (banner + disabled Generate + capNotice toast)
    and option min/max bounds (3.4).
25. **Multi-select >4-option cap error** (`multiOptionCap`) (3.12).
26. **Reset-then-direct-URL** 404 page; **`session_reset`/`results_revealed`
    bell rows** (4.2).
27. **Bell >20 confirm-clear dialog; dead-target redirect; 99+ clamp** (3.9).
28. **Hub/archived/classes empty + search-no-match states** (3.10, 3.11).
29. **Session-detail edge renders**: flagged/abandoned pill, Skipped verdict,
    total=0 panel (3.13).
30. **Gradebook search/filter/sort/truncation notice** via the UI selects (3.11).
31. **EditQuizDialog windowOrderError** (client + server) + metadataLocked
    disabled UI (3.12).
32. **My-quizzes `/new` + create-drawer validation guards** (3.3).
33. **Join-code copy-to-clipboard (desktop card)** + copy-denied error (3.10).
34. **Register password <6 guard; login `?message=` banners** (3.8).

## Tier C — known-limited / lower value

35. **429 rate-limit UX** — harness raises all limits to 1000 by design; the
    copy is only reachable via direct route-level tests (vitest covers these).
36. **Dark-mode rendering** — e41 covers the toggle; surface-level `dark:`
    screenshots are a visual-review concern, not e2e.
37. **`:active` press physics / safe-area / wake lock** — device-farm concerns.
38. **Focus traps / keyboard nav sweeps** — would need an a11y-focused pass
    (axe-core) rather than per-flow specs.
39. **ms rendering per surface** — parity is enforced at 1222/1222 by
    `scripts/check-i18n.mjs`; a second full ms suite would double CI cost.
    Cheapest win: extend e31's raw-key sweep to run once under ms locale.
40. **Browser back mid-quiz** — no guard exists; endpoints idempotent; low
    signal per spend.
41. **401 mid-use / offline-reconnect** — Supabase seam complexity vs value.

## One-line summary

Desktop happy paths are comprehensively covered. The real exposure is
**(a) every mobile-only composition beyond the two m1 specs, (b) mid-state
interruptions (refresh while paused/flagged, archive mid-play, builder-side
close), and (c) the error-branch layer — API contracts are pinned by specs
but the UI error copy/bands those contracts map to are mostly unasserted.**

---

# PART 7 — Audit method (for future re-runs)

- **Path layer (Parts 1–2)**: 3 Explore subagents swept (1) student/shared
  client components, (2) lecturer client components + shells, (3) all 61
  e2e specs + helpers into a spec→route matrix. Branch mechanisms verified
  in source (`useMediaQuery` queries, `sm:hidden`, ResponsiveModal splits).
- **Scenario layer (Parts 3–5)**: 4 Explore subagents swept (1) student/
  shared error-empty-boundary branches, (2) lecturer error/guard branches +
  API error contract, (3) state machines from route handlers + migrations +
  navigation interruptions, (4) cross-cutting dimensions. Every scenario was
  grepped against `e2e/*.spec.ts` by i18n copy, error codes, and API paths.
- Cross-checks performed: i18n parity script re-run (1222/1222);
  `m1-my-quizzes.spec.ts:71` radio-vs-Select conflict verified in source;
  playwright project gating re-read from `playwright.config.ts`.

---

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

---

# Pending E2E Tests — Student Practice-Quiz Editor Mirrors Lecturer Builder

> Added 2026-09-09. `/student/my-quizzes/[id]/edit` (`editor-client.tsx`) was
> rebuilt to mirror the lecturer quiz builder's composition. **Per user
> instruction the e2e specs were NOT touched** — all planned spec updates are
> recorded here instead. Typecheck + eslint green; i18n parity green (1210/1210
> keys; the 5 pre-existing `nav.*` failures in `dock-fab-actions.tsx` are from
> other uncommitted work, identical on a clean tree).

## What changed on the surface

- **Hero band** (lecturer parity): back link + settings gear, big title
  (double-click opens settings), chip row — Practice mode chip, description
  chip (or "Add description" when empty; opens settings), question-count chip
  — and a desktop action cluster (Generate with AI accent button + Preview
  outline button). Mobile gets the anchored action strip: empty quiz →
  Generate as primary; with questions → Add question primary + Preview + ⋯
  menu (Generate / Quiz details).
- **Settings constrained** to title + description (everything the lecturer's
  `EditQuizDialog` controls — mode, time limit, windows, retakes, shuffle —
  does not exist for practice quizzes). Same ResponsiveModal shell with pinned
  mobile footer (`form="student-quiz-settings-form"` association). The old
  always-open "meta card" with Save/Generate/Preview buttons is gone.
- **Questions section** is now one paper card (lecturer parity): mobile =
  accordion rows (check circle + 2-line prompt + chevron; expansion shows type
  label, A/B/C/D option rows with green key highlight, explanation, Edit
  button + ⋯ menu with Move up/down/Delete) with the reviewed-checklist filter
  toolbar (localStorage-backed, `student-editor-reviewed-<quizId>`); desktop =
  paper rows with a quiet icon gutter (Edit / Move up / Move down / Delete
  with tooltips). Empty state uses the shared EmptyState illustration.
- **Add-question**: mobile bottom Sheet (stays open for batch authoring) /
  desktop inline card, with the lecturer-style form — type Select (mcq /
  true_false; no multi_select on student schema), correct-answer Select, Textarea
  prompt, staged image between prompt and options, numbered clay option chips
  (click = mark correct; the radio fieldset is gone from the ADD form), option
  move/remove icons, Add option, explanation. The EDIT dialog keeps the
  radio-based OptionDraftForm.
- Error banner gained a dismiss ✕; title/description save toast reuses
  `myQuizzes.updatedNotice`.

## E2E impact (specs NOT updated — update when re- enabled)

- **e28 (editor mutations) — 3 tests now BROKEN against the new UI:**
  1. *Reorder*: `cards()` was `page.locator("ol > li")` per-question clay
     cards with four inline icon buttons; the question list is still `<li>`
     items but **move buttons are now inside the ⋯ dropdown** on mobile and
     tooltip-gutter icons on desktop (desktop: `article` inside `li`, buttons
     named `Move up`/`Move down` via `lecturer.builder`-equivalent keys —
     en "Move up"/"Move down" with aria-labels "Move option up"/"Move option
     down"). End-guard assertions (first/last disabled) still exist on desktop
     gutter buttons.
  2. *Delete*: per-row button name changed from `Delete` exact to the gutter
     trash (aria-label "Delete" via `common.delete`) — name survives on
     desktop; on mobile it's a menu item.
  3. *Option surgery*: edit dialog unchanged EXCEPT prompt uses `#edit-prompt`
     (label "Prompt") and options remain `fieldset input[maxlength='500']`
     with radio "Mark the correct answer: X" — should still pass.
  4. `addQuestion()` helper in e28/e17/e19/e20 fills
     `fieldset input[maxlength='500']` + `getByRole("radio").first()` — **the
     add form no longer has radios** (mark-correct is the numbered chip /
     correct-answer Select). Helpers must switch to the Select
     ("Correct answer" → "Option 2") or click the chip button.
- **e17**: "Preview quiz" link name still exists (hero + questions header +
  mobile strip) — `/preview quiz|play/i` regex still matches.
- **e19/e20**: rely on `add this question` submit button (kept: "Add this
  question"), `textbox name /prompt/i` in the add form (kept, now a Textarea
  with aria-label "Prompt"), and the edit dialog ("Edit question" pencil,
  `getByLabel("Prompt")`, radios in OptionDraftForm) — all preserved.
- **m1/e48 mobile**: no assertions on the editor body were found (nav/dock
  only) — unaffected.
- **New i18n keys** (`quizEditor.*`, en+ms, 24 each): `questionTypeLabel`,
  `correctAnswerLabel`, `optionLabel`, `questionsHeader`,
  `addQuestionSubtitle`, `moreActions`, `moveUp`, `moveDown`,
  `reviewFilterLabel`, `filterAll`, `filterUnreviewed`, `reviewedProgress`,
  `markReviewed`, `markUnreviewed`, `noQuestionsTitle`, `noQuestionsSubtitle`,
  `allReviewedTitle`, `allReviewedSubtitle`, `practiceChip`, `addDescription`,
  `editSettings`, `settingsTitle`, `settingsSubtitle`, `questionCount`. No
  spec asserts them today. `quizEditor.metaSave` ("Save details") moved into
  the settings sheet submit.

## Status

| Spec | Status | Notes |
|---|---|---|
| `e2e/e17-student-practice-quizzes.spec.ts` | ⏳ PENDING — helper `addQuestion()` needs the radio→Select/chip update | share flow + preview regex intact |
| `e2e/e28-student-editor-mutations.spec.ts` (tests 1–2) | ⏳ PENDING — needs move/delete selector updates (desktop gutter or ⋯ menu) | reducer behavior unchanged |
| `e2e/e28-student-editor-mutations.spec.ts` (test 3, option surgery) | ⏳ PENDING — likely green as-is | edit dialog radios kept |
| `e2e/e28-student-editor-mutations.spec.ts` (test 4, lecturer parity) | ✅ untouched | lecturer UI unchanged |
| `e2e/e19-student-ai-generate.spec.ts` | ⏳ PENDING — update `addQuestion()` helper | generate dialog untouched |
| `e2e/e20-question-image.spec.ts` | ⏳ PENDING — update `addQuestion()` helper; committed-mode tests should pass | staged/committed fields kept |
| `e2e/e24-network-failure.spec.ts` (editor segment) | ⏳ PENDING — same helper dependency | |
| `e2e/m1-my-quizzes.spec.ts` / `e48` | low risk | no editor-body assertions found |

> **CORRECTION (added with the 2026-09-09 path map):** the "m1/e48 low risk"
> note above is wrong for `m1-my-quizzes.spec.ts` — **line 71 does
> `page.getByRole("radio").first().check()` inside the ADD form**
> (`e2e/m1-my-quizzes.spec.ts:67-71`: fills `fieldset input[maxlength='500']`
> options, `/prompt/i` textbox, then checks a radio). The rebuilt add form has
> **no radios** (correct answer = numbered chip / "Correct answer" Select), so
> `m1-my-quizzes.spec.ts` **test 2 will fail** the same way e17/e19/e20/e28
> will. Update its add-question block alongside the shared `addQuestion()`
> helper (switch to the Select or click the option chip). Test 1 (zero-question
> card → editor) and the ⋯-drawer/Share/Copy-link segment are unaffected by
> this selector change.

---

# Pending E2E Tests — Gesture Calibration Mobile Redesign

> Added 2026-09-09. `gesture-calibration.tsx` was rebuilt mobile-first: the
> camera is the hero and a new `CalibrationHud` export (status chip +
> lighting chip + the 1–5 finger tray) is mounted by `gesture-layer.tsx`
> INSIDE the mobile video container, overlaid on the viewfinder. Mobile gets
> a fixed bottom action dock (full-width Continue, quiet text Skip, safe-area
> padded — same grammar as the quiz action bar, plan W3); ≥lg keeps the
> original card composition verbatim (chips + guide card + side-by-side
> buttons) except the emoji glyphs (💡🌙☀️⚠️) were swapped to Lucide icons.
> Mobile camera frame is now full-width `aspect-[3/4]` (was `h-[45dvh]
> w-auto`), outer `max-sm:sticky` wrapper removed (the dock is the fixed
> layer now). Typecheck + eslint + vitest (1498) green; i18n parity 1211/1211
> (no new keys — `lightingGood` reused for the HUD chip). Verified manually
> in-browser at 393×852 (mobile) and 1280×800 (desktop): layout renders,
> Skip → "Gestures unavailable — click to answer" → quiz clickable.

## The contract (assertions above depend on it — all preserved)

- `helpers.ts:475` — `getByRole("button", { name: "Continue", exact: true })`
  still resolves (mobile dock + wide card both render it; label unchanged).
- `helpers.ts:479` — `getByText("Hand gestures", { exact: true })` goes hidden
  after Continue: the h1 still renders with the same text on BOTH branches
  (mobile heading sits under the camera; it was never visible-in-camera).
- `e9c-calibration-skip.spec.ts:71` — `/skip/i` button still resolves (mobile
  renders Skip as a text button, wide keeps the outline Button).
- `role="status"` chips preserved (status + lighting on HUD and wide card).
- Practice/multi-latch logic untouched (QT-1 state machine as-is; mobile
  still omits the mock practice card — `multiPractice={hasMultiQuestions &&
  isWide}` unchanged in gesture-layer).
- New i18n usage: none added; no spec asserts `vision.*` copy changes.

## Status

| Spec | Status | Notes |
|---|---|---|
| `e2e/e9c-calibration-skip.spec.ts` | ⏳ PENDING — expected green | skip flow verified manually in-browser |
| Specs using `helpers.completeCalibration` (Continue path: e9 series, m-series with gestures) | ⏳ PENDING — expected green | Continue name/position changed on mobile only; specs run desktop viewport |

## Visual-design notes (for review)

- Mobile order: camera hero (HUD overlaid) → title + coach copy + privacy
  note → (multi practice <lg omitted as before) → lighting warning band →
  fixed action dock (Continue / Skip / waiting line).
- HUD finger tray is aria-hidden + frosted clay tray on the frame's bottom
  edge; live pose's pill lifts (`-translate-y-1 scale-110`, primary fill).
- Continue button pinned bottom; `continueDisabled` shows the waiting line
  inside the dock (was below the buttons).

---

# Pending E2E Tests — End Screen Mobile Redesign

> Added 2026-09-09. `end-screen.tsx` was rebuilt mobile-first: the result
> banner becomes a celebration card (avatar tile, eyebrow, title, clay SVG
> score RING around the raw count, `pctCorrect` line + a tiered praise line),
> actions stack full-width (Try again first as primary, Back to quizzes
> outline below), and the answer breakdown renders as a plain `<ol>` with
> native page scroll — the inner VList viewport is dropped on phones (a
> fixed-height scroll box inside the page was the "ugly" part on mobile).
> ≥lg keeps the proven composition VERBATIM (score typography, button row,
> VList virtualized breakdown) except the ⏱️ emoji became a lucide Timer.
> Typecheck + eslint + vitest (1498) green; i18n parity 1215/1215 (4 new
> `play.end.praise*` keys, en+ms). Verified in-browser at 393×852 (ring,
> praise, full-width buttons, `ol > li` = 4) and 1280×800 (identical to the
> old desktop layout), plus a live "Try again" click → routed into a NEW
> /play/<uuid> session (SQ-3 contract intact).

## The contract (assertions above depend on it — all preserved)

- `e45` — "Practice complete! 🎉" exact (unchanged `practiceTitle`),
  "Answer breakdown" visible, breakdown rows still `ol > li` (mobile now a
  real `<ol>`; desktop VList divs were NEVER `ol > li` — pre-existing, see
  below), ✓/✕ glyphs + "Correct answer" tag on the missed key option,
  "50% correct" exact, `/Try again/i` button + URL-change poll (SQ-3).
- `e42` — "Answer breakdown" visible; row-order assertions use
  `locator("ol > li")` — desktop keeps rendering VList divs
  `[role="listitem"]`, so `ol > li` resolves 0 there; **pre-existing
  gap** (the old code was also a div VList on BOTH layouts — specs run the
  desktop viewport, so these rows only ever matched via the fallback
  probing below). No behavior change; logged, not fixed.
- `e36` — "Answer breakdown" exact visible / count-0 before reveal (h2
  unchanged; unrevealed assessments still render NO breakdown section).
- `e5` / `e27` / `e38` / `e17` — `Back to quizzes` button, `/Try again/i`,
  `/Practice complete/i` text all unchanged.
- Time-expired chip: emoji ⏱️ removed (chip text `common.timeExpired`
  unchanged; no spec asserts the emoji).
- New i18n keys `play.end.praisePerfect/praiseStrong/praiseOk/praiseRough`
  (en+ms) — praise line is mobile-only; no spec asserts it.

## Status

| Spec | Status | Notes |
|---|---|---|
| `e2e/e45-multi-select.spec.ts` | ⏳ PENDING — expected green | end-screen copy/glyphs/flow preserved; verified manually |
| `e2e/e42-shuffle.spec.ts` (breakdown segment) | ⏳ PENDING — pre-existing `ol > li` vs VList-div mismatch on desktop; unchanged by this work | |
| `e2e/e36-close-grace-and-reveal.spec.ts`, `e5`, `e27`, `e38`, `e17` end segments | ⏳ PENDING — expected green | copy contracts preserved |

---

# Pending E2E Tests — Breakdown Accordion (end screen, follow-up)

> Added 2026-09-09. The MOBILE answer breakdown became a verdict accordion
> using the official base-lyra shadcn `accordion` (new
> `src/components/ui/accordion.tsx`, Base UI `@base-ui/react` — already a
> dependency; `cn` import normalized to the project's `@/lib/utils`). The
> accordion root renders as `<ol>` and each item as `<li>` via Base UI's
> `render={<ol/>}` / `render={<li/>}` element form, so the e42/e45
> `locator("ol > li")` probes keep resolving. Trigger = verdict: question
> number + prompt + a ✓/✗/— icon disc + a Correct/Wrong/Skipped pill; panel
> = option review + explanation (explanation now a tinted inset card).
> Wrong/skipped questions start OPEN (`defaultValue` = ids where
> `is_correct !== true`), correct ones closed; `multiple` allows any mix.
> ≥lg keeps the always-expanded VList cards VERBATIM (unchanged contract
> surface). Typecheck + eslint + vitest (1498) + i18n parity 1218/1218
> (3 new `play.end.verdict*` keys en+ms). Verified in-browser at 393×852:
> 4 `ol > li` items, wrong item open on load, tapping a closed correct item
> expands it alongside (aria-expanded + data-open flip, options+explanation
> mount), chevron swap via the registry's group-aria-expanded icons.

## Contract deltas (vs. the pre-accordion mobile breakdown)

- Mobile option rows + "Correct answer" tag + explanations are still in the
  DOM but INSIDE the accordion panel — Base UI panels unmount closed content
  (no `keepMounted`), so a spec asserting option text must first expand the
  row (click the trigger) when the item starts closed (correct answers).
  ✗/— rows start open, so e45's wrong-journey assertions resolve without
  clicks. e42/e45/e36 run the DESKTOP viewport → VList path, unaffected.
- Trigger rows are `<button>` inside `ol > li` — no spec clicks breakdown
  rows today (verified by grep), so no breakage expected.
- New i18n keys `play.end.verdictCorrect/verdictWrong/verdictSkipped`
  (en: Correct/Wrong/Skipped, ms: Betul/Salah/Tiada jawapan) — no spec
  asserts them. The mobile glyph disc keeps the ✓/✗/— characters.

## Status

| Spec | Status | Notes |
|---|---|---|
| `e2e/e42-shuffle.spec.ts`, `e2e/e45-multi-select.spec.ts` (breakdown segments) | ⏳ PENDING — desktop viewport, VList path unchanged | expected green |
| Mobile-only accordion behavior | no spec exists | verified manually (expand/collapse/default-open) |

## Follow-up (same day): "Correct answer" tag removed

- User call: the ✓ disc + green tint already encode correctness; the text
  tag double-encoded it. The `correctAnswer` tag span was removed from BOTH
  layouts (accordion panel rows + wide VList cards).
- `play.end.correctAnswer` i18n key is now UNUSED by code but kept in
  en/ms (harmless; parity 1215/1215).
- **e45 impact**: line 218
  `await expect(wrongRow.locator("li").filter({ hasText: "Bat" })).toContainText("Correct answer")`
  will FAIL against the new UI. Update it when clearing this file: assert
  the missed-key row by its ✓ glyph instead (e.g. filter Bat → contains ✓,
  not ✕). Line 37's comment references the tag too. No other spec asserts
  the tag (verified by grep).

## Follow-up 2: your-choice vs answer-key disc encoding

- New visual grammar in the breakdown option rows (both layouts):
  **solid disc = the student's choice** (green ✓ if it was correct, red ✕ if
  wrong); **hollow thick-ring disc = the answer key they missed** (green ✓
  outline); untouched wrong options keep the hollow gray number disc.
- Replaces the removed "Correct answer" text tag; screen readers get
  sr-only lines via new `common.aria.yourCorrectChoice / yourWrongChoice /
  missedCorrectAnswer` keys (en+ms, parity 1218/1218).
- e45 line 218 still needs the same rewrite noted above (assert the Bat row
  by ✓ glyph, not the removed text tag).

---

# Pending E2E Tests — Self-Play Results Screen Mobile Redesign

> Added 2026-09-09. `StudentPracticePlayer`'s results state
> (`src/components/student-quiz/player-client.tsx` — the surface behind
> /play/student/[quizId] "My Quizzes → Play" and /s/[code] shared play) got
> the same mobile treatment as the session EndScreen: celebration banner +
> shared `ScoreRing` (extracted to `src/components/quiz/score-ring.tsx`) +
> tiered praise, stacked full-width actions (Try again first), and the
> Review list as a verdict accordion on mobile (`<ol>`/`<li>` via Base UI
> render props, wrong/unresolved rows start OPEN, 2-line clamp on trigger
> prompts). ≥lg keeps the original composition (6xl score typography,
> side-by-side buttons, VList-virtualized review) with only the disc
> grammar update (solid = your choice, hollow ring = missed key). Unavailable
> questions keep the "No longer available." line inside the panel. i18n: 4
> new `sqPlayer.praise*` keys (en+ms, parity 1222/1222). Typecheck + eslint
> + vitest (1498) green; verified live at 393×852 by playing a real quiz
> (2 right / 1 wrong): ring 2/4 50%, praise line, wrong rows open on load,
> disc grammar correct (solid ✕ pick, hollow ✓ key, gray numbers).

## E2E contract notes

- No spec asserts the self-play/shared results-screen copy or structure
  (verified by grep: e27 asserts only "Question 1 of 3" on the play surface,
  e17/e32/e20 assert share gating, not the end state) — no spec impact.
- The old single-layout `div[role="list"]` review is now mobile accordion
  (`ol > li`) + desktop VList div (as before). No spec probed it.
- `sqPlayer.progress`/feedback copy untouched; checkpoint behavior untouched.

---

# Pending E2E Tests — Face Precheck Occlusion Deferral

> Added 2026-09-09. The mid-quiz face-check precheck in
> `use-face-pipeline.ts` now defers (bounded: 2 × 4s, then captures anyway)
> when `shouldDeferFaceCheck` (`src/lib/face/face-check-gate.ts`) sees bad
> lighting, an absent/unaligned face, or a mid-commit hand — instead of only
> bad lighting before. E2E can prove this with the existing fake seam:
> `setFacePose(page, { faceDetected: false })` while ready → assert NO
> verify POST for ~4s → `setFacePose(page, { faceDetected: true })` →
> periodic/catch-up POSTs resume. Exhaustion-side behavior (sustained
> occlusion → real capture → honest FAIL row) can be scripted by holding the
> bad pose past both deferral windows, but that overlaps the existing
> mismatch/FAIL-row specs, so the deferred-then-resumed happy path is the
> gap worth pinning. The fake already implements `getFaceHealth` +
> `setFacePose`; no seam work needed. Unit-pinned meanwhile in
> `face-check-gate.test.ts` (10 cases).

---

# Pending E2E Tests — Adaptive Face-Tracker Duty Cycle

> Added 2026-09-10. `FaceTracker.setFrameInterval` (clamped [33,200]ms) is
> flipped by the pipeline's `setStatusBoth` choke point: 66ms while
> `ready`, 33ms for every other status (gate/recovering run `waitForBlink`
> AFTER the flip, so blink sampling is never throttled). The E2E fake has
> no rAF loop (synchronous frames), so the tier mechanism itself is only
> exercisable against the real tracker — left to manual smoke
> (`npm run face:smoke` + a live quiz), consistent with the existing
> "browser-only glue is manual/E2E-fake" policy in face-tracker.ts. What a
> spec COULD pin once a real-loop seam exists: interval stays 66ms during a
> long `ready` stretch and returns to 33ms on pause → recover. Unit side
> is covered by construction (pure threshold constants; no timing-window
> state to invalidate at runtime).

---

# Verification Pass — Gemini Clearance Batch (2026-09-10)

> A full static verification of the pending-work batch (helpers rewrite, 13
> patched `e*`/`m1` specs, config changes, and the 5 new specs `e49`, `e50`,
> `m2`, `m3`, `m4`) against the component/API/RPC source. Gates: `tsc` clean,
> `eslint` clean, i18n parity 1223/1223, targeted vitest green,
> `playwright --list` parses all 176 tests. Selector-level findings below were
> fixed in the same pass; full Playwright runs still pending a quiet machine
> (webServer rebuilds `.next` — see the infra note above).

## Verified against source (no change needed)

- `helpers.setAutoReveal` now PATCHes `autoRevealOnComplete` — matches
  `RevealSettingsSchema` (`src/lib/quizzes/validation.ts:339`) and the
  `reveal-settings` route.
- `helpers.openJoinDrawer` visible-button probe + `joinClass` dialog-count-0
  wait — matches the ResponsiveModal unmount beat documented in §"What
  changed in these specs".
- `helpers.createQuizWithQuestions` shuffle Switch tap — Base UI `switch`
  role + wrapped-label name ("Shuffle question & option order"), same
  pattern as e40's retake switch.
- `helpers.openResults` simplification — builder "View results" link
  (`lecturer.builder.viewResults`, en) renders on every published builder.
- Editor add-form rewrites (`Option 1/2` labels, no radios, reset-then-row
  waits) — match `editor-client.tsx` (`quizEditor.optionLabel`,
  `addQuestionSubmit`, form reset on `emptyDraft`).
- e28 desktop gutter: `Move option up/down` (aria `quizEditor.moveUpA11y`),
  `Delete` (`common.delete`), `Edit question`; `li:has(> article)` row
  scoping; option-surgery radios kept in `OptionDraftForm`.
- e45/e42 breakdown `[role="listitem"]` (VList) vs `ol > li` (accordion);
  removed "Correct answer" tag assertion — tag no longer rendered.
- e36 results-dashboard close moved into the "Quiz actions" menu
  (`results.quizMenu`), `menuitem`-or-button fallback is correct.
- e49: submit-RPC auto-reveal flip (migration 0012 §7), "Results revealed"
  chip, desktop hub `<li>` cards, disabled-awaiting card branch.
- e50: answer RPC checks `session_not_active` BEFORE question membership
  (0008_sessions.sql:343 vs :383) so the dummy-questionId 409 probes are
  sound; overlay copy ("Face check paused"/"Assessment flagged"),
  `flagged-wait-ticker` testid, `/api/face/unlock` envelope all match.
- m2: sticky mobile header (`header.sticky`), `Q {current}/{total}` strip,
  `role="timer"` chip + aria-label, quiz-info modal rows
  (`infoOpen`/`info.*`), fixed bottom bar (`div.fixed.bottom-0` unique),
  calibration HUD (`noHand`/`lightingGood`, Skip →
  `vision.gesturesUnavailable`), PIP expand/collapse + Escape,
  palm-next (nextArmed = feedback), ScoreRing spans, verdict accordion
  default-open state.
- m3: `GradebookMobile` swap below sm, summary meter (`classAvgLabel`,
  width style), quiz chips, per-quiz sheet distribution
  (`bg-amber-400/80` / `bg-emerald-600/80`, `<50 · 50-64 · …` legend),
  per-student sheet (`colCumulative` = "Overall"), `#gradebook-search` +
  "Showing X of Y students".
- m4: builder mobile strip state swap (Generate-from-file → Add question),
  ⋯ menu Add question, batch sheet stays open + Done, single-open
  accordion, `mark checked — N` aria, reviewed persistence, publish footer
  bar + `getStatusLabel` "Live" chip; student editor hero chips, settings
  drawer (`metaSave` = "Save details"), reviewed checklist copy.

## Fixed during verification (strict-mode / drift)

1. **e45 (2 sites)** — bare `getByText("Practice complete! 🎉")` matched the
   banner in BOTH mounted end-screen layouts (the component renders the
   mobile and wide compositions unconditionally; visibility is CSS-gated).
   Scoped to `p:visible`.
2. **m2 test 4** — same dual-mount issue for "Practice complete! 🎉",
   "50% correct", praise line, quiz-title h1 (level-1 heading matches both
   layouts), and "Answer breakdown" h2. All scoped to visible elements.
3. **m2 test 1** — terminal "Assessment complete/submitted" text scoped to
   `p:visible` for the same reason.

Note for future specs on any end-state surface (end-screen.tsx,
player-client.tsx results): both layouts are ALWAYS in the DOM. Use
`:visible` scoping or layout-unique class hooks — never bare getByText.

## Still pending (unchanged)

- Full Playwright runs (chromium + mobile + e2f) on a quiet machine; the
  status tables above clear only on a green run.
- M3 backlog items (e51–e55) and the m1-mobile-journeys dialog-count fix
  verification remain as recorded in PROJECT.md.

# PLAN: Mobile Polish Round 2 — Density, Chrome Declutter & Correctness

> Status: **READY FOR OWNER APPROVAL** — not yet approved for implementation.
> Evidence base: three audits against the shipped `PLAN_MOBILE_REDESIGN`
> (v4) output — (1) Web Interface Guidelines pass over every mobile surface,
> (2) scale/density review, (3) persistent-chrome declutter review.
> Every file:line verified against the current working tree on 2026-09-07.

---

## What you're approving (taste calls, half a page)

The clay identity is untouched — same colors, fonts, borders, hard offset
shadows, 5 clay rules. What changes is how much *UI* the phone shows at
once, and how big that UI is. The calls:

1. **Display type shrinks toward native.** Mobile headings drop from
   30–34px to a 24px ceiling; the 19px question-prompt token drops to 17px.
   Touch-target growth from the v4 plan stays (48px buttons, 44px targets)
   — it was right; the *type-scale* growth was not.
2. **Chrome loses ~90px on phones.** Topbar 74px→56px, smaller brand mark,
   dock reserve 96px→84px. On a notched iPhone this returns ~10% of the
   screen to content.
3. **The gesture camera PIP defaults to collapsed** (a ~24px status dot);
   tap to expand the full self-view. The v4 plan shipped it always-open.
4. **Persistent context chrome folds behind taps** on the play screen: the
   mode pill + camera dot collapse into a "quiz info" sheet; the multi-select
   chip moves INSIDE the action card. The play screen's four floating layers
   (header, PIP, warn banner, action bar) drop to two.
5. **The classes hero band compresses below `sm`** to a single header row —
   gradient panel, sparkle chip, and stat caption are desktop flourish.
6. **Deadline chips become amber-only** (render only when closing <24h);
   the grey "Due in N days" chip on every card is deleted.
7. **Correctness fixes ride along**: the ResponsiveModal dialog/drawer swap
   flash, the notification bell's desktop-first paint on phones, the
   aria-hidden gradebook chart, sub-44px touch targets.

Non-goals: no desktop visual changes, no backend/API work, no new routes, no
native app, no design-language change (clay stays), no pull-to-refresh.

---

## 0. Problem statement

Three problems, each with audited evidence.

### 0.1 It still reads "desktop squeezed onto a phone" (density)

The v4 plan deliberately grew type ("text-xs retires from body-adjacent
duty", captions 12→13px, new 19px `--text-prompt` token) while page-level
rhythm and display type kept desktop proportions. Result: everything at
phone width is oversized, and the *chrome* eats over a third of the screen.

| Symptom | Evidence |
|---|---|
| Chrome ≈37–40% of viewport | Topbar `h-[74px]` + `pt-[var(--safe-top)]` (`src/components/layout/app-shell.tsx:70-71`) ≈ 121px on notched iPhone; dock ~68px + 8px offset (`src/components/layout/mobile-bottom-nav.tsx:90`); `<main>` reserves `pb-[calc(96px+var(--safe-bottom))]` (`app-shell.tsx:106`) ≈ 130px. Total ≈ 327px of an 812px iPhone, ≈ 250px of a 667px Android |
| Display type at desktop scale | `--text-display: clamp(1.75rem, 8vw, 2.125rem)` = 30px at 375px (`src/app/globals.css:69`); classes hero `text-3xl` = 30px (`src/app/(student)/student/classes/student-classes-client.tsx:126`); native app titles are 20–24px |
| Question prompt 19px | `--text-prompt: 1.1875rem` (`globals.css:67`) + `text-xl` heading on the same card (`src/components/quiz/question-card.tsx:87`) |
| Captions grew | `--text-xs: 0.8125rem` — v4 raised 12→13px (`globals.css:57`); the desktop restore block at `globals.css:112-133` only resets ≥sm |
| Only two components scale down | grep for `max-sm:text-*` finds just `face-gate.tsx:63` and `question-card.tsx:87` — desktop sizes flow through everywhere else |
| Bold-everything compounds it | System spec: body runs Nunito 600-700 ("not 400", `design-system/innovision/MASTER.md:55`); `font-extrabold` on nearly every label/button = the "zoomed" feel |
| Buttons taller than native CTAs | default 48px, `lg` 52px (`max-sm:h-13`) with `px-7` (`src/components/ui/button.tsx:28,33`); `lg` is the primary CTA everywhere (begin, join, next) |
| Rhythm is desktop rhythm | `space-y-8` between sections (`student-classes-client.tsx:117`), `py-10`/`py-12` page wrappers (`src/components/face/face-gate.tsx:52`, `src/components/quiz/play-client.tsx` etc.) — cards scale padding but the gaps between them don't |

### 0.2 Persistent chrome that doesn't earn its pixels

| Surface | Evidence |
|---|---|
| Play screen: up to 4 floating layers at once | Sticky play header (mode pill + counter + timer + cam dot + bar, `play-client.tsx:1104-1131`); always-visible 84px gesture PIP (`src/components/vision/gesture-layer.tsx:582`); sticky hand-loss warn banner (`gesture-layer.tsx:700`); fixed action bar that stacks 3 sub-layers when the multi-select chip + an error both show (`play-client.tsx:1184-1224`). Question content gets ~250px |
| PIP is always open by default | Collapse toggle exists (`pipExpanded`, `gesture-layer.tsx:532`) but the default state is the full 84px self-view, "glance-only" while armed |
| Mode pill is static context | Set once at the gate, never changes, yet occupies the header row for the whole quiz |
| Hero band eats the first viewport | Gradient panel + sparkle chip + 30px h1 + subtitle + stats caption before any class card (`student-classes-client.tsx:119-169`) |
| Deadline chip on every card | Grey "Due in N days" renders on every quiz card; only amber (<24h) is actionable (`src/app/(student)/student/quizzes/student-quizzes-client.tsx:281`) |
| Face enroll: 4 HUDs, 3 duplicate the same instruction | Angle chips (`face-enroll-client.tsx:303`), big instruction bubble (`:335`), bottom pose/lighting chip (`:366`), lighting tip line below the video (`:406`) — the file's own comment admits the duplication is deliberate ("single source of truth") |

### 0.3 Correctness & a11y defects (guidelines audit)

| Defect | Evidence |
|---|---|
| ResponsiveModal mounts wrong on first render | `useMediaQuery` returns false server-side + first client render, so every sheet mounts as a bottom **drawer**, then swaps to a centered dialog ≥640px; recomputed independently in 8 sub-components, which can disagree for a frame (`src/components/ui/responsive-modal.tsx:37,68,119…`) |
| Bell first-paints as desktop popover on phones | `useState(true)` corrected in an effect (`src/components/notifications/notification-bell.tsx:172`); invisible to e2e (same accessible name) but a real flicker on every mobile load |
| Bell trigger missing `aria-expanded` | `aria-haspopup="dialog"` declared but never toggled (`notification-bell.tsx:392`) |
| Gradebook chart hidden from AT | The 5-bucket distribution bar — the sheet's primary data — sits in `aria-hidden="true"` (`src/app/(lecturer)/lecturer/classes/[id]/gradebook/gradebook-mobile.tsx:172`) |
| Quiz-chip title overflows | `max-w-[150px]` with no truncate (`gradebook-mobile.tsx:66`) |
| Sub-44px touch targets | Avatar camera badge `size-6` = 24px (`src/components/layout/app-user-menu.tsx:264`); remove button 32px (`:325`); neither uses the `.hit-slop` class (`globals.css:276`) |
| Dock labels unrecoverable | `truncate` with no `title` (`mobile-bottom-nav.tsx:142`) |
| `transition-all` on mobile-surfaced controls | `switch.tsx:19` (consent checkbox), `gesture-layer.tsx:577,582` (PIP), `GenerateFromFileDialog.tsx:605,761,793,830,856` (mobile extraction), `quiz-builder-client.tsx:1064`, `page.tsx:154` |
| Join/matric inputs skip spellcheck/password-manager exclusion | `student-classes-client.tsx:81` (join code), `matric-capture-form.tsx` — no `spellCheck={false}` / `autocomplete="off"` |
| Unbounded lists | Gradebook sheet list (`gradebook-mobile.tsx:210`), practice review `<ol>` (`src/components/student-quiz/player-client.tsx:263`), notification panel — no virtualization past ~50 rows |
| Enroll `<video>` unlabeled | `face-enroll-client.tsx:294` |
| 500ms polling timer for life | `src/hooks/use-keyboard-occlusion.ts:49` — justified edge case, but a permanent 2Hz interval on every authenticated page |
| Topbar blur vs clay rule 2 | `bg-background/85 backdrop-blur` (`app-shell.tsx:70`) while the dock's own comment calls backdrop-blur bars a clay rule-2 violation (`mobile-bottom-nav.tsx:24`) |

### 0.4 Verified-correct (do not regress)

Safe-area tokens + `viewportFit: "cover"`; keyboard occlusion via
`data-keyboard-open` (focusin/focusout + relatedTarget edge cases handled);
tap-highlight killed globally; `prefers-reduced-motion` global override;
`overscroll-behavior-y: none` on `.play-stage` + `overscroll-contain` on
dialogs; toasts repositioned top-center on mobile to clear the dock; no
`user-scalable=no`/`maximum-scale`; aria-live coverage on async updates;
`role="timer"` with `aria-live="off"`; tabular-nums on numerics.

---

## 1. Workstreams

### W1 — Density & type scale ("squeezed desktop" fix)

- **Topbar 74→56px** (`app-shell.tsx:71`), brand mark 40→32px, keep
  `pt-[var(--safe-top)]`.
- **Dock reserve 96→84px** (`app-shell.tsx:106`); dock itself stays (it is
  the v4 plan's signature element and passes clay rules).
- **Mobile display ceiling**: `--text-display` → `clamp(1.5rem, 7vw, 1.75rem)`
  (=24px at 375px, `globals.css:69`); classes hero `text-3xl`→`text-2xl`
  below sm (`student-classes-client.tsx:126`); face-gate/end-screen H1s
  follow the same ceiling.
- **`--text-prompt` 19→17px** (`globals.css:67`); keep `text-xl` question
  heading but drop `md:text-2xl`'s mobile step via `max-sm:text-lg`.
- **Rhythm compression below sm**: section gaps `space-y-8`→`max-sm:space-y-5`;
  page wrappers `py-10`/`py-12`→`max-sm:py-6` (`face-gate.tsx:52`,
  `play-client.tsx`, `student-quiz/player-client.tsx:230,370`). Cards keep their existing
  `p-5 sm:p-7` pattern — the *gaps* are what changed.
- **Keep**: 44px+ touch targets, 48px buttons, icon sizes, captions at 13px
  (readability gain was real — only *display* type and chrome shrink).
- Run the `max-sm:text-*` sweep while here: any remaining ≥`text-2xl` body
  headings below sm get stepped down one token.

### W2 — Chrome declutter (persistent UI → collapsed/toggle)

1. **PIP defaults to collapsed** — flip the default at `gesture-layer.tsx:582`
   to a ~24px status dot (ring color = face status); tap expands to the
   existing full self-view. `pipExpanded` mechanics already exist; this is a
   default + collapsed-view change. `gesture-video-container` testid and the
   fake seams must survive.
2. **Play header folds to counter + timer + bar** (`play-client.tsx:1104-1131`).
   Mode pill + cam dot move into a tap-to-open "quiz info" sheet (ResponsiveModal;
   title, mode, time limit, cam status). The timer chip must remain the FIRST
   `span.tabular-nums` in DOM order (e10 contract) — the sheet is mounted
   outside the header row.
3. **Multi-select chip moves INSIDE the action card** (`play-client.tsx:1189`)
   — the fixed bottom area becomes one layer again. Chip is `aria-hidden` and
   the sr-only `multiSelectedCount` span stays inside the action-zone
   container (contract).
4. **Hand-loss warn banner renders inside the action bar** instead of a new
   sticky band (`gesture-layer.tsx:700`) — status, not a fourth layer.
5. **Hero band → compact header row below sm** (`student-classes-client.tsx:119`):
   keep the "My Classes" heading (m1:32 asserts it), drop the blobs/sparkle
   chip/gradient below sm, stats caption stays only when classes exist (v4
   zero-state rule already handles the empty case).
6. **Deadline chips amber-only** (`student-quizzes-client.tsx:281`): grey chip
   removed; amber renders only when closing <24h. **Verify** no e2e asserts the
   grey chip (grep of `e17`/`m1` found none; re-grep before the change —
   SQ-1 spec is the risk).
7. **Enroll HUD merge** (`face-enroll-client.tsx:303,366,406`): angle chips +
   bottom pose chip + lighting tip collapse into ONE status line under the
   video; the big arm's-length instruction bubble (`:335`) stays. Add
   `aria-label` to the `<video>` (`:294`) while here.

### W3 — Correctness & a11y fixes

1. **ResponsiveModal single decision** — hoist `isDesktop` into one context/
   prop inside `ResponsiveModal`; sub-components read it instead of each
   calling `useMediaQuery`. Kill the drawer→dialog mount swap on ≥640px.
2. **Bell first paint** — derive the media query like `ResponsiveModal` does
   (matchMedia read in the same render pass, no `useState(true)` default at
   `notification-bell.tsx:172`); add `aria-expanded={open}` to the mobile
   trigger (`:392`).
3. **Gradebook chart** — move `aria-hidden` off the container
   (`gradebook-mobile.tsx:172`) and add a text summary ("N students 80–89");
   add `truncate` (or `line-clamp-1`) to the quiz chip (`:66`).
4. **Touch targets** — `hit-slop` on the avatar camera badge
   (`app-user-menu.tsx:264`) and remove button (`:325`); `title` attr on dock
   labels (`mobile-bottom-nav.tsx:142`).
5. **Inputs** — `spellCheck={false}` + `autoComplete="off"` on join-code
   (`student-classes-client.tsx:81`) and matric capture inputs.
6. **Topbar blur** — either drop `backdrop-blur` (clay rule 2) or record it
   as an accepted sticky-header exception; pick one, don't leave the dock
   comment contradicting the topbar.

### W4 — Hygiene (cheap, low-risk)

- `transition-all` → explicit properties at `switch.tsx:19`,
  `gesture-layer.tsx:577,582`, `GenerateFromFileDialog.tsx:605,761,793,830,856`,
  `quiz-builder-client.tsx:1064`, `page.tsx:154`.
- Virtualize the gradebook sheet list (`gradebook-mobile.tsx:210`) and
  practice review list (`student-quiz/player-client.tsx:263`) with `virtua` (only the two
  unbounded ones; notification panel already pages via load-more).
- Replace the 500ms interval in `use-keyboard-occlusion.ts:49` with an
  event-driven sync (focusin/focusout already cover it; keep a
  `visibilitychange` safety net instead of polling).

---

## 2. Hard contracts (must not break)

Preserved verbatim from `PLAN_MOBILE_REDESIGN` §5, plus new ones from this
audit. Binding for W1–W4.

1. **Play ARIA mechanics**: `role="timer"` + `aria-live="off"` timer chip
   stays the first `span.tabular-nums` in DOM order (e10 selects `.first()`);
   exactly one `sr-only[role="alert"][aria-live="assertive"]` and one
   `sr-only[role="status"]`; the action-zone container keeps
   `aria-live="polite"`, stays mounted in all non-terminal phases, and the
   sr-only `multiSelectedCount` span survives; status chip/error/feedback
   chips render OUTSIDE it.
2. **m1 selectors**: nav `"Mobile navigation"`; dock links
   `/my classes|kelas saya/i`, `/class quizzes|kuis kelas/i`,
   `/my quizzes|kuis saya/i`; account sheet = `getByRole("dialog")` with
   `"Switch language"` + `testid=theme-toggle`; bell button
   `"Notifications"` (exact) opening a dialog; zero-state heading
   `"My Classes"` visible.
3. **e30 selectors**: `"Notifications, 1 unread"` (exact),
   `"Mark all as read"` (exact), row buttons `/New student/`, `/New practice quiz/`.
   W2 changes must not alter bell accessible names.
4. **Testids**: `scan-overlay`, `gesture-video-container`,
   `flagged-wait-ticker`, `face-degraded-banner`, `theme-toggle`,
   `question-image-input`, `bulk-import-file-input`.
5. **Safe-area rule**: every fixed/sticky top-anchored surface pads
   `var(--safe-top)`; bottom bars pad `var(--safe-bottom)`; `scan-overlay`
   exempt. The 56px topbar and any new "quiz info" sheet comply.
6. **Keyboard occlusion**: `data-keyboard-open` + dock `translate-y-[120%]`
   semantics unchanged; W4's interval removal must keep the unmounted-input
   safety net (e2e m1 finding).
7. **Fake seams**: `getFakeHandTracker()` / face-seam gating inside any
   redesigned component; `lib/gestures/constants.ts` pinned; `window.__INNOVISION_*`
   untouched.
8. **i18n**: all new copy (quiz-info sheet, collapsed-PIP label, chart
   summary, hero row) via next-intl keys in BOTH en.json and ms.json; no
   `t.rich` for new copy.
9. **Type-scale split**: the unlayered ≥640px restore block
   (`globals.css:112-133`) stays the single desktop-restore mechanism; W1
   mobile changes live in the @theme tokens or `max-sm:` utilities, never in
   that block.
10. **Security/privacy**: camera boots only after consent; no answer key
    pre-reveal; keyless assessment acks untouched.

---

## 3. Delivery phases (each shippable, e2e-green)

| Phase | Scope | Size |
|---|---|---|
| P1 Density | W1: tokens, topbar 56px, dock reserve, display ceiling, prompt 17px, rhythm, `max-sm` text sweep | 3–4 days |
| P2 Declutter | W2: PIP collapsed default + quiz-info sheet + action-bar merge + hero row + amber-only chips + enroll HUD merge | 3–5 days |
| P3 Correctness | W3: ResponsiveModal hoist, bell first-paint + aria-expanded, gradebook chart/truncate, touch targets, inputs, topbar blur decision | 2–3 days |
| P4 Hygiene | W4: transition-all sweep, virtua on two lists, occlusion interval | 1–2 days |

**Honest total: ~9–14 working days.**

**Validation per phase:**
`npm run lint && npm run typecheck && npm run check:i18n && npm run test && npm run build`,
then targeted e2e before merge: `m1-mobile-journeys`, `e10-timer-expiry`,
`e30-notification-bell`, `e17-student-practice-quizzes` (deadline-chip grep
first), `e3-face-enroll`. Full suite at each phase merge.

**Device QA (P1 + P2):** one notched iPhone-class device (safe-top math with
the 56px topbar) and one mid-range Android at 360px width (dock reserve,
collapsed PIP hit target ≥44px, action-bar merge with keyboard open).

---

## 4. Risks & recorded decisions

- **Course correction on v4's "everything grows" call**: v4 §1 grew buttons,
  icons, AND type. This plan keeps buttons/icons/tap targets and reverses
  only display type, prompt size, chrome height, and rhythm. Recorded here so
  the two plans don't read as contradictory: "grow interactivity, shrink
  presentation."
- **PIP collapsed default**: an 84px→24px default means the self-view is one
  tap away during the gesture quiz. Mitigation: the collapsed dot carries the
  live face-status ring color, so "something's wrong" is still glanceable;
  the warn banner (now in the action bar) still fires.
- **Deadline chips amber-only**: users lose the passive "due in 3 days" info.
  Mitigation: due date remains on the quiz card body (verify copy exists
  before deleting the chip); amber (<24h) still alerts. If owner prefers
  keeping grey, drop to W2 item 6 → icon-only chip.
- **Hero compression vs m1**: m1 asserts only the "My Classes" heading; the
  hero H1 (`heroSubtitle`) is not asserted in m1 but IS in desktop specs —
  below-sm-only changes keep desktop e2e untouched.
- **ResponsiveModal hoist**: the 8 sub-components currently self-report the
  media query; the hoist is mechanical but touches every sheet call-site's
  render pass. Low risk, high surface — P3 gets its own phase for that reason.
- **Topbar backdrop-blur**: clay rule 2 says no blur bars; the v4 plan kept
  the topbar translucent. Decision in W3: drop the blur (preferred, matches
  the dock) unless sticky-header legibility testing says otherwise.
- **Non-goal guard**: no desktop visual changes — every W1/W2 change is
  scoped to `max-sm:`/token values, verified by the unlayered ≥640px restore
  block remaining untouched.

---

## Appendix A — Findings index (audit cross-reference)

| # | Finding | Location | Stream |
|---|---|---|---|
| A1 | ResponsiveModal drawer→dialog mount swap | `src/components/ui/responsive-modal.tsx:37` | W3 |
| A2 | Bell desktop-first paint on phones | `src/components/notifications/notification-bell.tsx:172` | W3 |
| A3 | Bell trigger missing aria-expanded | `notification-bell.tsx:392` | W3 |
| A4 | Gradebook chart aria-hidden (data) | `src/app/(lecturer)/lecturer/classes/[id]/gradebook/gradebook-mobile.tsx:172` | W3 |
| A5 | Quiz chip max-w no truncate | `gradebook-mobile.tsx:66` | W3 |
| A6 | 24px/32px touch targets (camera badge, remove) | `src/components/layout/app-user-menu.tsx:264,325` | W3 |
| A7 | Dock label truncate, no title | `src/components/layout/mobile-bottom-nav.tsx:142` | W3 |
| A8 | transition-all ×12 | `switch.tsx:19`; `gesture-layer.tsx:577,582`; `GenerateFromFileDialog.tsx:605,761,793,830,856`; `quiz-builder-client.tsx:1064`; `page.tsx:154` | W4 |
| A9 | Join/matric inputs: no spellCheck/autocomplete=off | `student-classes-client.tsx:81`; `matric-capture-form.tsx` | W3 |
| A10 | Unbounded lists (gradebook sheet, review ol) | `gradebook-mobile.tsx:210`; `src/components/student-quiz/player-client.tsx:263` | W4 |
| A11 | Enroll video unlabeled | `src/app/(student)/student/face/enroll/face-enroll-client.tsx:294` | W2 |
| A12 | 500ms occlusion interval | `src/hooks/use-keyboard-occlusion.ts:49` | W4 |
| A13 | Topbar blur vs clay rule 2 | `app-shell.tsx:70` | W3 |
| D1 | Chrome ≈37–40% of viewport | `app-shell.tsx:70-71,106`; `mobile-bottom-nav.tsx:90` | W1 |
| D2 | Display clamp 30px @375 | `globals.css:69` | W1 |
| D3 | Prompt token 19px | `globals.css:67` | W1 |
| D4 | Captions grew 12→13px | `globals.css:57` | W1 (keep) |
| D5 | Hero text-3xl | `student-classes-client.tsx:126` | W1/W2 |
| D6 | Buttons 48/52px + px-7 | `src/components/ui/button.tsx:28,33` | W1 (keep) |
| D7 | Desktop rhythm (space-y-8, py-10/12) | `student-classes-client.tsx:117`; `face-gate.tsx:52`; `play-client.tsx`; `student-quiz/player-client.tsx:230,370` | W1 |
| C1 | PIP always-open 84px | `gesture-layer.tsx:582` (toggle exists `:532`) | W2 |
| C2 | Play header: 5 elements in one row | `play-client.tsx:1104-1131` | W2 |
| C3 | Action bar stacks 3 layers | `play-client.tsx:1184-1224` | W2 |
| C4 | Warn banner = 4th sticky layer | `gesture-layer.tsx:700` | W2 |
| C5 | Hero band eats first viewport | `student-classes-client.tsx:119-169` | W2 |
| C6 | Grey deadline chip on every card | `student-quizzes-client.tsx:281` | W2 |
| C7 | Enroll: 4 HUDs, 3 duplicate instruction | `face-enroll-client.tsx:303,335,366,406` | W2 |

## Appendix B — Changelog

- **v1** (2026-09-07): initial compilation from the three audits —
  guidelines pass, density review, chrome-declutter review.

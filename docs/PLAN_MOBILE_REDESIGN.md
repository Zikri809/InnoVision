# PLAN: Native-Feel Mobile UI Redesign (FINAL v4 — 3 critic rounds merged)

> Status: **READY FOR OWNER APPROVAL** — not yet approved for implementation.
> Evidence base: 4 parallel codebase audits + 3 critic rounds (6 critics:
> feasibility, design, contracts, UX flows, ambiguity red-team, holism).
> Every load-bearing claim verified against the repo by critics; changelog in
> Appendix A.

---

## What you're approving (taste calls, half a page)

The plan keeps claymorphism intact — same colors, fonts, borders, shadows,
same 5 clay rules. What changes is the mobile *grammar*. The visible calls
you're implicitly approving:

1. **The bottom bar becomes a floating clay island** (solid card, 3px border,
   hard offset shadow, 24px icons) replacing today's flat full-width bar.
   Lecturers keep 2 tabs (verified: no `/lecturer/quizzes` index route
   exists, so a "Class Quizzes" tab has no destination).
2. **The quiz title leaves the play screen** after Start (desktop unchanged).
   It appears once in the begin-gate sheet; the play screen gets a compact
   sticky header (progress + timer + camera PIP). On phones the title ate
   2–3 lines above every question.
3. **Gate → calibration reads as one continuous flow** — three full-screen
   clay sheets sharing one visual system with per-surface step indicators,
   NOT one shared component (state-owner rule forbids it).
4. **Recovery gains a live camera self-view.** Today a paused student blinks
   to recover with no preview; the recovery sheet gets a mirrored viewfinder
   + face-oval guide.
5. **Zero-state hero:** a fresh student's classes page shows title + join
   form in the empty-state card — never "0 Classes / 0 Live quizzes" stat
   cards; the stats strip collapses to one caption line once enrolled.
6. **Everything grows to native size:** buttons 48–52px tall on phones,
   body 16px floor, icons 24px in nav, 44px+ tap targets everywhere, safe
   areas respected top and bottom (notch and home-indicator).
7. **Landscape phones flash the portrait composition until hydration** on the
   play stage (accepted one-paint cost of the component-swap strategy; see
   §2/§7).
8. **Android-only extras:** haptics (mode-split, see §W3) and the install
   hint chip (iOS never emits the install event; iOS Add-to-Home-Screen is
   supported implicitly via manifest/splash — no in-app education prompt is
   planned; recorded decision).

Logistics note: P3 and W5 include physical-device QA passes — one mid-range
Android (low-power mode) and one device for per-sheet keyboard checks.

---

## 0. Problem statement

Mobile reads as "desktop UI squeezed onto a phone." Audited evidence
(verified against code by critics):

| Symptom | Evidence |
|---|---|
| Text is desktop-crumb sized | ~470 of ~605 text-size declarations ≤14px (217× `text-xs` 12px, 211× `text-sm`, 40× `text-[11px]`, 8× `text-[10px]`) |
| Touch targets below native floor | `icon-xs`/`icon-sm` (32/36px) pervasive; checkbox 24px; no 44px convention documented |
| Safe areas dead top AND bottom | No `viewport-fit=cover` in the viewport export → bottom-nav inset ~0; nothing pads top |
| iOS zoom-on-focus | `select.tsx` trigger 14px; datetime-picker time inputs 12px |
| Gesture quiz below the fold | Camera `min-h-[350px]` above the question (`gesture-layer.tsx:552`); calibration stacks ~700px before Continue; `100vh` instead of `dvh` |
| Recovery is camera-blind | Paused overlay covers everything; face pipeline runs on a hidden 1px video — student repositions with zero self-view |
| Sheets vs modals inconsistency | Only 2 of ~12 dialog surfaces use `ResponsiveModal` |
| Hover affordances on touch | Clay lift is hover-only; builder actions are tooltip-labeled (invisible on touch) |
| Two icon libraries | remixicon declared; 34-file lucide + 4-file remixicon in practice |
| No installable app story | Zero PWA assets; play routes already shell-free (good) |
| Undersized mobile nav | Dock icons 16px, labels 11px; dock violates clay rule 2 (blur + soft shadow) |
| 320px overflow | `minmax(300px,1fr)` card grids |
| Gradebook two-axis scroll | Only real `<table>`; N×110px columns on phones |
| First-run dead-end | Fresh student sees zero-stat hero; join form below the fold |

Non-goals: no native app (RN/Expo/Capacitor), no desktop visual redesign, no
backend/API changes, no design-language change, no pull-to-refresh on
server-rendered lists, no orientation lock, no in-app iOS install prompt.

## 1. Design thesis — "Clay, thumb-first"

Native feel is interaction physics, not a font bump. Clay stays the identity;
the grammar becomes native-mobile:

1. **Thumb-zone primacy.** One primary action per screen at the bottom; solid
   clay dock for navigation; glance-only info (timer/progress) top.
2. **Sheets, not modals.** Every dialog <640px is a vaul bottom sheet via one
   implementation (`ResponsiveModal`). Zero raw centered Dialogs on phone.
3. **Type roles, not size patches.** Six roles (§3.1), weight law,
   tabular-nums discipline (one pinned exception).
4. **44px+ everywhere; hit-slop for the rest.** Visual size ≠ tap target.
5. **Press physics, not hover.** Soft-press 120ms on touch; hover lift stays
   desktop-only.
6. **Safe-area & viewport correctness — both ends.** `viewportFit: "cover"`,
   `interactiveWidget: "resizes-content"`, `dvh` everywhere, no horizontal
   scroll at 320/375/430, landscape gated explicitly (§2).
7. **Camera surfaces are first-class citizens.** Portrait previews, PIP
   obeying gesture physics, self-view during recovery, wake lock during
   enroll AND assessments.

**Anti-slop guardrails (binding, self-audited):**
- No gradient washes; no glass blur panels anywhere new — existing dock blur
  removed; **no `backdrop-filter` anywhere on `/play/` <sm**.
- Warm scrims only; scan-countdown chip's `bg-black/70` →
  `rgba(124,45,18,.75)`.
- No emoji icons (`"Practice complete! 🎉"` is pre-existing copy pinned by
  e45 — kept verbatim).
- No new fonts; Nunito 800 is an accent (strings ≤4 words), never paragraph
  weight.
- No 1px hairlines; no pure-black/gray shadows; clay's 5 rules inherited.
- No arbitrary text sizes in new code (`text-[Npx]` banned; existing ones die
  in the W2/W3/W5 sweeps).
- Skeletons use a **clay opacity pulse** (not a gradient shimmer sweep —
  guardrail consistency).
- Exam trust surfaces (paused/flagged/gate overlays, timer digits) do not
  animate beyond 150ms fades.

## 2. Strategy: same routes, dedicated mobile compositions where IA diverges

Same routes, no UA-sniffing, no parallel tree. The **play stage** and
**gradebook** get new mobile-only compositions; everything else adapts.

**Component-swap boundary rule (binding).** A breakpoint gate may render-swap
subtrees only **below the state owner** — inside `PlayClient`'s render
(HUD/action-bar/option-zone JSX) and inside `GestureLayer`'s active-mode
branch (camera container) — never above `PlayClient`/`GestureLayer`, never
around anything that boots a tracker or owns phase state. State never lives
inside a swapped subtree.

No CSS-interleaved duplicate markup on the play stage (would break e10's
exactly-once announcer assertions). Exactly-once ARIA nodes render once at a
shared, non-swapped location.

**The gate, pinned literally:** one `useMediaQuery` call with the string
`"(min-width: 1024px), (orientation: landscape) and (min-width: 640px)"`
(matchMedia comma-OR; never two ORed hooks). `getServerSnapshot` returns
false → SSR renders the portrait composition; landscape phones swap at
hydration (the accepted §7 flash).

## 3. Token foundation (globals.css, Tailwind v4)

```css
@theme inline {
  --text-2xs: 0.6875rem;  --text-2xs--line-height: 1.2;   /* 11px micro-badges */
  --text-xs: 0.8125rem;   --text-xs--line-height: 1.35;   /* 13px caption (was 12) */
  --text-sm: 0.875rem;
  --text-base: 1rem;       /* 16px — interactive floor */
  --text-lg: 1.125rem;
  --text-label: 0.75rem;   --text-label--line-height: 1.3; /* 12px fixed, label role */
  --text-prompt: 1.1875rem;--text-prompt--line-height: 1.35; /* 19px question prompt */
  --text-display: clamp(1.75rem, 8vw, 2.125rem);
  --text-display--line-height: 1.1;

  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}
```

The `--text-*` namespace generates real utilities (`text-prompt`,
`text-display`, `text-label`). **`--icon-*` is NOT a recognized Tailwind
namespace and generates no utilities** — icons consume the vars via
arbitrary-value utilities only: `size-[var(--icon-nav)]` etc.; never
`size-icon-*` class names. `--icon-inline: 1rem`, `--icon-control: 1.25rem`,
`--icon-nav: 1.5rem`. The button base's default `[&_svg]:size-4` rule stays;
surfaces needing larger icons set `size-[var(--icon-control)]` explicitly.

`layout.tsx` viewport export gains `width: "device-width"`,
`initialScale: 1`, `viewportFit: "cover"`,
`interactiveWidget: "resizes-content"`; `<head>` gains
`apple-mobile-web-app-title`.

Global CSS: `.hit-slop` (`after:absolute after:-inset-2`),
tap-highlight suppression + explicit `:active` styles, `touch-manipulation`
on interactive primitives. `overscroll-behavior-y: none` route-scoped on
html/body for `/play/` (the stage stays page-scrolled — the property sits on
the scroll root).

**Dark-mode shadow strategy (binding, in §3 not deferred):** dark keeps
*offset* depth via darker, higher-alpha warm shadow — never blur. Mechanics:
rename the underlying vars in `:root`/`.dark` (e.g. `--shadow-clay-value`)
and map in `@theme inline` (`--shadow-clay: var(--shadow-clay-value)`),
mirroring the color pattern — `@theme`-declared vars cannot vary by `.dark`.

| Token | Light | Dark |
|---|---|---|
| `--shadow-clay` | `6px 6px 0 rgba(194,65,12,.14)` | `6px 6px 0 rgba(20,8,2,.55)` |
| inner highlight | `inset 0 3px 0 rgba(255,255,255,.8)` | `inset 0 3px 0 rgba(255,255,255,.06)` |
| button bases | `#c2410c` / `#1d4fd7` | deep-brown `#7c2d12` / deep-blue equivalents |
| borders | `#FED7AA` | `border-amber-900/60`-range |

Icon consolidation: lucide wins; the 4 remixicon files migrate;
`components.json` updated. Notification-bell migration is **16 glyphs**
(pinned mapping in the PR: TriangleAlert, Archive, Award, CameraOff,
CheckCheck, CircleCheck, Lock, LockOpen, **Radio** (quiz_live — keep the
broadcast reading, not Play), LogOut, Bell, RefreshCw, UserPlus, UserSearch,
Video, FileText).

### 3.1 Type roles (binding)

| Role | Font | Utility | Used for |
|---|---|---|---|
| display | Fredoka 600 | `text-display` | results score numeral, landing hero |
| title | Fredoka 600 | `text-xl max-sm:text-lg`, lh 1.25, `[text-wrap:balance]` | sheet headers, card titles, classes hero H1, gate-sheet quiz title |
| prompt | Fredoka 600 | `text-prompt` (19px) | question prompt |
| body | Nunito 600 | `text-base`, lh 1.5 | option text (700 if ≤3 words), explanations |
| caption | Nunito 700 | `text-xs` (13px), muted | timestamps, Due chips, hero stat captions |
| label | Nunito 800 | `text-label` (12px), uppercase, `tracking-[0.04em]` | mode pill, eyebrows, nav labels |

Weight law: 800 only on strings ≤4 words. `tabular-nums` on everything that
ticks — **single exception: the `n/N` question counter must NOT carry
`tabular-nums`** (it precedes the timer chip in DOM; e10(b) selects the
first `span.tabular-nums`, which must be the timer).

## 4. Workstreams

### W1 — Shell & navigation
- **Topbar (<sm):** brand mark + bell + avatar; Language/Theme toggles move
  into the account sheet (<sm; e31/e41 run at desktop 1280×720 and stay ≥sm
  — verified). `Switch language` name survives. Acceptance:
  `router.refresh()` mid-drawer vs drag-dismiss; e48 Escape-close.
- **Solid clay dock (no blur):** floating island
  `inset-x-3 bottom-[calc(8px+var(--safe-bottom))]`, `rounded-[24px]`, solid
  `bg-card`, `border-[3px]`, hard offset `0 6px 0 rgba(194,65,12,.14)`
  (dark: §3 table). Total height ≤84px. Student: 4 slots, each `flex-1`
  (≥44×44 satisfied by construction ≥320px): 56px icon area (`--icon-nav`)
  + 12px label; active pill slides via transform 220ms spring (pill element
  only — no containing-block hazard for portals, verified). Blur removed.
  `aria-label="Mobile navigation"` + student link names verbatim (e48).
- **Lecturer dock = 2 tabs: Classes / Archived** (unchanged composition,
  restyled; no `/lecturer/quizzes` index route exists — verified — so no
  third tab).
- **Safe-top binding rule:** every `fixed`/`sticky` top-anchored surface and
  every full-screen sheet adds `pt-[var(--safe-top)]` — topbar, play header
  row 1, sticky instruction pills, paused/flagged/gate sheets. `scan-overlay`
  exempt (scrim may bleed under the notch). §5 contract.
- **Content under dock:** main `pb-[calc(96px+var(--safe-bottom))]` <sm;
  `pb-10` ≥sm.
- **Keyboard vs dock:** a single `focusin`/`focusout` listener on
  `document` (filtering `input/textarea/select/[contenteditable]`) toggles
  `data-keyboard-open` on `<html>`; the dock styles
  `max-sm:translate-y-[120%]` under `html[data-keyboard-open]` (200ms,
  transform-only). Covers topbar forms and sheet-embedded inputs.
- **Face tab** keeps `faceSetup` name + status dot badge (emerald enrolled /
  amber pulse not enrolled); tabs never conditional on state.
- **Sheet-close-on-navigate:** any sheet whose item navigates (bell items,
  account links) closes optimistically before `router.push` — binding rule;
  covered by the m1 notifications spec.
- **Notification bell:** onto shared Drawer/ResponsiveModal;
  `w-[380px] max-w-[calc(100vw-1.5rem)]`; `max-h-[85dvh]` parity; e30/e41b
  names pinned (e30 stays desktop-only). The unread badge lives on the
  **topbar bell** (not the dock).
- **Standalone back buttons:** every pushed page gets a 44px clay
  ChevronLeft back button (`common.back` keys exist — verified),
  hit-slopped. The play stage deliberately gets none (integrity decision).

### W2 — Lists & cards
- Grid floors → `minmax(min(100%,300px),1fr)`; **single-column-first** card
  grids <sm; stats strip 2-col only inside full-width cards.
- **Spacing rhythm:** gutter 16px <sm; card padding 20px <sm; hero bands
  `p-5`; vertical gap 16px; radius stays 22px.
- **Zero-state rule (<sm, binding):** when `classes.length === 0`, hero
  collapses to title + one line — never render zero stat cards — and the
  join form moves into the empty-state card (BotAvatar 96px + Fredoka line +
  join input + Join button, thumb zone). Joined-state hero slims to a single
  inline caption row. New i18n keys (collapsed hero title/one-liner, joined
  caption) in both locales.
- **Join-flow dedupe:** the dashed "Join class" tile is deleted <sm;
  ≥sm keeps it. `aria-label="Join code"` kept; `inputmode` +
  `autoCapitalize=characters` + `enterkeyhint="go"`.
- Card footer actions → full-width thumb rows; exact `"Start"` + `li`
  structure untouched; filter-chip remove → hit-slopped 44px. **List cards
  get `:active` press states <sm** (cards currently go quiet on touch).
- Due chips → caption role.
- **Personality:** BotAvatar empty states (classes / my-quizzes /
  notifications; copy via next-intl both locales); `loading.tsx` for the
  four list routes renders 3 clay skeleton cards with a warm **opacity
  pulse** ≤1.4s.
- **Cheap wins bundled here:** `select-none` on labels/interactive text;
  iOS autofill styling for clay inputs; `:focus-visible`-only focus rings
  on coarse pointers (rings must not linger after taps).

### W3 — Play stage (flagship) — `/play/[sessionId]`
Mobile composition rendered inside PlayClient below the state owner; desktop
unchanged.

**Sticky header — two rows, opaque, `pt-[var(--safe-top)]`:**
- Row 1 (44px): `n/N` progress (Fredoka 600 16px, **not** tabular-nums —
  §3.1 exception) + progress bar + timer chip verbatim (`role="timer"`,
  `aria-live="off"`, /time remaining/i, destructive classes when low) + cam
  status dot.
- Row 2 (120px incl. padding): mode pill (label role) left; camera PIP right.
- **Header budget: safe-top + 164px hard cap** (44 + 120); PIP is 84×112
  ≥360px, **72×96 below 360px** (row 2 → 104px, budget safe-top + 156px).
  If a future element would push past the cap, it does not ship in the
  header.
- Quiz title appears once, in the begin-gate sheet (title role). Desktop
  keeps title-in-flow. No spec asserts the title on `/play/*` after Start
  (verified).

**Camera PIP obeys gesture physics:**
- Portrait PIP, `rounded-[18px]`, 3px clay border, mirrored.
- **Single hold-anchor rule: while armed, the option-card accent fill is the
  ONLY hold-progress display — PIP shows live mirror + status ring,
  hold-ring suppressed** (one attention anchor; gaze stays at the point of
  action). Auto-expand to 240×320 on camStatus reposition / face-degraded /
  calibration; manual tap-to-expand only when not armed; expanded = warm
  scrim + 44px X chip, 240ms sheet curve.
- PIP↔expanded is a CSS-only toggle within one JSX branch (video/canvas
  never remount; extend `bindDOMElements` deps if branch structure ever
  forces it). Landmark alignment is aspect-safe (video+canvas crop
  identically). **Default PIP/card aspect is 3:4; fallback 1:1** if the
  real-frame check (P3) shows the hand cropped out of the 640×480 source —
  one decision, inherited by both PIP and the calibration card.
- Frame-handler logic reused unchanged. Gestures off → no PIP.

**Action bar — 8-state matrix (binding):**

| Phase | Bar content |
|---|---|
| question, single, unanswered | **Container renders empty** (height/padding animates 200ms); tap-option is the primary action |
| question, multi, 0 selected | Bar visible; `Confirm answer` disabled clay (native `disabled` attr, current mechanism); count pill left of button (`aria-hidden`) — sr-only `multiSelectedCount` span kept |
| question, multi, ≥1 selected | Enabled; name exactly `"Confirm answer"`; status chip above the bar (see below) |
| locked / submitting | Disabled + spinner dot; pre-pressed shadow |
| feedback | Full-width `Next`/`Finish`; feedback chip above the bar, never inside |
| timeUp | Destructive-tinted `Retry-submit`, pinned |
| submit-failure | Destructive-tinted `Retry-submit` + error copy above the bar + offline hint (`navigator.onLine`, read at render); overlays suppressed as timeUp |
| submitted / dead | Full-screen takeover, no bar |

**ARIA mechanics (binding):** the action-zone container
(`play-client.tsx:998-1004`, `aria-live="polite"`) **stays mounted in every
non-terminal phase and renders empty in state 1** — a newly-inserted live
region does not announce, and the locked/submitting swaps depend on it
surviving; only `submitted`/`dead` remove the stage. All matrix **buttons**
render inside it; inner count/hint spans stay non-live. The multi **status
chip** ("N selected · open palm to confirm"), the submit-failure error copy,
and the feedback chip render **outside** the container, as siblings directly
above it, `aria-hidden` where they'd duplicate the sr-only channels (the
sr-only `multiSelectedCount` span remains the sole count announcement).

**Submit-failure is not a new Phase.** It is a client-render state:
`submitNow()`'s failure branches set `lastSubmitFailed = true` (cleared on
submit start and success); the bar renders the row when
`(phase === "timeUp" || phase === "question") && lastSubmitFailed`. Overlay
suppression becomes `BLOCK_INPUT_PHASES.includes(phase) || lastSubmitFailed`.
`Phase` and `FacePipelinePhase` unions unchanged.

- Options: full-width clay cards, min-h 56px, letter badge 40px,
  `aria-pressed` + `"<letter> <text>"` names; press 120ms.
- **Motion table (binding):**

| Surface | Motion |
|---|---|
| Sheet (vaul) enter/exit | 300ms `cubic-bezier(0.32, 0.72, 0, 1)`; velocity drag-dismiss **on read-only sheets; `handleOnly` on form sheets** (per W5/A16 rule) |
| Option press | 120ms translate+shadow collapse |
| Feedback chip (practice) | 200ms `back.out(1.4)` scale 0.92→1 |
| Feedback chip (assessment) | 150ms fade only |
| Question→question | 200ms translate-X 12px + fade, direction-aware; **main-thread budget: transform-only, no large opacity composites near the frame-handler cadence** (the tracker reads camera frames, not DOM pixels — this is about rAF contention dropping hold-confirm frames on low-end devices) |
| Dock pill | 220ms spring, transform-only |
| Timer low-time | instant color + haptic; no pulse |
| Never animates | paused/flagged/gate overlays (150ms fade max), timer digits, tabular numerals |
| Bar reveal/hide, dock keyboard-hide, PIP expand | ad-hoc ≤300ms, transform/opacity only, reduced-motion collapses |

`prefers-reduced-motion` collapses all to opacity.

**Recovery is camera-visible (binding):** the paused/recovering full-screen
clay sheets contain a live mirrored self-view: portrait viewfinder (~240×320,
face-oval guide), liveness instruction, Recover/Continue pinned at the
thumb. **Stream plumbing:** add a public `get stream(): MediaStream | null`
to `FaceTracker`, expose through `useFaceTracker`'s return, pass from
PlayClient into `FaceVerifier`, set `srcObject` on the viewfinder video —
no second `acquireCameraStream()` token, no context. Flagged stays blind
(waiting state). The overlay is opaque clay (the current
`bg-background/80 backdrop-blur-sm` is removed <sm).

**Calibration mobile composition (<640px, binding):**
- Single-column stepper: camera card ~45dvh (aspect per the PIP 3:4/1:1
  decision), finger chips directly beneath the camera, one instruction at a
  time, one-line status.
- The multi-select practice mock card is **omitted <sm** — live finger chips
  + status line teach toggle/commit; the multi status chip absorbs the
  vocabulary.
- Continue/Skip pinned as sticky bottom bar.
- **Gate/calibration/recovery do NOT share a component or lift state** — the
  gate is rendered while `GestureLayer` is unmounted, and mounting it under
  the gate would boot the hand tracker during the face gate (state-owner
  violation). They render as full-screen clay sheets **sharing one visual
  system**, with per-surface, locally-rendered step indicators ("Step 1 of
  2 · Consent & identity" in the gate sheet; "Step 2 of 2 · Calibrate" in
  calibration); navigation is the existing state machine
  (gate → beginGate() → ready → booting → calibrating). When gestures are
  off/unavailable the flow is single-step and no indicator renders.

**Wake lock on the play stage:** acquired on `beginGate()` for assessment
mode (camera-after-consent still holds — the lock is a screen lock, not the
camera), re-acquired on `visibilitychange`, released on submitted/dead.
Enroll gets it in W4.

**Perf budget (binding):** no `backdrop-filter` on `/play/` <sm; PIP is the
CSS-transformed existing element only (the recovery viewfinder's
shared-stream video is the sole exception); transitions transform-only; hand
tracker may idle while `phase !== "question"`. **P3 device QA:** one
mid-range Android in low-power mode; **fallback if no device is available:
Playwright with `cpuThrottlingRate: 4` + a written perf note**; a failed
item ships only fixed or with the exception recorded in §7.

**Haptics (mode-split):** practice — 8ms answer commit, 24ms hold-confirm,
`[16,60,16]` timeUp; **assessment — hold-confirm and timeUp only, no
per-commit buzz** (repeated haptics in a recorded exam hall; a desk-lying
phone can micro-shake the camera into spurious re-verify). None under
`prefers-reduced-motion`; no-op on iOS; no settings UI.

- Overlays keep `role="alertdialog"` + focus-trap; testids verbatim.
- `dvh` replaces the three `100vh` sites; landscape handled by §2.
- **Practice player scope (pinned):** runs the identical mobile composition,
  bar matrix, and motion table as assessment (minus face rows and haptic
  mode differences); nothing else about practice changes; `sq-progress:`
  sessionStorage untouched.

### W4 — Face enrollment & camera surfaces
- **`object-contain` + letterbox** portrait preview (guide accuracy >
  cosmetics); constraints stay 640×480 (revisit behind a flag only if device
  QA shows drift).
- Instruction pill → sticky below safe-top; bottom status chip single-line
  at 375px.
- Result dialog → ResponsiveModal; Wake Lock during capture.
- Face setup tab: native-feel status card; consent-before-camera untouched.

### W5 — Lecturer mobile parity
- All builder dialogs → ResponsiveModal sheets <sm; sticky footers.
- **vaul+inputs rules:** sheets with inputs/file controls set
  `repositionInputs` + drag-dismiss `handleOnly`; one device QA pass each
  (same device as P3).
- Builder icon-only actions: 44px labeled row menu <sm; tooltips stay on
  desktop; tooltips suppressed on coarse pointers globally.
- Create-quiz form: `w-full sm:w-52` pickers; h/min cluster 2-col grid;
  time inputs `text-base h-11` <sm.
- **Gradebook mobile composition** (<sm, below state owner): student list →
  per-student sheet (name + horizontal score-chip row per quiz, scroll-snap,
  + cumulative stat card); quiz-column tap → per-quiz sheet (5-bucket clay
  distribution bar + student rows). Cross-navigation closes-and-replaces.
  Desktop table untouched.
- Results dashboard: chips retuned to caption role.

### W6 — Auth, landing, practice
- Auth: type retune + full-width buttons; toggle collision fix.
- Landing: mobile anchor sheet (3 links) — last priority.
- `/s/[code]`: harmonize styling; logic untouched.

### W7 — PWA installability
- `manifest.webmanifest`: `display: standalone`, `theme_color` #F97316 +
  dark `media` variant, `background_color` #FFF7ED, maskable 192/512 icons,
  no `orientation` key; `apple-touch-icon`, capable + title metas.
- **iOS splash (optional line-item, may be cut without guilt):** one-time
  script generates `apple-touch-startup-image` set from the 512px maskable
  icon on #FFF7ED; if cut or deferred, the acceptance note "iOS launches
  white until splash set lands" is written down, not silent.
- No service worker (stale-cache hazard in a proctored exam app).
- Install hint chip (Android `beforeinstallprompt`; iOS gets no prompt —
  recorded decision, see "What you're approving"): rendered as a dismissible
  row inside the account sheet (placement + dismissal specified here).
- **Resume + pull-only notifications:** gate-sheet copy variant when
  `initialAnswers.length > 0` ("Resuming — N of M answered, T remaining";
  new keys both locales). Stated explicitly: no SW → no push — "results
  revealed" is seen on next app open via the **topbar bell badge**; the
  SQ-2 "Awaiting results" cards are the fallback surface.

### W8 — Systemic component retune
- **`ui/button.tsx` base changes land once in P0a** (as the fifth primitive,
  alongside select/checkbox/datetime-picker/drawer/popover) with a same-PR
  visual audit of every size variant <sm: size-sm `h-9→h-10`, default
  `max-sm:h-12`, lg 52px, xs desktop-only + hit-slop. "Per-workstream"
  applies only to swapping variant/size *usage* per surface and QA-ing
  those surfaces; P6 keeps only the variant audit residue.
- `ui/select.tsx`: 16px trigger/items; `max-w-[calc(100vw-1.5rem)]`.
- `ui/checkbox.tsx`: hit-slop. `ui/datetime-picker` time inputs
  `text-base h-11 w-14` <sm.
- `ui/drawer.tsx`: `pb-[max(1rem,var(--safe-bottom))]`; note vaul's
  `shouldScaleBackground` is a silent no-op today (no
  `[data-vaul-drawer-wrapper]`) — wire or remove while touching the file.
- `ui/popover.tsx`: `w-72 max-w-[calc(100vw-1.5rem)]`.
- Size sweep folded into W2/W3/W5; the token change (text-xs 12→13px)
  implicitly touches all 217 sites — the *audit* is scoped to touched files;
  watched sites: question-card chips, h/min cluster (P0a visual-QA list).

## 5. Hard contracts (verified across three critic rounds; must not break)

1. Names: `Mobile navigation`, student nav link names, exact `"Start"`,
   `"Next"`, `"Finish"`, `"Confirm answer"`, `"Try again"`,
   `"Begin assessment"`, bell `"Notifications"` / `"Notifications, N unread"`,
   `"Mark all as read"`, `/your innovision account/i`, `/sign in/i`,
   `/publish/i`, `/add this question/i`, `"Create class"`, `"Switch language"`.
2. Option names `"<letter> <text>"`; multi toggles `"Option N"`; quiz lists
   are `li` items.
3. Testids: `scan-overlay`, `gesture-video-container`,
   `flagged-wait-ticker`, `face-degraded-banner`, `theme-toggle`,
   `question-image-input`, `bulk-import-file-input`.
4. ARIA: `role="timer"` + `aria-live="off"` + /time remaining/i — timer chip
   stays the first `span.tabular-nums` in DOM order; exactly one
   `sr-only[role="alert"][aria-live="assertive"]` + one
   `sr-only[role="status"]` on play; the action-zone container keeps
   `aria-live="polite"`, stays mounted in non-terminal phases, hosts all
   matrix buttons, and never gains text-bearing children beyond the
   existing contract (status chip/error/feedback chips render outside it);
   the sr-only `multiSelectedCount` span survives; `role="status"` feedback
   chips; dialog/alertdialog roles.
5. Safe-top rule: every fixed/sticky top-anchored surface and every
   full-screen sheet pads `var(--safe-top)`; `scan-overlay` exempt.
6. Form labels: Email, Password (type attr), Full name, Matric number,
   Lecturer invite code, Join code, Class title, Quiz title, Mode, Question
   prompt, Option N, h/min. `data-day="YYYY-MM-DD"` ISO.
7. Fake seams: `getFakeHandTracker()` / face-seam gating inside redesigned
   components; `window.__INNOVISION_*` untouched; `lib/gestures/constants.ts`
   pinned.
8. i18n: all new copy via next-intl keys in both en.json and ms.json; no
   `t.rich` for new copy (check-i18n doesn't scan it); `getTranslations`
   references ARE caught.
9. Security/privacy: camera boots only after consent; keyless assessment
   acks; shuffle presented↔canonical translation; no answer key pre-reveal;
   `Permissions-Policy: microphone=()` untouched.

## 6. Delivery phases (each shippable, e2e-green)

| Phase | Scope | Size |
|---|---|---|
| P0a Foundations | tokens + dark shadow table + viewport export + hit-slop + **5 primitives (select, checkbox, datetime-picker, drawer, popover, + button base changes with same-PR size-variant audit)** + icon consolidation + watched-sites visual QA | 2 days |
| P1 Shell & nav | W1 (topbar, solid dock, safe-top, bell, 2-tab lecturer dock restyle, face badge, back buttons, keyboard dock-hide, sheet-close-on-navigate) | 3 days |
| P2 Lists & cards | W2 (grids, rhythm, zero-state hero, join-in-empty-state, card press states, empty states + skeletons, cheap wins) | 2–3 days |
| P3 Play stage | W3 (composition, PIP physics, 8-state bar + ARIA mechanics, calibration composition, recovery self-view, wake lock, perf budget + device QA) + practice harmonization; targeted e2e incl. e10(b) | 6–8 days |
| P4 Face & auth | W4 + W6 auth bits | 2 days |
| P5 Lecturer parity | W5 (sheets + vaul rules, builder menu, create-quiz, gradebook composition) | 4–5 days |
| P6 PWA + polish | W7 (splash optional), landing menu, button variant audit residue, dark-mode sweep per §3 table, reduced-motion/dynamic-type pass | 2–3 days |

**Honest total: ~21–26 working days.**

**Validation per phase:** `npm run lint && npm run typecheck && npm run
check:i18n && npm run test && npm run build`, then targeted e2e; full suite
per phase merge.

**Mobile e2e (binding, both sides of the split):**
- `playwright.config.ts` gains a second project: name `mobile`,
  `testMatch: ["**/m1-*.spec.ts"]`,
  `use: { ...devices["iPhone X"] }` (375×812, `hasTouch: true`,
  `isMobile: true`, mobile UA — without touch the m1 specs never exercise
  coarse-pointer/`:active` branches).
- The **desktop project gains `testIgnore: ["**/m1-*.spec.ts"]`** — without
  it the desktop project runs the m1 specs at 1280×720 where no mobile
  composition renders, and CI's `maxFailures: 1` aborts the whole step.
- webServer is per-run (shared across projects — no double build, verified);
  envs flow to both projects (`.env.local` at config scope, verified).
- **CI budget:** the m1 set adds a projected +4–7 min at `workers: 1`; the
  e2e step timeout (currently 15 min) is raised in the same PR that adds
  the project. CI intentionally runs both projects.
- m1 allowlist: auth→classes→quiz play→submit; face enroll seam; a NEW
  mobile-notifications spec (bell sheet, sheet-close-on-navigate, dock
  assertions — e30's popover flow is desktop-only by design and is not
  rerun at 375px).
- e48's `.gemini/` screenshot paths move to `test-results/` when its
  lecturer test is un-paused in P1.

## 7. Risks & recorded decisions

- **Hydration swap flash** (desktop + landscape phones until hydration):
  accepted for the two gated surfaces; countdown state lives in PlayClient.
  No CSS-interleave on play.
- **Camera constraints** stay 640×480; enroll commits to `object-contain`;
  PIP + calibration share one aspect decision (3:4 default, 1:1 fallback)
  verified with a real frame in P3.
- **PWA without SW:** standalone display + safe areas + splash (optional);
  no offline; notifications pull-only (stated in W7).
- **Perf:** §W3 budget + device QA with a named fallback
  (`cpuThrottlingRate: 4` if no device).
- **Haptics:** mode-split; no integrity interaction (verified — vibration is
  not captured by the incident recorder).
- **Scope control:** lecturer surfaces parity-tier; student flagship first.
- Open for owner: icon/logo asset source for manifest + splash.
- **Implementation note (P6):** `manifest.webmanifest` + SVG icons
  (`public/icon.svg`, `icon-maskable.svg`) + metadata wiring SHIPPED. The
  `beforeinstallprompt` install-hint chip and the iOS
  `apple-touch-startup-image` splash set are DEFERRED pending the owner's
  logo asset (the SVG placeholders are generated, not brand-approved) —
  recorded here per the plan's "written down, not silent" rule. Android
  install already works via the manifest; iOS Add-to-Home-Screen uses the
  apple-touch-icon fallback.

---

## Appendix A — Changelog

- **v1→v2** (round 1: feasibility R1-A + design R1-B): swap boundary binding;
  CSS-interleave struck on play; gradebook dock tab dropped; action-bar
  matrix (7 states); solid clay dock; sticky header anatomy + title to gate
  sheet; PIP gesture-physics fix; landscape gate; type roles; motion table;
  personality pass; spacing rhythm; P0 re-phased + honest estimate; mobile
  e2e allowlist; timer-chip DOM rule; object-contain commit; vaul+input
  rules; interactiveWidget; haptics decided; e45 citation fixed.
- **v2→v3** (round 2: contracts R2-A + UX flows R2-B): desktop-project
  `testIgnore` + device descriptor + CI timeout re-budget; action-zone
  polite container + sr-only count survival as contracts; safe-top binding
  rule; recovery self-view; calibration mobile composition; zero-state hero
  + join-in-empty-state; single hold-anchor rule; submit-failure state;
  play-stage wake lock; dark-mode shadow table; /play perf budget;
  sheet-close-on-navigate; resume copy; keyboard dock-hide; header budget;
  haptic mode split; motion rationale corrected; literal landscape query;
  hero role mapping; t.rich note.
- **v3→v4** (round 3: ambiguity R3-A + holism R3-B): action-zone container
  always-mounted rule ("bar hidden" = renders empty); submit-failure pinned
  as client-render state, not a Phase; gate/calibration one-visual-system
  instead of one shared sheet; `text-display`/`text-prompt`/`text-label`
  tokens; status chip outside the live container; icon consumption via
  arbitrary-value utilities; stream exposed via FaceTracker getter; button
  base changes moved to P0a (5 primitives); header budget arithmetic closed
  (safe-top + 164px); tabular-nums exception pinned; dark-shadow token
  rename mechanics; device-QA fallback; dock slot geometry + 96px content
  padding; bell glyph mapping pinned (16); keyboard listener mechanism;
  lecturer dock resolved to 2 tabs (no index route — verified); practice
  scope pinned; "What you're approving" owner summary; shimmer → opacity
  pulse; drag-dismiss vs handleOnly reconciled; bell-badge wording; cheap
  wins line-item; splash marked optional; iOS install prompt recorded as a
  non-goal.

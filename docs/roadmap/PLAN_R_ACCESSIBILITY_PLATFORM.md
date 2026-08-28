# Roadmap Plan — Accessibility, Theme & Platform Quality

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec.
>
> Domain: inclusive rendering, theme correctness, mobile ergonomics, payload
> hygiene, i18n internals. Baseline noted by auditor: i18n parity infrastructure
> is excellent (832/832 keys enforced) and several a11y patterns are strong
> (focus-trapped alertdialogs, aria-live announcer, skip links, reduced-motion
> kill-switch) — items below CLOSE gaps, they don't rebuild strengths.

---

## AX-1 · Ship dark mode toggle (HIGH — work already 90% present)

**Problem:** Complete `.dark {}` token set exists (globals.css:103–139) plus
`dark:` variants throughout components; NOTHING ever applies the class
(layout.tsx:43–46 has no theme provider). Worse: `colorScheme: "light dark"`
in viewport export tells UA widgets to go dark while app stays light —
contradictory rendering RIGHT NOW.

**Design sketch**
- Prefer CSS-native solution over next-themes dependency IF feasible:
  class-toggling island (localStorage + matchMedia preference resolution +
  inline pre-hydration script in layout head to prevent flash-of-light).
  Inline script must satisfy CSP Report-Only constraints (harmless now; note
  migration risk if CSP ever enforced — hash it).
- Toggle control beside LanguageToggle in AppUserMenu; cycle
  light/dark/system; persisted key namespaced.
- Keep `colorScheme: light dark` AFTER class system works coherently (it then
  becomes correct).

**Tests:** component toggle test; visual smoke screenshot pair in playwright
(optional); no-CSP-regression check.

---

## AX-2 · Primary contrast token fix (HIGH, tiny)

**Problem:** White on orange-500 (#f97316) ≈ 2.8:1 fails WCAG AA everywhere
bg-primary renders (button variant ui/button.tsx:14, score numerals, nav
active letters, calibration chips).

**Design sketch**
- Change `--primary-foreground` to deep-brown #431407 (palette-consistent,
  ≈7:1) OR introduce `--primary-deep` for white-bearing surfaces and reserve
  bright orange for accents/large numerals. Token-level fix = single-file
  globals.css edit + snapshot eyeball pass across screens (dashboard,
  builder, play pages, dialogs).
- Add contrast-pair unit assertion extending labels.test.ts AAA-pattern.

---

## AX-3 · Timer + phase live-region semantics (HIGH, small)

**Problem:** Countdown pill turns red silently (`progress-hud.tsx:52–62`);
phase swap buttons (Recording→Submitting→Retry) unannounced; SR users receive
zero warning before auto-submit.

**Design sketch**
- role="timer" on countdown element (aria-live OFF — ticks would spam);
  discrete sr-only announcer firing milestones (T-10m/5m/1m polite;
  <30s assertive ONCE).
- Wrap bottom action zone aria-live="polite".
- Announce hold-confirmations ("Answer B confirmed") via existing announcer
  utility channel used elsewhere in project (`src/lib/a11y/`).

---

## AX-4 · Overlay consistency + focus management (MEDIUM, small)

**Problem:** Hand-loss pause overlay missing trap sibling FaceVerifier has
(`gesture-layer.tsx:569–581` vs `face-verifier.tsx:17–31` using
`useOverlayFocusTrap` + alertdialog); PlayClient.goNext leaves focus stale
(:564–568) unlike practice player's heading-focus (:119–135); skip-link absent
on exam surface.

**Design sketch:** reuse the EXISTING utilities — trap wrapper + heading
tabIndex=-1 focus call after advance; add minimal skip-to-question-content
anchor within play layout.

---

## AX-5 · Mobile play ergonomics: camera PIP (MEDIUM)

**Problem:** Below lg breakpoint camera panel stacks ABOVE question column
(min-h-[350px]) forcing scroll ping-pong to keep hand visible while reading.

**Design sketch**
- Compact floating PIP (bottom-corner fixed, tap-expand) for gesture-active
  layouts under lg; quiz card owns scroll-top position. Coarse-pointer+
  narrow detection may additionally offer click-first minimized video mode
  leveraging existing tracker-on-hidden-video capability
  (`play-client.tsx:654–661`).
- Calibration stays full-screen (existing calibration→PIP pattern between
  statuses already precedents the transition choreography).

**Tests:** responsive E2E viewport assertions (exist? verify at pre-flight);
manual device matrix note.

---

## AX-6 · Scrollbar/pagination affordances (LOW-MED, small)

**Problem:** Global scrollbar suppression (globals.css:156–165) makes
horizontally-scrollable nav + truncated lists undiscoverable.

**Design sketch:** edge fade masks on horizontal scrollers (nav
app-shell.tsx:69); thin styled scrollbars elsewhere; "showing first N of M"
hints where roster/results truncation caps bite (ROSTER_LIMIT=100,
RESULTS_SESSION_LIMIT=200).

---

## AX-7 · Camera failure taxonomy + capability messaging (MEDIUM — shared kernel with STUDENT_QOL SQ-5)

Split-of-work rule at pre-flight: the getUserMedia rejection-classification
UTIL lands here (lib/vision/camera.ts currently throws undifferentiated
English strings — split NotAllowedError/NotFoundError/insecure-context into
typed outcomes feeding i18n keys en/ms); SQ-5 consumes in student surfaces.
Add WebGL/SIMD capability probe advisory ("device slow — clicks still work")
before boot attempts, replacing silent CPU-fallback degrade.

---

## AX-8 · i18n/date-formatting consolidation (LOW, small batch)

- Extract shared `localeTag()` (five files hand-roll ms-MY/en-US ternary);
  centralize True/False translation currently triplicated
  (player-client/question-card/end-screen formatOptionText copies).
- Route `.toLocaleString()` outlier (GenerateFromFileDialog:489) through
  locale-aware formatter.
- Delete inert hardcoded-English fallback branches (calibration/enroll
  try-catch blocks) so missing keys fail loudly in dev.

All changes must leave `npm run check:i18n` green.

---

## Pre-flight log

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- (none yet)

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

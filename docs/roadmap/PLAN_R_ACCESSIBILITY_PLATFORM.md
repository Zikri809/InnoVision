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

> **Pre-flight reconciled 2026-08-29 @ 5f6b1da:** Evidence verified. `.dark {}`
> tokens at globals.css:103–139 confirmed intact; layout.tsx:35 carries
> `colorScheme: "light dark"` with NO class-applying provider (contradiction
> still real). CHANGES SINCE AUDIT: (a) globals.css:145–151 now sets
> `color-scheme: light` on `html` and `dark` on `html.dark` — CSS `color-scheme`
> overrides the viewport meta, so once the class flips, native widgets follow
> correctly and the viewport `colorScheme` becomes harmless belt-and-braces;
> (b) viewport `themeColor` already ships both light/dark media entries
> (layout.tsx:31–34) — NOTE (corrected by gap review): CSS `color-scheme`
> and the `themeColor` meta drive DIFFERENT surfaces (native widgets vs
> browser chrome bar), so a user forcing dark on a light-OS device still
> sees a light browser bar; a one-line `meta[name=theme-color]` sync inside
> `applyTheme` can close that later (deferred); (c) CSP is still Report-Only with
> `script-src … 'unsafe-inline'` (next.config.ts:22) so the inline pre-hydration
> script is safe today; add its hash to next.config.ts before any CSP
> enforcement (noted in that file's own migration comment). Design refined:
> CSS-native island (NO next-themes dep) — pure helpers in
> `src/lib/theme/theme.ts` (storage key `innovision.theme`; cycle
> light→dark→system; system resolves via matchMedia; `applyTheme` toggles
> `.dark` on `document.documentElement`), inline pre-hydration script in
> layout `<head>`, toggle button beside LanguageToggle in AppUserMenu
> (app-user-menu.tsx:204). Auth/landing surfaces render LanguageToggle directly
> and get the pre-hydration script (no flash) but no toggle in v1 — toggle lives
> in the signed-in shell only. Tests: Node unit tests for the pure resolver
> (`src/lib/theme/theme.test.ts` — resolution matrix, storage fallbacks); E2E
> visual smoke optional per original sketch.

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

> **Pre-flight reconciled 2026-08-29 @ 5f6b1da:** Evidence verified —
> `--primary: #f97316` with `--primary-foreground: #ffffff` at
> globals.css:71–73; dark mode (globals.css:111–112) already correct
> (#2a170c on #fb923c). NEW FINDING: `--sidebar-primary-foreground: #ffffff`
> (globals.css:96) has the identical white-on-orange failure — fixed in the
> same token pass. Grep confirms ZERO hardcoded `text-white`-on-`bg-primary`
> bypasses; all 22 `text-primary-foreground` usages flow through the token, so
> a single-file edit is complete. Dark-mode `--primary-foreground` untouched.
> Contrast assertion lands as a pure-luminance unit test
> (`src/lib/theme/contrast.test.ts`) computing WCAG ratios from the token
> literals — extends the labels.test.ts AAA-pattern precedent (U-M20).

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

- 2026-08-31: AX-3 reconciled against the current main and implemented same
  day. CORRECTIONS to the sketch: (a) the "existing announcer utility in
  src/lib/a11y/" DOES NOT EXIST — src/lib/a11y/ held only focus-trap.ts; AX-3
  created the announcer machinery (pure timer-milestones.ts +
  in-component sr-only polite/assertive nodes following the notification-bell
  inline-announcer idiom and the FlaggedWaitTicker fire-once pattern). (b)
  On-screen option labels are NUMERALS, not letters — the confirmation copy is
  "Answer {label} confirmed" with label = presented index + 1 (matches what
  the student sees), not "Answer B confirmed". (c) progress-hud.tsx moved to
  src/components/quiz/ (plan cited a stale path); countdown span now at :53
  carries role="timer" + explicit aria-live="off" (face-verifier.tsx:69
  precedent) + accessible name (existing play.hud.timeRemaining). (d)
  Milestones are value-keyed (remainingMs) so pause/flag gaps are
  inherently tolerated; T-10m/5m/1m polite, <30s assertive ONCE via an
  announced-set ref, threshold ASSERTIVE_THRESHOLD_MS=30_000 twin-pinned to
  the HUD's WARNING_THRESHOLD_MS by unit test; derived during render (no
  setState-in-effect). Action zone div (:892) wrapped aria-live="polite" for
  Recording→Submitting→Retry swaps. e10(b) extended with the a11y assertions.
  No migration; keys under play.hud (en+ms same commit).

- 2026-08-29: AX-1 + AX-2 reconciled against 5f6b1da; no migrations involved
  (CSS/component/unit-test surface only); noted `color-scheme` CSS rules now
  exist in globals.css:145–151 (audit-era contradiction partially self-healed
  once `.dark` class flips), themeColor already dual-media, CSP still
  Report-Only w/ 'unsafe-inline', `--sidebar-primary-foreground` added to AX-2
  scope, zero hardcoded text-white-on-bg-primary bypasses found.

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

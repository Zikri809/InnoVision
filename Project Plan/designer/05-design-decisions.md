# 05 — Design Decisions Needed

Open questions where design input shapes the build. Ordered by when they're needed. Bring answers to the next team sync — several block Week 2.

---

## Blocking Week 2 (web loop build)

### D1. UI component library ✅ **DECIDED: shadcn/ui + Tailwind CSS**
Confirmed: the designer will design with shadcn/ui. This satisfies tech plan §12 and pairs with Tailwind as the styling base. Component-customization work (theming, risk-band colors, session-card anatomy) now flows through D8/D9.

### D2. Plan view visualization
The route is the product's signature view — sessions across weeks, per course, with debt/risk/buffer. Options:
- **Timeline/calendar hybrid** (sessions on a calendar, list below)
- **Gantt-ish route strip** per course (sessions as segments on a line to exam day)
- **Agenda list** grouped by day (simplest, weakest "big picture")
Recommendation: whatever makes *"am I going to make it?"* answerable in 3 seconds. Risk bands and buffer must live on it.

### D3. Post-replan communication
When the plan regenerates (SKIP, busy day, missed session, new PDF), how much do we show?
- **A. Silent** — plan just looks different next visit
- **B. Toast** — "Plan updated"
- **C. What-changed summary** — "3 sessions moved; exam prep still on track" ✅ *recommended — trust is the core design challenge (see 00-overview)*
If C: define the component (toast vs. inline banner vs. diff-style list) and its persistence.

### D4. Default evening windows in the Availability editor
Quick-plan silently assumes default evening windows. When the student opens the editor, do we show those defaults as actual blocks (editable, deletable) or as an implicit "default" mode? Showing them is more honest; implicit is less cluttered. Leaning: show them, styled distinctly as "suggested."

### D5. Session screen layout (mobile)
Many students will study from their phones. PDF viewer + timer + recall form on a small screen: stacked scroll? Tabbed (Read / Reflect)? Collapsible sections? This is the most-used screen on mobile — prototype this one first. Include the interrupted/resume state (`01` §7) in the prototype — "welcome back — still studying?" is half the mobile reality.

## Needed during Week 2

### D6. Failed page-count extraction
PDF uploads but page count fails. Can the student proceed (course stays unscheduled until fixed)? Manual page-count override field violates "students can't answer how many pages"… but blocking entirely may strand them. Leaning: allow proceed, keep course unscheduled, prominent retry. Your call on how the error row communicates this.

### D7. Empty-state illustration style
~10 empty states need art (see `03-state-matrix.md` §1). Pick a direction: spot illustrations / icon-only / none (pure typography). Consistency matters more than richness — Week 2 ships regardless.

### D8. Risk-band color system
4 bands + missed/skipped/edited session markers must coexist on the same cards without color overload. Define the palette once (accessibility: labels always accompany color). Note cram mode adds urgency styling on Today — needs to read as *time pressure*, not as a 5th risk band.

### D9. Session card anatomy
One card used in 3 places (Today, Plan, Course detail). Define: what metadata shows by default vs. expanded (duration? debt impact? buffer?), and the status icon system (scheduled/in-progress/done/skipped/missed/edited).

## Can wait (Week 3+)

### D10. Progress page depth
MVP: pages done/total + debt + risk per course, expired archive. Stretch: completion trend charts, streaks, confusion-note history browser. Scope decision: what ships for the demo vs. what's cut?

### D11. Course deletion
Pause exists; delete doesn't (plan silent). Do we add delete-with-confirmation on Course detail? Data model supports it (cascade), but it's scope. Your UX call: is pause-with-history enough for a competition MVP?

### D12. Onboarding escape hatch
Can a student skip quick-plan mid-flow (e.g., wants to set availability first)? Plan's stance is "no — defaults carry you to value." If you design a skip link, it lands on Today in incomplete state. Confirm stance or design the escape.

### D13. Venue: optional or required?
Schema doesn't pin nullability for `examinations.venue`; `01` §3 currently treats it as skippable. Decide and tell engineering to enforce matching validation. Leaning: optional (venue never drives planning).

### D14. Quiet-block semantics *(needs engineering input)*
Does a `quiet` block suppress only reminders, or also block session *scheduling*? The reminders test implies suppression; the engine spec is silent on scheduling. `01` §9 assumes "reminders only" — confirm before the block-type picker is built.

### D15. SKIP before recall *(confirm state machine)*
`01` §7 pins: SKIP available from STUDYING onward; recall answer required only for DONE. Confirm the state machine allows this — if not, either the machine or the spec changes. This determines whether a forced-recall-before-skip friction point exists.

### D16. Exam-day & just-expired beats
What does Today show the morning of an exam (supportive "good luck" card? nothing new?), and how does a course transition to expired (silent move to Progress archive vs. a closure moment)? Also: multi-exam courses where the earliest exam passes but a later one remains — does the plan re-target the next exam? Engine spec is silent; escalate to the team. The emotional payoff moment of an anti-cramming product deserves design intent.

### D17. Account deletion
D11 covers *course* deletion; account deletion is separate (emails + timetable images collected). Consciously defer for MVP or add a minimal flow? Your call with the team.

---

## Decision log (fill as decided)

| # | Decision | Choice | Date | By |
| --- | --- | --- | --- | --- |
| D1 | Component library | shadcn/ui + Tailwind | 2026-08-01 | Team |
| D2 | Plan view viz | | | |
| D3 | Replan communication | | | |
| D4 | Default windows display | | | |
| D5 | Session mobile layout | | | |
| D6 | Page-count failure | | | |
| D7 | Empty-state style | | | |
| D8 | Risk color system | | | |
| D9 | Session card anatomy | | | |
| D10 | Progress depth | | | |
| D11 | Course deletion | | | |
| D12 | Onboarding escape | | | |
| D13 | Venue optional/required | | | |
| D14 | Quiet-block semantics | | | |
| D15 | SKIP before recall | | | |
| D16 | Exam-day / expired beats | | | |
| D17 | Account deletion | | | |

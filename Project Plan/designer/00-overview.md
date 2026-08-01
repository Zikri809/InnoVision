# Project B — Designer Handoff

**What this is:** everything a designer needs to design Project B's UI with full context — what each screen contains, every state it can be in, and how users flow through it. Derived from `Project B — Technical Overview Plan.md` and `Project B — User Flow Diagrams.md`.

**What this is not:** a UI mockup, a wireframe, or a component spec. Layout, visual hierarchy, and component choices are yours. These docs give you the *why* and the *what*; you own the *how it looks*.

---

## Confirmed tech context (affects your design tokens)

| Layer | Choice | Why you care |
| --- | --- | --- |
| **UI library** | **shadcn/ui** | You design with shadcn components as the starting kit; customize via Tailwind, don't fight the defaults. |
| **Styling** | **Tailwind CSS** | All color, spacing, and typography decisions must translate to Tailwind tokens. |
| **Framework** | Next.js (App Router) + TypeScript | Server components mean some states (loading, streaming) are framework-native — your skeleton/loading designs get used. |
| **PDF rendering** | `pdfjs-dist` | The session PDF viewer is pdfjs under the hood — your viewer chrome design wraps its canvas, not a native `<embed>`. |

## The product in 60 seconds

Project B is an **adaptive anti-cramming planner** for students. The student tells it three things: their courses, their exam dates, and their PDF slide decks. The system slices the total page workload across the evenings between now and each exam, schedules every session on a route, and adapts when reality happens (skipped sessions, busy days, extra material).

The anti-cramming mechanic: each study session ends with a fixed recall prompt ("list 3 ideas you remember") and a confusion note ("what part did you not understand?"). The plan is never static — every SKIP, busy block, or missed session triggers a replan. Risk bands tell the student at a glance whether they're on track, drifting, or heading for a cram.

The **web app** is the entire design scope: onboarding, studying, plan management, progress, settings. A Telegram companion bot exists on the engineering side (reminders, quick capture, DONE/SKIP in chat) but is **out of design scope** — it mirrors web actions and carries no unique design surface.

## The core design challenge

The plan must feel **alive but never chaotic**. Sessions regenerate, windows shift, risk changes color — but the student should always feel in control, never surprised. Every automatic change must be visible, explainable, and reversible. If the UI ever makes a student think *"wait, where did my plan go?"*, we've failed.

---

## Scope boundary

**In scope:** the whole web app, end to end.

**Out of scope:** the Telegram bot. It's engineering-owned; no design deliverables needed. Only two implications leak into web design, both already covered in the specs:
- Sessions can be responded to from another surface → web shows an "already responded" state, never an error.
- Bot linking + reminder pause/resume live in Settings as minimal functional UI.

---

## The numbers that drive the UI

Fixed by the engine spec (or product spec where noted) — the UI must accommodate them:

| Number | What it means for design |
| --- | --- |
| **2 minutes** *(product goal)* | Max time from signup to seeing a first plan. Onboarding is ruthlessly short: name → exam → PDF → plan. |
| **3 / 5–10 / 15 pages** | Session sizes: minimum, standard range, cap. Never show a session smaller than 3 pages. The final session may absorb a small remainder but never exceeds 15. |
| **20%** | Review buffer = final 20% of total available *minutes* before exam (not days). Spent buffer is tracked; remaining = 20% − consumed. |
| **r ≤ 1 / ≤ 1.25 / ≤ 1.5** | Risk band cutoffs: on track → attention → cramming risk. **Infeasible is a separate condition** — workload > total capacity at max session size — not an r threshold. An r above 1.5 is still just cramming risk if capacity allows. Canonical definitions: `03-state-matrix.md` §3. |
| **<3 days** | Cram-mode trigger: review buffer auto-skipped. Drives urgency styling on Today/Plan — reads as *time pressure*, not a 5th risk band. |
| **+2 hours** | A session window ended 2+ hours ago with no response = MISSED. Cron marks it and replans. |
| **24 hours** | Extraction draft pending >24h gets surfaced for review (the nudge itself is bot-side; the web entry point is on Today). |
| **2 messages / 3 ignored** *(notification discipline)* | Max 2 study messages/day; 3 consecutive *ignored* reminders auto-pause. Settings copy reflects this — "ignored" ≠ "missed" (a defined session state). |

---

## Design principles to hold onto

1. **First value under 2 minutes.** The quick-plan path is the product's handshake. Every extra field, every premature question ("how many pages?"), every confirmation step is a drop-off risk. If a screen doesn't get the student to their first plan faster, cut it.

2. **"Pages," never "slides."** 4-up PDF handouts undercount slides 4×. All UI copy says *pages*. (Engine note for context: workload = sum of uploaded PDF page counts.)

3. **Students can't answer "how many pages."** Never ask. Page count comes only from PDF upload. Course creation is name-only.

4. **Incomplete ≠ broken.** A course missing an exam date or a PDF is *unscheduled*, not an error. Today prompts for whichever is missing; the course simply isn't in the plan yet. Design this as guidance, not a warning state.

5. **Risk is a threshold, not a prediction.** Bands are capacity ratios. The UI should show *why* the risk changed (debt grew, window shrank, buffer spent) — not just a color.

6. **One source of truth.** Reminders derive from `scheduled_at − offset`. Session moves → reminder moves. No separate "reminder time" setting anywhere.

7. **Manual edits are sacred.** A session the student edited (`manually_edited`) survives every replan as a fixed anchor. The UI should mark these visibly so the student knows what will and won't move.

8. **Confusion notes are never graded.** The recall answer is logged but never scored. Tone: reflective, not judgmental. No red/green on the recall text.

9. **Extraction is a draft, not a fact.** Vision-extracted fields are always pending until the student confirms each one. The design must make "this came from an image, please check it" unmistakable.

10. **Timezone is invisible.** All times display in `Asia/Kuala_Lumpur` (pinned for pilot). The student never picks a timezone; the UI never shows UTC.

---

## How to use these docs

| File | Use it when |
| --- | --- |
| `01-screen-specs.md` | Designing any individual screen. Every screen's purpose, content, actions, and **all states** (empty, loading, error, first-time, etc.). |
| `02-user-journeys.md` | Understanding flow between screens. Mermaid diagrams per journey with emotion/friction annotations. |
| `03-state-matrix.md` | Checking coverage. Grid of screens × states — instantly shows which combinations need a design. Also the copy inventory. |
| `04-telegram-surfaces.md` | Confirming the scope boundary — Telegram is engineering-owned (read once, then ignore). |
| `05-design-decisions.md` | Open questions that need your input before Week 2 starts. |

**Suggested order:** read this file → skim journeys (02) to feel the flow → deep-dive screen specs (01) → check state matrix (03) → decisions (05).

---

## Platform & accessibility baseline

- **Viewports:** mobile-first for Session and Today (phones are common study devices); desktop-tolerant for Plan view, Availability editor, and Progress (wide layouts shine). Design to 360px / 768px / 1280px reference widths.
- **Dark mode:** shadcn supports it via CSS variables — but it's **out of scope for MVP** unless the team says otherwise. Design light-mode first; flag at sync if you want to reserve dark tokens.
- **Accessibility floor:** WCAG 2.1 AA contrast, 44px minimum touch targets, full keyboard operability for everything except the PDF canvas, visible focus states, labels accompany every color-coded element. Non-negotiable for: risk bands, session cards, forms, and the availability grid.

---

## Key terms (shared vocabulary)

| Term | Meaning |
| --- | --- |
| **Route** | The sequence of study sessions the engine generates from now to exam day. |
| **Session** | One scheduled study block: course + PDF page range + time window. |
| **Revision debt** | Pages planned by today but not yet DONE, per course. Redistributed within that course only. |
| **Risk band** | `r = required pages/day ÷ planned pages/day`. On track / attention / cramming risk / infeasible. |
| **Review buffer** | Final 20% of available minutes reserved for review. Spent buffer is tracked (`buffer_minutes_consumed`). |
| **Cram mode** | <3 days to exam — review buffer auto-skipped; infeasible copy says "pick what to drop." |
| **Extraction draft** | Vision API output held in `extraction_drafts` until student confirms/corrects/rejects each field. |
| **`manually_edited`** | Flag on a session the student changed; replan preserves it as a fixed anchor. |
| **Quick-plan path** | Onboarding: course name → exam → PDF → instant plan with default evening windows. |
| **Today / "dashboard"** | Same screen. The source plans say "dashboard"; this handoff standardizes on **Today** (home). |

---

*Last updated: derived from Technical Overview Plan v2/v3 and User Flow Diagrams v2. If the plan files change, regenerate or hand-sync these.*

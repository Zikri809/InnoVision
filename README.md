# InnoVision — Adaptive Anti-Cramming Planner

A study planner that turns "cram the night before" into a calm, adaptive daily routine. Students add their courses, exam dates, and PDF slide decks — the app slices the total workload into scheduled study sessions and adapts the plan as life happens (skipped sessions, busy days, new material).

## How it works

- **Quick-plan onboarding** — course name → exam date → PDF upload → a personalized plan in under 2 minutes. No "how many pages?" questions; page counts come from the PDFs automatically.
- **Daily study loop** — every session opens the PDF at the assigned page range with a timer, then ends with a fixed recall prompt ("list 3 ideas you remember") and a confusion note. Responses are logged, never graded.
- **Always-adapting plan** — a SKIP, missed session, busy day, or new file triggers an automatic replan. Manually-edited sessions become fixed anchors that survive every replan.
- **Risk bands, not predictions** — each course shows whether it's on track, needs attention, or is heading for a cram. When the math says infeasible, the plan says so and offers recovery choices — never silent overload.
- **Review buffer** — the final 20% of available study minutes are reserved for review and tracked as a spendable budget.
- **Two surfaces, one source of truth** — a web app (planning, studying, editing, progress) and a Telegram companion bot (reminders, quick capture, DONE/SKIP) share a single backend and state machine.

## Tech stack

| Layer | Choice | Status |
| --- | --- | --- |
| Framework | Next.js (App Router) + TypeScript | Confirmed |
| UI | shadcn/ui + Tailwind CSS | Confirmed |
| Backend | Supabase (PostgreSQL + Auth + Storage) | Confirmed |
| Telegram bot | grammY (webhook mode) | Proposed |
| Extraction | Vision LLM (single AI call) | Proposed |
| Reminders | Supabase pg_cron + Edge Function | Proposed |
| Testing | Vitest + Playwright (E2E gate) | Proposed |

## Repository layout

```
Project Plan/
├── Project B — Technical Overview Plan.md   # How we build it: stack, schema, engine spec, weeks
├── Project B — User Flow Diagrams.md        # Every user flow in Mermaid
└── designer/                                # Handoff package for the designer (web-app scope)
    ├── 00-overview.md                       # Product context, principles, scope, key numbers
    ├── 01-screen-specs.md                   # Per-screen purpose, content, actions, all states
    ├── 02-user-journeys.md                  # Flows through screens with annotations
    ├── 03-state-matrix.md                   # Screen × state coverage + copy inventory
    ├── 04-telegram-surfaces.md              # Scope boundary (bot is engineering-owned)
    └── 05-design-decisions.md               # Open questions + decision log
```

## Status

**Planning phase — no code yet.** The technical overview, user-flow diagrams, and designer handoff are complete. Build is planned in four weeks (engine → web loop → AI + Telegram → E2E freeze), validated by a Playwright E2E suite as the release gate.

## Getting started

Nothing to run yet. When development begins, the plan calls for a Next.js App Router scaffold with Supabase migrations in `supabase/`, a pure engine module in `lib/engine/`, and a shadcn/ui-based interface.

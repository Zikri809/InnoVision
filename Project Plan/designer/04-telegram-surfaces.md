# 04 — Telegram: Out of Design Scope

**The Telegram bot is engineering-owned. No design deliverables are needed for it.**

It exists as a companion channel (reminders, quick timetable capture, DONE/SKIP responses) that mirrors web actions through the same backend — no unique design surface.

## What still touches web design (already covered elsewhere)

| Leakage | Where it's handled |
| --- | --- |
| A session can be responded to from another surface → "already responded" state | `01-screen-specs.md` → Session screen; `02-user-journeys.md` → Journey 5 |
| Reminder pause/resume + auto-paused status | `01-screen-specs.md` → Settings; `02-user-journeys.md` → Journey 4 |
| Bot link/unlink affordance | `01-screen-specs.md` → Settings (minimal functional UI) |

If engineering later wants bot copy/message formatting reviewed, that's a lightweight copy pass — not a design phase.

---

*Everything else in this handoff is 100% web app: `01-screen-specs.md` is the source of truth.*

# 03 — State Matrix & Copy Inventory

The coverage checklist. **Every ✓ below is a design that must exist.** Use this to verify nothing falls through the cracks, and to track progress (mark each cell as you design it).

Legend: ✓ = needs design · — = not applicable · 🔺 = high-stakes (anxiety/drop-off risk — give extra care)

---

## 1. Screens × universal states

| Screen | Default | Loading | Empty | Error | First-time | Offline/cached |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Sign up | ✓ | ✓ | — | ✓ (invalid email, weak pw, duplicate, server) | — | ✗ block submit |
| 1b. Log in | ✓ | ✓ | — | ✓ (wrong credentials, unverified email, server) | — | ✗ block submit |
| 2. Create course | ✓ | ✓ | — | ✓ (empty name) | ✓ (onboarding context) | ✓ banner |
| 3. Exam entry | ✓ (method choice) | ✓ (upload/extract) | — | ✓🔺 (unreadable image, past date, extraction fail) | ✓ | ✓ banner |
| 4. Draft confirmation | ✓🔺 (pending review) | ✓ | ✓ (no drafts — reached via Today banner) | ✓ (draft no longer exists — confirmed/rejected elsewhere → return to Today with notice) | ✓ | ✓ read-only |
| 5. PDF upload | ✓ | ✓ (per-file progress) | ✓ (drop zone) | ✓ (wrong type, too large, protected/corrupt PDF → count failed) | ✓ | ✗ block upload |
| 6. Today | ✓🔺 | ✓ skeleton | ✓ (no sessions today) | ✓ | ✓🔺 (post-onboarding payoff) | ✓ cached |
| 7. Session | ✓ (scheduled) | ✓ (PDF load) | — | ✓ (PDF fail, stale response) | ✓ (first session ever) | ✗ block respond |
| 8. Plan view | ✓ | ✓ (replanning) | ✓ (no scheduled courses) | ✓ | — | ✓ read-only |
| 9. Availability editor | ✓ (defaults shown) | ✓ (save → replan) | ✓ (only if D4 lands on hidden-defaults) | ✓ (conflict flagged) | — | ✗ block edit |
| 10. Courses list | ✓ | ✓ | ✓ (no courses — CTA) | ✓ | — | ✓ cached |
| 11. Course detail | ✓ | ✓ | — | ✓ | — | ✓ cached |
| 12. Progress | ✓ | ✓ | ✓ (no data yet — encourage, no empty charts) | ✓ | — | ✓ cached |
| 13. Settings | ✓ | ✓ | — | ✓ | — | ✓ read-only |

## 2. Screens × domain states

| Screen | Incomplete course | Risk bands | Cram mode | Exam day / just expired | Expired course | Paused | Manually-edited marker | Missed session | Concurrent/stale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6. Today | ✓ (prompt cards) | ✓🔺 (all 4 levels) | ✓ (urgency styling) | ✓🔺 (supportive beat — D16) | — | — | — | ✓ (gentle notice) | ✓ (in-progress elsewhere) |
| 7. Session | — | ✓ (context in header) | ✓ (days-left context line) | — | — | — | — | — | ✓🔺 ("already responded") |
| 8. Plan view | ✓ (excluded, prompts) | ✓🔺 (+ reason line) | ✓ (buffer auto-skip note) | — | — | ✓ (paused course shown grayed) | ✓🔺 (anchor icon) | ✓ (history, faded) | — |
| 10. Courses list | ✓ (status badge) | ✓ (badge per card) | — | — | ✓ (badge) | ✓ (badge) | — | — | — |
| 11. Course detail | ✓🔺 (missing exam / missing PDF prompts) | ✓ (+ debt explanation) | ✓ | — | ✓ (read-only + archive link) | ✓ (banner + resume) | ✓ (in session list) | ✓ (in history) | — |
| 12. Progress | — | ✓ (per course) | — | — | ✓ (archive section) | — | — | ✓ (done vs. missed trend) | — |

## 3. The four risk-band variants (recurring component)

**This section is the canonical definition** — other docs reference it, don't redefine it. Used on: Today, Plan view, Courses list, Course detail, Progress.

| Band | Condition | Suggested tone | Required elements |
| --- | --- | --- | --- |
| On track | r ≤ 1 | Calm, green family | Label + icon |
| Attention | r ≤ 1.25 | Amber family | Label + icon + one-line reason |
| Cramming risk | r ≤ 1.5 | Orange/red family | Label + icon + reason + link to Plan |
| Infeasible | workload > total capacity at max session size — a separate capacity condition, **not** an r threshold (r > 1.5 alone is still cramming risk) | Serious but not alarming | Label + reason + **recovery choices entry** 🔺 |

Rules: never color alone (always label — accessibility); always show *why* when above "on track" (debt grew, window shrank, buffer spent); infeasible never silent-overloads.

## 4. Session lifecycle states (recurring component)

Sessions appear on Today, Plan view, and Course detail. Visual language must be consistent everywhere:

| State | Trigger | Visual treatment suggestion |
| --- | --- | --- |
| Scheduled | Future, not started | Default card |
| In progress | Entered, timer running | Live indicator (pulsing dot / elapsed time) |
| Done | DONE response | Positive mark, range struck/completed |
| Skipped | SKIP response | Neutral mark — **not** a failure color |
| Missed | Window +2h, no response | Faded, informational only |
| Manually edited | Student changed it | Anchor icon overlay — combinable with any above |

## 5. Copy inventory (fixed strings the design must accommodate)

**Verbatim-locked** (exact wording, changes need team sign-off):

| Where | String |
| --- | --- |
| Recall prompt | "List 3 ideas you remember" |
| Confusion note prompt | "What part did you not understand?" |
| Infeasible recovery | "X pages/day needed — pick what to drop" |

**Tone-locked** (paraphrase OK, meaning and register fixed):

| Where | Requirement |
| --- | --- |
| Auto-pause notice | Conveys: "Paused after 3 ignored reminders — resume when ready." Warm, zero guilt. ("Ignored" ≠ "missed.") |
| Extraction header | Conveys: "This came from your image — please check each field" |
| Terminology | Always "pages," never "slides" |
| Missing exam prompt | Conveys guidance: "Add your exam date to start planning" |
| Missing PDF prompt | "Upload your slides to start planning" |
| SKIP confirmation | Neutral, forward-looking ("pages are rescheduled") — never failure framing |

## 6. Design coverage tracker (fill as you go)

MVP = needed for the Week-2 build per the tech plan (blocks development if missing). Polish = needed before freeze, not blocking.

| # | Screen | MVP? | States designed | Reviewed | Final |
| --- | --- | --- | --- | --- | --- |
| 1 | Sign up | MVP | ☐ | ☐ | ☐ |
| 1b | Log in | MVP | ☐ | ☐ | ☐ |
| 2 | Create course | MVP | ☐ | ☐ | ☐ |
| 3 | Exam entry | MVP | ☐ | ☐ | ☐ |
| 4 | Draft confirmation | MVP | ☐ | ☐ | ☐ |
| 5 | PDF upload | MVP | ☐ | ☐ | ☐ |
| 6 | Today | MVP | ☐ | ☐ | ☐ |
| 7 | Session | MVP | ☐ | ☐ | ☐ |
| 8 | Plan view | MVP | ☐ | ☐ | ☐ |
| 9 | Availability editor | MVP | ☐ | ☐ | ☐ |
| 10 | Courses list | MVP | ☐ | ☐ | ☐ |
| 11 | Course detail | MVP | ☐ | ☐ | ☐ |
| 12 | Progress | MVP (depth = D10) | ☐ | ☐ | ☐ |
| 13 | Settings | MVP | ☐ | ☐ | ☐ |
| — | Risk band component | MVP | ☐ | ☐ | ☐ |
| — | Session card component | MVP | ☐ | ☐ | ☐ |
| — | Empty-state illustrations (D7) | Polish | ☐ | ☐ | ☐ |
| — | Exam-day / just-expired beats (D16) | Polish | ☐ | ☐ | ☐ |

---

*The 🔺 cells are where students are anxious, guilty, or at risk of dropping off — those deserve your best work.*

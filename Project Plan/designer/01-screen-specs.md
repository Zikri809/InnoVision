# 01 — Screen Specifications

Every screen in the web app, in the order a first-time user encounters them. Format per screen:

- **Purpose** — the one thing the user is trying to do
- **Content** — what appears, and where it comes from
- **Actions** — every interactive element and where it leads
- **States** — every variation the design must cover

> Naming note: route names are from the technical plan (`app/(web)/` pages). Display names are suggestions — adjust freely.
>
> **Component context:** the UI is built with **shadcn/ui + Tailwind**. When a spec says "card," "banner," "toast," or "tabs," reach for the shadcn primitive first (`Card`, `Alert`, `Toast`, `Tabs`) and customize via Tailwind — don't invent a bespoke component unless shadcn genuinely can't express the state.

---

## Navigation model

**5 primary destinations** (named in Today §6 Actions): **Today · Plan · Courses · Progress · Settings.**

- **Mobile:** bottom tab bar, 5 tabs.
- **Desktop:** persistent left sidebar with the same 5 items.
- **Secondary screens** (Session, Course detail, Availability editor, onboarding steps, draft confirmation): pushed routes over the current tab — no tab bar on Session (focus mode) and onboarding (linear flow); tab bar remains on Course detail and Availability editor.
- **Availability editor entry points:** Plan view ("edit availability") + Settings ("availability") — both lead to the same screen. Onboarding reaches it only via the post-value refinement path.

---

## 1. Sign up

**Purpose:** Create an account with minimal friction.

**Content:**
- Email input
- Password input
- (Post-signup, no email-verification wall before first plan — confirm if Supabase auth flow allows)

**Actions:**
- Submit → creates account → **Course creation (quick-plan)**
- Link to log in (returning user)

**States:**
| State | Notes |
| --- | --- |
| Default | |
| Loading | After submit |
| Error — invalid email | Inline |
| Error — weak password | Inline |
| Error — email already registered | Inline, offer login link |
| Error — network/server | Banner, preserve entered values |

---

## 1b. Log in

**Purpose:** Return a registered student to their plan.

**Content:**
- Email + password inputs
- Link to sign up; link to password reset

**Actions:**
- Submit → **Today** (returning users skip onboarding entirely)
- Reset password → email-sent confirmation state (Supabase magic link / reset flow)

**States:**
| State | Notes |
| --- | --- |
| Default | |
| Loading | After submit |
| Error — wrong credentials | Inline, non-specific ("email or password incorrect") |
| Error — unverified email | Inline + resend-verification action (if verification is enforced — see screen 1 note) |
| Error — network/server | Banner |
| Reset requested | "Check your email" confirmation |

---

## 2. Create course (quick-plan step 1)

**Purpose:** Name the course. Nothing else — page count comes from PDF upload later; students can't answer "how many pages."

**Content:**
- Single field: course name
- Microcopy setting expectation: "You'll add your exam and slides next — takes under a minute."

**Actions:**
- Continue → **Exam entry**
- (Escape: skip to Today? — open decision D12, see `05-design-decisions.md`)

**States:**
| State | Notes |
| --- | --- |
| Default (first time) | Empty field, focused |
| Loading | After continue |
| Error — empty name | Inline |
| Subsequent course creation | Same screen; consider showing existing courses list above (returning-user variant) |

---

## 3. Exam entry (quick-plan step 2)

**Purpose:** Capture exam date, time, venue — typed directly or extracted from an image.

**Content:**
- Method choice: **Type it in** / **Upload exam timetable image**
- Typed path fields: exam date, start time, finish time, venue
- Upload path: image picker/drop zone → async extraction → **Extraction draft confirmation**

**Actions:**
- Submit typed form → exam stored → **PDF upload**
- Upload image → extraction in progress → **Extraction draft confirmation**
- Skip venue (optional/required is decision D13, see `05-design-decisions.md`)

**States:**
| State | Notes |
| --- | --- |
| Default — method choice | Two clear paths |
| Typed form | Date/time pickers, venue text |
| Uploading image | Progress indicator |
| Extracting (async) | "Reading your timetable…" — webhook pattern means wait could be seconds; show friendly progress, not a dead spinner |
| Error — image unreadable | Offer retry or "type manually instead" (this escape hatch must be visible at every extraction step) |
| Error — past date entered | Inline validation; exam date must be future |
| First-time vs. adding exam to existing course | Same fields; context header changes ("Exam for Economics") |

---

## 4. Extraction draft confirmation

**Purpose:** Verify AI-extracted fields before they're stored. **This came from an image — make that unmistakable.** Fields are drafts, not facts, until confirmed.

**Content:**
- Source thumbnail (the uploaded image — available only while the draft is pending; deleted on confirm *and* on reject)
- Per-field rows: label, extracted value, confidence cue (if available)
- Fields: exam date, start time, finish time, venue (for exams) / day, course, start, finish (for lectures — Week 3 feature, may be cut)

**Actions:**
- Confirm all → store → next step
- Edit individual field inline → confirm
- Reject entire draft → back to manual entry ("type manually instead")

**States:**
| State | Notes |
| --- | --- |
| Pending review | Default on arrival |
| Field edited | Dirty indicator on changed fields |
| Partial extraction (some fields missing) | Missing fields shown empty, required to fill before confirm |
| Confirmed | Success → next step (PDF upload or Today); image deleted from storage (PII hygiene) |
| Rejected | Draft discarded, image deleted from storage; return to manual form |
| 24h+ pending | Same screen, context banner: "This draft has been waiting — confirm or discard it" |
| Multiple drafts pending (list variant) | If several uploads unconfirmed — simple list, newest first. **Entry point:** a pending-draft banner card on Today (web-only students must be able to reach drafts without the bot) |

---

## 5. PDF upload (quick-plan step 3)

**Purpose:** Upload the slide deck(s) for the course. Page count is auto-extracted — this is the *only* source of workload size.

**Content:**
- Drop zone / file picker (PDF only)
- After upload: filename + auto-extracted page count + per-file remove
- Multiple files allowed (workload = sum of all page counts)
- Running total: "128 pages across 2 files"

**Actions:**
- Upload → auto page-count extraction → list entry
- Remove file → recompute total
- Continue → **instant plan generation** → **Today screen** (first value!)
- (Later, from **Course detail**: upload additional decks anytime)

**States:**
| State | Notes |
| --- | --- |
| Empty | Drop zone, clear CTA |
| Uploading | Per-file progress |
| Extracting page count | Brief — pdfjs is fast |
| One file uploaded | Row with name, pages, remove |
| Multiple files | Rows + running total |
| Error — not a PDF | Inline |
| Error — file too large (Supabase Storage limit) | Inline |
| Error — page count extraction failed | File listed with warning; allow retry or remove. Name the likely causes: password-protected or corrupt PDF (students upload protected past-year decks often — copy must say *why*, not just "failed"). **Decision needed (D6):** can the student proceed with a file whose count failed? See `05`. |

---

## 6. Today screen (home — first value, daily driver)

**Purpose:** Answer "what do I study today?" at a glance, and get the student into a session fast.

**Content:**
- Today's sessions: course name, page range (e.g., "Pages 41–55"), time window, estimated duration
- **Multi-course ordering:** sessions ordered by scheduled window start; ties broken by earlier exam date. Flat chronological list (no course grouping) — the student thinks in time, not courses.
- Current risk band per course (color + label)
- Incomplete-course prompts: "Economics needs an exam date" / "Add your slides to start planning" (guidance, not errors)
- Pending-draft banner (when extraction drafts await review) → **Draft confirmation**
- First-session hero CTA: "Start studying"
- (Post-onboarding first visit: celebratory "Your plan is ready" moment — this is the 2-minute payoff)

**Actions:**
- Tap session → **Session screen**
- Tap incomplete-course prompt → relevant setup step
- Tap pending-draft banner → **Draft confirmation**
- Nav to Plan / Courses / Progress / Settings

**States:**
| State | Notes |
| --- | --- |
| First visit after quick-plan | Celebration + first session highlighted |
| Normal day — sessions scheduled | List, next session emphasized |
| No sessions today (rest day / gaps in route) | Reassuring empty state; show next upcoming session |
| All sessions done today | Completion state; streak/progress micro-summary |
| Session in progress (started, possibly on another device) | Live "in progress" indicator; resume |
| Missed session exists (window ended +2h, no response) | Subtle notice — plan has been adapted; no shame copy |
| Course incomplete (missing exam or PDF) | Prompt card per incomplete course |
| Risk: on track / attention / cramming risk | Band color + one-line reason ("debt grew after skipped session") |
| Risk: infeasible | Prominent but calm alert → **Recovery choices** (see Plan screen) |
| Cram mode (<3 days to exam) | Urgency styling; buffer note ("review buffer skipped") |
| Exam day | Course's exam is today — supportive beat ("good luck" tone, no new sessions generated for it). **Exact behavior is decision D16, see `05`.** |
| Just expired (exam just passed) | Closure moment — course moves to Progress archive; brief acknowledgment, not a silent vanish. **Decision D16.** |
| Loading | Skeleton list |
| Offline/error | Cached data + banner |

---

## 7. Session screen (the study room)

**Purpose:** The focused study experience — PDF at the right pages, timer running, then recall + confusion note, then DONE/SKIP.

**Content:**
- Header: course, **document filename**, page range (e.g., "Calculus Slides 3.pdf — Pages 41–55 of 128"), scheduled window. A session always lives inside one document — name it, because courses can have several decks.
- **PDF viewer** opened at the session's start page — reading happens here. Constraints: default fit-width on phones (landscape slides on portrait screens); large decks (500+ pages) must lazy-load; scanned/image-only PDFs render fine but offer zoom. Page range boundary cue (subtle marker at the last assigned page).
- Timer — **starts on explicit "Start" tap**, not on page open (`started_at` stamped then; matches IDLE → STUDYING)
- Fixed recall prompt: **"List 3 ideas you remember"** — short text area. Logged, never graded. Tone matters: reflective, no scoring UI.
- Confusion note: **"What part did you not understand?"** — text area, skippable
- DONE / SKIP buttons

**Actions:**
- Tap Start → state machine IDLE → STUDYING, timer starts
- **SKIP is available from STUDYING onward** — a student who can't study right now bails without being forced through recall. Recall answer is required only for DONE. (Confirm with engineering, decision D15.)
- Submit recall answer → logged (no feedback/score)
- Enter confusion note → stored against course/doc/range/date → then DONE
- Skip note → straight to DONE
- DONE → range marked complete → **Today** (with progress micro-feedback)
- SKIP → pages return to pool, replan → **Today** (neutral copy — skipping is a feature, not a failure)

**States:**
| State | Notes |
| --- | --- |
| Scheduled (not started) | Preview: range, window, "Start" — timer does NOT auto-start here |
| STUDYING | PDF + timer; recall section collapsed/hidden until student taps "I'm done reading" |
| Interrupted (re-entered while STUDYING) | Timer derives from `started_at` — survives refresh, tab close, phone sleep. Show elapsed time with a calm "welcome back — still studying?" resume state. The window+2h MISSED rule applies to *no response*, not to study duration: a student actively in the session is never "missed." |
| Started-but-abandoned (started, never responded, window +2h passed) | Marked MISSED by cron — tone on next visit is gentle ("looks like that one got away") because the student *did* engage. No-shame rule still applies. |
| RECALL | Recall prompt shown; PDF still accessible |
| CONFUSION | Note prompt shown |
| Completed (DONE submitted) | Success micro-feedback → back to Today |
| Skipped | Neutral confirmation, pages re-entering pool → back to Today |
| Stale/concurrent (responded on another device) | "Already responded" notice — concurrency guard rejects second tap; show current state, no error framing |
| Cram-mode session | Same room; optional context line noting days left. No buffer messaging here — urgency lives on Today/Plan |
| Late-night window | Midnight-crossing windows (e.g., 22:00–23:30) display end time without date confusion; window times always in student-local |
| PDF load failure | Retry + fallback message |

---

## 8. Plan view (route + repair)

**Purpose:** See the whole route to exam day, understand debt and risk, make manual corrections, and recover when infeasible. **Forward-looking: what happens next and what to fix.** (History and closed courses live on Progress.)

**Content:**
- Timeline/calendar of all future sessions per course (route visualization)
- Per-course: revision debt (pages behind), risk band with reason, pages done / total
- Review buffer indicator: remaining buffer = 20% − consumed (visualize spending)
- Manually-edited sessions marked (anchor icon — "won't move in replans")
- Missed sessions shown in history (faded, informational)

**Actions:**
- Edit session page range → flags `manually_edited` → survives replans
- Move/edit session time (same flag)
- Pause course → excluded from planning (resume available)
- Mark day busy → one-off block → immediate replan
- **Edit availability** → Availability editor (nav entry point #1)
- Infeasible → **recovery choice**: (1) increase daily capacity (2) add extra study day (3) spend review buffer (4) reduce page range manually → replan
- Dismiss recovery panel → infeasible banner persists (dismissal ≠ resolution)
- Undo/exit edit mode

**States:**
| State | Notes |
| --- | --- |
| Normal — on track | Route + bands |
| Attention / cramming risk | Band colors + reason line per course |
| Infeasible | Recovery-choice panel (4 options above). Copy: "X pages/day needed — pick what to drop." **Never silent overload.** |
| Cram mode (<3 days) | Buffer auto-skipped notice |
| Editing a session | Edit mode; explain the anchor behavior ("this session won't move when the plan adapts") |
| Replanning (after busy day / edit) | Brief regenerating indicator; what-changed summary afterward is a **strong idea** (see `05`) |
| Empty — no scheduled courses | All courses incomplete → prompts; or no courses → CTA to create |
| Expired courses (past exam) | Excluded from route; visible on Progress only |
| Loading / error | |

---

## 9. Availability editor (weekly calendar)

**Purpose:** Refine when the student can study — lectures, work, clubs, busy blocks, quiet hours, rest days. Refinement happens *after* first value, never before.

**Content:**
- Weekly grid (day × time)
- Block types: lecture / work / club / busy / quiet / rest — visually distinct. Semantics per type:

| Type | Blocks session scheduling? | Suppresses reminders? | Representation hint |
| --- | --- | --- | --- |
| lecture / work / club / busy | Yes | Yes | Timed block on grid |
| quiet | *(decision D14 — likely no, reminders only)* | Yes | Timed block, muted styling |
| rest | Yes | Yes | Day-level treatment (toggle/banner on the day column), not a timed block |

- Recurring weekly vs. one-off (specific date) blocks
- Midnight-crossing blocks supported (e.g., 22:00–02:00 attaches to start day)
- Conflict detection: overlapping blocks flagged

**Actions:**
- Add block (type, day/date, start, finish, recurring?)
- Edit / delete block
- Save → conflict check → clean: plan regenerates (manually-edited sessions preserved) → **Plan view** or **Today**
- Overlap → inline flag, fix before save

**States:**
| State | Notes |
| --- | --- |
| Default (default evening windows if untouched) | Quick-plan used defaults — show them as editable blocks? (Decision: surface defaults explicitly, see `05`) |
| Editing | Drag or form-based — designer's call |
| Conflict flagged | Overlapping blocks highlighted |
| Saving → replanning | |
| Error | |

---

## 10. Courses list

**Purpose:** Manage all courses — add new, see status, drill into one.

**Content:**
- Course cards: name, status (active / unscheduled / paused / expired), pages done / total, risk band, next exam date
- "Add course" CTA

**Actions:**
- Tap course → **Course detail**
- Add course → **Create course**

**States:**
| State | Notes |
| --- | --- |
| Empty (no courses — only possible post-signup if quick-plan skipped) | CTA |
| Mixed statuses | Status badge per card |
| Loading / error | |

---

## 11. Course detail

**Purpose:** Everything about one course: materials, exam, progress, sessions.

**Content:**
- Name, status, risk band + reason
- Exam(s): date, time, venue (multiple exams → plan targets earliest confirmed)
- Documents: files + page counts; upload more; remove (removing affects workload → replan)
- Revision debt (pages)
- Session history + upcoming sessions for this course
- Initial offset ("already studied pages 1–50") — **settable here only** (course creation is name-only; no onboarding step collects it)

**Actions:**
- Edit name / offset
- Add exam (typed or image) / edit exam
- Upload / remove PDFs → replan
- Pause / resume course
- (Delete course? — likely needed; decision D11, see `05`)

**States:**
| State | Notes |
| --- | --- |
| Active | Full content |
| Unscheduled — missing exam | Prompt → exam entry |
| Unscheduled — missing PDF | Prompt → PDF upload |
| Paused | Excluded-from-planning banner; resume CTA |
| Expired (past exam) | Read-only summary + link to Progress archive (archive is the canonical expired view) |
| Removing a PDF that has DONE sessions | Confirmation with impact warning: completed pages against that file stay in history, but remaining planned pages shrink — show the delta before confirming |
| Debt exists | Debt figure + plain-language explanation |
| Loading / error | |

---

## 12. Progress / analytics

**Purpose:** Reflect and stay motivated — **backward-looking: what happened, including closed courses.** (Forward-looking route, debt repair, and risk reasons live on Plan view — don't duplicate those layouts here.)

**Content:**
- Per course: pages done / total, exam countdown, completion summary (deep dive → Course detail / Plan)
- Expired courses (past exams) — archive section
- Weekly summary
- Completion trend (sessions done vs. missed over time — nice-to-have depth; decision D10, see `05`)

**Actions:**
- Tap course → Course detail
- (Share/export? — out of scope for MVP unless requested)

**States:**
| State | Notes |
| --- | --- |
| With data | |
| Early (little data yet) | Encourage, don't show empty charts |
| Empty (no active courses) | CTA |
| Loading / error | |

---

## 13. Settings

**Purpose:** Account, reminder controls, optional bot linking.

**Content:**
- Profile: email, timezone display (read-only, pinned Asia/Kuala_Lumpur for pilot — other timezones are rejected at the backend; if a student's browser timezone differs, show the pinned zone as plain fact, no picker, no apology)
- Reminder PAUSE / RESUME
- Bot link section (minimal functional UI — bot itself is out of scope): 6-digit link-code display (large, copyable, with expiry hint) + status indicator + unlink
- Availability entry point ("edit availability" → Availability editor; nav entry point #2)
- (Quiet hours live in Availability editor — don't duplicate here; single source of truth)
- (Account deletion — decision D17, see `05`; likely defer for MVP)

**Actions:**
- Pause / resume reminders
- Generate fresh link code / unlink bot
- Go to Availability editor
- Log out

**States:**
| State | Notes |
| --- | --- |
| Bot unlinked | Code + one-line setup instruction |
| Bot linked | Status + unlink; generate a fresh code (codes are single-use — a used code display is stale) |
| Reminders paused | Status + resume; auto-paused variant: "Paused after 3 ignored reminders — resume when ready" (warm, zero guilt) |
| Loading / error | |

---

## Global UI elements (design once, use everywhere)

| Element | Where | Notes |
| --- | --- | --- |
| **Risk band badge** | Today, Plan, Courses, Course detail, Progress | 4 levels: on track / attention / cramming risk / infeasible. Canonical definitions: `03-state-matrix.md` §3. Color + label + optional one-line reason. Never color alone (accessibility). |
| **Session card** | Today, Plan, Course detail | Course, **document filename**, page range, time window, duration, band color, state (scheduled/in progress/done/missed/skipped/edited). Anatomy decision: D9. |
| **Incomplete-course prompt** | Today, Courses, Course detail | Guidance tone. "Add your exam date to start planning" not "⚠ missing required field." |
| **Replan indicator** | Any screen after replan triggers | Brief + honest. Decision D3 (what-changed summary). |
| **Empty states** | Every screen | See `03-state-matrix.md` — each needs copy + often an illustration/CTA. |
| **Offline banner** | All | Cached read-only + "reconnect to respond." |
| **Text truncation** | All cards/headers | Course names, filenames, venues: truncate with ellipsis at 1 line (cards) / 2 lines (headers); full text on hover/tap tooltip. |
| **Accessibility floor** | All | WCAG 2.1 AA contrast, 44px touch targets, keyboard operability, visible focus. See `00-overview.md` → Platform & accessibility baseline. |

---

*Cross-reference: flows between these screens → `02-user-journeys.md`. State coverage checklist → `03-state-matrix.md`.*

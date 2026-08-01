# 02 — User Journeys

How users move through screens across states. Each journey has a Mermaid diagram (renders on GitHub/Notion/VS Code), a state narrative, and design annotations (emotion, friction, drop-off risk).

Screen names match `01-screen-specs.md`.

---

## Journey 1 — Quick-plan onboarding (the 2-minute promise)

**Goal:** Signup → first personalized plan in under 2 minutes. This is the product's handshake; every screen here carries drop-off weight.

```mermaid
flowchart TD
    A["1. Sign up (email)"] --> B["2. Create course: name only"]
    B --> C["3. Exam entry"]
    C --> D{"Entry method?"}
    D -->|"Typed"| E["Exam stored"]
    D -->|"Upload image"| F["Extracting… (async, friendly wait)"]
    F --> G["4. Draft confirmation: verify each field"]
    G -->|"Confirm"| E
    G -->|"Correct fields"| G
    G -->|"Reject / type manually"| C
    E --> H["5. PDF upload: page count auto-extracted"]
    H --> I{"Exam + PDF both present?"}
    I -->|"Yes"| J["Plan generates (default evening windows)"]
    I -->|"Missing one"| K["6. Today: incomplete-course prompt"]
    J --> L["6. Today: 'Your plan is ready' + first session"]

    L -.->|"Later — refinement, never before value"| M["9. Availability editor"]
    M --> N{"Conflicts?"}
    N -->|"Overlap"| M
    N -->|"Clean"| O["Plan regenerates; edited sessions stay anchored"]

    style L fill:#d4edda
    style F fill:#fff3cd
```

**State narrative:**
The student is skeptical and impatient — they've tried planners before. Every field must justify itself. The typed exam path is 4 fields; the image path trades typing for verification (draft confirmation). The PDF upload is the moment the plan becomes *real* — the page count appearing automatically is a small delight; play it up. When the plan generates, celebrate briefly, then point at the first session. Do **not** ask about availability, quiet hours, or study preferences here — defaults carry the student to value; refinement waits.

**Design annotations:**
- ⚡ **Highest drop-off risk:** screens 1–3. Ruthlessly minimize.
- 😟 **Anxiety moment:** exam date entry — it makes the deadline real. Keep tone calm.
- ⏳ **Wait moment:** extraction. Seconds of async work — use a friendly progress state ("Reading your timetable…"), never a bare spinner.
- 🎉 **Payoff moment:** plan generated. This is the screenshot in the demo.
- 🚪 **Escape hatch:** "type manually instead" visible at every extraction step.

---

## Journey 2 — Daily study loop (the core habit)

**Goal:** Open app → study → recall → note → respond. Repeat daily. This loop *is* the product.

```mermaid
flowchart TD
    A["6. Today: sessions + risk bands"] --> B["7. Session: preview (scheduled)"]
    B --> C["Tap Start → STUDYING: PDF + timer"]
    C --> C2["Interrupted? Timer survives refresh/close — resume anytime"]
    C2 --> C
    C --> D["Student finishes reading"]
    D --> E["RECALL: 'List 3 ideas you remember' — logged, never graded"]
    E --> F["CONFUSION: 'What part did you not understand?' — skippable"]
    F --> G{"DONE"}
    G --> H["Range complete; progress micro-feedback"]
    C -->|"SKIP (available from STUDYING on)"| I["Pages return to pool; plan adapts — neutral copy"]
    H --> A
    I --> A

    J["Cron: window ended +2h, no response"] --> K["Session marked MISSED; plan adapts; risk recalculated"]
    K --> A

    style E fill:#e8f0fe
    style I fill:#f8f9fa
```

**State narrative:**
The student arrives in one of three moods: ready (tap Start), guilty (returning after a miss), or resistant (considering SKIP). The design must serve all three without judgment. Starting is an explicit tap — never auto-start the timer on page open. The recall prompt is fixed and short — it's a reflection ritual, not a quiz; **no scoring UI, no red/green on the answer**. The confusion note is skippable because friction here kills completion. SKIP is available from STUDYING onward — a student who can't study right now isn't forced through recall to bail (recall is required only for DONE). DONE gives a small reward (progress tick). SKIP is *not* a failure state — the plan absorbs it; copy should feel like the system has their back ("No problem — these pages are rescheduled"). A missed session triggers silent adaptation; next visit shows the updated plan with a gentle notice, never an alarm.

**Design annotations:**
- 🧘 **Focus mode:** the session screen is a study room — minimize chrome, notifications, navigation temptation.
- 😰 **Guilt risk:** missed/debt states. Tone: forward-looking ("here's your updated plan") not backward ("you failed to…").
- ⚖️ **DONE/SKIP balance:** neither button visually punished. DONE can be more prominent (it's the goal) but SKIP must not be hidden or shame-styled.
- 🔌 **Interruption resilience:** timer survives refresh/close (derived from `started_at`). A student actively in the session is never marked missed — the +2h rule applies to *no response*, not study duration.
- 📱 **Mobile-friendly:** PDF reading and the recall/note flow must work well on phones — plenty of students will study from one.

---

## Journey 1b — Adding a second course (returning user)

**Goal:** Same quick-plan mechanics, different emotional frame — no celebration needed, land where management happens.

```mermaid
flowchart TD
    A["10. Courses: 'Add course'"] --> B["2. Create course: name only"]
    B --> C["3. Exam entry (context header: 'Exam for X')"]
    C --> D["5. PDF upload"]
    D --> E{"Exam + PDF both present?"}
    E -->|"Yes"| F["Plan regenerates across courses"]
    E -->|"Missing one"| G["11. Course detail: unscheduled prompt"]
    F --> H["11. Course detail — new course in context"]
```

**State narrative:**
Returning users know the drill — skip the celebration, skip the "Your plan is ready" moment (that's Today-first-visit only). Landing on Course detail after creation shows the new course in context and confirms the cross-course replan. The exam-entry and PDF-upload screens are identical to onboarding; only the entry point, context headers, and landing differ.

---

## Journey 3 — Plan repair and recovery (when life happens)

**Goal:** Student adapts the plan to reality — edits, busy days, pauses — and recovers when the math says infeasible.

```mermaid
flowchart TD
    A["8. Plan view: route, debt, risk"] --> B{"Student action"}
    B -->|"Edit session range/time"| C["Session flagged manually_edited — anchor icon, survives replans"]
    B -->|"Pause course"| D["Excluded from planning; resume available"]
    B -->|"Mark day busy"| E["One-off block; immediate replan"]
    C --> F{"Risk status"}
    D --> F
    E --> F
    F -->|"r ≤ 1"| G["On track"]
    F -->|"r ≤ 1.25"| H["Attention"]
    F -->|"r ≤ 1.5"| I["Cramming risk"]
    F -->|"Infeasible"| J{"Recovery choices"}
    J -->|"1. Increase daily capacity"| K["Replan"]
    J -->|"2. Add extra study day"| K
    J -->|"3. Spend review buffer (tracked)"| K
    J -->|"4. Reduce page range manually"| K
    J -->|"Dismisses panel"| N["Infeasible banner persists — dismissal is not resolution"]
    K --> F

    L["<3 days to exam"] --> M["Cram mode: review buffer auto-skipped"]

    style J fill:#fff3cd
    style M fill:#fde8e8
```

**State narrative:**
The student here is either in control (fine-tuning) or stressed (infeasible). For fine-tuning: make the anchor behavior explicit — when they edit a session, tell them it won't move in future replans; ambiguity here destroys trust. For infeasible: **never silent overload.** The four recovery choices are honest trade-offs; present them as options with consequences ("spending buffer leaves less review time"), not as errors. Buffer spending is the most interesting: it's a budget, visualize it like one — remaining buffer after the spend, not just a recolor.

**Design annotations:**
- 😰 **Peak anxiety:** infeasible state. Calm colors, structured choices, zero blame. Copy fixed: "X pages/day needed — pick what to drop."
- ⚓ **Trust element:** manually-edited anchors must be visually identifiable wherever sessions appear.
- 💰 **Buffer as budget:** 20% total − consumed. A depleting resource reads instantly; a percentage alone doesn't.
- 🔥 **Cram mode:** urgency without panic. Buffer auto-skip is explained ("review time converted to first-pass study").
- 🚪 **No forced choice:** the student can dismiss the recovery panel — the infeasible banner stays (calmly) until resolved. Dismissal is not resolution.

---

## Journey 4 — Notification & reminder settings (design surface only)

The reminder system itself is backend/bot territory, but its **controls and status** live in web Settings, and its rules shape UX trust:

```mermaid
flowchart TD
    A["13. Settings"] --> B["Pause reminders"]
    A --> C["Resume reminders"]
    D["System: 3 consecutive ignored reminders"] --> E["Reminders auto-paused"]
    E --> F["Settings shows: 'Paused after 3 ignored reminders — resume when ready'"]
    F --> C
```

**Design annotations:**
- 🔕 Notification discipline (quiet hours respected, message caps, auto-pause) is a *trust feature*. The Settings copy should make the restraint visible — students trust systems that explain it.
- 📉 The auto-paused state is the key variant: warm, zero guilt, one-tap resume. Note: "ignored" ≠ "missed" — MISSED is a session state (window +2h, no response); ignored means the reminder itself went unanswered. A student can ignore reminders while still studying via web.

---

## Journey 5 — Shared state across devices (concurrent use)

A session can be started on one device and responded to on another. The backend guarantees first-write-wins; the design rule:

**Any surface that can respond to a session must handle the "already responded" state gracefully.** The student should never know a concurrency guard exists — only that the app always shows the truth. No error framing, no dead buttons without explanation.

---

*Screen details → `01-screen-specs.md`. Full state checklist → `03-state-matrix.md`. Note: the plan includes Telegram capture/reminder flows — those chat legs are out of design scope; web screens they touch (draft confirmation, Settings) are covered above.*

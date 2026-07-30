# Project B — User Flow Diagrams

Companion to: `Project B — Technical Overview Plan.md` (user flows in diagram form).
Mermaid syntax — renders on GitHub, Notion, VS Code (with Mermaid extension).

> v2: page count removed from course creation — it comes from PDF upload only. No PDF yet = course inactive. All node labels quoted for parser compatibility.

---

## 1. Web app — first-time setup (quick-plan path)

```mermaid
flowchart TD
    A["Sign up via email"] --> B["Create course: name only"]
    B --> C["Add exam: date, time, venue"]
    C --> D{"Entry method?"}
    D -->|"Typed"| E["Exam stored directly"]
    D -->|"Upload image"| F["Vision API extracts fields"]
    F --> G["extraction_draft: pending"]
    G --> H{"Student confirms each field?"}
    H -->|"Confirm"| E
    H -->|"Correct"| H1["Edit fields"]
    H1 --> E
    H -->|"Reject / type manually"| C
    E --> I["Upload PDF deck — page count auto-extracted"]
    I --> J{"Both exam + PDF present?"}
    J -->|"Yes"| K["INSTANT PLAN with default evening windows"]
    J -->|"Missing one"| L["Course inactive — prompted on dashboard"]
    K --> M["Today screen — first value under 2 min"]

    M -.->|"Later or same session"| N["Refinement"]
    N --> N1["Weekly calendar: lectures/work/club blocks"]
    N --> N2["One-off busy override"]
    N --> N3["Quiet hours + rest days"]
    N1 --> O{"Conflict check"}
    N2 --> O
    O -->|"Overlap flagged"| N1
    O -->|"Clean"| P["Plan regenerates — manually_edited sessions preserved"]
    N3 --> P
```

## 2. Web app — daily study loop

```mermaid
flowchart TD
    A["Today screen: sessions + risk band"] --> B["Open session"]
    B --> C["PDF opens at assigned page range + timer starts"]
    C --> D["State: STUDYING — started_at stamped"]
    D --> E["Student finishes reading"]
    E --> F["Fixed recall prompt: list 3 ideas you remember"]
    F --> G["Short text answer — logged, never graded"]
    G --> H["Confusion note: What part did you not understand?"]
    H -->|"Text entered"| I["Note stored vs course/doc/range/date"]
    H -->|"Skipped"| J
    I --> J{"DONE or SKIP?"}
    J -->|"DONE"| K["Range marked complete; engine continues route"]
    J -->|"SKIP"| L["Pages return to course pool; replan redistributes"]
    K --> M["Progress updated"]
    L --> M

    N["Cron tick every 5 min"] --> O{"Session window ended +2h, no response?"}
    O -->|"Yes"| P["Mark MISSED; replan; recalc risk"]
    O -->|"No"| Q["Nothing"]
    P --> M
```

## 3. Web app — plan management and repair

```mermaid
flowchart TD
    A["Plan view: route, debt, risk band"] --> B{"Student action"}
    B -->|"Edit session range"| C["Flag manually_edited — survives future replans"]
    B -->|"Pause course"| D["Course excluded from planning"]
    B -->|"Mark day busy"| E["One-off block; immediate replan"]

    C --> F{"Risk status"}
    D --> F
    E --> F

    F -->|"r <= 1"| G["On track"]
    F -->|"r <= 1.25"| H["Attention needed"]
    F -->|"r <= 1.5"| I["Cramming risk"]
    F -->|"Infeasible"| J{"Recovery choices"}
    J -->|"1"| J1["Increase daily capacity"]
    J -->|"2"| J2["Add extra study day"]
    J -->|"3"| J3["Spend review buffer — tracked in buffer_minutes_consumed"]
    J -->|"4"| J4["Reduce page range manually"]
    J1 --> K["Replan"]
    J2 --> K
    J3 --> K
    J4 --> K
    K --> F

    L["Less than 3 days to exam"] --> M["Cram mode: review buffer auto-skipped"]
```

## 4. Telegram — one-time account linking

```mermaid
flowchart TD
    A["/start in Telegram"] --> B["Bot asks for link code"]
    C["Web app Settings shows 6-digit code"] --> D["Student types code in chat"]
    B --> D
    D --> E{"Code valid?"}
    E -->|"Yes"| F["telegram_chat_id stored on profile — linked"]
    E -->|"No"| B
```

## 5. Telegram — timetable capture

```mermaid
flowchart TD
    A["Send timetable photo to bot"] --> B["Webhook returns 200 immediately"]
    B --> C["Async extraction via waitUntil"]
    C --> D["Result arrives as new message"]
    D --> E["Inline buttons per entry: Confirm / Correct / Reject"]
    E -->|"Confirm"| F["Stored; plan regenerates"]
    E -->|"Correct"| G["Deep link to web edit — one-time token auto-login"]
    E -->|"Reject"| H["Draft discarded; image deleted from Storage"]
    F --> I["Image deleted from Storage"]

    J["Text entry: Monday Economics 9:00-11:00"] --> K["Parsed via zod schema"]
    K --> E

    L["Draft pending over 24h"] --> M["Nudge message + type manually instead link"]
```

## 6. Telegram — daily loop

```mermaid
flowchart TD
    A["Cron tick: session starting soon"] --> B{"Inside busy/quiet/rest?"}
    B -->|"Yes"| C["Do not send"]
    B -->|"No"| D["Reminder sent; reminder_log written"]

    D --> E["Student opens Today's route"]
    E --> F["Course, page range, window, risk status — under 4096 chars"]
    F --> G["Deep link to web session screen — study happens on web"]

    G --> H["Recall prompt delivered in chat"]
    H --> I["Student replies with short answer"]
    I --> J["Confusion note prompt"]
    J --> K["Student replies with text or skips"]

    K --> L{"DONE / SKIP buttons"}
    L -->|"DONE"| M["Same state machine as web; route continues"]
    L -->|"SKIP"| N["Pages return to pool; replan"]
    M --> O["Weekly summary on demand: pages, debt, risk per course"]
    N --> O

    P["Missed session detected by cron"] --> Q["Recovery message: next session + new risk"]
```

## 7. Telegram — utility commands and notification discipline

```mermaid
flowchart TD
    A["Student sends command"] --> B{"Which?"}
    B -->|"MENU"| C["Main options keyboard"]
    B -->|"HELP"| D["Command list + what bot can/cannot do"]
    B -->|"PAUSE"| E["Reminders stopped"]
    B -->|"RESUME"| F["Reminders restarted"]
    B -->|"CANCEL"| G["Abort current multi-step flow"]

    H["Notification discipline"] --> H1["Max 2 study messages per day"]
    H --> H2["3 consecutive ignored sessions"]
    H2 --> H3["Auto-PAUSE + one RESUME when ready message"]
```

## 8. Shared state — both interfaces, one backend

```mermaid
flowchart LR
    subgraph Web
        W1["Session screen"]
        W2["Plan editor"]
    end
    subgraph Telegram
        T1["DONE / SKIP buttons"]
        T2["Recall + note replies"]
    end
    subgraph Backend
        S[("study_sessions — single source of truth")]
        SM["Shared state machine"]
        EN["Pure route engine"]
    end

    W1 --> SM
    T1 --> SM
    T2 --> SM
    W2 --> EN
    SM --> S
    SM --> EN

    S -.->|"Concurrency guard"| X["UPDATE ... WHERE state = expected — 0 rows = stale write rejected — first tap wins, phone or web"]
```

## 9. Responsibility split (which interface does what)

| Action | Web | Telegram |
| --- | --- | --- |
| Account creation | Yes | No (link only) |
| Course creation (name only) | Yes | No |
| Exam entry | Yes (typed or image) | Image or text |
| PDF upload — supplies page count | Yes | No |
| Weekly availability editing | Yes | Text entry + image only |
| Studying (PDF view + timer) | Yes | No — deep link to web |
| Today's route + risk | Yes | Yes |
| DONE / SKIP | Yes | Yes |
| Recall prompt + confusion note | Yes | Yes |
| Plan editing / manual range adjust | Yes | No — deep link |
| Recovery-choice selection | Yes | Notification + deep link |
| Progress / analytics | Yes | Compact weekly summary only |
| PAUSE / RESUME reminders | Settings | Commands |

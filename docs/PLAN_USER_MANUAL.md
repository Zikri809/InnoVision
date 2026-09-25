# Easy2U user manual — production plan

> **Status:** Plan only, 2026-09-25. No current screenshots are included.
> The existing repository captures are outdated. While the active E2E run uses
> the shared app, do not open it or capture screenshots. Code-based drafting can
> continue. Later UI verification and capture require a dedicated environment
> with a release build and synthetic data.

## 1. Goal and deliverables

Build a manual that lets a first-time **student** or **lecturer** finish the
ordinary tasks for their role without another person explaining the interface.
Keep the manual task-based: each procedure begins with a goal and prerequisites,
shows the exact clicks and fields, then shows the expected result and recovery
path. Explain special cases where a screen changes by quiz mode, role, device,
or institution configuration.

**Delivery decision:** the searchable docs website is the primary manual. The
PDF is a versioned download for printing or offline use, generated from the
same Markdown source so its instructions cannot diverge from the website.

Deliver these artifacts:

1. `docs/user-manual/README.md` — short entry page: choose Student or Lecturer,
   quick start, search/contents, version, changelog link, and help route. The
   published edition is served from a searchable docs site generated from
   these markdown sources (toolchain named in Phase 6); raw repo markdown is
   not the delivery format on its own.
2. `docs/user-manual/student.md` and `docs/user-manual/lecturer.md` — complete
   illustrated procedures, with stable heading links and a common glossary.
3. `docs/user-manual/troubleshooting.md` — symptoms, likely cause, exact next
   step, and when to contact a lecturer or administrator.
4. `docs/user-manual/support.md` — one page per role listing who to contact
   (lecturer, institution administrator, support channel), what to include in
   a report, and expected response context. Every troubleshooting item ends
   here; no reader is left without a contact path.
5. `docs/user-manual/CHANGELOG.md` — short per-edition change list keyed to the
   app release, linked from the README version line.
6. `docs/user-manual/screenshots/` — release-verified, annotated desktop and
   mobile captures with descriptive names; no real student identities or face
   images. Keep unannotated originals so annotations can be revised.
7. A print-ready PDF derived from the same content and a Bahasa Malaysia edition
   after the English content is validated. Keep interface labels aligned to the
   selected language; capture localized images when a label differs in length
   or meaning (BM localization rules are pinned in Phase 6).

The user-facing manual must not include demo passwords, invite codes, internal
URLs, API names, or deployment instructions. Those belong in the exhibition and
operator documents.

Where the product supports it, link key screens (class join, face setup, quiz
pause, results) directly to the matching manual anchor so help is one click
away from the moment of confusion.

### Editorial standard for each task

- Title sections with the user's action, such as **Join a class** or **Release
  results**. Start with the outcome, prerequisites, and the screen where the
  action begins.
- Use a short numbered list with one action per step. Name controls by their
  exact visible or accessible label and use input-neutral verbs such as
  **Select**. Split a long procedure at a meaningful checkpoint and link to
  shared procedures instead of repeating them.
- End with **What happens next** and **If it does not work**. Put important
  irreversible effects immediately before the relevant action, including
  closing a quiz, revealing results, resetting an attempt, and revoking a link.
- Write complete steps that work without images. Use a screenshot only when it
  clarifies navigation, a complex control, or a state change; avoid directional
  instructions such as “click the button on the right.”
- Keep product labels, role names, and terms consistent across English and
  Bahasa Malaysia. Mark institution-dependent options as conditional instead
  of assuming every deployment exposes them.

These rules follow the [Microsoft procedure guide](https://learn.microsoft.com/en-us/style-guide/procedures-instructions/writing-step-by-step-instructions),
[Google procedure guide](https://developers.google.com/style/procedures), and
[Google accessibility guidance](https://developers.google.com/style/accessibility).

## 2. Audience and route map

| Reader | Starting point | Tasks they must be able to finish |
| --- | --- | --- |
| New student | `/register`, `/login`, optional `/matric-capture` | Join a class, set up face verification, find a class quiz, complete it, see results when released, make and share a private practice quiz. |
| Returning student | `/student/classes`, `/student/quizzes` | Resume/retake when allowed, respond to pauses, view notifications and results, update account settings from the account menu. |
| New lecturer | `/register` with an institution-provided invite code | Create a class, share code/QR, make a quiz, publish it, review participation and marks. |
| Returning lecturer | `/lecturer/classes`, `/lecturer/quizzes` | Manage roster/classes/quizzes, adjust availability, review integrity events, resolve blocked attempts, release results, export reports. |
| Shared-quiz recipient | `/s/[code]` | Sign in if prompted, return to the shared personal quiz by code, and understand what the owner can see and what happens when the link is revoked. |
| Reader on phone | Same account, mobile layout | Find bottom navigation, open account/notification sheets, and perform the same supported role tasks. |

"Administrator" means the institution staff member who manages accounts,
invite codes, and deployment configuration. The manual never assumes the
reader can reach an administrator directly; the support page states when to
escalate beyond a lecturer and through which channel.

Notifications appear in the bell dropdown and its sheet, not a dedicated page;
account settings (avatar, matric display) live in the account menu popover,
not a settings page. Document both as they exist.

Use `src/app/(student)`, `src/app/(lecturer)`, `src/app/(auth)`, `/join/[code]`,
`/play/[sessionId]`, `/play/student/[quizId]`, and `/s/[code]` as the current
route map. Validate behavior in the UI; `docs/ARCHITECTURE.md` and
`docs/EXHIBITION_MANUAL.md` supply background but contain implementation and
demo details unsuitable for end users.

## 3. Manual outline and required procedures

### Part A — Start here (both roles)

Part A section 1 is explanation, not a procedure: label it as background and
cross-link it from the role guides rather than blending it into how-to steps.
Parts B and C are pure how-to material; Part D is pure reference.

1. **What Easy2U is:** class assessments versus personal practice quizzes;
   student and lecturer responsibilities; the three quiz states (draft, live,
   closed) in plain language.
2. **Before you begin:** supported browser/device statement confirmed by QA;
   internet, account, and email access; camera permissions and a well-lit space
   for assessments that require face verification. State that the lecturer or
   institution may turn some capabilities on or off.
3. **Create an account and sign in:** student registration, lecturer invite code,
   email confirmation if required, institutional Microsoft sign-in when offered,
   the one-time matric number prompt for eligible SSO students, password reset,
   and sign out. Include the visible success destination for each path.
4. **Find your way around:** desktop top navigation, phone bottom navigation,
   notification bell, account menu, language switch, theme switch, and how to
   return to the role dashboard. Explain unread versus read notifications.
5. **Quick starts:** one page each for “student: join → take → view result” and
   “lecturer: create class → create quiz → publish → review.” Each links to the
   detailed procedure rather than duplicating it.

### Part B — Student guide

| Section | Procedure and outcome to document | Important branch or warning |
| --- | --- | --- |
| S1 Join a class | Enter the six-character code from the lecturer or scan the class QR; confirm the class; find it under My Classes. | Explain invalid/expired/archived codes, already joined, and the temporary lock after repeated wrong codes. Show the login/register handoff after QR scanning. |
| S2 Find a class quiz | Open Class Quizzes, filter/find the class, read mode, availability window, deadline, time limit, and attempt status. | Distinguish practice from assessment; explain scheduled, closed, and retake states. |
| S3 Set up face verification | Read consent; permit camera; complete blink and three-angle enrollment; recognize enrolled or pending-review state. | Show camera denied/unavailable, poor light/multiple faces, duplicate-enrollment review, and how to retry or seek lecturer help. Include the student self-recovery path for face issues. Do not suggest bypassing verification. Reassure the reader that a pause or review is a normal process, not an accusation. |
| S4 Begin an assessment | Open a live quiz, review instructions, pass the camera/liveness gate where required, enter fullscreen if prompted, and start. | Describe what changes when gestures or face checks are disabled or the lecturer grants an exemption. |
| S5 Answer and submit | Select an answer by click/tap; if enabled, use a steady hand gesture and confirmation; handle single choice, true/false, multiple choice, short text, skip, Back/Next, timer, final Finish/Submit, and the completion screen. | State when answers lock, whether correctness appears immediately, and how to resume a saved session. Explain on-screen hand, camera, or focus warnings that the release UI actually displays. Verify exact button names and gesture timing in the release UI. |
| S6 Recover during a quiz | Follow the pause overlay: recheck face/blink, recover camera, return to the tab/fullscreen, use self-recovery, or wait for lecturer unlock. | Distinguish a temporary pause from a flagged attempt; explain timer behavior, failed submit/retry, and lost connection without promising unsaved work is retained. Also publish this procedure as a one-page **"During the quiz" card** (symptom → action) that is linked from S4–S7 and bookmarked in the PDF, so a student mid-pause can find it without scanning the guide. |
| S7 See results | Find own completed attempts and notification; view score and question review after reveal. | A completed assessment may show “waiting for results”; lecturer controls release. Practice feedback can appear sooner. Link glossary terms like *reveal* at first use, not only in Part D. |
| S8 Make a personal quiz | Open My Quizzes; create/edit questions and images; reorder/delete; optionally use AI generation if available; preview and play. | Personal quizzes are ungraded class work, and AI availability depends on configuration. |
| S9 Share a personal quiz | Create share link/code, send it, open a shared quiz, revoke or rotate access. | Explain who can open it and that revoking a link makes the old code unusable. |

### Part C — Lecturer guide

| Section | Procedure and outcome to document | Important branch or warning |
| --- | --- | --- |
| L1 Create/manage a class | Create a class, copy join code, display QR, see roster and quizzes, archive and restore. | Archived classes reject new joins; explain what remains visible. |
| L2 Create a quiz | Start from a class or My Quizzes; enter title, mode, time limit, open/close schedule, retake/reveal and gesture settings; save draft. | Define Practice versus Assessment using current UI wording. Note which settings stop being editable after publishing. |
| L3 Write questions | Add/edit/reorder/delete multiple choice, true/false, multiple select and short text; set correct response and explanation; attach/remove an image. | Explain which question types permit gestures and how short-text marking works. Use exact current limits from validation/UI. |
| L4 Import or generate | Import questions from plain text or CSV (`.txt`/`.csv` — the only supported formats); generate from files or a web topic where enabled (web-topic generation is behind a feature flag); review generated questions before publishing; regenerate a question; duplicate a quiz. | AI can be unavailable or return imperfect content. Explain the OCR/file-format and size rules from current UI, note that short answers may show a pending AI-mark state until reviewed, and require manual review of answer keys. |
| L5 Publish and manage access | Publish, read live status, adjust the availability window where allowed, close the quiz, and understand retakes. | Include a decision table for draft/live/closed, scheduled opening, completion auto-reveal, manual reveal, and close-with-unrevealed-results. |
| L6 Monitor and resolve attempts | Open results, interpret attendance/status and integrity timeline; inspect a student's session; approve pending face enrollment; unlock, grant face exemption with reason, or reset an attempt. | Explain the effect of each action before clicking; reset may permit a new attempt and change history. Keep incident media access private. |
| L7 Release and analyze results | Review scores, question insights and gradebook; release assessment results; inspect per-student details; download quiz and class Excel reports. | State when students can see score, answers and explanations; explain pending AI marks/review states before export or reveal. |
| L8 Housekeeping | Read notifications, archive/restore class, review old quizzes and exports, sign out. | Note that very large rosters show only the first N students with a truncation notice. Include an FAQ for a student missing from roster or unable to start. |

### Part D — Reference and help

- Glossary: class, join code, QR, draft/live/closed, practice/assessment,
  enrollment, attempt, paused/flagged, reveal, exemption, retake, shared quiz.
  Link each glossary term at its first use in Parts B and C, not only here.
- One-page state tables: **quiz availability**, **assessment attempt states**,
  **who can see results and when**, and **lecturer intervention outcomes**.
- **"During the quiz" panic card:** a single symptom → action page covering
  pause, camera loss, advisory warning, timer anxiety, and failed submit,
  cross-linked from S4–S7 and bookmarked in the PDF.
- Troubleshooting grouped by sign-in, join, camera/face, quiz answer/timer,
  AI/import, results/export, and mobile layout. Each item: visible symptom →
  action the user can take → who to contact if it persists, ending at
  `support.md`.
- Accessibility and privacy: keyboard/touch alternatives to gestures,
  readable screenshots and text alternatives, browser zoom, camera consent,
  handling downloaded reports, and how to stop sharing a personal quiz.

## 4. Screenshot plan

### Capture manifest — future work only

The screenshot set in the repository is **outdated** and is not evidence of
the current app. No browser visit, app screenshot, or screenshot reuse is part
of this planning pass. The states below form a **candidate shot list**, not a
quota. Captures happen only in the dedicated capture environment after the
active shared-app E2E run is clear; choose only images that make a task easier
to follow in the release candidate. Every listed state still needs a
matching text procedure, whether or not an image is selected.

| ID | Manual section | State to capture and annotate |
| --- | --- | --- |
| A01 | A3 | Student and lecturer registration choices; lecturer invite-code field. |
| A02 | A3 | Login, password recovery and reset; institutional sign-in if configured. |
| A03 | A3 | One-time matric number prompt and success destination. |
| A04 | A4 | Desktop navigation, notification bell, account, language and theme controls. |
| A05 | A4 | Phone bottom navigation and account/notification sheets. |
| S01 | S1 | Typed join code, QR handoff, join confirmation, newly joined class. |
| S02 | S1 | Invalid/archived code and temporary lockout messages. |
| S03 | S2 | Student quiz list: mode, status, deadline and attempt/retake states. |
| S04 | S3 | Face consent, camera permission, blink, three poses and enrollment success. |
| S05 | S3 | Camera blocked, failed capture, pending review and retry path. |
| S06 | S4 | Assessment instructions, liveness gate, fullscreen request and Begin. |
| S07 | S5 | Single choice, multiple select, short text, question image, skip and gesture confirmation. |
| S08 | S5 | Timer/progress, final submission and submitted screen. |
| S09 | S6 | Pause/recovery, flagged state and failed-submit retry. |
| S10 | S7 | Waiting for reveal and released score/question review. |
| S11 | S8 | My Quizzes list, new/edit form and configured AI generation. |
| S12 | S9 | Share dialog, shared preview/play, revoke and rotate controls. |
| L01 | L1 | Class dashboard, create class, join-code copy and QR display. |
| L02 | L1 | Class detail, roster, archive confirmation and archived list. |
| L03 | L2 | New quiz form, builder settings and schedule. |
| L04 | L3 | Question types, image upload, edit/reorder and Publish. |
| L05 | L4 | AI generation, bulk import, duplication and generated-question review. |
| L06 | L5 | Draft/live/closed states, availability settings and close confirmation. |
| L07 | L6 | Results, attendance, integrity detail, unlock/exempt/reset dialogs. |
| L08 | L6 | Face-enrollment review and decision. |
| L09 | L7 | Reveal, student-visible result, question insights and gradebook. |
| L10 | L7 | Quiz and class export controls with synthetic workbook headings. |
| M01 | A4, S/L | Phone lecturer class, builder, results and gradebook views. |
| S13 | D | "During the quiz" card states: pause, camera loss, advisory warning, failed submit. |
| BM01+ | Any | Bahasa Malaysia captures of every selected task figure; required whenever a BM label differs in length or meaning from English. |

### Capture and annotation rules

- Capture the **release build** with a dedicated synthetic dataset and known
  student/lecturer accounts. Record commit, capture date, browser, viewport,
  locale, theme, account role, and scenario for every image in a manifest CSV.
- Use a **dedicated clean browser profile** for capture: autofill, password
  managers, sync, and extensions disabled, so real names, emails, or matric
  numbers never leak into registration or account captures (A01–A03, A04).
  The fake-camera source must be fully synthetic (a generated or licensed
  loop rendered through a virtual camera), never a consenting person's real
  face or room.
- Review AI-generated and imported fixture output for PII before it enters a
  capture state; generated questions must not echo real names or matric
  numbers.
- Storage: keep originals and annotated files in clearly separated
  directories under `docs/user-manual/screenshots/`, publish only annotated,
  optimized images (PNG for UI, per-image and total-PDF size caps set at
  capture time), and keep originals out of the published PDF.
- Use desktop 1440×900 and a real-phone-sized 375×812 viewport as baselines;
  add a smaller 320 px check for navigation and forms. Capture a full page only
  for orientation; crop task figures tightly enough that controls remain
  readable at normal document width.
- Disable development overlays. Use synthetic records and an approved
  fake-camera setup so passwords, invite codes, access tokens, live join/share
  codes, real names, emails, matric numbers, real faces, and incident footage
  never enter the capture. If redaction is unavoidable, use a fully opaque
  block and flatten the exported image; do not rely on blur. Show a generic
  permission prompt only if it can be captured safely and consistently.
- Keep callouts brief and put their full meaning in nearby text. Caption an
  informative image with its purpose and expected result; give it concise alt
  text. If the image only repeats the complete surrounding instructions, use
  empty alt text in the published HTML. Never put essential instructions only
  inside a screenshot or convey state by color alone.
- Check English and Malay UI labels against `src/messages/en.json` and
  `src/messages/ms.json`; screenshot labels must match the instruction text.
  Recapture after any navigation, wording, or layout change.
- Review each proposed image against the
  [Google image guide](https://developers.google.com/style/images) and
  [GitLab illustration guidance](https://docs.gitlab.com/development/documentation/styleguide/):
  keep the useful UI area, avoid unnecessary images, and make the written
  instructions sufficient without them.

## 5. Production sequence

| Phase | Work | Exit check |
| --- | --- | --- |
| 1. Verify scope | After the shared-app E2E run is clear, walk every route in a dedicated environment on a release candidate; confirm feature flags and current labels with one lecturer and one student scenario. Audit user-visible strings outside `src/messages/` and record exceptions so screenshot-label parity can be reviewed. Mark unavailable institution-specific features as conditional. | Approved procedure checklist, exact UI labels, no undocumented branch in the critical journeys, string-audit findings resolved or documented. |
| 2. Build capture data | Create synthetic class, draft/live/closed quizzes, attempts and review states in a disposable local environment; stage a **fully synthetic fake-camera source** (generated loop via virtual camera — never a real person) and AI/import fixtures. Review AI and import fixture output for PII. Pin the environment to a commit and record its config. | Every capture state reproducible without real personal data; fake-camera provenance documented; fixtures pass PII review. |
| 3. Write the guide | Draft quick starts, then student and lecturer procedures, then state tables/glossary/troubleshooting, the "During the quiz" card, and `support.md`/`CHANGELOG.md`. Code-based drafting can proceed while E2E runs. Use consistent “Where to go → Steps → What you should see → If it fails.” Keep procedures short and split long flows at checkpoints. Mark the few steps where a visual would reduce confusion. | Every action named in the outline has a working route and visible outcome, with or without images; long procedures have been split at meaningful checkpoints. |
| 4. Capture and annotate | Select useful states from IDs A01–M01 based on the draft, capture them from the release candidate in the capture environment using **scripted Playwright sessions (reuse existing e2e journeys)** with the clean capture profile, make original/annotated files, fill manifest, compare desktop/mobile. | Every chosen image clarifies a task and matches the release; the guide is usable without images; manifest complete for every image. |
| 5. Test with readers | **Informed consent + privacy notice first:** participants complete face-enrollment tasks on test accounts, so consent must cover biometric template creation, retention, and deletion; offer an opt-out from biometric tasks; **delete all test-account biometric data after testing**. Give at least three first-time students and three first-time lecturers only the manual and test accounts — run **two revise-and-retest rounds** (or five per role in a single round), with scripted tasks, think-aloud protocol, recorded time-on-task and errors. Include desktop and phone tasks. Check the **manual's own keyboard traversal** (heading order, skip link, visible focus) and one keyboard-only reading path for each role in the app. | ≥90% of participants complete their role's critical journey unassisted per round; wrong turns and time-on-task recorded; fixes retested; consent fulfilled and biometric data deleted. |
| 6. Localize and publish | Fix the BM register before translation: **formal DBP-aligned register**, a signed-off BM terminology list, and a named native-speaker reviewer. Translate to Bahasa Malaysia, **recapture BM figures for every selected task image** and re-run the 320 px check in BM, verify date/time formats and labels, then generate an **accessible PDF from a named toolchain** (tagged export, verified reading order, bookmarks, `lang` metadata, callout contrast ≥4.5:1) plus **BM-edition testing with 1–2 BM-preferring readers**. Review privacy and links, then publish on the searchable docs site with version/date and changelog entry. | Links, image alt text, accessibility checks on the PDF, screenshots, and procedures pass final review; BM register and terminology signed off. |
| 7. Maintain | Assign a documentation owner. Manual changes go through **PR review with owner sign-off**. CI runs a **link checker** (e.g., lychee) on every PR. Keep a mapping from each screenshot to its source screen and review affected images on UI changes; image hashes alone cannot detect UI drift. On each UI label, navigation, feature flag, or flow change, review affected procedures and images before release. | The manual version identifies the matching app release and has a visible last-reviewed date; link checks and affected-image reviews pass. |

## 6. Acceptance checklist

- [ ] A student can register/sign in, join by code or QR, enroll face, take and
  submit an assessment, handle a pause, and find a released result using only
  the manual.
- [ ] A lecturer can create a class, share the join path, create/publish a quiz,
  review an attempt, resolve a blocked attempt, release results, and export a
  report using only the manual.
- [ ] Personal practice creation, sharing, revocation, and shared play are
  covered independently from class assessments; shared-quiz recipients on
  `/s/[code]` are addressed.
- [ ] Every task has prerequisites, concise numbered actions, expected UI
  state, and recovery guidance. Long procedures are split at checkpoints.
  Selected screenshots clarify complex tasks; removing images does not remove
  any essential instruction.
- [ ] **Reader-testing gates met:** ≥90% unassisted completion of each role's
  critical journey across two revise-and-retest rounds, with time-on-task and
  wrong turns recorded; consent fulfilled and all test biometric data deleted.
- [ ] **Readability reviewed:** first-time readers understand the procedures;
  automated readability scores are used as a signal, not a pass/fail rule,
  especially for the Bahasa Malaysia edition.
- [ ] Desktop and phone navigation, both languages, and keyboard/touch paths
  are checked — including the manual's own keyboard traversal and responsive
  published pages. No private data, secrets, or development overlays appear.
- [ ] The published PDF has verified tags, reading order, bookmarks,
  `lang` metadata, and ≥4.5:1 contrast for callouts; PDF/UA conformance is
  claimed only after formal validation. Web and PDF content parity is checked.
- [ ] A reviewer compares every step and selected screenshot to the same
  release commit; the manual has a version/date, last-reviewed date, owner,
  and a changelog entry for the edition.
- [ ] CI link checks pass and screenshots affected by UI changes have been
  reviewed against the published edition.

## 7. Source map for implementation

- User-visible routes/components: `src/app/(auth)`, `src/app/(student)`,
  `src/app/(lecturer)`, `src/app/join/[code]`, `src/app/play`, `src/app/s/[code]`,
  `src/components/layout/app-shell.tsx`, `src/components/quiz/play-client.tsx`,
  `src/components/face/face-gate.tsx`.
- Behavior and edge cases: `docs/ARCHITECTURE.md` §7,
  `docs/EXHIBITION_MANUAL.md` §3, and the relevant `e2e/*.spec.ts` journeys
  (also reused as the basis for scripted capture sessions).
- The existing `screenshots/` tree is historical and excluded from manual
  artwork. New captures happen only in the dedicated capture environment.


# Matric Numbers + Lecturer Excel Export

> **Status: EXECUTED (2026-08-25)** — design of record, revised through three
> independent critiques (security / data-integrity / product-UX) and three
> subagent review-fix iterations. Where this doc and the code disagree, code +
> migrations win.

## 0. Scope

Two features, one migration (**0027** — [FIX] 0026 already exists:
`0026_notify_face_enrollment_held_enum_cast.sql`):

1. **Matric number on student accounts** — collected at registration,
   uniquely enforced across all profiles (exactly 6 digits per the
   institutional format), shown (and editable) in the account (profile)
   modal, visible to lecturers via the roster view. Backfilled for existing
   students in the reserved 99xxxx range.
2. **Excel export of quiz results (lecturer side)** — a `.xlsx` download from
   the results dashboard: per-student rows with matric/name/score/per-question
   choices, plus an answer-key sheet and per-option choice-distribution sheet.

**Non-goals**: lecturer "staff number", CSV export (can be added later from the
same model), multi-select questions, bulk admin import of matrics.

**[FIX] Matric lifecycle decision** (was "SQL-only edits"): students may correct
their own matric once via the profile modal (server action, normalized +
validated + uniqueness-checked). Rationale: signup typos otherwise become
permanently wrong identities on grade exports; the self-update RLS policy
(student, own row, 0001) already permits the write, so the only new surface is
UI + one action. Format/uniqueness stay enforced by CHECK + unique index at
all times.

## 1. Part A — Matric number

### 1.1 Shared helper (`src/lib/auth/matric.ts`, unit-tested)

- `normalizeMatric(raw): { ok: true, value } | { ok: false, reason }`
  - trim → delete ALL internal whitespace.
  - Valid shape: **exactly 6 digits** (`^[0-9]{6}$`) — institutional matric
    style per product input. Letters/dashes rejected.
    [FIX] Whitespace rule pinned: whitespace is *deleted* before validation.
  - **[FIX] Reserved range**: values matching `/^99[0-9]{4}$/` (system-backfill
    namespace) are rejected with a dedicated reason (`matricReserved`) so a
    future registrant can never collide with generated legacy numbers.
- `sanitizeFilenamePart(title): string` — whitelist `[A-Za-z0-9._\- ]`,
  collapse repeats, cap 80 chars, empty → `"quiz"`.

### 1.2 Database (migration 0027_matric_numbers.sql)

- `alter table public.profiles add column matric_no text`
  - CHECK `profiles_matric_no_format`: null or matches the same shape as above
    (post-normalization storage contract: exactly 6 digits).
    Direct REST PATCHes with garbage fail opaquely here — accepted,
    the sanctioned paths all normalize first.
  - Partial unique index `profiles_matric_no_unique on public.profiles
    (matric_no) where matric_no is not null`. Plain CREATE UNIQUE INDEX
    (ACCESS EXCLUSIVE lock acceptable at this scale; CONCURRENTLY is not
    available inside a migration transaction — noted to prevent "fixes").
  - Multiple NULLs allowed (lecturers, trigger-sanitized signups).
- **`handle_new_user()` rewrite** (supersedes the 0015 body):
  - Preserve the exact 0015 locale whitelist logic.
  - matric: normalize inside the trigger (btrim → strip whitespace); insert
    **NULL** when the result fails the 6-digit shape regex OR falls in the
    reserved `^99` range (raw GoTrue signups bypass the app's normalizeMatric,
    so the system namespace is refused at the trigger too) — mirroring the
    locale fallback precedent. [FIX] Never abort signup on malformed
    attacker-controlled `raw_user_meta_data` (direct anon-key `signUp` bypasses
    the server action; fail-hard there yields opaque dead ends). Requiredness
    and friendly errors live in the registration layer; the 23505 uniqueness
    abort remains the race-safe correctness net.
- **Backfill**: existing students with NULL get `99{seq:4}` ordered by
  `created_at`, starting PAST any existing 99xxxx value (a defensive re-run
  after post-migration NULL rows appeared must not collide with the original
  assignment); an overflow-guard DO block RAISEs a clear error if the
  namespace cannot fit every NULL-matric student instead of aborting on an
  opaque CHECK violation. Single-statement = snapshot-atomic; on
  concurrent-commit loss it rolls back and re-runs. Lecturers stay NULL.
- **student_roster_view**: DROP + RECREATE (not OR REPLACE — [FIX] matches the
  0006 precedent so `security_barrier` retention is guaranteed) appending
  `p.matric_no` LAST (Postgres forbids renaming/reordering existing output
  columns), then re-`grant select`. MED-3 minimization rationale intact:
  matric is directory data, biometrics stay hidden.
- Regenerate types (`npm run gen:types`; needs local Supabase running).

### 1.3 Registration flow

- **UI** (`register/page.tsx`): required "Matric No." input when
  `role === "student"`; hidden on lecturer path. `autoComplete="off"`,
  `spellCheck=false`. Client mirror-check via `normalizeMatric` with distinct
  messages (`authErrors.matricInvalid`, `matricTaken`, `matricReserved`).
  Kept **required** even though the `/s/[code]` share funnel forces
  registration: self-edit (§1.5) is the pressure valve for placeholder values.
- **Server action** (`register.ts`):
  - New optional param `matricNo?: string`; normalize via shared helper;
    reject invalid/reserved with specific messages.
  - **[FIX]** Friendly uniqueness pre-check runs via **`createAdminClient()`**
    (service role) — the anon-cookie RLS client is self-only (0001) and would
    find nothing. Residual enumeration oracle (probing which matrics exist) is
    mitigated by the new per-IP student-signup rate limit below and accepted +
    documented like other coarse oracles (ARCHITECTURE §6 style).
  - **[FIX] Per-IP rate limit on the whole student signup path**
    (pattern: `sq-resolve-ip` in `student-quizzes/shared/[code]/route.ts`),
    e.g. `{ limit: 10, windowMs: 60_000 }` keyed `signup-ip:<ip>` — closes
    matric-squatting spam and blunts the oracle.
  - Stored via `signUp options.data.matric_no` (normalized value; trigger
    copies it). Only set on the student path; ignored when `wantsLecturer`.
  - Admin upsert fallbacks (promotion, consent repair) pass `matric_no`
    through where role-appropriate.
- Note: matric rides in `user_metadata` JWT claims thereafter — accepted at
  demo scale, recorded here.

### 1.4 Profile modal

- Layouts project `matric_no` alongside `role, consent_given_at, full_name`
  and thread it `AppShell → AppUserMenu`.
- Students see a bordered row `Matric No.: <value>` under name/email with a
  muted hint line (`nav.matricNumberHint`: "Visible to your lecturers" /
  "Boleh dilihat oleh pensyarah anda"). **[FIX]** System-generated values
  (`99xxxx`) additionally show "assigned by InnoVision — tap to update" copy so
  fabricated IDs are never mistaken for real ones.
- **[FIX] Inline self-edit**: pencil affordance swaps the row to an input +
  Save/Cancel; save calls new server action `updateMyMatric(matricNo)` which
  normalizes, validates (invalid/taken/reserved messages), and updates own row
  via the user-scoped client (RLS student-self-update policy authorizes it).
  Success refreshes the router. Lecturers see no matric row at all.

### 1.5 Roster plumbing

- `RosterEntry` gains `matricNo: string | null`; `getClassRoster` projection
  updated. Existing explicit-projection call sites stay safe.

## 2. Part B — Excel export

### 2.1 Library

**exceljs ^4.4.0**, server-side only. Rejected SheetJS CE (CVE-2023-30533 /
CVE-2024-22363 history, styling gaps).

### 2.2 Route + authorization (`src/app/api/quizzes/[id]/export/route.ts`)

- Guard chain **[FIX] reuses `requireQuizOwner()` verbatim** (`guards.ts` —
  one joined owner-filtered round trip) after `isUuid(id)` pre-check, plus
  explicit `profile.role === "lecturer"` check (guard assumes authed
  principal). No TOCTOU concern (class ownership immutable; RLS re-checks
  every read under the same JWT). Invariant: **all reads on the user-scoped
  client; `createAdminClient()` forbidden in this route**.
- **[FIX] Rate limit** `EXPORT_RATE ≈ { limit: 10, windowMs: 60_000 }` keyed
  `export:${userId}` immediately after the guard (every route in this repo
  throttles; this is the most expensive read + PII payload).
- Reads: quiz meta via guard; `lecturer_session_view` (GET-envelope minus
  nonce); extended roster; `questions` ordered by `order_index` **with**
  `correct_index`/`explanation` (same principal already sees them in builder;
  play-time D10 untouched); `lecturer_answers_view .in(session_id, ids)`.
  Caps: `RESULTS_SESSION_LIMIT` (200) and roster cap apply.
- Response: xlsx bytes, `Content-Type: application/vnd.openxmlformats-
  officedocument.spreadsheetml.sheet`, `Cache-Control: no-store`,
  `Content-Disposition: attachment; filename="<safe>-results-YYYY-MM-DD.xlsx";
  filename*=UTF-8''<enc>` — [FIX] title sanitized via `sanitizeFilenamePart`
  (CRLF would throw in undici Headers → 500; quotes/backslashes corrupt
  parsing; RFC 5987 covers non-ASCII), date suffix added per critique.
- Route test: student token → **403** (`requireUser` role denial), zero xlsx
  bytes; unknown/malformed id → 404; non-owner lecturer → 404 (guard's
  no-oracle semantics); rate-limit → 429; happy path parses the workbook and
  asserts attempt data actually reached the Results sheet.

### 2.3 Pure model layer (`src/lib/results/export.ts`)

`buildExportModel(input)` → plain JSON (no exceljs import) — Vitest target:

```
{
  meta: { quizTitle, className, mode, quizStatus, generatedAtISO,
          totalQuestions, attemptedCount, truncated },
  questions: [{ id, index, prompt, type, options[], correctIndex, explanation }],
  students: [{ studentId, matricNo|null, fullName|null, status, score|null,
               total, percent|null, startedAtISO, submittedAtISO,
               durationSec|null, faceFails|null, focusPauses|null,
               answers: (string|null)[], answerCorrect: (boolean|null)[] }],
  distribution: [[{ optionIndex, chosenCount, chosenPercent }]] // per question
}
```

- **[FIX] Rows are ROSTER-DRIVEN** (left-join sessions by student_id):
  never-started students appear with status "Not started". Do NOT reuse
  `assembleResultsRows` — it iterates sessions only and drags face/audit/
  advisory reads with it; reuse **only `deriveSessionDisplayStatus`** (pure:
  status + last_activity_at + quizStatus + nowMs) so screen and export never
  disagree. Sort default: **matric ascending** (mark-sheet convention),
  null-matrics last by name.
- **Representative attempt per student**: assessment quizzes have at most one
  session (one-attempt partial unique index is assessment-only); practice
  retakes collapse to the terminal attempt (completed/flagged), else the most
  recently started. Deliberate grading semantics, NOT strict dashboard parity
  (the dashboard ranks in_progress above completed). Distribution math and
  attemptedCount draw from exactly this session set.
- **Orphan attempts** (session whose student left the roster) still get a row
  appended — same honesty rule as the dashboard's session-without-roster rows;
  blank names render via the dashboard's "Student"/"Pelajar" label.
- Per-question cell: option letter + text (`B — Photosynthesis`) verbatim from
  the authored options (true_false renders whatever the lecturer typed);
  unanswered `—`.
- **[FIX] Sanitizer choke point**: every string cell passes ONE `safeText()`
  (leading `= + - @ TAB CR` → `'` prefix) applied UNCONDITIONALLY to all cells
  (title banners, class line, explanations included — classification-based
  scoping was rejected as drift-prone). exceljs stores plain strings inertly
  (formulas need the explicit `{formula}` shape — never used with user text);
  the prefix is defense-in-depth for downstream CSV re-export. Cosmetic
  apostrophe accepted. Unit-test banner/explanation cells explicitly.
- Distribution math over answered attempts only; whole-number rounding;
  zero-answer questions yield zeroed percentages (no div-by-zero).
- `truncated: true` when session count hits 200 or roster hits 100.

### 2.4 Workbook layout

- **Sheet 1 "Results"**: Row 1 merged banner quiz title; Row 2 class name +
  mode + generated-at; Row 3 blank; Row 4 header; frozen panes below header,
  autofilter on. Columns: `# · Matric No · Name · Status · Score · Total · %
  · Started · Submitted · Duration · Face fails · Focus pauses* · Q1 … Qn`.
  (*integrity pair present only for assessment mode.) Wrong answers red,
  correct dark-green; `%` stored numeric with percent format.
  **[FIX]** When `meta.truncated`, a styled warning row under the header:
  "Showing first N enrolled / M sessions".
- **Sheet 2 "Questions & Key"**: `Q# · Type · Prompt · Option A…E (✓ marks
  correct) · Correct Answer · Explanation · Times answered · Times correct ·
  % correct`.
- **Sheet 3 "Choice Distribution"**: long/pivot-friendly `Q# · Prompt ·
  Option letter · Option text · Is correct · Chosen count · % of choosers`.
- Sheet names + headers localized to the lecturer's `profiles.locale` via
  `tFor(locale)`; class/mode context repeated atop Sheets 2–3 ([FIX] sheets
  travel separately).
- Practice-mode quizzes export fine (sessions carry scores/statuses) but are
  subject to the 90-day idle prune (0019) — mode is printed on Sheet 1
  prominently; retention caveat lives here and in TESTING notes.

### 2.5 UI hook

- **[FIX] Fetch→blob download with busy state** (plain anchor rejected: JSON
  error bodies would save as corrupt xlsx; page convention is busy-state-everything):
  click handler sets `exporting`, `fetch()`es the route, non-OK renders inline
  alert (existing `role="alert"` pattern), OK paths through
  `URL.createObjectURL` + programmatic click + revoke.
- Placement: hero band right edge (aligned with reveal card) — NOT beside the
  breadcrumb Back link.
- Always enabled (zero-session export still carries full roster + key).
- Filename suggestion honored from Content-Disposition; local fallback adds
  date.

### 2.6 Localization keys (enumerated for check-i18n parity)

- `auth.*`: matricLabel, matricPlaceholder, matricHelp, matricRequired,
  matricInvalid, matricReserved (client mirror-check copies)
- `authErrors.*`: matricRequired, matricInvalid, matricTaken, matricReserved,
  sessionExpired, studentsOnly
- `nav.*`: matricNumber, matricHint, matricSystemHint
- `common.*`: reused save/cancel/edit/saving
- `lecturer.results.*`: exportButton, exporting, exportError (+ reuse
  tableHeaderStudent as the workbook's blank-name label)
- Workbook strings via `tFor` under `workbook.*`: sheet names, all column
  headers, statuses incl. "Not started", generated-at line, truncation
  warning, mode/class labels. ms copy mirrors ICU style of en.

## 3. Seed & demo data

Seed refresh assigns plausible matrics (`231201`–`231210` 6-digit style).
**[FIX]** seed-demo's `ensureUser` reuses existing users via service-role
profile repair — so the repair path must also set `profiles.matric_no`
idempotently, not just `createUser` metadata (existing demo DBs otherwise
never gain matrics). A claimed matric (real user got there first) is skipped
with a warning — it must never abort the whole demo provisioning.

## 4. Testing plan

| Layer | What |
|---|---|
| Vitest units | `normalizeMatric` (whitespace deletion, 6-digit shape, reserved 99xxxx range); `sanitizeFilenamePart`; `buildExportModel` (roster-driven not-started rows, matric sort w/ nulls, unanswered `—`, distribution math incl. zero-division over representative sessions only, `safeText` on EVERY string cell incl. banner/explanation/names, truncation flag incl. answers cap, practice-retake representative selection, orphan-session rows, equal-timestamp tie behavior, duration/integrity columns) |
| Server-action tests | `register` (matric required/reserved/invalid; normalized metadata; pre-check short-circuit before signUp; unique-race → matricTaken; lecturer path ignores garbage matric and skips the pre-check) and `updateMyMatric` (unauthenticated/non-student copy paths; validation; probe clash → taken without write; 23505 at write → taken; happy-path normalization) |
| Route tests | student token → 403 no bytes; unknown id → 404; malformed id → 404; happy path buffer >0 with 3 correctly named sheets AND attempt data asserted inside the parsed workbook; hostile-title filename sanitization; 429 after budget |
| `scripts/verify-matric.mjs` | self-contained fixtures (admin.createUser + deleteUser teardown, random stamp suffix): trigger copies normalized metadata; malformed metadata → NULL not abort; reserved-range metadata refused by trigger; duplicate matric second createUser errors; plural NULLs ok; format CHECK rejects direct bad writes; roster view exposes matric to owning lecturer only with exact column ORDER (select("*") key-order probe); negative probes: enrolled student SELECT on roster view → 0 rows; cross-profile matric read → 0 rows; RLS self-update of own matric + claiming another's fails with 23505. Backfill correctness is pinned by migration review + db:reset replay, not a live probe |
| CI | `verify:matric` wired into the verify chain |

Manual smoke: duplicate registration shows friendly taken-error;
profile-modal edit round-trip; seeded closed-quiz export opens in Excel +
LibreOffice; crafted title `=cmd|…` appears inert in file.

## 5. Risks / notes

- Trigger normalizes-and-nulls malformed metadata (locale precedent); the
  registration layer owns requiredness/friendly errors; 23505 stays the
  atomic uniqueness net.
- Enumeration oracle via admin pre-check exists but is rate-limit-blunted and
  strictly cheaper-than-signup only; documented acceptance.
- exceljs is server-segment-only; no client bundle impact.
- Export contains correct answers/explanations: lecturer-authored content,
  owner-gated route — same trust tier as builder edit view.
- Caps (200 sessions / 100 roster / 20k answer rows) retained; any cap hit
  surfaces via the workbook's in-file truncation warning rather than silently
  dropping rows.

> **Status: EXECUTED (2026-08-25)** — shipped through three subagent review
> iterations: (1) deep security/quality/data audit → representative-session
> selection, orphan rows, truncation surfacing, reserved-range trigger
> enforcement, collision-proof backfill; (2) regression audit → overflow
> guard, unknown-student label, tie determinism, test-fixture fixes;
> (3) final gate → doc accuracy + `safeText` invariant restored. No open
> blockers.

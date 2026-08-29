# Roadmap Plan — Authoring Productivity

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec.
>
> Domain: how quizzes get built faster — bulk import, duplication/reuse,
> question banks. Builds on manual builder routes (`api/quizzes/[id]/questions*`),
> AI generation pipeline (`lib/ai/*`, validation mirrors in
> `src/lib/quizzes/validation.ts`), bulk RPCs `save_quiz_questions` /
> `save_student_quiz_questions`.

---

## AP-1 · Bulk import (paste / pipe-separated text) (MEDIUM-HIGH)

**Problem:** Sole non-AI lecturer write path adds ONE question per call
(`POST api/quizzes/[id]/questions`, `src/app/api/quizzes/[id]/questions/route.ts`,
104 lines — the handler calls the `append_question` RPC once per request).
Lecturers with prepared question sets must hammer the form 20 times. Cap 30
questions/quiz is enforced in generate-quiz pre-checks
(`api/ai/generate-quiz/route.ts:165–189`, `current >= 30` at line 176) and in
`save_quiz_questions` (`0025_save_quiz_questions_hardening.sql:103–105`), but
**NOT** on the manual `append_question` path (0016:279–336 has no cap check) —
a manually built quiz can exceed 30 today, so capacity must always be computed,
never assumed.

**Design sketch**
- Dialog alongside GenerateFromFileDialog (`src/components/extract/GenerateFromFileDialog.tsx`),
  opened from the builder toolbar in
  `src/app/(lecturer)/lecturer/quizzes/[id]/builder/quiz-builder-client.tsx`.
  The Import button renders ONLY when `isDraft`, beside the Generate button
  (same gating as Generate at ~line 667–675).
- Input: textarea paste OR file upload that reads the file's text into the
  same textarea/parser (`file.text()`, UTF-8; BOM is stripped by
  `stripBidiControls`) — pipe-delimited grammar, NOT comma-CSV quoting.
- Accepted line grammar (forgiving, dialect-tolerant), one question per
  non-empty line:
  `prompt | optA | optB | [optC] [optD] [optE] | *correctLetter`
  - Correct answer given EITHER as a trailing `*<letter>` cell
    (`*A`/`*a`) OR as an asterisk prefix on the option cell itself
    (`*B) text`, `*B. text`, `*B text`).
  - 2 options where the answer cell is `true`/`false`/`t`/`f`
    (case-insensitive; also `benar`/`salah`) → `true_false` row
    (`prompt | true`). A 3+-option line ending in `true` stays mcq.
  - Constraints mirrored from `QuestionInputSchema`
    (`src/lib/quizzes/validation.ts:53–102`): prompt 1..2000, options 2..5
    distinct case-insensitively each 1..500 chars, correct index in range,
    explanation ≤2000 optional. Apply `stripBidiControls`
    (validation.ts:40–42) to every cell.
  - `|` inside text is NOT supported (no escaping): an option count above the
    grammar's cell budget is a distinct per-row problem ("'|' inside text is
    not supported"), and exactly one trailing empty cell is tolerated.
    Empty cells anywhere else are a per-row problem, never silently dropped.
  - Parse client-side → preview rendered as card rows (flex-col sm:flex-row,
    builder question-list pattern — NOT a wide table; must survive 375 px),
    showing row number, prompt, type, options, and per-row problems with
    ORIGINAL 1-based file line numbers (blank lines counted, never
    renumbered). Edit/fix before commit.
- **Reject whole batch atomically on any invalid row** (show all problems;
  nothing POSTs until every row is valid). Per-row problem strings are a
  CLOSED ENUM rendered via literal `t("importProblemXxx", { line, max })`
  calls (code→key switch, GenerateFromFileDialog codeMap pattern at
  GenerateFromFileDialog.tsx:302–308) — never `` t(`...${code}`) `` dynamic
  keys (check:i18n scans literal call sites only).
- Commit: `POST /api/quizzes/[id]/import-questions` (new route) with
  `{ questions: [...] }`. Route preamble in house order:
  `isUuid → requireQuizOwner → notDraft() → checkSameOrigin →
  rateLimit('quiz-import:<uid>', 120/h — quiz-author parity) →
  checkBodyLimit(request, 512 KB — 30×2000-char prompts approach the 64 KB
  default; same override generate-quiz uses) →
  Zod z.object({ questions: z.array(QuestionInputSchema).min(1).max(30) }) →
  map each Zod row to DB shape {type, prompt, options, correct_index,
  explanation} (camelCase→snake_case — aiQuizToRows precedent,
  src/lib/ai/quiz-schema.ts:147–172; REQUIRED, the RPC reads
  `correct_index` and raises invalid_question_fields on camelCase) →
  save_quiz_questions(p_mode := 'append', p_title/p_source_file_url/
  p_source_text := NULL)`.
  - Passing NULLs is load-bearing: 0025 append mode leaves title/sources/
    source_text untouched only when the args are NULL (0025:149–185) — no
    provenance pollution, no second writer invented.
  - Capacity: dialog shows "N of 30 remaining" from `30 - questions.length`
    (server-rendered props truth at render) and caps the parse client-side;
    the route does a head-count (generate-quiz pattern): already ≥30 →
    422 `unprocessable("quiz_question_limit_exceeded")`; rows > remaining →
    400 invalidBody with an explicit remaining-count message.
  - The RPC's cap check behind its advisory lock is the authoritative backstop.
  - Route sets `export const dynamic = "force-dynamic"`;
    `params: Promise<{ id: string }>` awaited.
  - Accepted house posture: the 512 KB gate is content-length-conditional
    (`checkBodyLimit` falls through on headerless/chunked requests — same as
    every sibling route); Zod's 30-row cap + per-field limits bound what
    persists, and the budget is rate-limited to 120/h.
  - Error mapping (mirror generate-quiz/route.ts:338–384): `not_owner`/
    `not_quiz_owner`/`quiz_not_found` → 404 notFound(); `quiz_not_draft` →
    409 notDraft(); `quiz_question_limit_exceeded` → 422; everything else
    (`not_authenticated`, `invalid_mode`, `source_text_too_large`,
    `invalid_title`, `invalid_questions_json`, `invalid_question_fields`) →
    503 internalError + console.error (route-caused/unreachable when the
    route is correct); check-constraint violations (`duplicate_options`,
    `empty_option`, `option_too_long`, `explanation_too_long`,
    `violates check constraint`) map to 400 exactly like the sibling
    questions route — friendlier drift insurance than a 503.
  - Response `200 { added }`; the client refreshes via `router.refresh()`
    (the builder's only state-refresh mechanism — questions are server
    props; there is no client refetch) + toast + close + reset, exactly the
    GenerateFromFileDialog success path (GenerateFromFileDialog.tsx:325–328).
- i18n all preview/warning strings in BOTH `src/messages/en.json` and
  `src/messages/ms.json`, under `lecturer.builder.*` (dialog copy); CI-enforced
  parity via `npm run check:i18n`.

**Tests:**
- Parser unit tests `src/lib/quizzes/import-parser.test.ts`: whitespace/CRLF,
  bidi controls, missing pipes, bad/out-of-range letters (`*E` on 3 options),
  >5 options, duplicate options, true/false variants incl. benar/salah,
  3-option-true stays mcq, asterisk marking (with/without letter, double
  marking trailing+prefix), embedded and trailing pipes, empty cells,
  blank/trailing lines, char-limit violations (prompt >2000, option >500).
- Route test `src/app/api/quizzes/[id]/__tests__/import-route.test.ts` via
  fake-supabase; FIRST extend the fake's `save_quiz_questions` append branch
  — its source_text guard checks `!== undefined` (fake-supabase.ts:449) so an
  explicit NULL currently corrupts existing source_text (diverges from
  0025:164–172); fix to treat NULL/'' as untouched, then add a test asserting
  NULL args leave title/source fields byte-identical.
- Playwright E2E `e2e/e43-bulk-import.spec.ts` paste-and-commit journey,
  lecturer-gated (`test.skip(!LECTURER_INVITE_CODE)`) like
  e23-builder-mutations.spec.ts; `createQuizWithQuestions` ends on the
  builder URL (helpers.ts:165).

---

## AP-2 · Quiz duplication & copy-to-class (MEDIUM-HIGH)

**Problem:** Zero cloning functionality (grep `duplicate|clone|copy_quiz`
across `src/` + `supabase/` returns zero quiz hits). Every semester rebuilds
identical content by hand; class-scoped model (`quizzes.class_id →
classes.lecturer_id` — ownership is CLASS ownership, NOT `quizzes.created_by`
or a `classes.created_by` column, per `src/lib/quizzes/guards.ts:19–21`)
blocks sharing.

**Design sketch**
- Migration `0035_clone_quiz.sql` (next free number after `0034_quiz_shuffle.sql`,
  ═══ banner with Adds:/Depends on: per 0032–0034 style, idempotent):
  single SECURITY DEFINER plpgsql RPC
  `clone_quiz(p_src_quiz_id uuid, p_dest_class_id uuid) returns uuid`,
  one transaction, `set search_path = public`, house guard order
  (`not_authenticated` → `not_quiz_owner` via `is_lecturer_of_quiz` →
  `not_class_owner` via `is_lecturer_of_class` → `class_archived` if dest
  class has archived_at NOT NULL — mirroring the quiz-create precedent
  `src/app/api/classes/[id]/quizzes/route.ts:40–41` → typed `P0001` strings),
  grants `revoke … from public, anon; grant … to authenticated` (0025:190–191
  posture). Takes `pg_advisory_xact_lock(hashtext('quiz_replace:' || src))`
  to serialize against `save_quiz_questions` writers. (Note: `append_question`
  writers use a different lock key — a concurrent append on a draft src can
  race the snapshot read; effect is skew only, no integrity violation, cap
  deliberately unenforced — documented, accepted.)
  - INSERT sets `class_id = p_dest_class_id, created_by = auth.uid(),
    status = 'draft'` (the `quiz_status_transition` trigger, 0004:156–164,
    rejects any INSERT with status ≠ 'draft' — draft/live/closed sources all
    clone with zero special-casing; destination is always draft).
  - Metadata copied: title with " (copy)" suffix trimmed to the 200-char cap,
    mode, time_limit_sec, allow_retake, max_attempts, shuffle_questions,
    auto_reveal_on_complete, source_text (plain text provenance — genuinely
    reusable). NOT copied: source_file_url and sources (AI-regen's tenant
    isolation re-validates `source_file_url` against
    `<uid>/<quizId>/` of the quiz being generated FOR —
    generate-quiz/route.ts:202–231 — so a copied path would be dead weight;
    clone starts with clean file provenance), results_revealed_at,
    opens_at/closes_at (fresh windows stay NULL), created_at (default),
    any session/linkage state (quizzes have no share-code column — those
    live on `student_quizzes`, 0023:40).
  - Questions copied wholesale: order_index, type, prompt, options,
    correct_index, explanation — constraints (2–5 distinct options,
    true_false ⇒ 2, explanation ≤2000) carry by construction and re-validate
    via existing triggers. The 30-cap is deliberately NOT enforced in clone
    (a faithful copy of a quiz that exceeded 30 via the uncapped manual path
    must not fail) — documented deviation from the `save_quiz_questions`
    posture. No UNIQUE index exists on (quiz_id, order_index) (0025 header
    R2) — copy cannot collide.
  - `image_path` copied verbatim by the RPC; the route then duplicates the
    storage objects (below). `resolve_question_image` authorizes by
    quiz/class ownership, never path prefix (0028:94–116), and media-cleanup
    matches exact paths — prefix semantics are safe.
- Route `POST /api/quizzes/[id]/duplicate`: house preamble
  `isUuid → requireQuizOwner(src) → checkSameOrigin →
  rateLimit('quiz-duplicate:<uid>', 30/h — publish/close parity) →
  checkBodyLimit → Zod z.object({ destClassId: uuid }) →
  requireClassOwner(destClassId) (failure = the SAME bare notFound() as src,
  ordered after the src guard so a non-src-owner learns nothing about dest
  classes) → owner.archivedAt → 409 class_archived → clone_quiz RPC →
  storage-copy phase → 201 { quizId }`. Same-class duplicate = `destClassId`
  equal to source class. Route deliberately does NOT call `notDraft()` (live/
  closed sources are allowed; destination is draft by trigger). RPC
  re-validates destination ownership + archived (defense in depth). Route
  sets `export const dynamic = "force-dynamic"`; `params: Promise<{id}>` awaited.
  - Zod failure → invalidBody(firstIssueMessage(...)).
  - Error mapping: `not_quiz_owner`/`quiz_not_found` → 404 notFound();
    `not_class_owner` → 404 notFound() (no oracle); `class_archived` → 409;
    everything else → 503 internalError + console.error.
  - Storage-copy phase (media pattern, ARCHITECTURE §7.12,
    docs/ARCHITECTURE.md:639): question-image DELETE removes the storage
    object (`.../questions/[questionId]/image/route.ts:134–139`), so sharing
    an object would break the clone's render after the src image is deleted.
    Select dst questions (`quiz_id = newId, image_path not null`); per
    question: validate srcPath with `isWellFormedQuestionImagePath`
    (src/lib/media/validation.ts:110–145 — house rule: validate immediately
    before every privileged storage op; the admin client bypasses all
    policy), `admin.storage.from('question-images').copy(srcPath,
    '<uid>/<uuid>.<ext>')` (server-side in-bucket copy, confirmed in
    @supabase/storage-js 2.112.2 StorageFileApi.ts:601), then guarded column
    UPDATE via the USER client (least privilege; RLS re-checks) with
    `.eq('id', dstQid).eq('quiz_id', dstQuizId)`. Failure arms: invalid path
    or copy failure → NULL that dst image_path; copy succeeded + UPDATE
    failed → remove the just-copied object (image-route rollback pattern,
    image/route.ts:77–82) then NULL; any unexpected phase error → NULL
    remaining dst paths (fail-closed). Orphans swept by
    `npm run media:cleanup`. Crash-window residual: until the phase lands,
    dst rows reference src objects (benign same-owner sharing; sign route
    degrades a missing object to a clean 404).
- UI: **no kebab/dropdown-menu primitive exists** in `src/components/ui/` and
  no quiz-index page — quizzes render as rows in
  `src/app/(lecturer)/lecturer/classes/[id]/class-detail-client.tsx` (~589).
  So: a duplicate icon button (lucide `CopyPlus` — `Copy` is already taken by
  join-code copy on that page, class-detail-client.tsx:35) placed in the
  EXISTING right-side action cluster of each row as a sibling of the results
  link (never inside the builder Link; aria-label
  `${t("duplicateBtn")} - ${q.title}` mirroring line 616) + a Duplicate
  button in the builder toolbar. Both open one shared
  `DuplicateQuizDialog` (`src/components/quiz/duplicate-quiz-dialog.tsx`) with
  a destination-class `ui/select`, defaulting to the source's class. The
  hosting server pages (`builder/page.tsx`, `classes/[id]/page.tsx`) each
  gain an owned-classes query (id+name where lecturer_id = user, unarchived)
  passed as props. Success toast (sonner) with a deep-link action to the new
  draft (first `action:` usage in the codebase — new pattern, E2E tolerates
  toast auto-dismiss) + `router.refresh()`.
  - A11y: focus returned to trigger via the builder's handleDialogClose
    pattern (quiz-builder-client.tsx:140–153); errors rendered inside the
    modal with role="alert" (GenerateFromFileDialog.tsx:382–391); per-row
    problems inside aria-live="polite"; aria-labels on icon-only buttons.
  - Dark mode (AX-1): semantic tokens only (bg-card, border-border,
    text-muted-foreground, destructive/10) — no hardcoded hues.
- i18n in BOTH message files: dialog strings → `lecturer.dialogs.*`
  (shared-dialog namespace, edit-question-dialog.tsx:81), class-detail row
  label → `lecturer.classDetail.*`, builder toolbar label →
  `lecturer.builder.*`.

**Tests:**
- Verify harness `scripts/verify-clone-quiz.mjs` (+ `verify:clone` in
  package.json, assertLocalTarget + admin provisioning + cleanup pattern):
  clone fidelity (questions/order/options/explanation/image_path rows
  copied), metadata copy, window/reveal fields NULL, dest always draft,
  title suffix ≤200, ownership guards (cross-lecturer src AND dest denied),
  archived dest denied, live/closed source allowed, clone cap NOT enforced
  (>30 src clones).
- Route test `src/app/api/quizzes/[id]/__tests__/duplicate-route.test.ts`:
  fake-supabase + NEW `vi.mock('@/lib/supabase/admin')` with a
  `storage.from().copy()` stub incl. failure injection for the
  NULL-image_path arm (the existing fake only implements storage.download).
- Playwright `e2e/e44-duplicate-quiz.spec.ts`: create quiz → duplicate within
  class → "(copy)" row appears → open builder → questions present; optional
  copy-to-second-class journey via helpers `createClass` (helpers.ts:125).

---

## AP-3 · Question banks (MED-HIGH, largest in domain — schedule after AP-1/2 prove patterns)

**Problem:** No reusable item library. AI regen is per-question-in-a-quiz
only. Compounding pain each semester.

**Design sketch (minimal copy-on-insert variant first)**
- `question_bank_items` table: lecturer-owned (`created_by`), own Zod
  constraints mirroring question shapes, optional tag/subject text, image_path
  support reusing question-images bucket + `resolve_question_image`-style RPC
  generalized to bank items (visibility: creator only).
- Save-to-bank action from existing draft questions; builder gains "From my
  bank" insert flow — INSERT copies values INTO the quiz's questions
  (copy-on-insert, no live FK reference → zero ripple into grading/secrecy
  machinery later).
- Caps mirror quiz caps (bank size limit ~200).
- Routes: `api/bank/**` standard preamble; ownership joins = creator match.
- Student quizzes intentionally OUT of scope (keep bank lecturer-only v1).

**Tests:** harness probes (RLS deny cross-user, image resolve boundary),
route tests, E2E save-and-reinsert journey.

---

## Pre-flight log

- 2026-08-29: reconciled against main @ ffc1cc3 (three parallel codebase
  audits). Corrections: stripBidiControls is the quiz-title sanitizer, not a
  roster precedent (no CSV/roster parser exists in the codebase; CM-1 is
  still planned); generate-quiz cap block is lines 165–189 (`current >= 30`
  at 176); the manual `append_question` path has NO 30-cap — capacity must be
  computed, never assumed; `save_quiz_questions` append mode passes NULL
  title/source args to avoid mutating sources (0025:149–185); ownership is
  `classes.lecturer_id` (no `classes.created_by` column); quizzes carry no
  share-code column (those live on `student_quizzes`); clone must insert as
  draft (quiz_status_transition trigger 0004:156–164) — so live/closed
  sources clone with zero special-casing; question-image DELETE removes the
  storage object, therefore AP-2 duplicates objects server-side via
  `storage.copy` (available in @supabase/storage-js ^2.112.2) instead of
  sharing paths; no kebab/dropdown-menu UI primitive exists — duplicate
  actions are buttons; next migration will be **0035**; new routes
  `POST /api/quizzes/[id]/import-questions` and `POST /api/quizzes/[id]/duplicate`
  with body-cap override 512 KB for import; verify harness `verify:clone` to
  follow the `scripts/verify-*.mjs` assertLocalTarget + cleanup pattern.
  AP-1/AP-2 are this phase's scope; AP-3 stays parked.
- 2026-08-29: plan reviewed by three independent reviewers (DB/RPC, API/
  security, UI/tests/i18n). Amendments folded in: (1) BLOCKER — import route
  must map Zod camelCase rows to snake_case {correct_index,…} before the RPC
  (aiQuizToRows precedent); (2) duplicate route + clone_quiz refuse archived
  destination classes (quiz-create precedent) → 409 class_archived; (3)
  explicit error-mapping tables for both routes (404/409/422/503; dest
  failure = same bare 404, no oracle); (4) validate srcPath with
  isWellFormedQuestionImagePath before admin storage.copy; column UPDATE via
  the user client; copy-then-UPDATE-failure rolls back the copied object;
  phase fail-closed NULLs remaining dst paths; (5) clone copies source_text
  but NOT source_file_url/sources (AI-regen tenant isolation
  generate-quiz/route.ts:202–231 would reject the copied path anyway) —
  "enables AI regen" claim dropped; (6) clone INSERT pins
  created_by=auth.uid()/status='draft' and leaves created_at to defaults;
  (7) builder refresh is router.refresh() (no client refetch exists) —
  import success path mirrors GenerateFromFileDialog (toast → refresh →
  close → reset), import responds 200 {added}, duplicate 201 {quizId}; (8)
  fake-supabase append-branch NULL-source bug (fake-supabase.ts:449 checks
  `!== undefined`) must be fixed and covered by a NULL-args-untouched test;
  duplicate route tests need a new vi.mock('@/lib/supabase/admin') storage
  seam with copy-failure injection; (9) parser: pipe-in-text is an explicit
  per-row problem (no escaping), one trailing empty cell tolerated, original
  1-based line numbers, closed-enum problem keys via literal t() calls only;
  (10) rate budgets pinned (import 120/h, duplicate 30/h); Zod wrapper
  z.object({questions: array.min(1).max(30)}); (11) i18n namespaces corrected
  (lecturer.dialogs.* / lecturer.classDetail.* / lecturer.builder.*);
  (12) duplicate icon = CopyPlus (Copy taken by join-code), placed in the
  existing row action cluster, never inside the Link; hosting pages gain an
  owned-classes query; Import button draft-gated beside Generate; preview
  uses card rows not tables; a11y (role=alert, aria-live, focus return) and
  dark-mode semantic tokens pinned. Reviewers confirmed: trigger exposure on
  the clone path is exactly quiz_status_transition (draft-only INSERT arm),
  NULL-args append leaves the quizzes row byte-identical, no UNIQUE index
  collisions possible, migration/RPC/grant style matches 0025/0034, preamble
  order matches the house precedent.

## Implementation log

### 2026-08-29 — AP-1 + AP-2 shipped (AP-3 stays parked)

**Migrations**
- `0035_clone_quiz.sql` — SECURITY DEFINER `clone_quiz(p_src_quiz_id uuid,
  p_dest_class_id uuid) returns uuid`. House guard order
  (`not_authenticated` → `not_quiz_owner` → `not_class_owner` →
  `class_archived`), no-oracle (ownership before existence), advisory lock
  `hashtext('quiz_replace:'||src)`, " (copy)" title suffix trimmed into the
  200-char CHECK, verbatim `image_path` copy, grants
  revoke public/anon → grant authenticated. `npm run gen:types` run
  (`clone_quiz` in `src/lib/types/database.ts`).

**New routes**
- `POST /api/quizzes/[id]/import-questions` — full house preamble, body cap
  512 KB, Zod `z.object({ questions: z.array(QuestionInputSchema).min(1).max(30) })`,
  head-count pre-check (≥30 → 422; rows > remaining → 400 with remaining
  count), camelCase→snake_case row mapping, RPC append with NULL provenance
  args; rate `quiz-import:<uid>` 120/h. Error arms: 404 / 409 (incl. RPC
  `questions_locked_quiz_not_draft` race arm) / 422 / 400 check-constraint
  drift / 503 drift + head-count failure.
- `POST /api/quizzes/[id]/duplicate` — full house preamble (no `notDraft()` —
  live/closed sources allowed), `requireClassOwner` + archived → 409, RPC,
  then the storage-copy phase (`isWellFormedQuestionImagePath` before admin
  `storage.copy`, guarded USER-client column UPDATE, copy-then-UPDATE-failure
  rollback awaited, unexpected phase error → fail-closed NULL of every clone
  image_path); rate `quiz-duplicate:<uid>` 30/h. Response `201 {quizId}`.

**New lib/UI**
- `src/lib/quizzes/import-parser.ts` — total, never-throwing parser; closed
  problem enum; position- vs letter-marked options; true/false words incl.
  benar/salah; delimiter-required letter form (`*always` cannot corrupt).
- `src/components/quiz/bulk-import-dialog.tsx` (draft-gated Import button in
  the builder toolbar action cluster; live preview card rows; over-cap
  `quizFull` short-circuit; client 512 KB file guard;
  `data-testid="bulk-import-file-input"`).
- `src/components/quiz/duplicate-quiz-dialog.tsx` (builder toolbar + class-
  detail row action; Base-UI Select with function-child label render — the
  raw-UUID default was a real bug caught in review; default falls back to the
  first owned class when the source class is archived; sonner toast with the
  codebase's first `action:` deep-link; select disabled while duplicating).
- Wiring: builder toolbar (Generate/Import/Duplicate grouped right), class-
  detail quiz-row `CopyPlus` button (sibling of the results link, never
  inside the Link), owned-classes queries in both server pages.
- i18n: `lecturer.builder.importQuestions/duplicateQuiz/duplicateQuizAria`,
  `lecturer.builder.import.*` (17 keys incl. closed problem enum),
  `lecturer.dialogs.duplicate.*` (12 keys), `lecturer.classDetail.duplicateBtn`
  — en+ms in parity (check:i18n 970/970).

**Tests**
- `src/lib/quizzes/import-parser.test.ts` — 36 tests (U-AP1-1..34).
- `src/app/api/quizzes/[id]/__tests__/import-route.test.ts` — 24 tests
  (U-AP1-R1..R24, incl. 413, invalid_json, every RPC error arm, 30/29+1
  boundaries, direct fake-cap lockstep probe).
- `src/app/api/quizzes/[id]/__tests__/duplicate-route.test.ts` — 24 tests
  (U-AP2-R1..R24, incl. admin-storage mock with copy-failure/throw
  injection, select-error fail-closed arm, archived 409 at both layers).
- fake-supabase.ts: `.not()` seam, table-scoped `selectError` seam,
  `_cloneQuiz` stub, append-branch NULL-source fix (was corrupting
  source_text on explicit NULL — diverged from 0025:164–185).
- `scripts/verify-clone-quiz.mjs` + `npm run verify:clone` — 14 checks
  (AP2-D1–D11: fidelity, metadata, fresh state, live/closed sources,
  ownership both ways, archived dest, 31-question cap-free clone, 200-char
  title truncation, anon grant denial).
- E2E `e2e/e43-bulk-import.spec.ts` (paste/preview/commit, atomic reject,
  reload persistence, file-upload path) and `e2e/e44-duplicate-quiz.spec.ts`
  (duplicate-in-class, duplicate-with-image incl. real storage copy + signed
  URL + naturalWidth render on the clone, copy-to-class via row action,
  no-second-copy invariant).

**Deviations from the plan text (all deliberate)**
1. Check-constraint RPC errors map to 400 (questions-route parity), not the
   plan's original 503 — plan amended to ratify.
2. The 512 KB gate is content-length-conditional (house `checkBodyLimit`
   posture shared by every sibling route); Zod bounds + 120/h rate limit
   bound what persists — plan amended to ratify.
3. The duplicate dialog defaults AWAY from an archived source class (first
   owned unarchived class) — the server would 409 anyway; the source class
   is only offered when it is selectable.
4. "3+-option line ending in `true` stays mcq" is implemented as: a tf-word
   answer cell WITH a marked option cell falls through to mcq (re-including
   the tf cell as an option); a tf-word cell with UNMARKED option cells is
   `tooManyCells` (mistyped-mcq guidance).
5. Focus return for both new dialogs relies on Base UI's default
   trigger-restore (verified `returnFocus` default), not the plan's pinned
   `handleDialogClose` pattern (remains EditQuizDialog-specific).
6. Additions beyond plan: `quizFull` over-cap short-circuit, `fileTooLarge`
   client guard, select-disabled-while-duplicating, over-cap pastes folding
   into ONE `tooManyRows` problem, import route's
   `questions_locked_quiz_not_draft` → 409 arm, duplicate route's non-string
   RPC id → 503 arm.
7. The import grammar has no explanation cell (v1 keeps rows short) — the
   plan's explanation-constraint mention applies to option/prompt lengths.
8. Clone cap: 30 NOT enforced (per plan), but the verify harness pins the
   behavior positively (AP2-D10) rather than merely documenting it.

**Doc updates made with this change**: ARCHITECTURE.md §7.2 (import-questions
route + duplicate route blocks), §7.4 (duplicate), §7.12 (image replication
during duplication), §9 (verify:clone in the harness map); docs/README.md
(migration range 0001…0035, verify:clone command, partial-shipments list).
Move-out (Step 3) stays pending until AP-3 ships.

**Review process**: plan reconciled by 3 parallel codebase audits, reviewed by
3 independent reviewers (DB/RPC, API/security, UI/tests/i18n), implemented,
then audited in 3 rounds by 6 auditors (DB/security; API/route-tests;
UI/i18n/a11y; test-adequacy; specialized E2E-gap; completeness). Real bugs
caught and fixed in review/audit: parser `*always` corruption, SelectValue
raw-UUID render, fake append NULL-source corruption, e43/e44 selector
blockers, storage-phase fail-closed gaps.

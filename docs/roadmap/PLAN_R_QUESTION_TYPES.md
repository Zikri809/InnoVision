# Roadmap Plan — Question Types & Answering Semantics

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec — EXCEPT
> **QT-3, which SHIPPED 2026-08-29 (migration 0034)**; its authoritative
> record is the Implementation log below (design section updated to match).
>
> Domain: expanding what a question IS and how students answer it. Highest
> blast-radius domain: touches DB CHECK enums, grading RPCs, secrecy views,
> gesture layer, and AI-generation contracts. Nothing here should start
> before QT-3 (shuffling, deliberately ordered cheapest-first).
>
> Key constraint inherited from architecture: gesture answering maps finger
> count → option index; any type that breaks that mapping needs explicit
> gesture-semantics decisions, not just schema.

---

## QT-1 · Multi-select questions (HIGH, FULL subsystem — schedule last)

**Problem:** Only MCQ single-correct + true/false exist. Multi-select declared
non-goal in PLAN_MATRIC_EXCEL_EXPORT.md (no design exists since). Most common
missing type across mainstream tools.

**Design sketch (inventory before coding — ALL of this moves together)**
- Schema: question `type` enum gains `'multi_select'`; `options[]` unchanged;
  NEW `correct_indices integer[]` (or jsonb array) replacing `correct_index`
  meaning for that type. Column secrecy: revoke correct_indices identically
  to correct_index in migration 0012 lineage; barrier views add the field to
  their omission lists.
- Grading: exact-set comparison (all-or-nothing — no partial credit v1;
  keeps `is_correct boolean` intact so submit_session/scoring/export/export
  consumers untouched).
- Order-insensitive set equality; validate indices within options bounds in
  Zod mirror + DB CHECK (sorted+distinct constraint).
- Answer storage: `selected_index` column inadequate → either widen to
  `selected jsonb` (migration touching session_answers secrecy grants) or
  companion column `selected_indices` — DECIDE at pre-flight, prefer
  companion column to leave single-select fast-path byte-identical.
- RPC `answer_question`: validate EVERY selected index against THIS
  question's options (current design already refuses clean-400 prefetch —
  preserve).
- Player: multi-select checkbox-like option cards (aria-pressed semantics;
  hold-to-toggle then explicit commit button in gesture mode? RECOMMEND:
  restrict multi-select answering to CLICK-first input only v1 — gesture
  finger-map has no natural multi semantics; disable gesture layer for these
  questions with explanatory chip).
- Views affected (from ARCHITECTURE §5): student_question_view,
  student_quiz_player_question_view, student_results breakdown, lecturer
  export model sheets.
- AI generation: extend AiQuizSchema contract + prompt steering
  (`lib/ai/quiz-prompt.ts`) with explicit multi_select format + retry pipeline
  (normalizeOptions handling) behind same budget guards.

**Tests:** full stack — DB CHECK probes, RPC answer validation matrix,
secrecy probes (student cannot select correct_indices), export rows,
E2E multi-select journey incl. wrong-answer feedback, verify harness extension.

---

## QT-2 · Short-answer / typed-text questions (MEDIUM)

**Problem:** No free-text graded types.

**Design sketch**
- New type `'short_answer'`; `options` CHECK relaxed for this type only
  (currently mandatory 2–5) — store expected-normalized answer(s) in a
  dedicated column instead (`accepted_answers text[]`, ≤10, each ≤200 chars).
- Grading in RPC: normalize (trim/casefold/fold whitespace/NFC) then exact
  membership match. No fuzzy matching v1.
- Storage: session_answers gains `answer_text` (≤200 chars) — secrecy status:
  NOT secret (it's the student's own text) but review views expose only
  post-reveal for assessment, matching per-question review policy.
- Input conflicts with gesture play screen: keyboard input element replaces
  option cards when type demands it; skip gesture overlay for these
  questions (input focus steals tracker anyway). Tablet/mobile: text input
  fine.
- AI generation: map explicit short_answer extraction rules into prompt
  contract with accepted-answer paraphrase suggestions (mark low-confidence).

**Tests:** normalization unit matrix, RPC grading probes, secrecy/order
reviews, E2E typing journey.

---

## QT-3 · Per-student shuffling / randomization (MEDIUM, cheap — DO FIRST)

**Problem:** Fixed order leaks answers across shoulders/screenshares in
classroom sittings; no randomization anywhere.

**Design (reconciled against the codebase — see Pre-flight log)**

One quiz-level flag controls BOTH question order and option order v1 (the
translation machinery makes option shuffle nearly free, and option position
leaks as much as question position to a shoulder-surfer).

- **Scope: session-based play only** — `/play/[sessionId]` (assessment AND
  in-class practice; both run on `quiz_sessions`). Student practice quizzes
  (own + shared via `/s/[code]`) are OUT of scope v1: they have no
  `quiz_sessions` row to seed from, and the play flow is stateless
  (`answer_student_question` performs zero writes). Retakes spawn a NEW
  session id (QC-4) → each attempt gets a fresh permutation (feature).
- **Schema (migration 0034):**
  - `alter table public.quizzes add column if not exists shuffle_questions
    boolean not null default false;`
  - Add `shuffle_questions` to the DRAFT-FREEZE column set of
    `quiz_status_transition` (redefine the trigger in 0034, following the
    documentation convention at 0030:465-467 / 0032:686-690). Rationale
    (corrected per security review): persisted answers CANNOT desync (they
    are canonical and pre-graded; translations are plan-relative), but a
    mid-flight flip breaks presented-space client snapshots (two tabs,
    resume-after-reload straddling the flip), assessment fairness (students
    answering different orderings of the same instrument), and the draft
    freeze matches the mode/time_limit precedent (presentation semantics,
    not management knobs). Freeze comment in 0034 must state THIS rationale.
  - Redefine `student_quiz_view` and `student_closed_revealed_quiz_view`
    projections to include `shuffle_questions` — the play page reads quiz
    metadata from either (live path vs closed+revealed fallback at
    `src/app/play/[sessionId]/page.tsx:161-174`). Additive column; all
    consumers select explicit columns; no verify-script projection probes
    break (scripts/verify-*.mjs all use explicit selects). NOTE: `create or
    replace view` can only APPEND columns — put `shuffle_questions` last in
    both projections.
  - `npm run gen:types` regenerates `src/lib/types/database.ts`.
- **Pure module `src/lib/sessions/shuffle.ts`** — importable from client AND
  server (NO `server-only` import; single implementation = single source of
  truth, replacing the sketch's vague "both sides agree"):
  - seed string → FNV-1a 32-bit → mulberry32 PRNG → Fisher-Yates. Pure
    integer ops (Math.imul/shifts) — deterministic across processes/platforms;
  - `shufflePlan(sessionId, scope, n)` → permutation of [0..n-1]; scopes:
    `"questions"` for question order, questionId (+suffix) for each option
    array, so orders are independent;
  - `presentedToCanonical(i, plan)` / `canonicalToPresented(i, plan)`;
  - `applyQuestionShuffle(questions, planFn)` envelope transform and a
    breakdown transform for results rows.
- **Read-time application — play page RSC** (`src/app/play/[sessionId]/page.tsx`),
  ONLY when `quiz.shuffle_questions`:
  - add `shuffle_questions` to BOTH explicit select lists on the page (line
    ~163 primary `student_quiz_view` + line ~171 `student_closed_revealed_quiz_view`
    fallback) — redefining the views alone is NOT enough; a missed select
    leaves the flag `undefined` → falsy → feature silently dead (caught by
    the positive E2E ordering assertion, not by the "same twice" test);
  - permute the fetched `student_question_view` rows: question array order
    AND `options` within each question;
  - translate resume `initialAnswers[].selectedIndex` canonical→presented
    (stored values are canonical; rendering is presented-space —
    play-client.tsx:121-131 seeds answers directly from the stored index);
  - compute `initialIndex` via `firstUnansweredIndex` on the PERMUTED array
    (timer.ts:55-61; ID-keyed findIndex — correct semantics = first
    unanswered in the student's presented order);
  - permute `student_results` breakdown rows + per-row
    `options`/`selected_index`/`correct_index` for EndScreen, and renumber
    the display position (EndScreen renders `order_index + 1` as the number,
    end-screen.tsx:145 — override with presented position). Nothing stored;
    re-derived from the same session seed on every load. NULL
    `selected_index` (unanswered rows — reachable via time-up /
    `quiz_window_closed` submits) must pass through as null, never NaN.
- **Client translation — play-client.tsx**, only when a `shuffled` prop is
  true (client recomputes plans via the shared module; it already knows
  sessionId + question.id + option count):
  - `answer()`: translate outgoing `selectedIndex` presented→canonical
    BEFORE the POST — the wire stays canonical, so `/api/sessions/[id]/answer`
    and RPC `answer_question` are UNTOUCHED (bounds validation, grading,
    error taxonomy, keyless assessment ack all unchanged);
  - practice feedback: incoming `correctIndex` (canonical) → presented for
    highlight;
  - 409 `already_answered` replay keeps storing the client's own presented
    index (in-memory state is presented-space; consistent).
  - **Trust note (documented residual risk):** translation happens
    client-side but is NOT a security boundary. The RPC still validates the
    canonical index against that question's option count and grades whatever
    arrives; a hostile client gains nothing over today (it can already send
    arbitrary canonical indices, and assessment acks stay keyless
    pre-reveal). The permutation is derived from ids the client already
    knows — this is shoulder-surfing obfuscation, not secrecy.
- **Gesture layer: UNTOUCHED.** Finger N selects presented slot N-1
  (`mapFingersToOption` returns fingerCount-1); the finger badges,
  hold-progress and palm-next rule all operate on presented slots; the
  translation happens downstream in `answer()`. Face pipeline is
  question-index agnostic (verify payloads carry no option data).
- **Lecturer surfaces: UNTOUCHED and stay CANONICAL.** Lecturer per-session
  review, `student_results` RPC internals, exports (sorted by `order_index`),
  gradebook — one answer key must line up across all students. Only the
  student's own EndScreen view is presented-space.
- **Toggle plumbing (full surface — every touchpoint named per review):**
  - Zod: `shuffleQuestions: z.boolean().nullable().optional()` in
    `QuizFieldsSchema` — MIRRORING the `allowRetake` precedent exactly
    (`src/lib/quizzes/validation.ts:156`); a bare required `z.boolean()`
    would 400 every existing create payload that omits it.
    `UpdateQuizSchema` picks it up via `.partial()`;
  - create route `POST /api/classes/[id]/quizzes`: map
    `shuffle_questions: shuffleQuestions ?? false` for BOTH modes — do NOT
    copy the `mode === "assessment"` conditional used for `allow_retake`
    (route.ts:80; shuffle applies to practice too);
  - PATCH route plumbing — five touchpoints, not just Zod
    (`src/app/api/quizzes/[id]/route.ts` + `src/lib/quizzes/updates.ts`):
    (1) `QuizMetadataPatch` type (updates.ts:3-11); (2) `buildQuizUpdates`
    column whitelist (updates.ts:62-72) — without it the field is silently
    DROPPED; (3) `hasNonWindowFields` classification (updates.ts:37-43) —
    shuffle is FROZEN metadata, so a non-draft PATCH carrying it must hit
    the blanket `quiz_not_draft_edit` 409 (do NOT add to
    WINDOW_PATCH_KEYS/RETAKE_PATCH_KEYS); (4) the "No editable fields
    provided" guard (route.ts:73-83) — a shuffle-only PATCH body must not
    400 as empty; (5) response select lists (create route + PATCH
    route.ts:101);
  - UI: checkbox in the create form (`class-detail-client.tsx`, i18n
    namespace `lecturer.classDetail`) + edit dialog (`edit-quiz-dialog.tsx`,
    namespace **`lecturer.dialogs`** — NOT quizEditor; retake keys already
    live there, dialog.tsx:55), dirty-diff payload; the builder page's
    explicit quiz select + `QuizInfo` type must carry the column for the
    dialog's dirty-diff to see it (`builder/page.tsx:46`);
  - AI generate route: calls `save_quiz_questions` on an EXISTING draft (no
    quiz insert there) — column default false applies, no change;
  - e2e helper: `createQuizWithQuestions` gains an OPTIONAL `shuffle` opt
    (check the checkbox before create, mirroring `configureRetakesOnCreate`)
    — optional ⇒ zero existing callers break.
- **Stability invariant (state in ARCHITECTURE.md too):** the
  `(sessionId, questionId, n)` permutation is only stable because question
  rows/options are draft-frozen (0025 `quiz_not_draft`; reorder/AI
  regenerate draft-only). The `"questions"` scope is POSITIONAL — any future
  live-question editor or reorder would desync persisted canonical answers
  from the presented mapping on reload. Document as a constraint, not an
  accident.
- **Determinism contract (pinned by tests):** same sessionId ⇒ same
  permutation everywhere (golden vectors); bijection; distribution sanity
  across seeds; presented↔canonical round-trip; n edges (options 2..5 per
  DB CHECK, questions 3..30 per save caps; 1-question quizzes skip question
  shuffle trivially); true/false pair shuffle harmless.

**Tests:**
- Unit `src/lib/sessions/shuffle.test.ts` (colocated): golden-vector
  determinism (fixed seeds ⇒ exact permutations); bijectivity; ROUND-TRIP
  incl. null pass-through (`presentedToCanonical(null)` stays null —
  unanswered breakdown rows); SCOPE-INDEPENDENCE sweep (option plans for
  different question ids / scope strings differ across a seed sweep);
  permutation-uniformity sweep (all n! orders occur across seeds, n ≤ 4);
  n edges (n=1 identity, n=2 swap, manual 1-2-question quizzes are legal —
  the 3..30 cap is AI-generation only); envelope transform; breakdown
  transform with null rows. Coverage threshold entry in `vitest.config.ts`
  (lib bar 80/80/80/70, like timer.ts/validation.ts).
- Route tests (fake-supabase): create payload WITHOUT the field still
  succeeds (defaults false); create with `shuffleQuestions: true` persists
  `shuffle_questions: true`; PATCH on draft applies it; PATCH
  `{shuffleQuestions}` on a LIVE quiz → 409 `quiz_not_draft_edit` (pins the
  `hasNonWindowFields` classification — the DB trigger would mask a miss
  behind the same 409, so assert the route-level gate too); PATCH response
  echoes the column. Add `shuffle_questions: false` to the fake-supabase
  default quiz row (fake-supabase.ts seed helper) so update-payload asserts
  see it.
- `verify:quizzes` block `QT3-D*` (house style: createUser/promoteLecturer/
  asUser provisioning, `record(name, pass, detail)`, createdQuizIds cleanup):
  default false; draft flip allowed; flip on live quiz REJECTED
  (`quiz_not_draft_edit`, MED-4 pattern); flag exposed via
  `student_quiz_view` (D23 pattern) AND `student_closed_revealed_quiz_view`
  (QC-2 pattern — quiz must be closed + results_revealed_at set via admin
  first); base-table access still denied (RLS, D23 pattern).
- E2E `e42-shuffle.spec.ts` (UNTIMED PRACTICE mode like e4 — no assessment
  gate on reload; practice feedback fails LOUDLY on a broken translation):
  (1) toggle in create form persists (service-role probe of
  `quizzes.shuffle_questions`, e37 probe pattern); (2) POSITIVE ordering
  assertion — import the shared shuffle module in the spec, parse the
  sessionId from the URL, recompute the expected permutation, and assert the
  rendered first prompt + ordered (letter,text) accessible names EQUAL the
  computed plan (guards the select-list edit AND page↔client agreement;
  the weaker "same order twice" test passes in a dead-feature world);
  (3) DETERMINISTIC translation probe — answer by unique option TEXT, then
  with the service-role client compare persisted
  `session_answers.selected_index` against the canonical index of the
  clicked text (admin reads `questions.options` directly) → P(false pass)=0,
  no probability budget needed; (4) highlights: practice `aria-pressed`
  on freshly answered questions ONLY (seeded/resumed answers suppress
  practice highlights, question-card.tsx:88) + EndScreen
  `li.filter({ hasText: optionText })` contains ✓ (end-screen.tsx:189);
  (5) every created prompt appears exactly once (HUD counts).
- **Existing-E2E order-independence audit (done at pre-flight):** no existing
  spec enables shuffle (new feature, default false). Position-letter
  assertions (e3, e18), finger-index mapping (e8, e9, e11 selectedIndex
  assertions), and question-sequence assertions (e4, e10, e13, e37, e39, e40
  via `completeQuiz`) all run with shuffle off — unaffected.
  `completeQuiz` matches options by TEXT (e2e/helpers.ts:712-714) —
  shuffle-safe by construction. QT3's own spec is the only consumer.
  e15 edit-dialog label assertions are substring-safe against a new
  checkbox label.

**Docs to touch in the same PR:** ARCHITECTURE.md §5 data model (quizzes
column list), §7.5 (envelope permutation note + the draft-frozen stability
invariant), §9 Testing map (record the QT3-D range, SQ-D1–D9 precedent);
docs/TESTING.md traceability row; roadmap README progress board
(QUESTION_TYPES → partial) once shipped.

---

## QT-4 · Audio/video prompts & sections (LOW — defer)

Noted for completeness; follows the §7.12 image pattern for storage/signing,
but transcoding cost (COSTS.md impact) + player complexity → blocked pending
real demand. Sections additionally cosmetic at ≤30 questions/quiz. No design
work until promoted.

## Pre-flight log

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- 2026-08-29 (QT-3): reconciled against `6066f72`; migration will be **0034**.
  Verified: envelope loader = play page RSC reading `student_question_view`
  ordered by `order_index, created_at` (`src/app/play/[sessionId]/page.tsx:175-180`);
  there is NO JSON questions API — `/api/sessions/[id]` envelope is
  session-status only. Options are a `text[]` column — array order IS
  presentation order (no per-option position table); CHECK cardinality 2..5.
  RPC `answer_question` (0030:280-423) grades the submitted index directly
  against canonical `correct_index` and stays untouched (translation happens
  before the POST). Resume seeds answers from stored canonical
  `selected_index` rendered against presented order — must be translated at
  envelope build. Students CANNOT read the base `quizzes` table (RLS,
  owner-only SELECT), so a server-side flag fetch on the answer path would
  need new view plumbing — chose client-side translation via a shared pure
  module instead (see trust note). Edit-freeze trigger (`quiz_status_transition`,
  latest body 0032:~685) must absorb `shuffle_questions` into the frozen set.
  `student_quiz_view` + `student_closed_revealed_quiz_view` must both expose
  the flag (play page falls back to the closed view for reveal review).
  Student practice quizzes excluded (no session id to seed; stateless RPC).
  Retake (QC-4) spawns a new session id → fresh permutation per attempt.
  Gesture/face subsystems verified order-agnostic given pre-POST translation
  (finger N = presented slot N-1; verify payloads carry no option data).
  Existing E2E order-independence audit complete (see Tests). Local Supabase
  healthy — gen:types + verify harnesses runnable.
- 2026-08-29 (QT-3): plan reviewed by 3 independent reviewers (data-flow,
  security, test-strategy) — no blockers, findings folded in: play-page
  select lists named as explicit edit points; PATCH plumbing expanded to all
  five touchpoints (updates.ts whitelist + hasNonWindowFields + empty-guard
  + response selects) with a route test pinning live-quiz 409; Zod shape
  corrected to `.nullable().optional()` (bare required would 400 existing
  create payloads); freeze rationale corrected (persisted answers can't
  desync — real reasons are presented-space snapshots + fairness); edit
  dialog namespace corrected to `lecturer.dialogs`; AI-route mechanism
  corrected (save_quiz_questions on existing draft, no quiz insert); create
  route must not copy the assessment-only allow_retake conditional; stability
  invariant (draft-frozen question sets make the positional seed stable)
  documented; E2E upgraded to POSITIVE permutation assertion + deterministic
  service-role translation probe (replaces probability budget); unit plan
  gains scope-independence sweep, uniformity sweep, n=1/2 edges, null
  pass-through; verify/e2e house-style specifics (view append-last column,
  e42 untimed practice mode, helper `shuffle` opt, fake-supabase default
  row, builder select + QuizInfo for dirty-diff); docs list gains
  ARCHITECTURE §9 + docs/TESTING.md.
- 2026-08-29 (QT-3): **Audit round 1** (implementation-correctness + security/
  DB auditors): 0 blockers, 0 majors. Fixed: closed+revealed fallback now
  derives the presented row order from the breakdown rows themselves (the
  question projection is live-only and empty on that path); e42 asserts the
  breakdown rows render in the DERIVED presented order (canonical rows are
  self-consistent, so ✓-text assertions alone cannot catch a skipped
  transform); the identity-permutation teeth check was replaced by purely
  plan-relative assertions (identity is a legitimate outcome that passes
  everything). The `shuffleQuestions: null` PATCH asymmetry was investigated
  against live PostgREST and matches the pre-existing allowRetake
  null-handling — accepted, not a finding.
- 2026-08-29 (QT-3): **Audit round 2** (E2E-gap specialist + fresh-eyes
  adversarial reviewer): 0 blockers, 0 majors. Fixed: e42's mid-test
  `test.skip(identity)` was removing the deterministic probes on ~0.7% of
  runs — restructured so all probes run unconditionally; the shuffled
  RESUME journey (all-answered reload → presented slot aria-pressed) and the
  shuffled ASSESSMENT journey (keyless acks → persisted-canonical probe)
  were added as e42 tests 2 and 3; ms.json "Rambak" → "Rombak" (×2) +
  helper rewording; stray blank line in edit-quiz-dialog. Confirmed safe:
  e15 dialog assertions, full `playwright --list` parse (124 tests/52
  files), e31 ms-locale sweep, e3/e18 letter-pinned specs (shuffle off),
  two-tab/nonce-rotation/reset edge cases.

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

### QT-3 · Per-student shuffling — SHIPPED 2026-08-29 (migration 0034)

Shipped as designed, with these concrete surfaces:

- **Migration `0034_quiz_shuffle.sql`:** `quizzes.shuffle_questions boolean
  not null default false`; `student_quiz_view` + `student_closed_revealed_
  quiz_view` redefined with the flag appended last; `quiz_status_transition`
  full 0032 carry-forward with `shuffle_questions` in the frozen set.
  `gen:types` regenerated.
- **Pure module `src/lib/sessions/shuffle.ts`:** FNV-1a → mulberry32 →
  Fisher-Yates; `shufflePlan` / `toCanonical` / `toPresented` /
  `applyQuestionShuffle` / `applyBreakdownShuffle`; `QUESTION_ORDER_SCOPE`
  + `optionScope(questionId)`. Client-importable (no server-only).
- **Play page RSC:** both select lists gained `shuffle_questions`;
  envelope permutation; resume `selected_index` canonical→presented;
  `firstUnansweredIndex` over the presented array; breakdown transform
  (row order + option order + index translation + presented renumbering).
- **PlayClient:** `shuffled` prop; outgoing POST index presented→canonical;
  incoming practice `correctIndex` canonical→presented. Route + RPC
  untouched (wire stays canonical).
- **Toggle plumbing:** `QuizFieldsSchema.shuffleQuestions`
  (`.nullable().optional()`); `QuizMetadataPatch`/`QuizUpdateColumns`/
  `buildQuizUpdates`/`hasNonWindowFields`; create route maps
  `shuffle_questions: shuffleQuestions ?? false` (both modes); PATCH route
  destructure + empty-guard + response select; create-form checkbox
  (`lecturer.classDetail`) + edit-dialog checkbox locked when
  `metadataLocked` (`lecturer.dialogs`); `QuizInfo` + builder page select.
- **Tests:** `shuffle.test.ts` U-QT3-1..18 (18) + coverage threshold;
  route tests QT3-1..5 in `quizzes-routes.test.ts`; `verify:quizzes`
  QT3-D1..D6 (75/75 checks pass); `e2e/e42-shuffle.spec.ts` — THREE tests,
  all passing: (a) practice journey with a POSITIVE ordering assertion
  (spec re-derives the plan from the session id and asserts the rendered
  order EQUALS it — a dead feature fails; every assertion is plan-relative,
  so the legitimate identity permutation passes), reload determinism,
  full-score answer-by-text, deterministic persisted-canonical probe, and
  breakdown rows asserted in the DERIVED presented order; (b) RESUME
  translation: all-answered reload renders the presented slot of the
  canonical answer with aria-pressed (the seeded-highlight journey); (c)
  ASSESSMENT with shuffle on: keyless acks still persist canonical indices
  (service-role probe). Helper `createQuizWithQuestions` gained an optional
  `shuffle` opt.
- **Docs:** ARCHITECTURE §5/§7.5/§9; TESTING.md §2.8/§5/§8.
- **Deviations from the original sketch:** (1) the sketch suggested
  translation could live "in the player layer" server-side — final design
  translates client-side via the shared pure module after review showed a
  server-side translation on the answer path would need new student-readable
  quiz-flag plumbing (students cannot read base `quizzes`); (2) option
  shuffle shipped under the same flag as question shuffle (sketch marked it
  "optional"); (3) freeze rationale corrected per review (persisted answers
  cannot desync — see 0034 comment).

# Roadmap Plan — Question Types & Answering Semantics

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec — EXCEPT
> **QT-3, which SHIPPED 2026-08-29 (migration 0034)** and **QT-1, which
> SHIPPED 2026-08-30 (migrations 0036 + 0037)**; their authoritative
> records are the Implementation logs below (design sections updated to
> match).
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

**Design (reconciled against the codebase at `50bfa19` — see Pre-flight log)**

Scope v1: **lecturer quizzes only** (session play — practice AND assessment).
Student-authored quizzes (the `student_quiz_questions` domain:
`/play/student/[quizId]` self-play and `/s/[code]` shared play) are OUT of
scope v1: `student_quiz_questions` gains an explicit `check (type <>
'multi_select')` guard so the exclusion is enforced by the DB, not
convention; the student editor (auto-derives mcq/true_false via
`isTrueFalsePair`, editor-client.tsx:227) and the stateless
`answer_student_question` RPC (0023:445-467) stay untouched. Same scoping
precedent as QT-3's student-practice exclusion.

- **Migrations 0036 + 0037 (SPLIT REQUIRED):** `alter type
  public.question_type add value if not exists 'multi_select'` (house style,
  0030:36) cannot have the new value
  USED in the same transaction ("unsafe use of new value" — Supabase runs
  each migration file in one transaction) →
  `0036_add_multi_select_type.sql` carries ONLY the enum growth;
  `0037_multi_select_questions.sql` carries columns/CHECKs/triggers/RPCs/
  views. `npm run gen:types` regenerates `src/lib/types/database.ts`
  (Enums.question_type + new columns). An intermediate commit of 0036 +
  regenerated types is GREEN: the widened enum breaks no consumer (all
  client/player types are local literal unions; DB writes flow through
  Zod-narrowed values; typecheck gates the rest) — keep the 0036 diff
  reviewable on its own.
- **Schema (0037):**
  - `questions.correct_indices int[]` nullable. `correct_index` DROPS NOT
    NULL — multi rows store `correct_index = null` (honest schema; the
    compiler forces every consumer to branch, instead of a silent sentinel).
    Mutual-exclusivity CHECKs: `check (type = 'multi_select' or correct_index
    is not null)` and `check (type <> 'multi_select' or (correct_index is
    null and correct_indices is not null))`. The existing bounds CHECK
    (0004:58) keeps applying to non-multi rows (NULL passes CHECKs).
  - `correct_indices` validity — for multi rows: not null, `1 ..
    cardinality(options)`, every element in `[0, cardinality(options))`,
    sorted ascending, distinct; for non-multi rows: must be null. Enforced by
    trigger `questions_correct_indices_guard` following the
    `questions_options_distinct` trigger pattern (0004:295-327) — a row CHECK
    cannot express per-element bounds against another column without an
    IMMUTABLE helper. Event list is `before insert or update of type,
    options, correct_index, correct_indices` — NOT the options trigger's
    `update of options` verbatim: an options-shrink UPDATE that never touches
    the array must still re-validate, and type flips change which shape is
    legal. Error string pinned as `invalid_correct_indices` (P0001, house
    style) — mapped in every authoring route's error map (Routes bullet
    below).
  - `session_answers.selected_indices int[]` — companion column (sketch's
    preference CONFIRMED: single-select fast path stays byte-identical; multi
    rows store the canonical sorted set with `selected_index` null).
    `check (selected_indices is null or cardinality(selected_indices) between
    1 and 5)`. Per-element bounds + normalization (sort+distinct) enforced in
    the RPC, mirroring how `selected_index`'s upper bound lives only in the
    RPC today (0008:66 is lower-bound-only by precedent). NOT a secret (it is
    the student's own answer); the 0012 column-revokes
    (`session_answers.is_correct`, `quiz_sessions.score`) are untouched and
    nothing new is revoked.
  - `student_quiz_questions`: `check (type <> 'multi_select')` (scope guard
    above).
  - `student_answers_view` AND `lecturer_answers_view` redefined
    (create-or-replace, APPEND `selected_indices` LAST — QT-3 append-last
    rule): resume reads the student view; the lecturer session-detail page
    (results/[sessionId]/page.tsx:120-123), the export route
    (export/route.ts:153-155) and the gradebook-export route (:211-214) all
    read the LECTURER view — without this column those surfaces render every
    multi answer as unanswered, and verify D5 (which reads the set via
    lecturer_answers_view) cannot even select the column. Their three
    explicit select lists gain `selected_indices` too.
  - **Barrier question views need NO edit:** `student_question_view`
    (0008:127-134, last redefined 0028:162-168) and
    `student_quiz_player_question_view` (0023:302-308, last redefined
    0028:172-179) select explicit columns — the new column is omitted by
    construction. Secrecy model is RLS row-omission (0004:129-136 — students
    have NO read policy on `questions`) + these views. **The sketch's claim
    "revoke correct_indices identically to correct_index in migration 0012
    lineage" was WRONG** — no column-level revoke on `correct_index` has ever
    existed. Verify probes D42 (verify-sessions) and SQ-D3b
    (verify-student-quizzes) already assert key-absence on `select("*")`;
    they are extended to expect `correct_indices`/`correct_index` absence.
- **Grading RPC `answer_question`** (latest body 0030:280-426; scalar
  equality at :374): signature gains `p_selected_indices int[] default null`.
  OVERLOAD MECHANICS (0025:2-15 precedent — "0019 had to DROP … R1 grants"):
  create-or-replace with a CHANGED arg list creates a NEW overload and leaves
  the old body live — PostgREST 3-arg calls would keep hitting the old
  function and grade against NULL, and a fresh function defaults to EXECUTE
  to PUBLIC. 0037 must `drop function public.answer_question(uuid, uuid,
  int)` after creating the 4-arg signature (same for `append_question(uuid,
  question_type, text, text[], int, text)`) and re-issue `revoke all … from
  public, anon; grant execute … to authenticated` on the NEW signatures.
  With the old overloads dropped, named-arg resolution keeps every existing
  3-arg caller (verify scripts D43/D44, fake-supabase, routes) on the new
  function — "existing callers unaffected" then holds. Branch on the fetched
  question's type:
  - multi_select: require `p_selected_index is null` AND
    `p_selected_indices` non-null with 1..5 elements each in
    `[0, cardinality(options))` → else `invalid_selected_indices` (new error
    string alongside the D43 `invalid_selected_index` taxonomy). SQL NULL
    elements MUST be rejected explicitly: PostgREST accepts
    `'{1,NULL,2}'::int[]` from any authenticated caller, a naive
    `v < 0 or v >= n` loop passes NULLs (the exact trap documented at
    0008:389-395 for the scalar), and `int[] = int[]` with a NULL element
    yields NULL → `is_correct` NOT NULL violation → 500. Validate with an
    explicit `e is null` arm (e.g. `not exists (select 1 from
    unnest(p_selected_indices) e where e is null or e < 0 or e >=
    cardinality(v_options))`); normalize
    (sort+distinct); `v_is_correct := (p_selected_indices =
    q.correct_indices)` — both sides sorted+distinct, so int[] equality IS
    exact-set equality. Assessment: the INSERT column list (0030:380-382)
    gains `selected_indices` TOO — "ack unchanged" refers only to the
    response; a missed insert column stores NULL sets on every assessment
    multi answer (EndScreen/student_results/export would all show
    "unanswered"). Insert-once → `already_answered` conflict; keyless
    `{recorded:true}` ack unchanged. Practice upsert must
    SET BOTH `selected_index = excluded.selected_index, selected_indices =
    excluded.selected_indices` so a row never carries a stale scalar.
    Practice payload shape PINNED for multi:
    `{is_correct, correct_index: null, correct_indices, explanation}` —
    mirrors the scalar practice shape (0030:411-421) with the scalar nulled;
    route `mapAnswerPayload` and the client highlight set depend on this
    exact key set.
  - non-multi: scalar path byte-identical; strict
    `invalid_selected_indices` rejection when `p_selected_indices is not
    null` (symmetry; no existing client sends the field).
  - `is_correct boolean` semantics preserved → `submit_session` recount
    (0032:452-461), score, gradebook, and export STRUCTURE all untouched.
  - Face/vision verify payloads carry no option data — untouched (QT-3
    precedent).
- **Authoring RPCs:** `append_question` (0004:437-493) gains
  `p_correct_indices int[] default null` — 0037 drops the old 6-arg
  signature and re-grants (same overload mechanics as answer_question);
  `save_quiz_questions` (0025:28-191) per-question validation gains the
  correct_indices mirror (SQL today checks only the lower bound at
  0025:111-116; the INSERT column list :120-127 must also gain the column —
  table CHECK/trigger do the rest, same split as correct_index);
  `clone_quiz` (0035:134-155)
  verbatim copy column list MUST gain `correct_indices` (else clones
  silently lose the answer key); `student_results` (0028:182-261) row
  payload gains `'correct_indices', q.correct_indices` and
  `'selected_indices', sa.selected_indices` (reveal-gating unchanged — the
  whole payload is already gated at 0028:206-208). The PATCH question route
  updates rows DIRECTLY (no RPC — `[questionId]/route.ts:88-102`) so its
  mapping carries the new columns.
- **Zod mirror:** `QuestionInputSchema` (validation.ts:55-101):
  `correctIndex` becomes optional; new optional `correctIndices`; superRefine
  makes it strictly symmetric — multi_select ⇔ `correctIndices` (1..
  options.length, each < options.length, sorted+distinct, `correctIndex`
  ABSENT) and non-multi ⇔ `correctIndex` (`correctIndices` ABSENT). No
  silent field-dropping at insert mappings. `AnswerSchema`
  (sessions/validation.ts:24-33) gains `selectedIndices:
  z.array(z.number().int().min(0).max(2_147_483_647)).min(1).max(5).optional()`
  (int4 element ceiling matches `selectedIndex`'s `.max` + comment
  convention — unbounded elements die as PostgREST transport errors, not
  clean 400s), becoming
  one-of with `selectedIndex` (exactly one present), keeping the existing
  "upper bound validated by the RPC against THIS question's options"
  comment convention. `ImportSchema` already wraps QuestionInputSchema — the
  parser change below feeds it.
- **Bulk import (AP-1) grammar extension:** ≥2 `*`-marked options ⇒
  multi_select row (correctIndices = marked positions, sorted distinct;
  letter-form marks `*B) text` map by LETTER, bare position marks by
  position — both forms are already parsed today at import-parser.ts:89-108).
  Single mark ⇒ mcq exactly as now. This REPLACES the
  `markCount > 1 → doubleMark` failure (import-parser.ts:223-226):
  previously-invalid input gains a meaning; no previously-valid input
  changes. `doubleMark` survives only for the letter-cell + marked-option
  mix (:219-222). Import route mapping (import-questions/route.ts:126-132)
  carries `correct_indices`.
- **AI generation:** `AiQuestionSchema` (quiz-schema.ts:38-105) gains
  multi_select + `correct_indices` with a one-of superRefine;
  `normalizeOptions` (:125-144) remaps `correct_indices` alongside
  `correct_index` (dedupe shifts), SORTS+DISTINCTS the remapped set, and
  returns null (→ clean retry, never a DB-trigger 500) if any correct
  option vanished in a duplicate collapse; `ReplaceQuestionRow` (:112-118)
  gains
  `correct_indices?: number[]`; `aiQuizToRows` maps it. **Opt-in only,
  gated at the LIB level:** `generateQuiz` opts gain
  `allowMultiSelect = false` — the multi format rule + JSON contract +
  schema example (analogues of :57-62, :78-83, :104, :128, :202) render
  ONLY when true (default prompt stays byte-identical, pinned by a golden
  unit test), and when false any parsed multi_select question triggers the
  existing retry-with-feedback loop (format-drift pattern :370-383). This
  placement covers BOTH consumers of the shared function: the lecturer
  GenerateQuizSchema (ai/validation.ts:53-82) gains the flag, and the
  STUDENT route (student-quizzes/[id]/generate/route.ts:220) inherits
  default-false — `GenerateStudentQuizSchema` (:94, `.strict()`) must NOT
  gain the flag, and a unit/route test pins that student generation never
  emits multi_select. regenerate-question (route :196-215) normalize +
  UPDATE gains `correct_indices`/`correct_index = null` for multi; its
  `toAi` context mapping (:158-164) carries the correct set through
  keep-SAME-type regen (quiz-prompt :439-445).
- **Routes:** POST `/api/quizzes/[id]/questions` (RPC append,
  questions/route.ts:66-77), PATCH/DELETE `[questionId]/route.ts`
  (:88-102 — the response select :99 and the POST 201 echo also gain
  correct_indices), import-questions route (:127-133) — all parse via
  QuestionInputSchema; each mapping site carries correct_indices and nulls
  correct_index for multi. **Answer route** (`/api/sessions/[id]/answer`)
  is a named edit point with three changes: (1) the rpc call passes
  `p_selected_index: selectedIndex ?? null` + `p_selected_indices:
  selectedIndices ?? null` (supabase-js drops `undefined` keys; with the
  old overloads dropped the 4-arg function resolves); (2) the error map
  (:118) gains `invalid_selected_indices → 400` (today an unknown RPC error
  string falls through to the unexpected-payload 500 arm); (3)
  `mapAnswerPayload` (:144-151) gains `correct_indices → correctIndices`
  — the whitelist strips unmapped keys, silently killing practice
  highlights. **Student-domain authoring routes are NOT untouched** (they
  share QuestionInputSchema): `student-quizzes/[id]/questions[/questionId]`
  routes (:5, :58-79) get an explicit `type !== "multi_select"` refine (or
  a strict single-type variant) so a multi-shaped body 400s cleanly instead
  of reaching `append_student_question`/direct UPDATE as an unmapped 500 —
  plus a backstop error-map entry for the DB CHECK string. The new trigger
  error string `invalid_correct_indices` is added to every authoring error
  map (questions create/PATCH, import, AI generate + regenerate, student
  create/PATCH) as drift insurance — Zod catches well-formed input first;
  this keeps the AI pipeline's trigger path a clean 400/retry instead of a
  500.
- **Player (session play):**
  - play-client.tsx: `AnswerState` gains `selectedIndices?: number[]` +
    `correctIndices?: number[]` (presented space, like selectedIndex today).
    Multi questions: option taps TOGGLE membership in a pending set (the
    answered-lock guard at :293-303 applies only after COMMIT); an explicit
    Confirm button (disabled at 0 selected) fires answer(set) — wire body
    `{ questionId, selectedIndices }` with each element translated
    presented→canonical BEFORE the POST (QT-3 translation point; route + RPC
    see canonical, sorted). Practice feedback: incoming is_correct +
    correct_indices → presented per element for highlights. 409
    `already_answered` replay renders from the in-memory presented set.
    Resume seed: `student_answers_view.selected_indices` (canonical) →
    presented per element — the play page resume select (page.tsx:148-151)
    MUST gain `selected_indices` in its explicit select list (the exact
    missed-select dead-feature trap QT-3's log warned about; guarded by
    e45's positive resume assertion).
  - Shuffle interplay (QT-3): per-element toCanonical/toPresented via the
    existing optionPlanFor; `applyBreakdownShuffle` (shuffle.ts:134-160)
    gains array translation (map every element; null passthrough stays
    exact — U-QT3 null precedent).
  - Gesture layer: answering DISABLED on multi questions — GestureLayer
    gains an `answerEnabled` prop (hold-latch answering suppressed) while
    palm-next NAVIGATION stays live and becomes unconditional (5 fingers =
    Next even at optionCount 5, since answering is off;
    mapFingersToOption gates it at optionCount < MAX_ANSWER_FINGERS today).
    Explanatory chip on the card (play.* key): "tap to select, then
    confirm". Navigation-by-click exists only POST-answer (Next button
    renders in feedback phase, play-client:605, :814) — pre-answer skip
    relies on palm-next, which is why navigation must stay gesture-enabled.
  - question-card.tsx: type chip MUST become a 3-way map over a NEW
    `common.multiSelect` key (today
    `type === "mcq" ? tCommon("mcq") : tCommon("trueFalse")` at :55-57 — the
    else-fallthrough would mislabel multi as True/False). Audit EVERY
    hardcoded `"mcq" | "true_false"` union and `type ===` ternary —
    enumerated: play page `QuestionRow`/`ResultsBreakdownRow` (:25, :69 —
    unions widen AND `correct_index: number` → `number | null`),
    play-client.tsx:27, question-card.tsx:12/:39, shuffle.ts
    `ShufflableBreakdownRow` (:117 — correct_index nullable),
    session-detail answer types, quiz-builder-client.tsx:75/:84,
    edit-question-dialog.tsx:35, import-parser.ts:48 +
    bulk-import-dialog.tsx:283 (its chip ternary falls through to MCQ —
    opposite direction), regenerate route :135, formatOptionText sites.
    The student player's union (student-quiz/player-client.tsx:15) stays
    2-type (v1 scope). Multi option cards keep button + aria-pressed (toggle
    semantics already correct); practice feedback set version of
    :86-109: isCorrectOption = correctIndices.includes(i),
    isWrongSelection = selected && !includes.
  - EndScreen (end-screen.tsx:148-212): multi rows render ✓ on EVERY
    correct_indices member, ✕ on selected-but-wrong, number otherwise;
    `selected_index == null → "—"` (:152-158) branches on type — answered
    multi rows have selected_index null ALWAYS and must not render "—"
    (presence of selected_indices decides). `ResultsBreakdownRow` (play
    page :66-77) gains correct_indices/selected_indices.
  - Lecturer per-session detail (session-detail-client.tsx:27,164):
    `ResultsSessionRow` gains selected_indices; multi rows render joined
    letters. Its deliberately-no-correct-key security comment
    (session types.ts:6-11) is PRESERVED — we add the student's own
    selections only, never the key.
- **Lecturer authoring:** builder type Select (quiz-builder-client.tsx:
  838-863) gains "Multi-select"; correct-answer control branches: dropdown
  (:867-886) for single types, a toggle-button GROUP for multi (aria-pressed
  buttons — closest in-app pattern is GenerateFromFileDialog's role="radio"
  cards at :575-590; student editor's native radios at editor-client.tsx:
  714-722 are the marking UX precedent). Option rows: add/remove/move must
  MAINTAIN correctIndices (question-draft.ts `applyOptionDraftOp` currently
  walks correctIndex — gains a set-aware variant: removal filters the index
  and decrements higher ones; move swaps). The option add/remove/move UI is
  `draft.type === "mcq"`-gated (builder :934, :975; edit dialog :361, :406)
  — those gates must accept multi_select too, or multi questions get no way
  to edit options. true_false option-lock (:931)
  untouched. Edit dialog (edit-question-dialog.tsx:248-304) mirrors both
  controls; PATCH body (:196-212) carries correctIndices. i18n:
  lecturer.builder keys (new multi type label + "Correct answers" label +
  hint), lecturer.dialogs for dialog titles (house pattern).
- **Exports/gradebook:** export.ts model (ExportQuestion.correctIndex :55,
  optionLetter :29-33, per-student cell :265-268, distribution :313) —
  multi cell contract: letters joined "," + " — " + selected texts joined
  " / " (e.g. `A,C — Photosynthesis / Respiration`); Questions & Key sheet
  Correct Answer column: joined letters (`A,C`); Choice Distribution counts
  each selection. export-workbook.ts (:224, :232, :268-270) branches on
  correctIndices presence. gradebook-export route (RA-1) reuses
  buildExportModel — inherits automatically; its question select
  (gradebook-export/route.ts:222) must add correct_indices. **Cross-doc
  rule:** PLAN_MATRIC_EXCEL_EXPORT.md line 23 lists multi-select as a
  Non-goal and :203-205 pins the single-letter cell contract — both amended
  in the same PR.

**Tests:** full stack —
- Units: validation.test.ts multi refines; import-parser.test.ts multi
  grammar (2+ marks, letter+position mix, out-of-range letter, sort/dedupe)
  + doubleMark regression retarget; quiz-schema/quiz-prompt tests for multi
  acceptance + normalization (collapse → null retry; non-multi return stays
  BYTE-identical) + allowMultiSelect gating (default prompt golden);
  student-AI-never-emits-multi pin; shuffle.test.ts
  array-translation cases (set presented↔canonical, breakdown rows, null
  passthrough); export.test.ts multi cell + key sheet + distribution;
  question-draft set-aware ops. vitest.config.ts gains lib-bar
  (80/80/80/70) entries for results/export.ts, results/export-workbook.ts,
  quizzes/import-parser.ts (in coverage globs but currently UN-gated — the
  multi-cell and grammar tests must be forced, not voluntary).
- Route tests (fake-supabase): answer route multi payload mapping + Zod
  (empty array 400; selectedIndex AND selectedIndices together 400; OOB
  element → 400 via the invalid_selected_indices error map); questions
  routes multi create/PATCH (correct_index null on multi; response echo);
  import route multi rows; AI route allowMultiSelect=false rejects multi
  via retry; student routes reject multi-shaped bodies with 400.
  fake-supabase edits are NOT just `_answerQuestion` (multi branch
  mirroring the RPC grading matrix: exact-set true, order-insensitive,
  subset/superset/disjoint false, OOB/NULL-element/empty errors): the
  `append_question` stub (fake-supabase.ts:394-414) and
  `save_quiz_questions` stub (:416-497) must carry correct_indices, and
  single-select inserted rows keep their current fixed shape with
  `selected_indices` absent-or-null consistently (no test toEquals a full
  answer row today — preventive pin).
- Regression retargets (guaranteed red otherwise):
  sessions/validation.test.ts:55 "rejects a missing selectedIndex" →
  retarget to the exactly-one-present rule; quiz-schema.test.ts:150-154
  pins normalizeOptions' exact return shape (non-multi result must stay
  key-identical — no `correct_indices` key on non-multi output; `undefined`
  passes toEqual, `null` does not); quiz-prompt.test.ts:243-250 golden
  "ONLY multiple-choice / ONLY True-False" prompt assertions cover three
  prompt builders (:62, :104, :128) — retarget for the conditional multi
  lines; type-widening forces explicit multi branches at export.ts:313
  (`correctIndex + 1`) and export-workbook.ts:224/:232.
- Verify probes `QT1-D1..D10` (house style: createUser/promoteLecturer/
  asUser + record()), assigned to their OWNING harnesses —
  verify:quizzes → D1 enum+columns exist, D2 authoring via append_question
  with correct_indices, D7 student_results payload arrays (reveal-gated);
  verify:sessions → D3 exact-set grading matrix incl. order-insensitivity,
  D4 OOB/NULL-element/empty → invalid_selected_indices, D5 assessment
  keyless ack + stored canonical set + is_correct via
  lecturer_answers_view, D6 practice upsert overwrite, D8a
  student_question_view `select("*")` omits
  correct_index/correct_indices/explanation (D42 extension);
  verify:student-quizzes → D8b student_quiz_player_question_view omission
  (SQ-D3b extension), D10 student-domain block (append_student_question
  with multi type rejected by CHECK) — lives there because that script owns
  the student fixtures/cleanup; verify:clone → D9 clone fidelity (AP2-D2
  pattern) — **and `verify:clone` must be ADDED to ci.yml** (package.json:47
  defines it; ci.yml never runs it — without this, a clone silently losing
  correct_indices ships green).
- E2E `e45-multi-select.spec.ts` (practice-mode journey for loud feedback +
  a separate assessment test): (1) authoring — builder creates a multi
  question with 2 marked answers, edit-dialog re-open asserts both persist;
  (2) practice — toggle two presented options, Confirm, feedback highlights
  BOTH correct + wrong-selection styling, EndScreen shows ✓ on the full
  correct set; (3) resume — reload renders aria-pressed on the presented
  slots of the persisted set; (4) assessment — keyless acks + service-role
  probe of stored selected_indices (deterministic text→canonical mapping;
  the probe compares the SORTED canonical array against the clicked-text
  set — identity permutations make presented == canonical, so this probe
  only bites when paired with (6)'s ordering assertion); (5) export —
  per-student cell `A,C — Photosynthesis / Respiration` + Questions & Key
  joined-letter cell via loadWorkbook (e18 asserts exact cell strings; keep
  option texts clear of safeText's leading `=+-@` prefix); (6) shuffle-on
  multi journey with
  plan-derived assertions (e42 pattern: recompute plan from sessionId,
  assert rendered order + persisted canonical set); (7) GESTURE-DISABLED
  contract — installFakeHandTracker + completeCalibration on a multi
  question: hold 2 fingers → NO answer POST within window
  (expectNoAnswerPost, e9's negative-proof helper) + explanatory chip
  visible; hold 5 fingers → advances to the next question (palm-next
  unconditional even at 5 options, contrasting e8's Q4 gate assertion).
  Accessible-name contract pinned here so helpers can drive the new
  controls: correct-answer toggle group label "Correct answers", Confirm
  button "Confirm answer". Helpers:
  `QuestionInput` gains `correctIndices?: number[]`; `completeQuiz` stays
  text-matched — a multi variant clicks a SET then Confirm (helper opt).
  Existing specs unaffected (new type, no existing spec authors it;
  position-letter assertions all run with multi absent; e23's correct-answer
  dropdown assertions and e31's ms-locale sweep double as canaries that the
  branching correct-answer control is additive).

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

- 2026-08-30 (QT-1): reconciled against `50bfa19`; migrations will be
  **0036** (enum value only — `alter type add value` cannot have the value
  USED in the same transaction under Supabase's transactional migration
  runner, so the enum growth is split from the columns/RPC migration) +
  **0037**. Verified/corrected: there is NO column-level revoke on
  `questions.correct_index` — the sketch's "revoke correct_indices in the
  0012 lineage" claim was wrong; secrecy is RLS row-omission (0004:129-136)
  + barrier-view omission (0012's revokes are `session_answers.is_correct` /
  `quiz_sessions.score` only). Barrier views `student_question_view` /
  `student_quiz_player_question_view` select explicit columns (last
  redefined 0028:162-179) so a new column is omitted by construction; they
  need no edit. `answer_question` latest body 0030:280-426 (scalar equality
  :374); `session_answers.selected_index` CHECK is lower-bound-only
  (0008:66). `student_results` payload 0028:182-261. `clone_quiz`
  (0035:134-155) copies questions verbatim — its column list must gain
  `correct_indices`. Student domain (`student_quiz_questions` 0023:51-62 +
  `answer_student_question` 0023:445-467 + student-quiz player UI) is a FULL
  parallel surface — scoped OUT v1 behind a `check (type <> 'multi_select')`
  guard. Gesture: pre-answer skip relies on palm-next (Next button renders
  post-answer only, play-client:605/:814), so gesture NAVIGATION stays
  enabled on multi questions while ANSWERING is disabled.
  question-card type chip + editor chips are `===` ternaries whose
  else-fallthrough would mislabel multi as True/False — 3-way maps needed.
  Export cell contract + PLAN_MATRIC_EXCEL_EXPORT.md non-goal amended per
  the cross-doc rule. AI: default formatDistribution must stay unchanged →
  `allowMultiSelect` opt-in. Import grammar: ≥2 `*` marks ⇒ multi_select
  (replaces the markCount>1 doubleMark failure; no previously-valid input
  changes). Existing E2E order/letter assertions unaffected (new type,
  nothing authors it today; completeQuiz matches by text). Local Supabase
  healthy — gen:types + verify harnesses runnable.
- 2026-08-30 (QT-1): implementation notes (recorded as they arose while
  coding): (1) BOTH scalar RPC params are `default null` (answer_question
  `p_selected_index`, append_question `p_correct_index` + `p_explanation`)
  — a defaulted param cannot precede a non-defaulted one (42P13), and the
  generated supabase-js arg types are `?: T` (not `| null`), so routes pass
  the value with undefined-keys-dropped semantics instead of explicit
  nulls; (2) append_question NORMALIZES the set on write (sorted+distinct,
  same posture as save_quiz_questions) — unsorted/duplicate input lands
  canonical; only OOB/null-element/scalar-shape violations are rejected;
  (3) the builder page question select list needed correct_indices too
  (list-row summary renders the set — the same missed-select class the
  reviewers kept flagging); (4) play-client's pending multi-selection is
  keyed by question id with NO reset effect — a state-reset effect broke
  the React-compiler lint rules (set-state-in-effect) and un-bailed the
  compiler onto pre-existing ref patterns; the keyed map makes stale
  entries unobservable at the read site.

- 2026-08-30 (QT-1, gesture amendment — user decision): the shipped
  "gesture-inert on multi" behavior is REPLACED by hold-to-toggle +
  palm-commit (user-specified design): holding N fingers (1..4) LATCHES a
  toggle of presented option N (the same pending set the tap path uses);
  an open palm commits the set; multi questions are capped at FOUR
  options so palm is never ambiguous with an option pose. Mechanical
  consequences recorded before implementation: (1) a latch RE-ARMS only
  after the pose changes (hand lost or different count) — otherwise a
  sustained hold would toggle twice; (2) the 4-option cap ripples: DB
  CHECK folded into 0037 (uncommitted changeset), Zod mirror
  (MULTI_SELECT_OPTIONS_MAX=4) in QuestionInputSchema + AiQuestionSchema,
  import parser problem code `multiTooManyOptions`, builder + edit-dialog
  add-option cap and blocked type-switch at 5 options, e45 fixture
  reduced to 4 options, gesture test rewritten for toggle/commit
  semantics; (3) palm-commit with an empty selection is a no-op with a
  hint notice (mirrors the disabled Confirm); (4) the
  `answerEnabled`/`multiGestureNote` gesture-inert machinery is removed;
  gesture-layer's prop becomes `answerMode: "single" | "multi"`, scalar
  behavior byte-identical (e8 is the canary).

- 2026-08-30 (QT-1, calibration practice module — user follow-up): the
  gesture calibration gate now TEACHES the multi vocabulary when the quiz
  contains multi-select questions: `hasMultiQuestions` flows play page →
  PlayClient → GestureLayer → GestureCalibration, which renders an
  interactive practice card (4 mock options; the live calibration frame
  stream toggles them on with holds 1..4 — union-only, idempotent on the
  streamed frames — and a 5-finger pose flips the "committed" success
  chip). Practice state is calibration-local (nothing touches the quiz);
  toggling OFF is taught by copy since a streaming frame cannot
  distinguish a fresh hold from a sustained one (the in-quiz latch re-arm
  handles that). aria-live narration mirrors the in-quiz count; e8's
  calibration assertions and the full e45 suite stay green.

- 2026-08-30 (QT-1): **Audit round 1** (implementation-correctness +
  security/DB auditors): 1 blocker, 2 majors, ~7 minors, all fixed and
  re-verified. Blocker B1: the import route emitted an explicit JSON-null
  `correct_indices` key on every scalar row — jsonb null is NOT SQL null, so
  0037's presence check rejected every mcq/true_false import; fixed by
  omitting absent keys (aiQuizToRows convention) AND hardening 0037 to treat
  jsonb null as absent both ways, pinned by a real-DB probe (QT1-D2c) the
  fake-supabase tests could never catch. Majors: assessment multi re-answer
  (`already_answered`, keyless, first answer intact) and >5-element/legacy
  3-arg-shape probes added (QT1-D5b/D5c); normalizeOptions collapse test
  re-pinned to the deliberate merge-to-one behavior; student-domain CHECK
  probe now asserts the constraint by name; verify-quizzes class cleanup
  tracked (was orphaning a class per run); answer route gained a body cap.
- 2026-08-30 (QT-1): **Audit round 2** (E2E-gap specialist + fresh-eyes
  adversarial): the specialist found the shuffle×multi journey and the
  EndScreen/export-workbook multi arms had ZERO coverage (e45's plan items 5
  and 6 had never been written) and wrote them: a shuffle-on plan-derived
  e45 test (reverse-order clicks → sorted canonical wire → EndScreen set
  marks → service-role set probe → resume translation), EndScreen
  wrong-selection assertions, edit-dialog type-switch assertions, and a
  multi-fixture export-workbook unit test (branch coverage 77→86%). The
  fresh-eyes pass verified gen:types idempotence (zero drift), exhaustively
  verified question-draft move/remap math (462 cases), confirmed the 409
  replay parity and deploy-order safety, and flagged: resume seed no longer
  fabricates option 0 on a double-null row; ms label de-confused
  ("Jawapan Pelbagai"); deploy-order assumption documented in 0036;
  Implementation log + roadmap board bookkeeping done. Also surfaced a
  PRE-EXISTING engine dead-end (all-answered unsubmitted resume → Next
  strands the student in question phase with no submit) — out of QT-1
  scope, affects scalar quizzes identically, separate ticket.
- 2026-08-30 (QT-1): **Audit round 3** (a11y/UX + e2e sweep and
  data-integrity/exports): 1 blocker, 1 major, ~5 minors. Blocker: the
  round-1 jsonb-null hardening ran a text-vs-jsonb comparison
  (`jsonb_array_elements_text` + `is not distinct from 'null'::jsonb`) that
  raised `operator does not exist` for EVERY multi row through
  save_quiz_questions — bulk import and opt-in AI writes 503'd; fixed
  (jsonb_array_elements) and pinned by QT1-D2d (multi row via the import
  RPC: string element rejected, valid set stored normalized) — the one
  function no other test exercises with a multi row on real Postgres.
  A11y majors/minors fixed: focus now moves to Next/Finish when feedback
  mounts (Confirm unmount previously dropped focus to <body> with an
  unannounced result), a visually-hidden aria-live selection count sits
  beside Confirm, the en hint says "select" (was "tap"), and gesture-active
  students get an explicit "gestures are off for this question" note on
  multi questions. Builder list type badge got the 3-way map (was
  mislabeling multi as True/False). All gates re-run green after each
  round (1307 unit tests + coverage, 13 verify harnesses, i18n parity,
  e45 5/5, lint/typecheck clean).

- 2026-08-30 (QT-1): plan reviewed by 3 independent reviewers (data-flow,
  security, test-strategy/E2E). 2 blockers + 12 majors + ~12 minors, all
  folded into the design above. Blockers: `lecturer_answers_view` was
  missing entirely (session-detail/export/gradebook read multi answers
  through it; D5 selects via it) — 0037 redefines it append-last and the
  three answer select lists gain the column; e45 had NO gesture test (the
  riskiest player change could ship dead/broken with every other listed
  test green) — test (7) added. Majors folded in: RPC overload mechanics
  (drop old signatures + re-grant, 0025 precedent); assessment INSERT
  column list gains selected_indices; NULL-element rejection
  (`'{1,NULL,2}'::int[]` slips naive guards → is_correct NOT NULL 500);
  answer route named edits (rpc args `?? null`, invalid_selected_indices →
  400, mapAnswerPayload correct_indices); student authoring routes share
  QuestionInputSchema → strict multi reject (500 → 400); allowMultiSelect
  gated at generateQuiz opts so the student AI path inherits default-false
  (GenerateStudentQuizSchema stays strict, no flag); prompt multi-lines
  conditional (default prompt byte-identical, golden-pinned);
  normalizeOptions sorts+distincts and returns null on collapse (clean
  retry, not a trigger 500); trigger event list
  type/options/correct_index/correct_indices + pinned error string mapped
  in all authoring routes; QT1-D probes reassigned to owning harnesses
  (D3-D6/D8a → verify:sessions, D8b/D10 → verify:student-quizzes, D9 →
  verify:clone, which must be ADDED to ci.yml); play-page resume select
  named as an edit point; regression-retarget list completed (sessions
  validation :55, normalizeOptions exact-shape, prompt goldens, export
  type-widening); fake-supabase append_question/save_quiz_questions stubs
  carry correct_indices; coverage gates added for
  export/export-workbook/import-parser; `common.multiSelect` key;
  AnswerSchema element int4 max; multi practice payload shape pinned
  ({is_correct, correct_index: null, correct_indices, explanation});
  option-row edit gates accept multi_select; bulk-import-dialog chip
  3-way; 0036 uses `add value if not exists`; hardcoded-union audit list
  enumerated; e45 accessible names pinned ("Correct answers" group /
  "Confirm answer"); e23/e31 cited as additive-control canaries.

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

### QT-1 · Multi-select questions — SHIPPED 2026-08-30 (migrations 0036 + 0037)

Shipped as designed (see the reconciled design above and the 2026-08-30
Pre-flight log entries — 3 plan reviewers, 3 audit rounds), with these
concrete surfaces:

- **Migration `0036_add_multi_select_type.sql`:** enum value only (split
  required: the new value cannot be USED in the same transaction).
  **`0037_multi_select_questions.sql`:** `questions.correct_indices int[]`
  + `correct_index` NOT NULL dropped + `questions_correct_shape` CHECK +
  `questions_correct_indices_guard` trigger (insert or update of
  type/options/correct_index/correct_indices; error string
  `invalid_correct_indices`); `session_answers.selected_indices int[]` +
  cardinality CHECK; `student_quiz_questions_no_multi_select` CHECK (v1
  scope guard); `student_answers_view` + `lecturer_answers_view`
  redefined appending `selected_indices` LAST; `answer_question` 4-arg
  (old 3-arg DROPPED, grants re-applied) with the multi branch — NULL/
  OOB/empty/both-shape rejection (`invalid_selected_indices`), sorted+
  distinct normalization, exact-set grading, assessment insert-once,
  practice upsert setting BOTH columns, practice payload
  `{is_correct, correct_index: null, correct_indices, explanation?}`;
  `append_question` 7-arg (old dropped, re-granted) with set
  normalization; `save_quiz_questions` multi mirror (jsonb-null treated
  as absent — audit B1 hardening); `student_results` rows gain
  `correct_indices`/`selected_indices`; `clone_quiz` copies the set.
- **Pure/shared code:** `validation.ts` (QuestionInputSchema strict one-of
  + StudentQuestionInputSchema scope reject), `sessions/validation.ts`
  (AnswerSchema exactly-one), `import-parser.ts` (≥2 `*` marks ⇒
  multi_select), `ai/quiz-schema.ts` (contract + normalizeOptions set
  remap, merge-to-one on duplicate collapse — deliberate), `ai/
  quiz-prompt.ts` (`allowMultiSelect` gated at the lib level, default
  prompt byte-identical), `question-draft.ts` (set-aware option ops),
  `shuffle.ts` (element-wise set translation), `results/export.ts` +
  `export-workbook.ts` (joined-letter cells "A,C — X / Y", per-set
  distribution).
- **Routes:** answer (rpc args, `invalid_selected_indices` → 400,
  `correct_indices` in mapAnswerPayload, body cap), questions create/
  PATCH, import, AI generate/regenerate, student authoring (strict
  reject). Player: play page (resume set translation), play-client
  (keyed pending map, Confirm commit, per-element canonical wire + set
  feedback), question-card (3-way chip, set highlights, hint chip),
  gesture-layer (`answerEnabled` — holds never answer multi; palm-next
  unconditional at 5 options), end-screen (set ✓/✕ rendering),
  session-detail (set selections), builder + edit dialog (toggle-group
  answer key), bulk-import dialog (set preview).
- **Tests:** U-QT1-1..7, U-QT1-P1..P5, U-QT1-A1..A7, U-QT1-V1..V3,
  U-QT1-E1..E4, U-QT3-19..20, U-AP1-9a/9b/9c; route tests QT1-1..13 +
  QT1-9/10 (student reject); `verify:quizzes` QT1-D1/D2/D2b/D2c,
  `verify:sessions` QT1-D3/D4/D5/D5b/D5c/D6/D8a/D7,
  `verify:student-quizzes` QT1-D8b/D10, `verify:clone` QT1-D9
  (`verify:clone` ADDED to ci.yml); `e2e/e45-multi-select.spec.ts`
  FIVE tests — authoring + edit-dialog persistence + type-switch seed,
  practice set journey incl. wrong-selection + EndScreen set marks +
  resume, assessment keyless acks + canonical-set probe, gesture
  disabled/no-POST + genuine palm-next at 5 options, shuffle-on
  plan-derived journey (reverse-order clicks → sorted canonical wire →
  EndScreen set marks → service-role set probe → resume translation).
- **Gesture interaction (amended same-day, user decision — supersedes the
  shipped "gesture-inert" behavior):** multi questions are answered BY
  GESTURE — holding N fingers (1..4) latches a TOGGLE of presented option
  N (the same pending set taps write), and an open palm COMMITS the set.
  A latch re-arms only after the pose changes (hand lost or different
  count), so a sustained hold can never double-toggle. Multi questions
  are CAPPED AT 4 OPTIONS (`questions_multi_option_cap` CHECK in 0037,
  Zod `MULTI_SELECT_OPTIONS_MAX`, AI schema/prompt, import grammar
  `multiTooManyOptions`, builder/dialog add-option cap + blocked
  5→multi type-switch) so five fingers is unambiguously commit.
  Palm-commit with an empty selection shows a notice (mirrors the
  disabled Confirm). GestureLayer's prop became `answerMode:
  "single" | "multi"`; scalar behavior is unchanged (e8 canary green).
  e45's gesture test proves: hold→toggle on, re-arm+hold→toggle off,
  dual holds build {A,C}, palm POSTs the sorted canonical set, palm-next
  advances in feedback.
- **Deviations from the plan as written:** (1) the plan's e45 item (5)
  export workbook E2E probe was dropped in favor of unit pins (model
  U-QT1-E1..E4 + a multi-fixture `export-workbook.test.ts` raising
  branch coverage 77→86%) — the route/view wiring is covered by route
  tests + verify probes; (2) the plan's "pre-answer skip relies on
  palm-next" rationale does not hold for multi (nextArmed is
  feedback-only) — multi questions are gesture-INERT while unanswered;
  (3) timer expiry discards an unconfirmed multi selection (Confirm-to-
  commit semantics; the scalar auto-commit precedent does not apply);
  (4) `allowMultiSelect` is an explicit GenerateQuizSchema field
  defaulting false rather than a distribution value.
- **Out-of-scope observation (pre-existing, NOT QT-1):** an
  all-answered unsubmitted reload lands in feedback on the LAST question
  and clicking Next leaves the student stuck in `question` phase with
  no way to submit — affects scalar quizzes identically (resume tests
  assert-and-stop, which is why it was never hit). Separate ticket.

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

# Roadmap Plan — Question Types & Answering Semantics

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec.
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

**Design sketch — deliberately read-time-derived (NO schema migration)**
- Deterministic permutation seeded by hashing `quiz_sessions.id` +
  quiz-level salt-free constant. Question order shuffled at READ time inside
  the session-envelope loader / session question view; option order shuffled
  OPTIONAL per-question (riskier: gesture finger mapping MUST remap consistently
  — compute shuffled presentation index ↔ canonical index mapping inside the
  same envelope and translate submitted canonicalized indexes BEFORE persist;
  simplest correct approach: shuffle at ENVELOPE BUILD, translate in the
  player layer, persist canonical index only — server remains single source
  of truth for ordering derivation so both sides agree).
- Review/results display must reuse THE SAME session-seeded order (store
  nothing; re-derive deterministically).
- Opt-in per quiz (`shuffle_questions boolean` default false) — negligible
  schema addition if opted-for; could also be global-off config constant v1.
  Pre-flight decides: recommend shipping with the boolean column immediately
  to avoid a second migration later.
- Edge cases pinned in tests: exactly-one-option impossible (constraint
  existing), true/false pair shuffle harmless, face/gesture subsystems
  unaffected (question-index agnostic already).

**Tests:** determinism unit suite (same seed ⇒ same permutation across
processes), distribution sanity, envelope↔persist round-trip translation,
existing E2E specs must pass unchanged (order-independent assertions audit
required).

---

## QT-4 · Audio/video prompts & sections (LOW — defer)

Noted for completeness; follows the §7.12 image pattern for storage/signing,
but transcoding cost (COSTS.md impact) + player complexity → blocked pending
real demand. Sections additionally cosmetic at ≤30 questions/quiz. No design
work until promoted.

## Pre-flight log

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- (none yet)

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

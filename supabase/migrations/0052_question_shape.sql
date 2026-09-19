-- ═══════════════════════════════════════════════════════════════════════
-- 0052 — short_text shape + marking state (PLAN_GESTURE_OFF_RICH_TYPES)
--
-- Depends on 0051 (the enum value must exist and be COMMITTED — this file
-- USES it, which is legal only because the CLI applies each file in its own
-- transaction; see 0051's header for the D8 rationale).
--
-- Contents:
--   §1  quizzes.gestures_enabled (quiz-level gesture kill switch, D9/FC-1)
--   §2  questions: answer_key / max_score
--   §3  session_answers: answer_text / skipped / mark_status / mark_score /
--       marked_at / attempt_version / mark_metadata
--       (D3: TEXT+CHECK, not an enum — marking state churns)
--   §4  per-type options CHECK (the 0004 2..5 arm is type-blind)
--   §5  questions_correct_shape 3-way + subsumed multi cap
--   §6  short_text shape CHECKs
--   §7  session_answers pending/skip shape CHECKs
--   §8  student-domain scope guard (D12)
--
-- NOT here: privileges (0054), RPC bodies (0055+), view projections (0060).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Quiz-level gesture toggle ─────────────────────────────────────
-- D9: draft-frozen like shuffle_questions (0056 adds it to the freeze list)
-- so a live quiz cannot have its input modality flipped under in-flight
-- students. DEFAULT true preserves today's always-on behaviour: a quiz
-- created before this column existed keeps gestures.
alter table public.quizzes
  add column if not exists gestures_enabled boolean not null default true;

-- ─── 2. questions: short_text key column ──────────────────────────────
-- answer_key — the rubric text the AI marker grades a free-text answer
--              against. Non-blank and ≤ 500 chars (§6): an empty rubric
--              would make the marker grade against nothing while still
--              spending tokens.
-- max_score  — D7: structure reserved, value locked at 1. A NUMERIC column
--              (not INT) so a future partial-credit scale needs no type
--              change; the CHECK pins today's single-point semantics.
alter table public.questions
  add column if not exists answer_key text;

alter table public.questions
  add column if not exists max_score numeric not null default 1
  check (max_score = 1);

-- D2-1: short_text carries no options, and the 0004 column is NOT NULL with
-- a 2..5 CHECK. The CHECK has to give (it is type-blind); the NOT NULL does
-- NOT — the convention for short_text is the EMPTY ARRAY, and keeping the
-- column NOT NULL with a '{}' default is what ENFORCES that convention
-- instead of merely documenting it.
--
-- Why this matters beyond tidiness: a nullable column types every reader as
-- `string[] | null`, forcing a null branch into ~50 call sites (the player's
-- option map, the builder, both exporters, the AI readbacks) for a case that
-- can never legitimately occur. NOT NULL + DEFAULT '{}' keeps `options` a
-- total `string[]` for every type, and legacy rows are untouched.
alter table public.questions
  alter column options set default '{}'::text[];

alter table public.questions
  alter column options set not null;

-- ─── 3. session_answers: marking state ────────────────────────────────
-- answer_text — the student's own free-text answer. CHECK-capped at 500
--               chars (S6/FS-7): a single oversized answer must not
--               monopolize the quiz's daily AI budget, and the Zod layer
--               mirrors the same bound.
-- skipped     — the student chose "skip". Terminal in assessment (0055).
-- mark_status — D3: TEXT + CHECK rather than an enum, because marking
--               workflow state churns (a new state would need its own
--               migration file per ADD VALUE) while house enums are stable
--               domain values. Default 'marked' keeps every legacy row and
--               every mcq/true_false/multi answer semantically unchanged.
-- mark_score  — the resolved score. NULL = not yet marked. CHECK-pinned to
--               the 0/0.5/1 ladder (defense-in-depth: the RPC and the AI
--               finalizer both clamp, but a direct service-role write must
--               not invent 0.7).
-- attempt_version — the override epoch. The AI ledger's idempotency key is
--               '{session}:{question}:{attempt_version}' and the finalizer's
--               guard is `attempt_version = p_attempt_version`, so a lecturer
--               override during an in-flight AI call makes the late write a
--               no-op instead of clobbering the adjudication.
-- mark_metadata — AI rationale + confidence, rendered as PLAIN TEXT only
--               (S7: never HTML/dangerouslySetInnerHTML).
alter table public.session_answers
  add column if not exists answer_text text
  check (char_length(answer_text) <= 500);

alter table public.session_answers
  add column if not exists skipped boolean not null default false;

alter table public.session_answers
  add column if not exists mark_status text not null default 'marked'
  check (mark_status in ('pending', 'marked', 'needs_review', 'failed'));

alter table public.session_answers
  add column if not exists mark_score numeric
  check (mark_score is null or mark_score in (0, 0.5, 1));

alter table public.session_answers
  add column if not exists marked_at timestamptz;

alter table public.session_answers
  add column if not exists attempt_version int not null default 1;

alter table public.session_answers
  add column if not exists mark_metadata jsonb;

-- ─── 4. Per-type options cardinality ──────────────────────────────────
-- The 0004:57 CHECK (`cardinality(options) between 2 and 5`) is TYPE-BLIND,
-- so it rejects short_text (0 options) before any shape logic runs. Replace
-- it with a per-type disjunction. Legacy arms are byte-identical to their
-- old bounds; only the short_text arm is new.
--
-- NOTE: the constraint name is the 0004 auto-name (`questions_options_check`,
-- verified against pg_constraint on the target DB — C12).
alter table public.questions drop constraint if exists questions_options_check;
alter table public.questions add constraint questions_options_check check (
    (type = 'mcq' and cardinality(options) between 2 and 5)
    or (type = 'true_false' and cardinality(options) = 2)
    or (type = 'multi_select' and cardinality(options) between 2 and 4)
    or (type = 'short_text' and cardinality(options) = 0));

-- ─── 5. questions_correct_shape: three-way ────────────────────────────
-- C1: the 0037 two-way constraint demands `correct_index IS NOT NULL` on
-- every non-multi row, so a short_text insert fails on the FIRST row.
-- Recreate as a three-way that accepts the legacy shapes verbatim and adds
-- short_text's keyless shape.
--
-- questions_multi_option_cap (0037:59-61) is now SUBSUMED: the multi arm of
-- questions_options_check above carries the same 2..4 bound, so keeping both
-- would mean two constraints to update for one rule.
alter table public.questions drop constraint if exists questions_correct_shape;
alter table public.questions drop constraint if exists questions_multi_option_cap;
alter table public.questions add constraint questions_correct_shape check (
    (type = 'multi_select' and correct_index is null and correct_indices is not null)
    or (type in ('mcq', 'true_false') and correct_index is not null and correct_indices is null)
    or (type = 'short_text' and correct_index is null and correct_indices is null));

-- ─── 6. short_text shape CHECKs ───────────────────────────────────────
-- short_text: options present-but-empty (the §2 convention, enforced by the
-- NOT NULL + DEFAULT '{}' above and the `cardinality(options) = 0` arm of the
-- options CHECK). Without the zero arm a short_text row could carry stray
-- options that the player would try to render as choices the student cannot
-- meaningfully answer.
alter table public.questions add constraint questions_short_text_shape check (
  type <> 'short_text' or cardinality(options) = 0);

-- short_text: a non-blank rubric of bounded length.
alter table public.questions add constraint questions_answer_key_shape check (
  type <> 'short_text' or (answer_key is not null
  and char_length(trim(answer_key)) between 1 and 500));

-- ─── 7. session_answers shape CHECKs ──────────────────────────────────
-- D3: a 'pending' row must be UNSCORED and counted wrong — the pending
-- sentinel is (is_correct=false, mark_score IS NULL). If a pending row could
-- carry mark_score, the D10 SUM would count a mark the finalizer has not
-- written yet, and `is_correct=true` would contradict it.
alter table public.session_answers add constraint session_answers_pending_shape check (
  mark_status <> 'pending' or (is_correct = false and mark_score is null));

-- A skipped row carries NO answer of any kind. Without this, a skip on top
-- of an existing answer (or a partial write) would leave a row that reads
-- as answered AND skipped — and `session_answers_skip_shape` is what makes
-- the 0055 practice-upsert reset (A5-5) load-bearing.
alter table public.session_answers add constraint session_answers_skip_shape check (
  skipped = false or (selected_index is null and selected_indices is null
  and answer_text is null));

-- ─── 8. Student-domain scope guard ────────────────────────────────────
-- D12: practice quizzes keep the scalar types only. 0037:139-141 already
-- bans multi_select, so this constraint is deliberately REDUNDANT with it on
-- that value and adds only short_text. Redundancy is the point: the student
-- authoring RPCs cast to the shared enum, so without a row CHECK a direct
-- RPC call could mint a row the student player cannot answer (and, for
-- short_text, one with no AI marking path at all — practice has no spend
-- budget).
alter table public.student_quiz_questions
  add constraint student_questions_no_new_types
  check (type in ('mcq', 'true_false'));

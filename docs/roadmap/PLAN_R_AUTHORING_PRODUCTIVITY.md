# Roadmap Plan — Authoring Productivity

> **Status:** PLANNED (roadmap) — see `docs/roadmap/README.md` for the mandatory
> pre-implementation workflow. Items here are NOT current spec.
>
> Domain: how quizzes get built faster — bulk import, duplication/reuse,
> question banks. Builds on manual builder routes (`api/quizzes/[id]/questions*`),
> AI generation pipeline (`lib/ai/*`, validation mirrors in
> `lib/quizzes/validation.ts`), bulk RPCs `save_quiz_questions` /
> `save_student_quiz_questions`.

---

## AP-1 · Bulk import (paste / CSV) (MEDIUM-HIGH)

**Problem:** Sole non-AI write path adds ONE question per call
(`POST api/quizzes/[id]/questions`). Lecturers with prepared question sets
must hammer the form 20 times. Hard cap 30 questions/quiz enforced in
generate-quiz pre-checks (`api/ai/generate-quiz/route.ts:176–188`).

**Design sketch**
- Dialog alongside GenerateFromFileDialog: textarea paste OR file upload.
- Accepted line grammar (keep forgiving, dialect-tolerant):
  `prompt | optA | optB | [optC] [optD] [optE] | *correctLetter` —
  asterisk-in-option-cell alternative supported (`*A)` prefix marking).
  True/false rows accept prompt | true/false-answer.
- Parse client-side → preview table (count, per-row warnings, edit before
  commit) → POST all at once through the EXISTING bulk RPC path
  (`save_quiz_questions` append mode already validates count caps + Zod
  mirror constraints — reuse; do not invent a second writer).
- Reject whole batch atomically on any invalid row (show all problems).
- Bidi-strip normalization reused from `stripBidiControls` (roster precedent).
- Raise/expose cap handling: batch exceeding remaining capacity errors with
  explicit remaining-count message.
- i18n all preview/warning strings both en/ms.

**Tests:** parser unit tests (messy inputs galore), route test via fake-
supabase against save RPC path, E2E paste-and-commit journey.

---

## AP-2 · Quiz duplication & copy-to-class (MEDIUM-HIGH)

**Problem:** Zero cloning functionality (grep `duplicate|clone|copy_quiz`
empty of hits). Every semester rebuilds identical content by hand; class-scoped
model (`quizzes.class_id`) blocks sharing.

**Design sketch**
- Server clone RPC/route (owner-guarded):
  - Duplicate within class → fresh DRAFT copy titled "<title> (copy)".
    Copies questions (+order_index) AND images (image_path objects duplicated
    into same bucket layout per media pattern, ARCHITECTURE §7.12) and
    metadata fields (time_limit, mode defaulting to original); NEVER copies
    session/linkage state, share codes, or reveal timestamps.
  - Copy-to-another-class: same mechanics, caller picks destination class they
    own (guard verifies destination ownership too).
- Source restrictions: allow duplicating CLOSED and DRAFT sources (live?
  recommend yes-with-copy-to-draft so cross-class reuse works mid-term).
- UI: kebab/button on quiz cards + builder toolbar → two actions + class
  picker modal; success toast deep-linking to the new draft.
- Implementation note: single definer RPC
  `clone_quiz(src_quiz_id, dest_class_id)` in one transaction beats
  N-route choreography (answers the orphan-image sweep risk by inheriting the
  upload-then-insert cleanup posture from §7.12).

**Tests:** SQL harness (clone fidelity: questions/order/images copied;
session/share/reveal fields null-or-defaulted; ownership guards incl.
destination-class owner), E2E journey.

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

<!-- Required before ANY item above is implemented. See roadmap README Step 1. -->

- (none yet)

## Implementation log

<!-- Filled at move-out per roadmap README Step 3. -->

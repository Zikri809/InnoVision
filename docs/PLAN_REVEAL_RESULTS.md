# Reveal Results — Final Implementation Plan (v4)

Status: READY FOR IMPLEMENTATION — revised after TWO rounds of parallel
stress-test audits (round 1 found the original leak + race blockers; round 2
re-audited v3 and found the remaining gaps below, all now resolved).
This is the implementation reference; the changes below are binding.

---

## 1. Goal
Control when students see their results (score, breakdown, explanations) by quiz mode.
- **Practice**: instant on submit.
- **Assessment**: hidden until lecturer reveals (or auto-reveal when all students submit).

## 2. Core decisions
- **Reveal = state on the quiz**: `quizzes.results_revealed_at timestamptz` (nullable). NULL = hidden, NOT NULL = revealed.
- **Auto-reveal intent**: `quizzes.auto_reveal_on_complete boolean not null default false`.
- **Reveal rule** (`is_student_reveal_allowed`): enrolled in quiz's class AND (`mode='practice'` OR `results_revealed_at is not null`). Practice is always revealed; no "hide a practice" override (removed v2 contradiction).
- **Reveal is ONE-WAY, enforced by a DB trigger.** `reveal_once_only` raises on ANY change from a non-null `results_revealed_at`; same-value no-op allowed (idempotent auto-reveal).
- **Manual reveal is only offered while the quiz is LIVE** (UI and route both gate on `status='live'`). Documented consequence: closing a quiz before revealing permanently locks results out (one-way; the student_quiz_view is live-only so nothing can reach them). Follow-up (out of scope): a closed-quiz recovery surface.
- **Auto-reveal is submit-triggered only — NO background job.** A class whose remaining students never submit never auto-reveals; lecturer manual reveal is the escape. State this on the checkbox copy.

## 3. A single sealing story (round-2 BLOCKER: `quiz_sessions.score` + `session_answers.is_correct`)  
v3 sealed the RPCs/routes but left the ROW layer open: students can PostgREST-read
`quiz_sessions.score` and `session_answers.is_correct` directly (both RLS-owner-
readable + `grant select … to authenticated`; `0008_sessions.sql:78,141-160`).
v4 seals at the data layer with one mechanism — **student-safe VIEWs**:

1. `student_scores_view` — `quizzes ⋈ quiz_sessions` for students: exposes
   `session_id, quiz_id, student_id, mode, status, started_at, submitted_at,
   last_activity_at` and `score` **only when** `is_student_reveal_allowed(quiz_id)`
   (else NULL) and `student_id = auth.uid()`. `security_barrier`.
2. `student_answers_view` — `session_answers` for students: exposes
   `id, session_id, question_id, selected_index, answered_at` and
   `is_correct` **only when** `is_student_reveal_allowed(quiz_id)` and
   `student_id = auth.uid()` (via session join). `security_barrier`.
3. RLS grants: `session_answers` / `quiz_sessions` direct `SELECT` by students is
   replaced by the two views. **Lecturer reads are unaffected** (their RLS paths
   and the `results/*` reads stay on the base tables — views are student-only).
4. **Play RSC** (`src/app/play/[sessionId]/page.tsx`): reads **resume state from
   `student_answers_view`** and (when revealed) score from `student_scores_view`.
   Resume only needs `question_id, selected_index` (verified: play-client seeds
   by question id/selectedIndex only; "answered" = presence; no is_correct use).
   **Practice resume keeps `is_correct`** (practice is always revealed; the
   Correct/Incorrect resume chips at `question-card.tsx:53-66` need it).
5. `student_results` RPC (below) is the SOLE student-facing read of the
   per-question breakdown/explanation/correct answer; views never expose those.
6. **Score is a secret for assessment pre-reveal at every node**: table (view
   NULLs it), `submit_session` RSC envelope, `submit` route, GET session
   envelope, and the RSC prop `score` are all reveal-gated. Practice always passes score.

## 4. Assessment answer responses become keyless (round-2 client BLOCKER)
The client engine `src/components/quiz/play-client.tsx` is IN SCOPE (v3 missed it):

1. `answer_question` RPC (`0008_sessions.sql:302` — NOT superseded; 0009 only
   redefines `submit_session`): assessment success returns `{'recorded': true}`;
   assessment `already_answered` replay returns `{'error':'already_answered'}`
   (no `is_correct`). Practice returns `is_correct`/`correct_index`/`explanation`
   unchanged (assessment block `399-415` + tail `431-433` only).
2. `answer/route.ts`:
   - success gate `:116` becomes "non-error payload" (accepts `recorded`), NOT
     `"is_correct" in payload` (that would 500 every assessment answer).
   - `mapAnswerPayload` drops the unconditional `is_correct` copy (`:133`);
     409 body drops `isCorrect` (`:108`).
3. **`play-client.tsx:282-288` mode-aware ack** — the 200 shape-check must accept
   `recorded === true` for assessment (mark answer from `selectedIndex`, neutral
   chip) and keep the `isCorrect` boolean check for practice.
4. **`play-client.tsx:290-301` 409 branch** — stop reading `body.isCorrect` for
   assessment; set answered from `selectedIndex` only.
5. **Tests to update (both the route tests AND the RPC stub)**: I7/I10
   (`sessions-routes.test.ts:373-388,468-490`) and the fabricated assessment
   rows in `fake-supabase.ts:484,494,516,518`. Pin "assessment 200 has no
   isCorrect" via a new type pin on the client response type.

## 5. Submit path: no score until reveal, and the client submitted view (round-2 BLOCKER)
1. `submit_session` (deployable = `0009_face.sql:788-880`): reads
   `quizzes.results_revealed_at` **in the same transaction AFTER the guarded
   reveal flip** and returns `score=null` for assessment pre-reveal. Both paths:
   success (`0009:864-878`) and **`already_submitted` replay (`0009:824-840`)**
   — the 409 replay must also null score.
2. `submit/route.ts`: gate `:86` must pass `score: null` through (no 500);
   409 body `:74-84` drops score until revealed.
3. GET `/api/sessions/[id]`: envelope `score` reveal-gated.
4. **`play-client.tsx:541-564` submitted view must be reveal-aware**: accept
   `score: number | null`; render **"Submitted ✓ — results will be released by
   your lecturer"** when null; DELETE the `body.score ?? 0` / `?? 0` fallbacks
   (`:443`) — no fake `0 / N` anywhere.
5. **`end-screen.tsx`** (server-rendered final card): new contract
   `score: number | null`, `revealed: boolean`, optional `breakdown` prop.
   Rendering matrix:
   - Practice: score + % + breakdown.
   - Assessment + not revealed: "Submitted ✓ — results will be released by your lecturer." No score, no %.
   - Assessment + revealed: score + % + breakdown.
   - **Play RSC `page.tsx:236` removes `score={s.score ?? 0}`**; computes
     `revealed = quiz.mode === 'practice' || quiz.results_revealed_at != null`;
     passes `score = revealed ? s.score : null`; adds `results_revealed_at` to
     the `student_quiz_view` projection + `QuizRow`.
6. **`student_results` wiring: SERVER-SIDE in the play RSC** (round-2 HIGH).
   Not a client fetch — `end-screen.tsx` is a server component and `createClient`
   is already student-authenticated; the definer RPC re-validates. Pass
   `breakdown` as a prop. Practice multi-session note: return the **most recent
   completed session's** breakdown (`order by started_at desc limit 1`).

## 6. `student_results(p_quiz_id)` RPC — security definer, `search_path=public`
- Guards in order: `auth.uid() is null` → role = student → enrolled in the
  quiz's class (`is_enrolled_in_class`, NOT `can_student_view_quiz` which
  requires `status='live'`) → **sessions scoped to `auth.uid()`** → reveal
  allowed. Single no-oracle error: `{'error':'not_revealed'}` folds
  not-found + not-enrolled + not-revealed (house pattern per `start_quiz_session`).
- Output: `{score, total, revealed_at, questions:[{prompt, options, selected_index, is_correct, explanation, correct_index}]}` (revealed only; otherwise just the error).
- Grants: `revoke execute from public, anon; grant execute to authenticated`.
  Grant the helper `is_student_reveal_allowed` the same way (missing in v3).
  `service_role`: not needed (no server component renders lecturer corrects via
  this RPC).

## 7. Migration `0012_results_reveal.sql`
- `alter table quizzes add results_revealed_at timestamptz;`
- `alter table quizzes add auto_reveal_on_complete boolean not null default false;`
- Add `results_revealed_at` (NOT `auto_reveal_on_complete`, which is lecturer
  intent/timing and must not reach students) to `student_quiz_view`
  (`0006:12-19`).
- `is_student_reveal_allowed(p_quiz_id)` helper + grants.
- One-way trigger (sibling to `quiz_status_transition`):
  `if OLD.results_revealed_at is not null and NEW.results_revealed_at is
  distinct from OLD.results_revealed_at then raise exception 'reveal_once_only';`
- `student_scores_view` / `student_answers_view` (security_barrier, student-only
  projection per §3) + swap student SELECT grants onto them.
- `student_results(uuid)` RPC per §6.
- `submit_session` change: inside the existing single transaction, after the
  guarded reveal flip, derive `score`/`total` from the reveal state (§5.1).

## 8. Auto-reveal predicate + exactly-once (round-2 fixes)
**Predicate ("all done"):** no session where
  `mode = 'assessment' AND status in ('active','paused','flagged')
   AND last_activity_at >= now() - interval '2 hours'`
  exists for the quiz. → `completed` (any age) and stale rows count as done;
  **flagged counts as in-progress** (v3's predicate text contradicted this —
  fIXED: flagged is now explicitly in the blocking set so auto-reveal waits for
  the lecturer's unlock → completion). 2h matches `ABANDON_STALE_MS`
  (`src/lib/results/constants.ts:9`). Count on `s.mode` (session column; equals
  quiz mode for reachable rows). NULL/future `last_activity_at`: SQL side treats
  only explicit-completed/stale as done.

**Exactly-once** in `submit_session`, in this order:
1. session row `for update` (existing `0009:810-813`);
2. `pg_advisory_xact_lock(hashtext('quiz_reveal:' || p_quiz_id))`;
3. `UPDATE quiz_sessions SET status='completed' …`;
4. count per predicate;
5. guarded reveal flip (below). Skip steps 2-5 on the `already_submitted`
   early-return (`0009:824-841`) so retries never contend.

**Guarded flip (idempotent, exactly-once across resets):**
```sql
update quizzes
   set results_revealed_at = clock_timestamp()
 where id = p_quiz_id
   and auto_reveal_on_complete
   and results_revealed_at is null
   and status = 'live';             -- round-2: must not run on a closed quiz
get diagnostics v_rows = row_count; -- v_rows = 1 ⇒ first flipper
```
- **`status = 'live'` is REQUIRED** (round-2 HIGH): the bare flip would fire
  `quiz_status_transition`'s same-status branch which can raise
  `closed_quiz_cannot_transition` if a lecturer closed concurrently → the final
  student's submit 500s/rolls back, and a retry reveals a closed quiz. With the
  WHERE guard, 0 rows match → trigger never fires.
- The reveal write is a `security definer` write into `quizzes` — document that
  it is WHERE-bounded to ONLY `results_revealed_at` on an owned session's quiz,
  and must never touch other quiz columns.
- **Lock table** (round-2 note): `submit_session` acquires `quiz_reveal` +
  implicit `quiz_publish` (its own UPDATE fires `quiz_status_transition`); no
  deadlock cycle exists today (only `submit_session` holds two; `quiz_append`/
  `quiz_replace` draft-only single-key; `quiz_start` per-(quiz,student)). A
  lecturer holding `quiz_publish` benignly blocks a concurrent auto-reveal until
  commit.

## 9. Lecturer side — results page
- Controls in a white `Card` row BELOW the hero band (not on the orange band):
  - Assessment + live only: **"Reveal to students"** `variant="default"`
    (primary orange; disclosure, not destructive — irreversibility carried in copy).
  - Hint while hidden: **"N of M enrolled students haven't submitted yet"**
    (N = `roster.length − completed`; completed counted from the session slice —
    note the RESULTS_SESSION_LIMIT=False ceiling skew at >200 sessions).
  - **Auto-reveal checkbox**: "Release automatically once every student has
    finished (last submit, or no one remains active)." — copy matches the
    predicate (flagged blocks, stale counts as done). Buyer-beware note: no
    background job; if nobody submits, it never fires.
  - After reveal: emerald chip **"Results revealed"** with lucide check
    (`aria-hidden`), matching lifecycle-badge style.
- Confirm dialog: **"Reveal answers for all M enrolled students?"** (M =
  `roster.length`). Body: "This cannot be undone. Students who haven't submitted
  will see results after they finish." Confirm `variant="default"`.
- Busy label `"Revealing…"`, then `router.refresh()`.
- Empty/no-submissions state: the button stays enabled but the hint reads
  sensibly (`M of M`); copy drafted on the toggle checkbox.
- **Focus after reveal** (round-2 a11y): after confirm+refresh, focus the status
  chip (give it `tabIndex={-1}`); dialog focus-restore lands on a removed node.

## 10. API routes
- `POST /api/quizzes/[id]/reveal` — lecturer-only (`requireQuizOwner`), CSRF +
  rate-limit, `status='live'` REQUIRED, guarded ONE-WAY-safe UPDATE
  (`where id=$1 and results_revealed_at is null returning …`); idempotent
  (second click → 0 rows → 200/`{already:true}`), maps `reveal_once_only` to
  409, never 500.
- `PATCH /api/quizzes/[id]/reveal-settings` — set `auto_reveal_on_complete`
  (lecturer-only; draft or live).
- All auto-reveal logic lives INSIDE `submit_session` (never the route).

## 11. Out of scope (v4)
- Per-student answers archive page; scheduled reveal; notifications;
  closed-quiz reveal recovery surface; practice "hide results" override.

## 12. Test plan
DB/API (prior list retained, corrected):
- `student_results` matrix including multi-session practice → most recent
  completed; not-owning-student → `not_revealed`.
- One-way trigger + same-value no-op.
- Auto-reveal: flagged blocks; stale=done; concurrent last-submit fires exactly
  once (`row_count`); concurrent quiz-close ⇒ flip is a 0-row no-op (no 500/rollback); reset-then-resubmit doesn't re-fire.
- Sealed shapes: update I7/I10, submit replay I13 (`:633`), `fake-supabase.ts`
  assessment fabrications; route success gates accept `recorded`/`score:null`.
- Type pins: assessment response types carry no `isCorrect`; student-visible
  types carry no `correct_index`.

UIX (NEW — round-2 finding, house convention = Playwright e2e, e.g.
`e11-answer-secrecy.spec.ts`, `e14-results-actions.spec.ts`, `e4-play-practice.spec.ts`):
- Assessment submit → submitted screen shows NO score ("released by your lecturer").
- Practice + assessment-revealed → EndScreen shows score + %.
- Practice resume chips still show Correct/Incorrect (is_correct seed intact).
- Reveal button disabled on draft/closed and after reveal; dialog shows M; after
  confirm the chip appears and receives focus.
- Assessment answer flow still advances (keyless ack does not error) and the 409
  already-answered branch doesn't fabricate a wrong state.

## 13. Implementation order
1. Migration 0012 + views + RPC + trigger (DB layer).
2. `answer_question` + `submit_session` + routes + stubs/tests.
3. `play-client.tsx` + play RSC + `end-screen.tsx` (student flows).
4. Lecturer reveal UI + routes + dialogs.
5. e2e UIX specs.
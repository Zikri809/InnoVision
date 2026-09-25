# PLAN — Student-Created Practice Quizzes (shareable)

Status: FINAL (reviewed by 4 independent critiques: data-modeling, product/UX,
testing/delivery, security/abuse — all findings incorporated)
Depends on: 0002_classes.sql (profiles/roles), 0004_quizzes.sql
(question_type enum, trigger functions), 0006 (secrecy view doctrine),
0008_sessions.sql (player-view + RPC patterns), 0019 (join throttle precedent)
Owner: TBD

## 0. Summary

Students author their own quizzes (manual builder in v1), play them in
practice mode with unlimited tries and instant per-question feedback, and
share them via an unlisted share code/link. **Authoring is student-only;
playing a shared quiz is open to ANY authenticated user** (students and
lecturers). Lecturer quizzes and assessment machinery are untouched — the
migration is additive-only.

## 1. Goals / Non-goals

**Goals (v1)**
1. Student creates a quiz: title + N questions (mcq / true_false) reusing the
   `QuestionInputSchema` rules from `src/lib/quizzes/validation.ts`.
2. Practice-only by construction: untimed, unlimited attempts, instant
   per-question feedback (`is_correct` + `correct_index` + explanation after
   each non-null answer) — same feedback contract as lecturer practice mode.
3. Sharing: creator mints a 10-char share code; any authenticated user with
   the link plays. Unshare nulls the code (revocation is meaningful);
   re-sharing mints a fresh code.
4. Creator keeps full edit rights at all times; players are warned content
   may change, with a designed failure path for mid-play mutations (§4).
5. AI generation for student quizzes (shipped in 0029): creator-gated,
   rate-limited generation route with a per-day budget via the
   `ai_generation_usage` counter, cancel checkpoint, and results clamped to
   the 50-question cap, persisted via `save_student_quiz_questions`.

**Non-goals (explicitly out of scope for v1)**
- Anonymous (logged-out) sharing — requires anon policies + public routes.
- Discovery/search/listing of shared quizzes ("marketplace").
- Moderation/reporting UI (a `report` seam is reserved; see §8).
- Scores/leaderboards persistence across players (stateless grading).
- Refactoring the lecturer builder UI (see §5 — fresh editor instead).

## 2. Key design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-SQ1 | **Separate tables** `student_quizzes` / `student_quiz_questions`, NOT nullable `class_id` on existing tables | ~20 policies/triggers/RPCs assume class ownership; retrofitting risks assessment-integrity regressions. Additive-only = zero blast radius |
| D-SQ2 | No `mode` column, no draft/live/closed machine | The table *is* practice by definition; state machines protect graded assessments, nothing here is graded |
| D-SQ3 | Share model: unlisted 10-char code on the join-code alphabet (`^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$`, CHECK-enforced, ~2^50 space); **single source of truth: `share_code IS NOT NULL` ⇔ shared** (no separate boolean column) | Matches join-code UX; brute-force infeasible; one fact, no drift states. Unshare sets `share_code = NULL`; regenerate gated on being shared |
| D-SQ4 | Server-side grading via RPC gives **per-question reveal** (NOT absolute key secrecy): a determined player can harvest the key by answering every question. Accepted for practice semantics; anyone adding scores/leaderboards later inherits this | Keeps "never trust the client"; player view exposes questions WITHOUT correct_index/explanation (mirrors `student_question_view` from 0008). NULL selections are rejected — they must not reveal anything |
| D-SQ5 | Stateless play (no session rows, grading RPC performs ZERO writes) | Practice = unlimited tries; no one-attempt guard needed; avoids FK entanglement with `quiz_sessions`. Also makes creator-cannot-see-who-played true **by construction** — keep it that way permanently |
| D-SQ6 | Authz split: **authoring routes/RPCs require student role; the two play routes (`GET shared/[code]`, `POST shared/answer`) require authentication only**; the shared-play surface is reached exclusively through `resolve_shared_student_quiz` (definer RPC) + `student_quiz_player_question_view` | Resolves the draft's contradiction; lecturers opening a student link get a working page, not a mysterious 403. Route guard and shared-read paths MUST agree; tested explicitly. Note: the RLS SELECT policy is creator-only (narrowed in 0045 §2.1 — a shared arm would let any authenticated user dump the whole practice corpus), so shared reads are code-gated, never direct table reads |
| D-SQ7 | Caps enforced DB-side with row-derived owner + advisory-lock serialization (never bare count-then-insert, never `auth.uid()` inside triggers) | Concurrent-insert oversubscription closed; works under service_role where `auth.uid()` is NULL |

## 3. Schema — migration `0023_student_practice_quizzes.sql`

```sql
-- Depends on: 0002 (profiles), 0004 (question_type enum, trigger fns)

create table if not exists public.student_quizzes (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(trim(title)) between 1 and 200),
  description text check (char_length(description) <= 500),
  -- Single source of truth: share_code IS NOT NULL <=> shared.
  share_code  text check (share_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists student_quizzes_created_by_idx on public.student_quizzes (created_by);
create unique index if not exists student_quizzes_share_code_idx
  on public.student_quizzes (share_code) where share_code is not null;

create table if not exists public.student_quiz_questions (
  id            uuid primary key default gen_random_uuid(),
  quiz_id       uuid not null references public.student_quizzes (id) on delete cascade,
  order_index   int not null check (order_index >= 0),
  type          public.question_type not null,
  prompt        text not null check (char_length(trim(prompt)) between 1 and 2000),
  options       text[] not null check (cardinality(options) between 2 and 5),
  correct_index int not null check (correct_index >= 0 and correct_index < cardinality(options)),
  explanation   text,
  image_path    text,
  generation_id uuid,
  created_at    timestamptz not null default now(),
  check (type <> 'true_false' or cardinality(options) = 2)
);
create index if not exists student_quiz_questions_quiz_id_order_idx
  on public.student_quiz_questions (quiz_id, order_index);
-- image_path (0028): shape CHECK (sq_questions_image_path_shape) + ownership
-- trigger tr_sq_questions_image_path_ownership (0046 C-03) — self-service
-- writes must point at the caller's own storage folder.
-- generation_id (0045): tags AI-generated batches for append-retry
-- idempotency; partial index on non-null generation_id.

-- ─── Role/ownership helpers (house convention: security definer, pinned
-- search_path, revoke from public+anon, grant to authenticated). NOTE:
-- public.is_student() DOES NOT EXIST today (only is_lecturer(), 0002) — this
-- migration introduces it. Never inline profiles subqueries into policies.
create or replace function public.is_student() returns boolean
language sql security definer set search_path = public as $$
  select exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role = 'student');
$$;
revoke execute on function public.is_student() from public, anon;
grant execute on function public.is_student() to authenticated;

create or replace function public.is_student_quiz_creator(p_quiz_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.student_quizzes s
                 where s.id = p_quiz_id and s.created_by = auth.uid());
$$;
revoke execute on function public.is_student_quiz_creator(uuid) from public, anon;
grant execute on function public.is_student_quiz_creator(uuid) to authenticated;

-- Shared-visible helper used by BOTH the SELECT policy and the player view.
create or replace function public.is_shared_student_quiz(p_quiz_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.student_quizzes s
                 where s.id = p_quiz_id and s.share_code is not null);
$$;
revoke execute on function public.is_shared_student_quiz(uuid) from public, anon;
grant execute on function public.is_shared_student_quiz(uuid) to authenticated;

-- ─── RLS ────────────────────────────────────────────────────────────
alter table public.student_quizzes enable row level security;
alter table public.student_quiz_questions enable row level security;

-- SELECT: creator-only (narrowed in 0045 §2.1: the earlier shared arm let any
-- authenticated user dump the whole practice corpus via the table). Shared
-- reads flow exclusively through the definer RPC + player view (D-SQ6).
drop policy if exists "Creator or shared-visible" on public.student_quizzes;
create policy "Creator only (shared reads are code-gated RPC/view paths)"
  on public.student_quizzes for select
  using (created_by = auth.uid());

drop policy if exists "Student creates own quiz" on public.student_quizzes;
create policy "Student creates own quiz" on public.student_quizzes for insert
  with check (created_by = auth.uid() and is_student());

drop policy if exists "Creator updates own quiz" on public.student_quizzes;
create policy "Creator updates own quiz" on public.student_quizzes for update
  using (created_by = auth.uid())
  with check (created_by = auth.uid() and is_student());

drop policy if exists "Creator deletes own quiz" on public.student_quizzes;
create policy "Creator deletes own quiz" on public.student_quizzes for delete
  using (created_by = auth.uid());

-- Questions: creator-only CRUD. Players NEVER read this table directly.
drop policy if exists "Creator manages own questions" on public.student_quiz_questions;
create policy "Creator manages own questions" on public.student_quiz_questions for all
  using (is_student_quiz_creator(quiz_id))
  with check (is_student_quiz_creator(quiz_id) and is_student());

-- Privilege layer: revoke all from anon/authenticated, then grant exactly what
-- the app needs (select+insert+update+delete on both tables to authenticated;
-- full to service_role) — 0008 convention.

-- ─── Triggers: ATTACH existing functions, never redefine them ───────
-- questions_options_distinct() and questions_explanation_length() (0004)
-- reference only NEW columns → attach verbatim under NEW trigger names.
drop trigger if exists student_questions_options_distinct on public.student_quiz_questions;
create trigger student_questions_options_distinct
  before insert or update of options on public.student_quiz_questions
  for each row execute function public.questions_options_distinct();
-- (same pattern for explanation length)

-- ─── Caps (D-SQ7): row-derived owner, advisory-lock serialized ──────
-- 25 quizzes/student; 50 questions/quiz. BEFORE INSERT triggers derive owner
-- from NEW (works under service_role), take pg_advisory_xact_lock(
-- hashtext('student_quiz_cap:' || owner)) before counting. The question
-- cap/append path is unified on the advisory lock
-- 'student_quiz_append:' || quiz_id, taken BEFORE any count/delete by BOTH
-- append_student_question and save_student_quiz_questions (0045/0049) —
-- same session+key is reentrant (no-op), no reverse order (no deadlock).

-- ─── updated_at ─────────────────────────────────────────────────────
-- BEFORE UPDATE plpgsql fn sets updated_at = now(). A child-side trigger on
-- student_quiz_questions touches the parent row so question edits bump
-- updated_at (content-version honesty for the "content may change" warning).
```

Notes:
- Enum boundary hard-pinned in DB (divergence happened, so the Zod gate alone
  is no longer the story): 0037 adds `student_quiz_questions_no_multi_select`
  CHECK; 0052 §8 adds `student_questions_no_new_types` CHECK pinning
  `type in ('mcq','true_false')` — short_text explicitly has no AI path in
  practice (no spend budget; practice short_text is not even authorable).
  The same boundary 400s at the API (`StudentQuestionInputSchema`).
- Title sanitization: strip bidi-override / zero-width characters at Zod
  validation time (homoglyph spoofing defense).

### Views + RPCs

```sql
-- Player-facing view (name distinct from 0008's student_question_view):
-- NO correct_index, NO explanation. security_barrier=true like 0008; default
-- (definer-rights) views BYPASS base-table RLS, so the WHERE helper IS the
-- boundary — stated explicitly here. Cost: barrier blocks qual pushdown, so
-- is_shared_student_quiz runs per row over the questions scan; bounded by
-- caps and PK-indexed lookups (documented tradeoff, mirrors 0008:124-126).
create or replace view public.student_quiz_player_question_view
with (security_barrier = true) as
select q.id, q.quiz_id, q.order_index, q.type, q.prompt, q.options, q.created_at
from public.student_quiz_questions q
where is_shared_student_quiz(q.quiz_id);
grant select on public.student_quiz_player_question_view to authenticated;

-- Grading RPC: SINGLE statement (no TOCTOU window between "verify shared"
-- and "fetch key"): joins parent in the same snapshot; folds foreign-id /
-- deleted / unshared / bad-index into ONE no-oracle error. Rejects NULL
-- selected_index outright (must not reveal anything). Returns
-- { is_correct, correct_index, explanation? } — practice-mode shape.
create or replace function public.answer_student_question(
  p_question_id uuid, p_selected_index int) returns jsonb ... security definer ...

-- Creator display name for the landing page: profiles SELECT is self-only
-- (0006 MED-3), so FK-embedding through the client would return null.
-- Security-definer helper exposing ONLY split_part(full_name,' ',1),
-- callable when is_shared_student_quiz(p_quiz_id). created_by UUID itself is
-- STRIPPED from every player-facing payload (metadata, questions, grades).

-- Bulk persistence RPC (live 5-arg form):
-- save_student_quiz_questions(
--   p_quiz_id uuid,
--   p_questions jsonb,
--   p_mode text,
--   p_generation_id uuid default null,   -- append-retry idempotency: a
--                                        -- generation_id already tagged on
--                                        -- the quiz returns the saved rows
--                                        -- instead of duplicating
--                                        -- (audit-1 P1-10)
--   p_replace_ids uuid[] default null)   -- replace deletes ONLY the listed
--                                        -- ids, so a manual question appended
--                                        -- mid-generation survives
--                                        -- (0049 H3-ATOM-F1)
```

Share code issuance lives in the API route (`generateShareCode()` port of
`join-code.ts`, length 10, retry-on-conflict ×3) — matching how class join
codes work. Code normalization (`normalizeShareCode`: trim/uppercase/regex)
runs BEFORE any DB touch; format failures are a 400, misses a uniform 404.

## 4. API surface (App Router, mirrors existing conventions)

Authz per D-SQ6: authoring routes use a new `requireStudent` guard
(`src/lib/student-quizzes/guards.ts`); the two play routes use
`requireAuthenticated`. Zod validation at the boundary; typed errors via
`src/lib/http.ts`; no-oracle 404s; `checkSameOrigin()` on every POST/PATCH/
DELETE (join-route convention); request-body size precheck (64 KB -> 413 via
the existing `payloadTooLarge` precedent).

| Method & path | Purpose |
|---|---|
| `GET /api/student-quizzes` | List own quizzes + question counts (per-quiz head COUNT queries — NOT embedded aggregates; keeps fake-supabase support trivial) |
| `POST /api/student-quizzes` | Create quiz (title/description); returns id |
| `PATCH /api/student-quizzes/[id]` | Update title/description; share actions: `{action:"share"}` mints code, `{action:"unshare"}` nulls it, `{action:"regenerate"}` gated on currently-shared |
| `DELETE /api/student-quizzes/[id]` | Delete (cascades questions) |
| `POST /api/student-quizzes/[id]/questions` | Append via RPC `append_student_question` (advisory lock on `'student_quiz_append:'||quiz_id`, same key as the cap trigger) |
| `PATCH/DELETE /api/student-quizzes/[id]/questions/[questionId]` | Edit/remove (always editable) |
| `POST/DELETE /api/student-quizzes/[id]/questions/[questionId]/image` | Attach/remove question image (0028; ownership-triggered storage path per 0046 C-03) |
| `POST /api/student-quizzes/[id]/generate` | AI generation (0029; creator-gated, rate-limited, per-day budget via `ai_generation_usage`): SSE stream with cancel checkpoint, clamped to the 50-question cap, persisted via `save_student_quiz_questions` |
| `POST /api/student-quizzes/[id]/reorder` | RPC reorder (mirror of 0004 semantics) |
| `GET /api/student-quizzes/shared/[code]` [auth-only] | Resolve code -> quiz metadata + creator first name + questions via player view (no answer key, no created_by) |
| `POST /api/student-quizzes/shared/answer` [auth-only] | Thin wrapper around `answer_student_question`; NULL selected_index rejected with `invalid_body` |

Validation: `src/lib/student-quizzes/validation.ts` imports the SAME
constants/schemas from `src/lib/quizzes/validation.ts`; description <=500 new.

**Mid-play lifecycle error contract:** any grade-RPC failure caused by
deletion/unshare/question-mutation maps to one generic shape
`{ error: "unavailable" }` (404). Client marks that question "no longer
available", auto-advances, excludes it from the tally; if persistent, shows
"This practice quiz is no longer available." Never surfaces which case
occurred (no-oracle preserved at revocation time).

Rate limits (`src/lib/classes/rate-limit.ts`, in-memory, documented
per-process limitation):

| Action | Limit |
|---|---|
| create quiz | 5 / user / hour |
| append question | 60 / user / hour |
| quiz PATCH | 20 / user / hour |
| question PATCH/DELETE | 60 / user / hour |
| reorder | 30 / user / hour |
| share toggle/regenerate | 10 / user / hour |
| shared-code resolve | 20 / user / min **+ best-effort per-IP bucket** |
| grade answers | 60 / user / min |

Code-resolve hardening: normalize+regex 400 BEFORE any DB touch; uniform 404
on miss; failures counted separately from successes so legitimate users
opening several links are not locked out. Optional later hardening (NOT v1):
DB-side fail-counter table ported from `class_join_attempts` (0019) inside a
definer resolve RPC, closing the direct-PostgREST probe path. Justified deferral:
2^50 space makes brute force infeasible even unthrottled; route limiter is
hygiene parity with join codes, not load-bearing.

## 5. Frontend

New student section "My Quizzes" (claymorphism cards, next-intl **en + ms**
— the repo's actual locales; NO RTL exists or is needed):

1. `/student/my-quizzes` — list + Create CTA; per-card Play / Edit / Share /
   Delete (confirm dialog). Nav label of the EXISTING class quizzes tab
   renamed to "Class Quizzes" (i18n-only change) to avoid Quizzes/My-Quizzes
   confusion.
2. `/student/my-quizzes/new` + `[id]/edit` — FRESH lightweight student editor
   (do NOT refactor the lecturer builder this feature). Extract only the PURE
   option-array draft reducers (setOption/addOption/removeOption/moveOption +
   correctIndex fixing — currently copy-pasted in quiz-builder-client.tsx and
   edit-question-dialog.tsx) into `src/lib/quizzes/question-draft.ts`,
   deduping both copies. Lecturer components untouched; lecturer cleanup is an
   optional follow-up PR.
3. Play screens are SHELL-LESS focused pages (root group), consistent with
   `/play/[sessionId]` precedent — same chrome for self-play and shared play:
   - Self-play: `/play/student/[quizId]`
   - Shared: `/s/[code]` landing (title, description, question count, creator
     first name, community-content banner) then the same player UI.
   Both render an END SCREEN mirroring `src/components/quiz/end-screen.tsx`:
   score X/N, per-question review, Retry (resets state), Back.
4. Refresh resilience: sessionStorage checkpoint of answered indices/results,
   restored on mount (client-only; statelessness tradeoff documented in §8).
5. Share UX: Copy link + WhatsApp intent (`wa.me/?text=`); `generateMetadata`
   OG tags on `/s/[code]` (title = quiz title); regenerate behind an explicit
   "old links will stop working" confirm.
6. Logged-out share-link recipients: guard does
   `redirect('/login?redirect=/s/<code>')` — the login page already supports a
   sanitized redirect param; nothing populates it today. This closes the
   viral-loop break point.
7. Rendering contract (codify where shared components are built): all UGC
   text renders as plain text only — never `dangerouslySetInnerHTML`, never
   auto-linkified.
8. i18n keys added for every string incl. ms translations; run `check:i18n`
   at phase boundaries (not just polish).

## 6. Testing plan

1. Unit (vitest): validation schemas; share-code generate/normalize; guards;
   question-draft.ts reducers.
2. Route tests (vitest): enumerate fake-supabase EXTENSIONS as deliverables —
   VIEW_TO_BASE entry for `student_quiz_player_question_view`, route-mapping
   RPC stubs (`append_student_question`, `answer_student_question`, reorder)
   under the lockstep-with-migration discipline, counts via supported head
   COUNT queries, NO `.or()` filters anywhere. `_resetRateLimiter()` in every
   suite's beforeEach; hour-window 429 tests via N real calls (seam has no
   windowMs param). Authz split tested explicitly: student B denied A's
   unshared quiz (route test) + lecturer CAN play shared link (route test).
   RLS note: B sees ZERO rows in both tables (SELECT policy is creator-only,
   0045 §2.1); shared access is via `resolve_shared_student_quiz` + the
   player view only, so direct-table read probes assert creator-only and
   shared-flow probes assert through the RPC/view paths.
3. DB/RLS probes: extend the verify-family — `scripts/verify-student-quizzes.mjs`
   + package.json `verify:student-quizzes` + ci.yml step. Built INCREMENTALLY:
   RLS/policy probes land with Phase 1, RPC/route-authZ probes with Phase 2
   (verify scripts are the authoritative semantics layer, not polish).
   Route-vs-RLS denials asserted separately (direct-table read probes).
4. E2E (Playwright): `e17-student-practice-quizzes.spec.ts` (e16 is TAKEN by
   integrity spec) — split into 2–3 serial tests over shared setup:
   (a) create/add/play own; (b) share -> second account plays via link ->
   logged-out recipient: login wall -> redirect back lands on `/s/[code]`;
   (c) unshare -> link dead (uniform 404) -> delete cascades.
5. Gates per phase: Phase 1 exit = migration applies clean + `npm run
   gen:types` + typecheck green. Coverage thresholds in vitest.config.ts get
   explicit rows for `src/lib/student-quizzes/**` and
   `src/app/api/student-quizzes/**` (80/80/80/70 like lib/quizzes precedent)
   as Phase 2 exit criteria. check:i18n re-run after Phases 3 and 4.
6. TESTING.md updated each phase (new U-/I-/D-/E-case rows + phase-gate row);
   HANDOFF.md entry last.
7. Regression: full `npm run test && npm run test:e2e` green at every phase
   boundary; because NO shipped file is modified except app-shell label i18n
   keys, additive-only holds structurally.

## 7. Rollout

1. Migration 0023 + helpers + triggers + views/RPCs + RLS probes in verify
   script + gen:types. Gate: migration applies; typecheck green.
2. Guards/validation/rate-limited routes + fake extensions + route tests +
   coverage rows + RPC probes in verify script + ci.yml step.
3. Builder UI (fresh editor + question-draft extraction) + self-play +
   end screen. Gate: check:i18n passes.
4. Share flow (mint/unshare/regenerate + `/s/[code]` + login-redirect +
   WhatsApp/OG) + e17 specs. Gate: check:i18n passes; e2e green.
5. Docs: TESTING.md final rows, HANDOFF.md entry.

Estimated effort: ~8–11 working days (gates above are part of the estimate).

## 8. Risks / open questions

1. UGC exposure: mitigations = caps, length limits, login-gated access,
   plain-text rendering rule, bidi-strip on titles, community banner +
   visible creator first name. Deferred: report/takedown (reserve a `report`
   seam now — school-context peer content will need it), admin queue.
2. Answer-key harvest by parallel grading is inherent to instant-feedback
   practice (D-SQ4 states this honestly); harmless until scoring features
   exist.
3. Stateless play loses progress on refresh outside the checkpoint restore;
   acceptable for low-stakes practice (documented deviation from class-mode
   resume).
4. In-memory rate limiter is per-process (existing documented limitation);
   DB-side resolve backstop deferred with rationale (§4).
5. Creator stats ("who played my quiz") intentionally impossible while the
   grading RPC stays write-free — revisit only with explicit privacy design.

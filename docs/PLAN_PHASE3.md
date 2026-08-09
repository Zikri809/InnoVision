# InnoVision — Phase 3 (Manual Builder) Implementation Plan

> **Status:** Validated (graphify graph refreshed at HEAD `742185a`; baseline lint/typecheck/37 unit tests green) and approved for execution.
> **Depends on:** Phase 2 (Classes) — committed, gates green (D8/D12/D15–D18, E1, E1a).
> **Phase 3 deliverable (PLAN §6):** `quizzes` + `questions` CRUD UI (mcq/true_false only), publish flow — a lecturer hand-builds a quiz, publishes it, and it appears **live** for enrolled students.
> **Gate tests (TESTING §9):** **D5** (answer secrecy on read) · **D6** (owner reads `correct_index`) · **I20** (student blocked from every lecturer-only route). All earlier gates (E1a, D8/D12/D15–D18, E1) stay green.
> **New tests added by this plan:** D19–D24 (DB/RLS), I-Q1–I-Q13 (route-handler authZ + validation), U-Q1–U-Q7 (Zod schema), E1b (manual quiz → publish → visible to student).

---

## 1. Current state

- **Phase 2 committed:** classes + enrollment via `join_class` RPC, join codes (retry-on-collision), cross-lecturer RLS isolation, private `quiz-sources` bucket, role-aware landing pages, `requireLecturer`/`requireStudent` guards, per-process rate limiter, `verify-security.mjs` + `verify-classes.mjs` harnesses, minimal CI.
- **Baseline verified:** `npm run lint` clean · `npm run typecheck` clean · `npm test` 37/37 · graphify regenerated (no import cycles).
- **Known gaps surfaced during validation:**
  - No `quizzes`/`questions` tables or RLS yet (PLAN §1 schema not built).
  - Class detail page has a hardcoded disabled **"Quizzes"** button (`class-detail-client.tsx:67`) — placeholder to replace.
  - No student quiz list page (`(student)/student/quizzes` per PLAN §4).
  - **No request-validation dependency** — P2 hand-rolled title/code checks; P3 adds a real object payload (question), so hand-rolled validation becomes error-prone. PLAN §2 already commits to **Zod** for the AI contract (P4) — introduce it now and reuse it in P4.
  - TESTING.md P3 gate row lists D5/D6/I20 but §5 already specifies **E1b** with no gate row entry — this plan wires E1b in.
  - No route-handler test harness yet (TESTING §1 promises "route-handler invocation" for API tests) — P3 needs it for I20.
  - Docker daemon is not currently running in this workspace — local DB verification (`supabase start`, `db reset`, `gen:types`, harnesses) requires it. Not a code blocker.

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Schema** | One `quizzes` table + one `questions` table exactly per PLAN §1, plus enums (`quiz_mode`, `quiz_status`, `question_type`). | Matches the locked data model; P5/P7 reuse it as-is. |
| **Answer secrecy (D5)** | `questions` has **no student-readable SELECT policy** in P3 (owner-of-quiz only). Students see **quiz rows** (title/mode/status) but **zero question rows**. The P5 play screen later reads questions through a dedicated view/RPC that omits `correct_index` (PLAN §1). | Strictest interpretation of "`correct_index` never exposed via any client-readable policy"; zero rows is trivially secret. Avoids building a partial view now that P5 will replace. |
| **Quiz visibility** | `quizzes` SELECT = lecturer-of-class **OR** (enrolled **AND** `status='live'`). Drafts are invisible to students; the builder owner sees all statuses. | E1b requires students to see published quizzes; draft secrecy prevents answer-sheet leakage before publish. |
| **Edit locking** | `questions` are immutable once the quiz leaves `draft` — enforced by a **DB trigger** (blocks INSERT/UPDATE/DELETE when `quiz.status <> 'draft'`) **and** a route-level draft check (clean 409). `quizzes` title/mode/time-limit edits also restricted to drafts at the route. | A live/closed assessment must be tamper-proof (even by direct SQL). Trigger = defense-in-depth; route = clean status codes. |
| **Publish invariant** | A quiz can only become `live` if it has **≥1 question** and was `draft` (closed can't be re-published). Enforced by a **DB trigger** on status transition **and** a route pre-check (409 `no_questions`). Re-publishing an already-live quiz is an idempotent no-op (200). | Prevents publishing empty quizzes; keeps status machine strict; idempotent re-publish avoids client double-click errors. |
| **Request validation** | Add **`zod`** dependency now; `src/lib/quizzes/validation.ts` holds shared schemas (`CreateQuizSchema`, `UpdateQuizSchema`, `QuestionInputSchema`, `ReorderSchema`). | PLAN §2 commits to Zod for P4's `AiQuizSchema`; introducing it for the object-shaped question payload now is standard, non-hacky, and directly reused by P4. |
| **Ordering** | `questions.order_index` is a soft ordinal (no UNIQUE constraint — see robustness matrix). Client order = `ORDER BY order_index, created_at, id`. Reorder is a security-definer **RPC** (`reorder_questions`) that atomically renumbers and validates the exact id set. | Avoids the UNIQUE-constraint renumber race; gaps after delete are tolerated; reorder must be atomic (two non-transactional updates would be a hack). |
| **Route pattern** | **Server components read** directly from Supabase (RLS applies — same as P2 pages); **all mutations** go through route handlers (`app/api/...`) that self-check authz via `requireLecturer` + explicit owner pre-check. | Consistent with P2; route handlers are testable (I20) and own their authz (middleware only blocks unauthenticated `/api/*`). |
| **Quiz ownership chain** | `quizzes.created_by` = creator for audit, but **authorization ownership is class ownership** (`quizzes.class_id → classes.lecturer_id`), matching RLS. New security-definer helper `is_lecturer_of_quiz(quiz_id)` breaks RLS cross-table recursion (same pattern as `is_lecturer_of_class`). | Route guards and RLS never drift apart; the class detail page only shows quizzes for classes the lecturer owns. |
| **Question type rules** | `mcq`: 2–5 distinct options. `true_false`: **exactly 2** options (UI defaults to "True"/"False"). `correct_index` must be `< options.length`. Distinct-options CHECK on the array. | Matches the gesture mapping (1–5 fingers; 1 finger = true, 2 = false). Duplicate options are ambiguous for finger selection. |

## 3. Work breakdown

### Step 0 — Prereqs & blockers
1. Start Docker Desktop (local Supabase verification requires the daemon; CI is unaffected).
2. `npm i zod` (runtime dependency — route validation; NOT a devDep).
3. `git pull`/rebase to latest `main` before branching; confirm baseline gates green (already verified above).

### Step 1 — Migration `0004_quizzes.sql`
- Enums (idempotent `do $$` blocks): `quiz_mode ('practice','assessment')`, `quiz_status ('draft','live','closed')`, `question_type ('mcq','true_false')`.
- `quizzes`:
  ```sql
  create table if not exists public.quizzes (
    id              uuid primary key default gen_random_uuid(),
    class_id        uuid not null references public.classes (id) on delete cascade,
    created_by      uuid not null references public.profiles (id) on delete cascade,
    title           text not null check (char_length(trim(title)) between 1 and 200),
    mode            public.quiz_mode not null default 'practice',
    status          public.quiz_status not null default 'draft',
    time_limit_sec  int check (time_limit_sec is null or time_limit_sec between 1 and 7200),
    source_file_url text,                                   -- null until P4 (manual builder)
    created_at      timestamptz not null default now()
  );
  create index if not exists quizzes_class_id_idx on public.quizzes (class_id);
  ```
- `questions`:
  ```sql
  create table if not exists public.questions (
    id            uuid primary key default gen_random_uuid(),
    quiz_id       uuid not null references public.quizzes (id) on delete cascade,
    order_index   int not null check (order_index >= 0),
    type          public.question_type not null,
    prompt        text not null check (char_length(trim(prompt)) between 1 and 2000),
    options       text[] not null check (cardinality(options) between 2 and 5),
    correct_index int not null check (correct_index >= 0 and correct_index < cardinality(options)),
    explanation   text,
    created_at    timestamptz not null default now(),
    check (type <> 'true_false' or cardinality(options) = 2),
    -- distinct options (no ambiguous finger targets); subquery over the row's own array is legal in CHECK
    check (cardinality(options) = (select count(distinct o) from unnest(options) as o))
  );
  create index if not exists questions_quiz_id_idx on public.questions (quiz_id);
  ```
  > If the distinct-options subquery CHECK causes any migration friction on the pinned Postgres, drop that single CHECK and keep it in Zod only — the app layer always trims/deduplicates.
- RLS helpers: `is_lecturer_of_quiz(p_quiz_id uuid)` (security definer, `search_path` pinned, execute revoked from `public`/`anon`, granted to `authenticated`) — joins `quizzes → classes` and checks `lecturer_id = auth.uid()`.
- Grants: `authenticated` + `service_role` select/insert/update/delete on both tables.
- RLS policies:
  - `quizzes` SELECT: `is_lecturer_of_class(class_id) OR (is_enrolled_in_class(class_id) AND status = 'live')`
  - `quizzes` INSERT: `WITH CHECK (auth.uid() = created_by AND is_lecturer_of_class(class_id) AND is_lecturer())`
  - `quizzes` UPDATE: `USING (is_lecturer_of_class(class_id)) WITH CHECK (is_lecturer_of_class(class_id) AND is_lecturer())`
  - `quizzes` DELETE: `USING (is_lecturer_of_class(class_id))`
  - `questions` SELECT/INSERT/UPDATE/DELETE: `is_lecturer_of_quiz(quiz_id)` only (students denied entirely → D5).
- Triggers (defense-in-depth):
  - `quiz_status_transition` (BEFORE UPDATE OF status) — explicit one-way state machine:
    - allowed: `draft→live` (**requires ≥1 question**), `draft→closed`, `live→closed`; no-op `live→live` (idempotent re-publish).
    - **blocked: `live→draft`, `closed→draft`, `closed→live`** — a quiz that has been live/closed must never return to an editable state (would let a lecturer re-open a taken assessment and alter questions). Even though P3 has no sessions yet, the state machine is correct from day one.
  - `questions_draft_only` (BEFORE INSERT/UPDATE/DELETE on questions): raise unless parent quiz `status = 'draft'`.
- `reorder_questions(p_quiz_id uuid, p_ordered_ids uuid[])` security-definer RPC: re-checks `auth.uid()` + `is_lecturer_of_quiz`; validates `cardinality(ordered_ids) = count(questions)` and that every id belongs to the quiz; renumbers `order_index = 0..n-1` in one function (single transaction). Raises typed exceptions (`not_owner`/`id_count_mismatch`/`foreign_question_id`) mapped by the route to 404/400.

### Step 2 — Types + validation + pure helpers
- `npm run gen:types` → commit regenerated `database.ts` (new tables/enums/function). Aliases stay in `aliases.ts`.
- `src/lib/quizzes/validation.ts` (Zod):
  - `QuestionInputSchema`: `type` enum; `prompt` trimmed 1–2000; `options` array 2–5 of trimmed 1–500 strings; `correctIndex` int ≥0; `explanation` optional/nullable trimmed ≤2000; `.superRefine` → `correctIndex < options.length`, `true_false ⇒ options.length === 2`, distinct options.
  - `CreateQuizSchema`: `title` 1–200; `mode` default `practice`; `timeLimitSec` int 1–7200 nullable optional.
  - `UpdateQuizSchema = CreateQuizSchema.partial()`.
  - `ReorderSchema`: `questionIds` array of UUIDs min 1.
- `src/lib/quizzes/guards.ts`: `requireQuizOwner(supabase, quizId)` and `requireClassOwner(supabase, classId)` — ownership is **class ownership** (`quizzes.class_id → classes.lecturer_id = auth.uid()`), matching RLS exactly (not `created_by`, which could drift). Fetch the row joined owner-filtered (404 when not found/not owned, no oracle), return typed `{ok, userId}` or 404/503 responses. Reuses the `requireUser` core from `lib/classes/guards.ts` (extract/export it rather than duplicating).
- Unit tests `src/lib/quizzes/validation.test.ts`: U-Q1 valid mcq, U-Q2 valid true_false, U-Q3 `correctIndex` ≥ options.length rejected, U-Q4 true_false with 3 options rejected, U-Q5 duplicate options rejected, U-Q6 empty/whitespace prompt rejected, U-Q7 wrong type / >5 options / title bounds rejected.

### Step 3 — Route handlers (all mutations; reads stay in server components)
- `POST /api/classes/[id]/quizzes` — `requireLecturer` → UUID check → `requireClassOwner` → Zod body → insert (status `draft`, `created_by = auth.userId`) → 201 `{ quiz }`. Student → 403; non-owner lecturer → 404.
- `PATCH /api/quizzes/[id]` — `requireLecturer` → UUID → `requireQuizOwner` → draft-only 409 → Zod partial update (title/mode/time_limit_sec) → 200 `{ quiz }`.
- `DELETE /api/quizzes/[id]` — `requireLecturer` → UUID → `requireQuizOwner` → delete (cascade questions) → `{ ok: true }`. (P5+ adds a "block when sessions exist" guard — no sessions in P3.)
- `POST /api/quizzes/[id]/publish` — `requireLecturer` → UUID → `requireQuizOwner` → already-live → idempotent 200; closed → 409; count questions (0 → 409 `no_questions`); `UPDATE status='live'` (trigger is the backstop; map trigger exceptions to 409/503, never raw). → 200 `{ quiz }`.
- `POST /api/quizzes/[id]/questions` — `requireLecturer` → UUID → `requireQuizOwner` → draft-only 409 → Zod body → `order_index = max+1` (single `select max(order_index)`) → insert → 201 `{ question }`.
- `PATCH /api/quizzes/[id]/questions/[questionId]` — `requireLecturer` → both UUIDs → `requireQuizOwner` → draft-only 409 → Zod **full** body → update (map camelCase → `correct_index`) → 200 `{ question }`.
- `DELETE /api/quizzes/[id]/questions/[questionId]` — `requireLecturer` → UUIDs → `requireQuizOwner` → draft-only 409 → delete → `{ ok: true }` (order gaps tolerated).
- `POST /api/quizzes/[id]/reorder` — `requireLecturer` → UUID → `requireQuizOwner` → draft-only 409 → Zod `ReorderSchema` → `rpc('reorder_questions')` → map typed RPC errors (`id_count_mismatch`/`foreign_question_id` → 400, `not_owner` → 404) → 200 `{ ok: true }`.
- Every handler: invalid JSON → 400; non-UUID params → 404; Supabase errors → 503 (typed), never a raw message. All bodies validated with Zod (400 `invalid_body` + issue details).

### Step 4 — Pages & navigation
- `(lecturer)/lecturer/classes/[id]/page.tsx` + `class-detail-client.tsx` — replace the disabled **Quizzes** button with a real **Quizzes** section: list quizzes (title, mode badge, status badge), link each to `/lecturer/quizzes/[id]/builder`, and a "New quiz" form (title + mode + optional time limit).
- `(lecturer)/lecturer/quizzes/[id]/builder/page.tsx` (server component, PLAN §4 path) — resolve ownership first (`quiz.class_id → classes.lecturer_id = auth.uid()`, RLS + explicit filter; `notFound()` otherwise — never leak another lecturer's quiz or a draft to a student); fetch quiz + questions ordered; if quiz is `live`/`closed`, render read-only banner and disable all mutating controls; if `draft`, render the builder.
- `quiz-builder-client.tsx` — add-question form (type select → options editor [mcq: dynamic 2–5 inputs; true_false: fixed True/False with a correct-answer toggle], correct-answer radio, explanation textarea), question list with edit/delete/move-up/move-down (reorder via API), **Publish** button (disabled when 0 questions), error/empty states, ref-lock on submits (P2 pattern).
- `(student)/student/quizzes/page.tsx` — server component listing live quizzes from enrolled classes (title, class title, mode badge, time limit if set); empty state "No quizzes available yet". Add a `UserNav` header consistent with `student/classes`.
- Role-aware redirects already flow through `/dashboard` — no middleware change.

### Step 5 — Tests (gate)
- **Route-handler tests** `src/app/api/**/*.test.ts` (Vitest + `vi.mock("@/lib/supabase/server")` returning a stub `createClient`; TESTING §1 "route-handler invocation"): I20 sweep (student → 403 on every mutation route), I-Q8 non-owner lecturer → 404, I-Q9 invalid body → 400, I-Q10 publish with 0 questions → 409, I-Q11 edit live quiz question → 409, I-Q12 add question happy path → 201 + correct `order_index`, I-Q13 reorder happy path (RPC stub).
- **`scripts/verify-quizzes.mjs`** (extends the proven harness; real anon-token clients; live DB):
  - D5: student SELECT `questions` → 0 rows; student never sees `correct_index`.
  - D6: owner lecturer reads questions → `correct_index` present.
  - D19: owner creates quiz (draft), adds 3 questions, `reorder_questions` works, publishes → live.
  - D20: lecturer B cannot read A's quiz/questions (0 rows); student cannot create a quiz in A's class; lecturer B cannot create in A's class.
  - D21: UPDATE `status='live'` on a 0-question quiz → trigger error.
  - D22: after publish, question INSERT/UPDATE/DELETE → trigger error; title edit via DB still possible (route-level draft check is app-layer; DB locks questions only).
  - D23: enrolled student sees the live quiz row but not the draft quiz; unenrolled student sees nothing.
  - D24: re-open transitions (`live→draft`, `closed→live`) → trigger error (state machine is one-way).
- **E2E `e2e/e1b-manual-quiz.spec.ts`** (E1b): lecturer creates class → opens builder → adds 3 questions (mcq + true_false) → publishes → student (separate context) sees the quiz on `/student/quizzes` with a mode badge. Keep **E1a/E1 green** (invite-code env-driven, timestamped emails, service-role cleanup — reuse `helpers.ts`).
- Update `docs/TESTING.md` (§3 add D19–D24; §4 add I-Q1–I-Q13; §9 P3 gate row adds **E1b** and notes D19–D24/I-Q).

### Step 6 — CI
- Add `verify:quizzes` script (`package.json`) and a `node scripts/verify-quizzes.mjs` step in `.github/workflows/ci.yml` (after `verify:classes`). Route-handler tests run under the existing `npm test` (Vitest glob already covers `src/**/*.test.ts`). No other CI changes.

### Step 7 — Verification & graph refresh
- `npm run lint` · `typecheck` · `build` · `vitest run` · `playwright test` · `node scripts/verify-security.mjs` + `verify-classes.mjs` + `verify-quizzes.mjs` (requires Docker up).
- `graphify update .` — re-check for new import cycles/structural issues (none expected; all new modules are leaves or reuse existing `cn()`/`createClient()` hubs).

## 4. Robustness / edge-case matrix

| Area | Guard |
|---|---|
| Answer secrecy | `questions` has no student SELECT policy (0 rows, D5); `correct_index` only ever returned to the owner; draft quizzes invisible to students (D23); `quizzes` is owner-only — students read `student_quiz_view` (no `source_file_url`/`created_by`) |
| Column secrecy (M-1/MED-1) | `classes`/`quizzes` owner-only; students read `student_class_view`/`student_quiz_view` (security_barrier, gated by `is_enrolled_in_class`); lecturers read `student_roster_view` (no `face_embedding`); direct `profiles` SELECT is self-only |
| Live-quiz tampering | DB triggers block question DML + `quiz_id` moves + metadata edits once `status <> 'draft'` (even direct SQL) + route 409; builder renders read-only when live |
| Publish validity | DB trigger enforces a one-way state machine (`draft→live` needs ≥1 question; **no `live→draft`/`closed→live` re-open**; `INSERT` must start `draft`); advisory-lock re-check prevents a stale idempotent publish from re-opening a closed quiz; route pre-checks for clean 409 |
| `correct_index`/options consistency | Zod `.superRefine` + DB CHECKs (`correct_index < cardinality(options)`; `true_false ⇒ 2 options`; distinct after case/trim) + length backstops (option ≤500, explanation ≤2000, prompt ≤2000, title ≤200, time_limit 1..7200) — shrink-options-on-edit can't orphan the answer |
| Ordering | Soft ordinal, no UNIQUE race; `ORDER BY order_index, created_at, id`; gaps after delete tolerated; reorder is an atomic security-definer RPC that validates the exact id set (no foreign ids, no count drift); appends serialized by `append_question` advisory lock |
| Concurrency | `append_question` computes `order_index = MAX+1` under a per-quiz advisory lock (no duplicates, D32); publish-vs-add race fail-closed via the RPC's in-transaction status re-read; reorder staleness → typed 400 + client refresh |
| AuthZ (I20) | `requireUser` on every mutation route (student → 403); explicit owner pre-check → clean 404 for non-owner lecturers (no oracle); `is_lecturer_of_quiz` is security-definer (breaks RLS recursion) with execute revoked from anon/public |
| Input handling | Zod at the boundary (trimmed lengths, enums, ranges); non-UUID params → 404; invalid JSON → 400; Supabase errors → 503 typed; XSS avoided by React escaping (no `dangerouslySetInnerHTML`) |
| Cascades | Class delete → quizzes → questions (FK ON DELETE CASCADE); `questions_draft_only` allows the cascade but blocks direct deletes on live quizzes; `source_file_url` null in P3 (storage untouched) |
| Student direct PostgREST | `classes`/`quizzes`/`profiles` return 0 rows to students (owner/self-only); views leak only the minimal columns; no `correct_index`/join_code/embedding path exists |
| Route param forgery | UUID regex pre-check (mirrors `isUuid` in `lib/classes/roster.ts`) before any DB call |

## 5. Risks / open items
- **Docker daemon down locally** — DB harnesses/`gen:types`/E2E need it; CI (ubuntu) is unaffected. Start Docker Desktop before local verification.
- **`source_file_url` exposure (resolved)** — students now read `student_quiz_view` (no `source_file_url`/`created_by`); `quizzes` is owner-only. P4 must still keep file access storage-only and never render raw paths to students.
- **Quiz delete vs future sessions** — P3 allows delete (no sessions exist). P5/P8 must block or soft-delete quizzes that have `quiz_sessions` rows (otherwise results/attendance orphan). Tracked as a P5 constraint.
- **`updated_at` omitted** — YAGNI; add only if the results dashboard (P8) needs it.
- **Rate limiting on quiz mutations** — deliberately deferred (owner-only writes at demo scale; join/invite already throttled). Noted in SECURITY_AUDIT future-work.
- **In-memory rate limiter is per-process** — on multi-instance Vercel the join/invite budgets multiply by instance count. Accepted at demo scale; documented in code.
- **Plan drift:** PLAN.md stack line already fixed in P2 (Next 16.3.0) — no further drift.

## 6. Gate traceability

| Gate | Proven by |
|---|---|
| D5 (answer secrecy on read) | verify-quizzes.mjs D5 + TESTING §3 D5 (student SELECT questions → 0 rows) |
| D6 (owner reads key) | verify-quizzes.mjs D6 (owner reads `correct_index`) |
| I20 (authZ sweep) | route-handler tests I-Q1–I-Q7 (student → 403 on every lecturer-only route) |
| E1b (manual quiz → publish → visible) | `e2e/e1b-manual-quiz.spec.ts` |
| Earlier gates stay green | CI re-runs verify:security, verify:classes, E1a/E1, full vitest |

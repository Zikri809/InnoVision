# InnoVision — Phase 2 (Classes) Implementation Plan

> **Status: EXECUTED** (classes, join codes, roster). Historical plan — kept as the record of what was built and why.
> **Depends on:** Phase 1 (Scaffold) — committed, gates green.
> **Phase 2 deliverable (PLAN §6):** `classes` + `class_enrollments`, 6-char join codes with retry-on-collision, student enrollment via code, cross-lecturer RLS isolation, private `quiz-sources` bucket, class CRUD + role-guarded pages.
> **Gate tests:** **D8** (lecturer B cannot read lecturer A's classes) · **D12** (`quiz-sources` owner-only) · **E1** (class → join via code → roster updates). Plus all earlier gates stay green (E1a).

---

## 1. Current state

- **Phase 1 committed:** Next.js 16.3 + Supabase + shadcn; email auth via server actions; `profiles` RLS locked down (self-signup always `student`, no insert policy, `service_role` granted); E1a E2E green; security audit applied.
- **Known gaps surfaced during validation:**
  - No way to create a lecturer (Phase 1 fix hardcodes `student`; audit's "privileged path" never built). → **Blocker**, resolved by invite-code provisioning.
  - Supabase CLI not installed (Docker available) → all DB scripts + gate tests dead until added.
  - Middleware intercepts `/api/*` and 307-redirects to a login HTML page → route-handler calls get confusing HTML. Must exclude `/api` from the auth matcher (route handlers own their auth).
  - Direct `INSERT` policy on `class_enrollments` would let students enroll by leaked UUID without the code → must be RPC-only.
  - `classes` UPDATE policy needs `WITH CHECK` (owner can't transfer class).
  - Roster requires a "lecturer reads enrolled students' profiles" policy (currently read-own only).
  - Invite-code lecturer gate will break the existing E1a spec unless updated.
  - Plan drift: PLAN.md says Next.js 15; code is 16.3.0.

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Lecturer provisioning** | **`LECTURER_INVITE_CODE` env secret** — register page shows an invite-code field when "Lecturer" is selected; server action validates (constant-time) before `signUp`, then promotes via a **service-role admin client** (`src/lib/supabase/admin.ts`). DB trigger stays strict (`student`); `user_metadata.role` stays untrusted. | Matches SECURITY_AUDIT's "privileged path" note. Only a valid invite code + server action can produce a lecturer; raw `signUp` still yields `student`. Usable, no CLI. |
| **Test infra** | **Add Supabase CLI as devDependency** + extend `scripts/verify-security.mjs` → `scripts/verify-classes.mjs` (real anon-token clients) for D8/D12; **minimal GitHub Actions CI** as final step. | CLI is a prerequisite for every existing script (`db:reset`, `gen:types`, `supabase:start`). The Node harness is the proven pattern and exercises the JS/storage client D12 depends on. |
| **Enrollment path** | `join_class(code)` security-definer RPC is the **only** insert path into `class_enrollments` (no direct INSERT policy). | Closes code-free enrollment by leaked UUID; mirrors the profiles no-insert-policy pattern. |
| **Mutations** | Route handlers (`app/api/classes/*`) using the **anon cookie client** (RLS applies); never service-role for user-scoped writes. Server actions remain for auth. | Testable with Vitest+MSW per TESTING §4; matches PLAN §2. |

## 3. Work breakdown

### Step 0 — Prereqs & blockers
1. `npm i -D supabase`; verify `supabase start` / `db reset` locally (Docker v29.6.2 ✓, Node 22 ✓).
2. **Fix middleware `/api` handling** (`src/lib/supabase/middleware.ts` + `proxy.ts`): exclude `/api/*` from the matcher (route handlers own their auth, return JSON 401).
3. **Invite-code lecturer provisioning**:
   - `.env.local` / `.env.local.example`: add `LECTURER_INVITE_CODE=`.
   - `src/lib/supabase/admin.ts`: service-role client (`createClient(url, SERVICE_ROLE, { auth: { persistSession: false } })`).
   - `src/lib/auth/register.ts`: accept `inviteCode`; if role claimed is lecturer → `timingSafeEqual` vs env; on success, after `signUp`, `admin.auth.admin.updateUserById(...)` + `admin.from('profiles').update({ role: 'lecturer' })` (upsert fallback for trigger race). Validate **before** creating the account.
   - `src/app/(auth)/register/page.tsx`: conditional "Lecturer invite code" input.
   - **Update `e2e/e1a-auth-consent.spec.ts`** to fill the invite code from `process.env.LECTURER_INVITE_CODE` — keeps Phase 1 gate green.

### Step 1 — Migration `0002_classes.sql`
- `classes(id uuid PK default gen_random_uuid(), lecturer_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, title text NOT NULL CHECK(char_length(trim(title)) BETWEEN 1 AND 200), join_code text NOT NULL UNIQUE CHECK(join_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'), created_at timestamptz NOT NULL DEFAULT now())`; index on `lecturer_id`. (Alphabet = 32 chars ≈ 1.07B space; excludes `0/O/1/I`; `L` optional.)
- `class_enrollments(class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE, student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, enrolled_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(class_id, student_id))`; index on `student_id`.
- **RLS**:
  - `classes`: SELECT = `lecturer_id = auth.uid() OR EXISTS(select 1 from class_enrollments ce where ce.class_id = classes.id and ce.student_id = auth.uid())` (students never see unenrolled classes → join-code secrecy); INSERT = `auth.uid() = lecturer_id AND role='lecturer'`; UPDATE/DELETE = owner-only **with `WITH CHECK (lecturer_id = auth.uid() AND role='lecturer')`**.
  - `class_enrollments`: SELECT = lecturer-of-class OR own row; **no INSERT policy**; DELETE = self-unenroll OR lecturer-of-class.
  - **profiles**: add "Lecturer reads enrolled students' profiles" SELECT policy (`exists(... c.lecturer_id = auth.uid())`); relax update `WITH CHECK` to "cannot change role" instead of "must be student" so lecturers can edit their own `full_name` without self-escalation: `role = (select p.role from profiles p where p.id = auth.uid())`.
- Grants: `authenticated` + `service_role` (select/insert/update/delete) on both tables.
- **`join_class(code text)`** security-definer RPC:
  - `set search_path = public`; `revoke execute from public, anon`; `grant execute to authenticated`.
  - Internally: re-check `auth.uid() IS NOT NULL` and caller role = `student`; `code := upper(trim(code))`; find class by join_code; `insert into class_enrollments ... on conflict (class_id, student_id) do nothing returning ...`; map 0 rows → `already_enrolled`, not found → `invalid_code`; return `jsonb` `{class:{id,title}} | {error:...}` — **student_id hardcoded to `auth.uid()`**, never a param; **don't return join_code**.
  - Idempotent: re-join → `already_enrolled`; unenroll→rejoin works.

### Step 2 — Migration `0003_storage.sql` (D12)
- Idempotent bucket: `insert into storage.buckets (id, name, public) values ('quiz-sources','quiz-sources',false) on conflict (id) do nothing;`
- Grants: `select on storage.buckets` + `select, insert, update, delete on storage.objects` to `authenticated`.
- Policies on `storage.objects` (scoped `bucket_id='quiz-sources'`, `drop policy if exists` then create), keyed on **`storage.foldername(name)[1] = auth.uid()::text`** (NOT `owner`, which is NULL for service-role uploads): owner (lecturer) read/write/delete in own folder; students denied entirely.

### Step 3 — Types + pure helpers
- `npm run gen:types` → commit regenerated `database.ts` (RPC return type for `join_class` as jsonb).
- `src/lib/classes/join-code.ts`: `generateJoinCode(rng?)` (crypto default, injectable RNG; rejection sampling), `normalizeJoinCode(input)` (trim → uppercase → strip internal spaces/dashes → regex-reject), `createClassWithRetry(insert)` (3 attempts via `ON CONFLICT (join_code) DO NOTHING` — never exception-based retry inside one transaction).
- `src/lib/classes/*.test.ts` (Vitest): format regex, alphabet membership (no `0/O/1/I/L`), uniqueness over 100k samples, injected-RNG determinism, normalization cases, retry-count logic.

### Step 4 — Route handlers (`app/api/classes/*`)
- `POST /api/classes` — `requireLecturer(supabase)`; normalize title; insert with retry; return class + join_code (201).
- `GET /api/classes` — owner OR enrolled (one query via the SELECT policy; returns `archived_at`).
- `GET /api/classes/[id]` — owner → full detail + roster + `archived_at` (uses new profiles policy); student → title only (omit roster, 200 not 500).
- `PATCH /api/classes/[id]` — owner-only update: support `{ title?: string, archived?: boolean }` to rename or archive/restore classes.
- `DELETE /api/classes/[id]` — **soft delete (archive) by default**: sets `archived_at = now()`, safely preserving all quizzes, questions, student rosters, face verification logs, and scores for grade disputes and audit compliance.
- `POST /api/classes/join` — `requireStudent(supabase)`; body `{code}`; call `join_class`; map typed errors → 400 malformed / 404 `invalid_code` / 409 `already_enrolled` / 403 `not_student` / 400 `class_archived`.
- Auth helpers `src/lib/classes/guards.ts`: `requireLecturer/requireStudent(supabase)` read the profile, return `403` typed responses. (Layout guards are for pages; route handlers must self-check — they're hit directly.)

### Step 4b — Soft Delete & Archiving Subsystem (`0017_class_archiving.sql` & `0018_class_archived_index.sql`)
- **Schema & Migrations**:
  - `0017_class_archiving.sql`: Add `archived_at timestamptz default null` to `classes`, partial index `classes_lecturer_active_idx`.
  - `0018_class_archived_index.sql`: Add partial composite index `classes_lecturer_archived_idx ON public.classes (lecturer_id, archived_at desc, created_at desc) WHERE archived_at IS NOT NULL` for sub-millisecond retrieval on the archive route.
- **Security & Views**:
  - `student_class_view`: Hardened with `where c.archived_at is null` so enrolled students only see active classes.
  - `student_quiz_view`: Enforces `c.archived_at is null` to hide quizzes of archived classes.
  - `join_class` RPC: Rejects attempts to join an archived class with typed `{ error: "class_archived" }`.
  - `start_quiz_session` RPC: Rejects sessions on archived classes with `{ error: "quiz_not_live" }`.
- **Dedicated Archive Page (`/lecturer/classes/archived`) & Dashboard Navigation**:
  - Main dashboard `/lecturer/classes`: Streamlined to render only active classes with an interactive `[ 📦 Archived classes ({count}) → ]` header pill and a 3-stat hero cluster.
  - Dedicated page `/lecturer/classes/archived`: Server Component with instant client-side search (`search.ts` with diacritic normalization and multi-word token matching), responsive Clay cards, "View audit →" dispute review links, and safe restore dialogs.
  - Detail view `/lecturer/classes/[id]`: Preserves complete student roster, quiz scores, and biometric audit logs for dispute resolution, with back navigation returning to `/lecturer/classes/archived` when viewing archived classes.

### Step 5 — Pages & navigation
- `(lecturer)/lecturer/classes/page.tsx` (list + create + show join code), `(lecturer)/lecturer/classes/[id]/page.tsx` (roster; quizzes placeholder for P3).
- `(student)/student/classes/page.tsx` (join-by-code + my classes).
- Role-aware post-login redirect: `dashboard/page.tsx` → `/lecturer/classes` vs `/student/classes`; middleware's hardcoded `/dashboard` redirect updated; `router.refresh()` after login (layout-cache caveat).

### Step 6 — Tests (gate)
- **`scripts/verify-classes.mjs`** (extends proven harness; real anon-token clients):
  - **D8**: lecturer A owns a class; lecturer B sees 0 classes + 0 enrollments for A's; student sees 0 pre-join, 1 post-join (secrecy).
  - **D12**: A uploads (service-role into A's folder) → A downloads OK; student + lecturer B download and `createSignedUrl` denied; student upload into A's folder denied; bucket `public=false`.
  - **Join RPC**: valid → class; repeat → `already_enrolled`; bad code → `invalid_code`; lecturer → `not_student`; concurrent double-join → exactly one success.
  - **Escalation**: student direct-insert enrollment fails; student create/update class fails; lecturer `UPDATE ... SET lecturer_id=other` fails (WITH CHECK).
- **E2E `e2e/e1-classes.spec.ts`** (P2 scope): two browser contexts; register lecturer (with invite code) → create class → capture join code from DOM → register student → join → assert roster via auto-retry (`toHaveText`, `waitForResponse('**/api/classes/**')`), unique `Date.now()` emails, cleanup via service role. **Keep E1a green** (updated for invite code).
- Update `docs/TESTING.md`: disambiguate **E1 (P2)** class→join→roster vs **E1b (P3)** quiz-publish; add new DB cases D15 (join idempotency), D16 (concurrent double-join), D17 (lecturer-join blocked), D18 (join_code CHECK rejects `ABC01!`).

### Step 7 — CI (minimal GitHub Actions)
- `.github/workflows/ci.yml`: setup-node 22 → `npm ci` → `supabase start` → write `.env.local` from `supabase status -o env` → `db reset` → `verify-security.mjs` + `verify-classes.mjs` → `vitest run` → lint/typecheck → `test:e2e`. Makes "gates blocking in CI" true.

### Step 8 — Verification & graph refresh
- `npm run lint`, `typecheck`, `build`, `vitest run`, `test:e2e`, `node scripts/verify-security.mjs` + `verify-classes.mjs`.
- **Regenerate graphify** (`graphify update`/extract) and re-check for new import cycles / structural issues.

## 4. Robustness / edge-case matrix

| Area | Guard |
|---|---|
| Join-code secrecy | No unenrolled-class visibility; generic `invalid_code` error (no oracle); RPC-only enrollment |
| Concurrency | `ON CONFLICT (join_code)` + retry for create; `ON CONFLICT (class_id, student_id)` for join (no exception → no txn abort) |
| Security-definer hygiene | `search_path` pinned, execute revoked from public/anon, internal role+uid re-check, `student_id=auth.uid()` hardcoded |
| Storage | foldername-keyed policies (owner NULL gotcha); explicit grants; idempotent bucket; signed-URL denial tested |
| Route authZ | Self-checking guards on every handler (can't rely on layouts); explicit owner pre-check for 404/403 distinction |
| Cascades | FKs `ON DELETE CASCADE`; note storage-object cleanup on class/lecturer delete (manual, acceptable at demo scale) |
| E2E flake | env-driven invite code, timestamped emails, auto-retry assertions, service-role cleanup |

## 5. Risks / open items
- **CI deferral** possible, but Step 7 is included to honor the "blocking in CI" gate rule.
- **Plan drift:** PLAN.md says Next 15; code is 16.3.0 → fix stack line in PLAN.md.
- **Rate limiting** on join (code brute-force) intentionally deferred (MVP, auth required, no privilege escalation); noted in SECURITY_AUDIT future-work.

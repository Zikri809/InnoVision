# InnoVision — Phase 8 (Results & Attendance) Implementation Plan

> **Status: EXECUTED** — design record for the Phase-8 dashboard (results, reset, audit views). E2E coverage was partially deferred.
>
> ⚠️ **Since this plan shipped**, the integrity suite (migrations 0020/0021) EXTENDED this surface: per-type advisory chips (`second_face` / `looked_away` / `voice_activity` / `headset_active`), the `focus_pause_count` line, and incident-clip playback with signed URLs. The body below describes Phase-8 scope only — for the full current surface read **docs/PLAN_INTEGRITY_SUITE.md**.
> **Depends on:** Phase 5 (play screen) + Phase 7 (face pipeline, CompreFace) — both committed; all P7 gates green.
> **Phase 8 deliverable (PLAN §6):** Lecturer dashboard: sessions = attendance (incl. **"abandoned"** derived state), scores, face-check timeline, flags, **unlock + face-exempt + session-reset buttons** (all audited). The **source-text preview in builder** is a P8-row item that is **ALREADY DELIVERED** (`SourceTextPreview` in `quiz-builder-client.tsx` — no new work).
> **Gate tests (TESTING §9):** **U-T4** (abandoned derived state) · **I21** (session-reset releases the one-attempt slot) · **E5b** (lecturer resets attempt) · **E13b** (attendance = session; renamed from the doc-colliding `E13`, see §7/D12). Audit rows verified via **D13**.
> **UI-rewrite constraint (top of mind):** an upcoming UI rewrite is expected. This plan therefore focuses the durable work on the **data/API/logic layer** (migration, RPC, view, pure derivation, reset route, play-client 404 branch) and keeps the presentational dashboard **thin and conventional** (server-component reads + one client component + existing shadcn primitives). All display logic lives in pure, unit-tested `lib/results/` so a rewrite touches only presentational files.
> **Review status:** iterations 1–3 of the critic loop incorporated (§9 — audit trail). Iteration-3 final coherence audit: **CONVERGED — no Critical/High/Medium remains.**

---

## 1. Current state (what exists / what is missing)

**What exists (do not rebuild):**
- `quiz_sessions` (incl. `face_fail_streak`, `face_exempt`, `verify_nonce`, `last_activity_at`, `face_unavailable_at`), `session_answers`, `face_checks` (incl. `suspected_replay`, `too_frequent`, `frame_hash`), `audit_events` — full DDL in 0008/0009/0010.
- RLS already lets the **quiz lecturer read** `quiz_sessions`, `session_answers`, `face_checks` (`is_lecturer_of_quiz`, `is_session_owner_or_lecturer` policies). **Writes are RPC-only** (privilege layer: `select` only for `authenticated`).
- `student_roster_view` → `getClassRoster(supabase, classId)` returns `{ student_id, full_name, enrolled_at }` for a class (lecturer-scoped). Fetches names for the dashboard.
- Lecturer-action routes that exist: `POST /api/face/unlock` (lecturer, audited), `POST /api/sessions/[id]/exempt-face` (lecturer, audited). E7's unlock is route-based today — **the dashboard buttons are P8's job**.
- `GET /api/sessions/[id]` envelope (`ENVELOPE_COLS` literal, lecturer omits `verify_nonce`), builder RSC + `SourceTextPreview`, the `quiz_has_sessions` delete guard, `requireQuizOwner`/`requireLecturer` guards, CSRF/rate-limit helpers, FakeSupabase + `fakeHolder` route-test pattern, `verify-*.mjs` harness pattern, coverage per-file thresholds.
- `scripts/verify-face.mjs` already probes **D13** (audit rows on unlock/exempt/self-recover/consent_revoked/re-enroll).

**What does not exist (built here):**
- A results page (`lecturer/quizzes/[id]/results/`) and any navigation to it.
- Any session-listing data path for a quiz (reads via RSC — see D1; no API route).
- `DELETE /api/sessions/[id]/reset` **and** any reset capability (the `"Lecturer can delete session"` DELETE policy on `quiz_sessions` exists as dead code — `authenticated` has no DELETE grant; writes stay RPC-only).
- A **lecturer-facing view over `audit_events`** (currently service-role only; 0009 comment: "P8 adds a lecturer view").
- The U-T4 **abandoned** derivation (pure helper + unit test) — `last_activity_at` is schema-completeness today.
- `src/lib/results/` module; `verify:results` script; E13b/E5b/E14 E2E specs; the play-client **`not_owner` (session reset mid-flight) branch**.

**Key constraints (verified):**
- `quiz_sessions`/answers/`face_checks` **mutations are RPC-only** (0008/0009 grants; HEADER invariants). Session reset is therefore a **security-definer RPC**, not a raw `DELETE` in the route.
- Answer secrecy: the student's own-session SELECT policy must never expose `correct_index`/`explanation`. The lecturer's results read is fine (D6 — lecturer reads the key). The dashboard shows **score + per-session `is_correct`** only (never `correct_index`).
- **`audit_events.subject_id` conventions (verified in 0009/0010):** `face_enroll`/`face_reenroll`/`consent_revoked`/`self_recover` → **student uid**; `unlock`/`exempt_face` → `v_session.student_id` (**student uid**). `subject_id` is always a **profile/student uid**. Only **new** P8 rows carry `metadata.session_id`/`quiz_id` (fully attributable).
- `verify_nonce` is a per-student replay token: the results RSC must **explicitly not select** it (envelope precedent).
- The one-attempt race is closed by the partial unique index **at the table level** — deleting a session row frees the slot automatically (no migration needed for I21/E5b). **Corollary: no second assessment session can be inserted for an existing (quiz, student) — the E2E abandoned-seed must UPDATE, never INSERT (E13b).**
- `class_enrollments` has **no `left_at` snapshot** and a **self-unenroll DELETE policy** (0002) — current-membership predicates are subject to change; audit-view visibility must be event-scoped where possible (D4).
- The P7 locked-query invariant is **"never row-lock a foreign id"** — the lecturer gate goes in the `WHERE` of the locked SELECT, before the lock is taken (0008/0009 comments; `unlock_session`/`exempt_face_session`). `reset_session` must follow it literally (D2).

---

## 2. Locked decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D1** | **Results read = lecturer RSC (no new read API route)** | `results/page.tsx` is a server component (`force-dynamic`) that reads `quiz_sessions` + `student_roster_view` + `face_checks` (batched `.in`) + `lecturer_audit_view` (`.in("subject_id", sessionStudentIds)` — attribution applied in JS per D6/D8) directly (RLS-scoped) and builds typed rows via `lib/results/derive.ts`; hands them to one client component. **Alternative rejected:** a `GET /api/quizzes/[id]/sessions` route duplicates the RSC's job, adds CORS/CSRF/rate-limit surface, and contradicts the repo's "lecturer reads = RSC" convention (builder, class-detail). The I-level gate for P8 is only **I21** (reset) — reads are not API-gated. | Durable logic lives in pure `lib/results/`; the RSC is thin glue; the future UI rewrite keeps the same data contract. |
| **D2** | **Session reset is a security-definer RPC, not a route `DELETE`** | `reset_session(p_session_id uuid) → jsonb` in migration `0011`, following the `unlock_session`/`exempt_face_session` pattern **verbatim including the locked-query ordering**: single `select … for update` with the ownership predicate **in the `WHERE`** (`where s.id = p_session_id and public.is_lecturer_of_quiz(s.quiz_id)`), so a guessed foreign id is **never row-locked**. Not found → `not_owner` (no oracle). **Mode gate:** `mode <> 'assessment'` → `not_assessment` (400) — practice has no one-attempt slot to release and multiple practice sessions are natural; deleting one is a corruption risk without benefit. Then `delete` (cascades answers + face_checks) and `insert audit_events('session_reset')` with `metadata = {session_id, quiz_id}`. Return `{ok, deleted_session_id, student_id, quiz_id}` (attributable success, not bare `{ok:true}`). The route `DELETE /api/sessions/[id]/reset` only guards/CSRF/rate-limits/maps. | "Session writes are RPC-only" invariant; the dead DELETE policy on `quiz_sessions` is intentionally never used by authenticated paths. |
| **D3** | **`reset_session` allows ANY session STATUS (active/paused/flagged/completed) but only `mode='assessment'`** | Reset is a supervisor fallback (dead laptop, glitched submit); the lecturer decides. `completed` resets are deliberate, audited re-take decisions. Every reset is audited; the `session_reset` audit row is the residual trail after the cascade. | Demo fallback (PLAN risk 7). Mode gate (D2) keeps the write surface consistent; status gate would block the demo fallback. |
| **D4** | **`audit_events` lecturer visibility = new `security_barrier` view with a CURATED projection and EVENT-SCOPED predicate** | View `lecturer_audit_view` columns: `id, actor_id, subject_id, action, created_at, event_quiz_id, event_session_id` — extracted **scalars** from `metadata` (`metadata->>'quiz_id'` / `->>'session_id'`), **never the raw `metadata` jsonb** (kills the biometric-adjacent leak: `face_enroll` status, `consent_revoked` `flagged_sessions`, exempt reasons stay out of lecturer reads — D28 spirit). Predicate: `is_lecturer() AND ( (event_quiz_id IS NOT NULL AND is_lecturer_of_quiz(event_quiz_id)) OR (event_quiz_id IS NULL AND exists(student currently enrolled in a class owned by auth.uid())) )`. **New rows (event_quiz_id set) are quiz-attributable and do NOT depend on current enrollment** — a self-unenrolled student's `session_reset` trail remains visible to the lecturer of that quiz (F3 closed). **Legacy rows (event_quiz_id NULL)** remain **subject-granular** (visible only while the student is currently in one of the caller's classes) — honestly documented, never claimed as permanent. Grants: `revoke all … from anon, authenticated; grant select to authenticated` on the **view**; the raw table stays service-role-only. | Mirrors `student_roster_view` (predicate calls the security-definer helpers); no cross-lecturer disclosure for attributable rows; no metadata leak; the reset trail survives self-unenrollment. |
| **D5** | **Abandoned derivation is a pure, env-free helper with an EXHAUSTIVE mapping** | `deriveSessionDisplayStatus({ status, last_activity_at }, { quizStatus, nowMs })` in `lib/results/derive.ts`. Inputs parsed via `Date.parse` (accepts ISO string or ms number; `last_activity_at` is `NOT NULL` in DB — helper still defends NULL/future/unparseable, sorting them as **never stale**). **Any `quizStatus !== 'live'` (incl. `draft` — unreachable-with-sessions via app paths but still pinned) is treated as the closed branch.** **Exhaustive truth table (unit-pinned, no dead members):** | TESTING U-T4 is the P8 gate. The `active`/`paused` DB statuses are **not** surfaced verbatim — a fresh live session renders `in_progress` (per TESTING U-T4 "recently-active session → 'in progress'"), so `DisplayStatus` has exactly four members. **Deviation note:** PLAN_PHASE7 §4 pins "abandonment anchors on `started_at` + deadline, not robot-touchable `last_activity_at`" — that conflicts with PLAN §1 / TESTING U-T4 (anchor = `last_activity_at`, no deadline). The master spec governs; D5 implements `last_activity_at` + `ABANDON_STALE_MS = 2h`, strictly `>`. PLAN_PHASE7's note is superseded (recorded in §8.6). |
| **D6** | **Integrity timeline = merged face_checks + session-attributable audit markers; legacy markers stay STUDENT-LEVEL** | `buildIntegrityTimeline(session, faceChecks, sessionAuditRows)` → time-ordered `IntegrityEvent[]`. **Attribution rule (pinned, truthful):** an audit row is attached to a session's timeline **only when `event_session_id = session.id`** (new `session_reset` rows). **Legacy rows** (`unlock`, `exempt_face`, `consent_revoked`, `self_recover` — no session link) carry **unknowable origin** (a student has ≤1 assessment session per quiz, so "exactly one session" is trivially true — they could be from *another* quiz), so they are **never merged into a session timeline**; they render once under the student-level "Student history" aggregate block. `face_unavailable_at` renders as a marker. **Sort:** timestamp ASC, then a **type-priority tie-break** (audit marker before face check on equal timestamps), then `id` ASC for stable order (mirrors the 0008 `checked_at DESC, id DESC` discipline). | HANDOFF §5 wants `suspected_replay`/`unavailable`/revocation markers; merging unknowable-origin markers into a session's timeline is a correctness lie (F14/iter-2). Aggregate-only is simple, honest, and avoids the "always-one-assessment-session" trap. |
| **D7** | **Dashboard UI is minimal + rewrite-aware** | One client component `ResultsDashboardClient` (session table + per-row expandable integrity timeline + action buttons). Uses only existing shadcn primitives (`Card`, `Button`, `Dialog`, `Select`, `Separator`, `Input`, `Label`) and the roster-style `<ul>`/`<li>` markup. **No new UI primitives, no new design system, no table/badge components.** After any action (unlock/exempt/reset) the client calls the API route then `router.refresh()` (builder/class-detail pattern) — no optimistic state, no client-side cache. **Reset idempotency UX:** a 404 on `DELETE /reset` (row already gone — double-click/concurrent lecturer) is treated as **success** (the goal is achieved); the confirm button cools off after the first success. | The upcoming rewrite owns presentation; P8's job is a complete-but-thin demo path. |
| **D8** | **Dashboard data assembly is N+1-free with explicit projections** | One `.eq("quiz_id")` query for sessions; one `.in("session_id", ids)` (guarded empty) for `face_checks`; one roster fetch; one `lecturer_audit_view` read **`.in("subject_id", sessionStudentIds)`** (attribution applied in JS per D6 — an `eq` on `event_quiz_id` would exclude legacy markers). **Every read uses an explicit `.select(...)` column literal** — sessions = `GET`-envelope columns **minus `verify_nonce`**; `face_checks` = timeline columns (no `frame_hash`); the view = its curated columns. Enforcement is the projection, not type absence. **Roster/session union:** every session renders even if the roster misses the student (name falls back to `"Removed student"`); roster-without-session students render under "Not attempted" (D11). | Demo room ~20 students, but N+1 is sloppy; explicit projection is the only real `verify_nonce` guard (F5). |
| **D9** | **New route follows the house template exactly (no body → no Zod)** | `isUuid(id)` → 404; `requireLecturer` → 401/403/503; `checkSameOrigin` → 403; rate-limit `session-reset:<userId>` **10/min** → 429; `supabase.rpc("reset_session", { p_session_id: id })`; **`if (error) return internalError(...)` — transport/raised-exception → 503 (never a false `200`)**; then `mapFaceError(payload)` (common keys auto-cover `not_owner`→404, `not_lecturer`→403, `not_assessment`→400); finally **shape-assert `payload.ok === true`** before `200` — anything else → 503. No body, no Zod (a `DELETE` has no payload; `isUuid` covers the param). | `mapFaceError` never sees transport errors (unlock/exempt routes pin the `if (error)` guard first); without the guard + shape-assert a failed reset could return a false `200 {ok:true}` (F1). |
| **D10** | **`session_answers` are NOT read for the dashboard v1** | Attendance = sessions; per-session outcome = `score`/`total`. Per-question correctness is **deferred** (trivial via the existing lecturer SELECT policy if the rewrite wants it). This ALSO keeps `correct_index`/`explanation` structurally out of the results surface. | Minimal read surface; a secrecy property stated as such, not left to type absence. |
| **D11** | **"Not attempted" roster group is read-only, default ON** | The RSC passes `roster` + session rows; the client lists enrolled students with **no session** under a secondary "Not attempted" group (name + join date only). | Roster context with zero extra queries. |
| **D12** | **Docs gate-row correctness** | TESTING.md's duplicated `E13` (lines 269 P7 timer-gate vs 270 P8 attendance) is disambiguated: **P8 attendance = `E13b`**; the timer-gate keeps `E13`. The **§9 P8 gate row (line 344) is also updated** `E5b, E13 → E5b, E13b`, and PLAN.md §6 row → `U-T4 · I21 · E5b, E13b (audit rows verified via D13)` (parenthetical kept). | Two gates can't share an ID; the D13 annotation must survive the rename. |
| **D13** | **Mid-flight reset has a defined client branch** | A student whose session is reset mid-flow gets `not_owner`→**404** on their next answer/verify/submit. `play-client.tsx` + `use-face-pipeline.ts` gain an explicit **`not_owner`/404 branch** that surfaces a terminal dead screen "This attempt was reset by your lecturer — ask them to restart you" (mirror of the P7 `not_enrolled` explicit-state precedent). No auto-retry, no re-submit. Pinned by a route test (answer after reset → 404) + optional E2E. | Reset exists for live/lost laptops; the student's screen must not loop on 404s (F9). |

### D5 exhaustive mapping (display status)

| DB `status` | quiz `status` | freshness (`nowMs − last_activity_at`) | displayStatus |
|---|---|---|---|
| `active` | `closed` | any | `abandoned` |
| `paused` | `closed` | any | `abandoned` |
| `active` | `live` | `> 2h` | `abandoned` |
| `paused` | `live` | `> 2h` | `abandoned` |
| `active` | `live` | `≤ 2h` (incl. exactly `2h` — `>` strict) | `in_progress` |
| `paused` | `live` | `≤ 2h` | `in_progress` |
| `flagged` | any | any | `flagged` |
| `completed` | any | any | `completed` |
| `active`/`paused` | `live` | `last_activity_at` NULL or future | `in_progress` (never stale — defensive pin) |
| `active`/`paused` | `draft` (or any non-`live`) | any | `abandoned` (treated as the closed branch — `start_quiz_session` requires `live`, so draft-with-sessions is unreachable via app paths; still pinned for exhaustiveness) |

---

## 3. Work breakdown

### Step 0 — Prereqs
1. Docker Desktop + local Supabase up; P7 baseline green (HANDOFF §2 matrix). No new npm deps.

### Step 1 — Migration `0011_results.sql` + types + `verify-results.mjs`
1. **`reset_session(p_session_id uuid) returns jsonb`** (security definer, `set search_path = public`; **full body identical to `unlock_session`'s framing** — `declare v_session public.quiz_sessions;`, `begin/end;`, `$$` wrapper):
   1. `auth.uid()` null → `not_authenticated`; caller not a lecturer → `not_lecturer`.
   2. **Single locked query (never row-lock a foreign id):**
      ```sql
      select s.* into v_session from public.quiz_sessions s
       where s.id = p_session_id and public.is_lecturer_of_quiz(s.quiz_id)
       for update;
      ```
      Not found → `not_owner` (no oracle — non-existent and not-owned are identical).
   3. **Mode gate:** `if v_session.mode <> 'assessment' then return jsonb_build_object('error','not_assessment'); end if;` (post-lock — the only caller who can reach it owns the quiz; keeps the distinct 400).
   4. `delete from public.quiz_sessions where id = v_session.id;` — cascades `session_answers` + `face_checks` (FK `on delete cascade`); deleting by the locked row (not the raw param) makes it structural.
   5. `insert into public.audit_events (actor_id, subject_id, action, metadata) values (auth.uid(), v_session.student_id, 'session_reset', jsonb_build_object('session_id', v_session.id, 'quiz_id', v_session.quiz_id));`
   6. Return `jsonb_build_object('ok', true, 'deleted_session_id', v_session.id, 'student_id', v_session.student_id, 'quiz_id', v_session.quiz_id)`.
   - Grants (full house form): `revoke execute on function public.reset_session(uuid) from public, anon; grant execute on function public.reset_session(uuid) to authenticated;`. Status matrix: **any** status resets (D3); **only** assessment mode (D2).
2. **`lecturer_audit_view`** (security barrier, curated projection):
   ```sql
   create or replace view public.lecturer_audit_view
     with (security_barrier = true, security_invoker = false) as
   select ae.id,
          ae.actor_id,
          ae.subject_id,
          ae.action,
          ae.created_at,
          nullif(ae.metadata ->> 'quiz_id','')::uuid   as event_quiz_id,
          nullif(ae.metadata ->> 'session_id','')::uuid as event_session_id
     from public.audit_events ae
    where public.is_lecturer()
     and (
           (
             nullif(ae.metadata ->> 'quiz_id','')::uuid is not null
             and public.is_lecturer_of_quiz(nullif(ae.metadata ->> 'quiz_id','')::uuid)
           )
           or
           ( -- legacy, subject-granular rows: visible only via CURRENT class membership
             nullif(ae.metadata ->> 'quiz_id','')::uuid is null
             and exists (
               select 1 from public.class_enrollments ce
               join public.classes c on c.id = ce.class_id
               where ce.student_id = ae.subject_id and c.lecturer_id = auth.uid()
             )
           )
         );
   revoke all on public.lecturer_audit_view from anon, authenticated;
   grant select on public.lecturer_audit_view to authenticated;
   ```
   - `audit_events` table grants stay untouched (service-role only). **`security_invoker = false` is spelled out even though it is the PG default** — a future flip to `security_invoker = true` would silently return 0 rows for every lecturer (no base grants); do not flip or drop it. **No raw `metadata` in the view** (D4). **`nullif(…,'')::uuid` is applied in BOTH the SELECT projection AND the WHERE predicate** (a malformed non-empty value under `metadata->>'quiz_id'` would otherwise raise `invalid input syntax for type uuid` and break the view for every lecturer — the projection-only guard would not protect the predicate). Legacy rows surface only via the subject-granular branch (documented); new rows via the quiz-attributable branch (survive self-unenroll).
3. **`gen:types`** — `database.ts` regenerates (new function `reset_session`, new view `lecturer_audit_view`). **`aliases.ts` DOES need one manual line** (it is a hand-written passthrough): `export type LecturerAuditEvent = Database["public"]["Views"]["lecturer_audit_view"]["Row"];` (regen supplies the Row in `database.ts`).
4. **`scripts/verify-results.mjs`** (live-DB harness; env preamble + **`finally` cleanup identical to `verify-sessions.mjs`** — delete quizzes/classes, `admin.auth.admin.deleteUser`). Provisioning: stamped lecturer L + students S1/S2 (+ a second lecturer L2 with another class), class, UNTIMED assessment, enroll, start/answer/submit; **plus one flagged→`unlock_session` legacy audit row** (reuse the verify-face FLAT-window choreography or its simpler equivalent) so the D-view **NULL-`event_quiz_id` branch has rows to filter on** — without a legacy row seeded, the legacy and self-unenroll sub-assertions are vacuous (only `session_reset` rows carry `event_quiz_id`). Checks:
   - **D13-reset:** `reset_session` as quiz lecturer → `{ok:true}` + `deleted_session_id`; `audit_events` row with `action='session_reset'`, `actor_id`=lecturer, `subject_id`=student, `metadata->>'session_id'`=`deleted_session_id`, `metadata->>'quiz_id'` correct.
   - **I21-D (live):** after reset the student can `start_quiz_session` again → success (slot released); cascade verified: `session_answers`/`face_checks` for the deleted id → 0 rows.
   - **authZ:** student calls `reset_session` → `not_lecturer`; second lecturer (different class) → `not_owner`; non-existent id → `not_owner`; **anon** execute → denied (D47 precedent); **practice-mode** session → `not_assessment` (400, status unchanged, no audit row).
   - **Status matrix:** reset of `active`/`paused`/`flagged`/`completed` assessment sessions → `{ok:true}` + audit row each. **Choreography (pinned):** seed the target statuses directly via the service-role client (status *arrival* is already proven by `verify-face.mjs`'s FLAT-window probes — this harness tests only reset-on-status, so direct seeding is explicit and legitimate; noted in the header).
   - **D-view:** lecturer reads `lecturer_audit_view` → sees rows for **their** class's student (both `event_quiz_id` and NULL-`event_quiz_id` branches); **projection key-absence (mirror D42's star-select):** `select("*")` as lecturer → returned object keys are exactly `{id, actor_id, subject_id, action, created_at, event_quiz_id, event_session_id}` and **`metadata` is absent** — a future DDL that projects raw `metadata` fails this silently-green check; **cross-class isolation:** student enrolled in BOTH L's and L2's classes, L2 resets a session → L's read of that row → 0 rows (quiz-attributable branch gates it); **documented legacy cross-lecturer visibility:** the same shared student's **legacy** (NULL-`event_quiz_id`) `unlock` row IS visible to both L and L2 while enrolled — assert-and-pin this as the documented subject-granular trade-off (SECURITY_AUDIT line); **self-unenroll:** subject self-unenrolls → legacy rows for them become invisible, **`session_reset` rows (event_quiz_id set) remain visible**; the **student** reads the view → 0 rows; raw `audit_events` SELECT as lecturer → denied (privilege level).
   - **Race pin:** reset concurrent with an in-flight `answer_question` → the loser gets `not_owner` (or `session_not_active`), **no partial write, no 500** (atomic `for update`).
   - **RPC error surface (not route-mapping):** the harness asserts the **RPC's** typed errors return cleanly (`not_owner`/`not_lecturer`/`not_assessment` — never a thrown `{ok:true}`). **The 503-on-transport/RPC-raise mapping is ROUTE-TEST-ONLY** — a `verify-*.mjs` Node harness cannot invoke Next.js route handlers, and `reset_session` has no input that raises (every failure is a typed return); the route test with the FakeSupabase `rpcError` seam is the sole proof of "503, never a false 200".
5. `npm run lint && npm run typecheck` clean (gate). `verify:results` added to `package.json` + CI step (§6).

### Step 2 — `lib/results/` (pure logic, Node-unit-tested; no `process.env`)
- **`types.ts`** — `DisplayStatus = 'abandoned' | 'in_progress' | 'flagged' | 'completed'` (four members only — D5); `IntegrityEvent` (face-check event | unavailable marker | audit marker); `ResultsSessionRow` (session cols + student name + question total + `score:number|null` + timestamps + `displayStatus` + `integrityTimeline` + `legacyHistory`). Re-exports `LecturerAuditEvent` via `aliases.ts`.
- **`constants.ts`** — `ABANDON_STALE_MS = 2 * 60 * 60 * 1000` (mirror-not-enforcement header: the RSC computes display state; the DB is untouched).
- **`derive.ts`** —
  - `deriveSessionDisplayStatus({ status, last_activity_at }, { quizStatus, nowMs })` → D5 exhaustive table. Timestamps parsed with `Date.parse` (accepts ISO string or ms); `last_activity_at` null/unparseable/future → never stale (defensive pin); `quizStatus !== 'live'` (incl. `draft`) → the closed branch.
  - `summarizeFaceChecks(checks)` → `{ fails, replays, tooFrequent, firstAt, lastAt }`.
  - `buildIntegrityTimeline(session, faceChecks, sessionAuditRows)` → D6 attribution + sort (timestamp ASC, type-priority tie-break, `id` ASC). `sessionAuditRows` = rows **already pre-filtered to `event_session_id = session.id`** (legacy NULL-`event_session_id` rows never enter this function); legacy rows are handled by `assembleResultsRows` for the `legacyHistory` aggregate only — never merged here.
  - `assembleResultsRows({ quiz, sessions, roster, faceChecks, auditRows, totalQuestions, nowMs })` → `ResultsSessionRow[]`. **Comparator (pinned):** group rank `{in_progress:0, abandoned:1, flagged:2, completed:3}`; within `in_progress` → `last_activity_at` DESC; within `abandoned` → `last_activity_at` ASC (oldest first); within `flagged`/`completed` → `started_at` DESC; tie → `id` ASC. **All timestamps parsed with the same `Date.parse` as D5; an unparseable/NULL value sorts as epoch 0 (deterministic — never `NaN`).** Also: legacy `auditRows` (NULL `event_session_id`) are placed in the row's `legacyHistory` aggregate, **never merged into `integrityTimeline`**; attributable rows whose `event_session_id` matches no fetched session (torn read / `>200` truncation) are dropped and reconciled on `router.refresh()`. Session-without-roster → row kept, `studentName: null` (client renders "Removed student"). `score:null` stays `null`.
- **`derive.test.ts`** — **U-T4** + boundaries + suffix IDs:
  - **U-T4** (exhaustive D5): every truth-table row incl. the **`draft`/non-live default**; exactly-`2h` → `in_progress` (`>` strict); closed-quiz rows abandoned regardless of freshness; `flagged`/`completed` never abandoned even closed+stale; `last_activity_at` NULL/future/ISO-string/ms-number inputs.
  - **U-T4b** (`summarizeFaceChecks`): counts fails/replays/too-frequent; empty → zeros.
  - **U-T4c** (`buildIntegrityTimeline`): merge/sort; equal-timestamp tie-break deterministic; `event_session_id`-matched `session_reset` attached; **legacy rows are never passed in (the caller pre-filters — no merge path)**; empty → empty.
  - **U-T4d** (`assembleResultsRows`): comparator ordering + equal-timestamp tie + **NULL/unparseable timestamp sorts as epoch 0 (no `NaN`)**; roster-miss → `studentName:null` (no crash); empty roster/checks/audit → empty groups; **legacy rows land in `legacyHistory`, not `integrityTimeline`**; attributable row with no matching session → dropped; `score:null` passthrough; **type-level pin:** no `verify_nonce`/`correct_index` field exists on `ResultsSessionRow`.
- **Coverage/config**: `vitest.config.ts` `coverage.include` += `src/lib/results/**`; per-file thresholds: `derive.ts` `{80,80,80,70}` (mirror `timer.ts`); `constants.ts`/`types.ts` **omitted from `thresholds` entirely** (no executable surface — consistent with `lib/face` constants/types).
- **Gate (Step 2):** `npx vitest run src/lib/results/derive.test.ts` green + `npm run lint && npm run typecheck` clean.

### Step 3 — `DELETE /api/sessions/[id]/reset` + route tests (I21)
- **`src/app/api/sessions/[id]/reset/route.ts`** (house template, D9):
  1. `isUuid(id)` → 404.
  2. `requireLecturer` → 401/403/503.
  3. `checkSameOrigin(request)` → 403 `invalid_origin`.
  4. Rate-limit `session-reset:<userId>` 10/min → 429.
  5. `supabase.rpc("reset_session", { p_session_id: id })`.
  6. **`if (error) return internalError("Could not reset the session right now.")`** (transport/raised-exception → 503, no raw message).
   7. `mapFaceError(payload)` — common keys auto-handle `not_owner`→404, `not_lecturer`→403, `not_assessment`→400; any other payload → the mapper's default 503 (unexpected).
   8. **Shape-assert `payload.ok === true`** → `200` with the RPC payload `{ok, deleted_session_id, student_id, quiz_id}`; anything else → 503.
- **FakeSupabase additions** (`fake-supabase.ts`): **`_resetSession(args)` stub** — lockstep with 0011: **first line = the house `rpcResult` seam override** (`if (this.rpcResult.data !== null || this.rpcResult.error !== null) return this.rpcResult;`) so the transport-error route test has an injection point; then gate = caller is `lecturer` **AND** the session's quiz is owned by the caller (mirror the `is_lecturer_of_quiz` stub — do NOT copy the role-only `_unlockSession`/`_exemptFaceSession` pattern, which carry the same latent drift; documented as out-of-P8-scope); `not_lecturer`/`not_owner`/`not_assessment` typed returns; on success delete the row **and** its `session_answers`/`face_checks` children from the tables; push an `audit_events` row **inline** (like the other RPC stubs — do NOT use the test-only `seedAuditEvent` seam inside a stub). **No `lecturer_audit_view` FakeSupabase stub** — the RSC is the only consumer and RSCs are unit-excluded; view semantics are proven only by `verify-results.mjs` (live SQL predicate). If a route/derive test needs view-shaped rows, seed them directly via a plain staging helper (explicitly a staging table, not a semantics mirror).
- **`src/app/api/sessions/__tests__/results-sessions-routes.test.ts`** (or extend face-session-routes): **I21** — lecturer resets → 200 `{ok:true}`; session + its answers + its face_checks gone (tables emptied); **audit row present** after the stub's inline push (assert via the fake's `audit_events` table + metadata — no `seedAuditEvent` in the stub); **the assessment one-attempt slot is freed** (subsequent `start_quiz_session` stub returns a fresh session, not `already_attempted`). Plus: student → 403; non-owner lecturer → 404; malformed id → 404; CSRF cross-origin → 403; rate-limit 429 (`_seedRateLimit`); RPC `not_owner`/`not_lecturer` → 404/403; **practice-mode → 400 `not_assessment`** (no-op, no audit row); **second DELETE on the same id → 404** (row gone — D7 client treats it as success); **answer-after-reset → 404 `not_owner`** (D13 pin); **transport/RPC-raise → 503, never 200** (via the `rpcResult`/`rpcError` seam — the F1 pin).
- `playwright.config.ts`: no change (no new env).
- **Gate (Step 3):** `npx vitest run src/app/api/sessions/__tests__/results-sessions-routes.test.ts` green + `npm run lint && npm run typecheck` clean.

### Step 4 — Results dashboard (thin, rewrite-aware)
- **`src/app/(lecturer)/lecturer/quizzes/[id]/results/page.tsx`** (RSC, `force-dynamic`) — mirrors the builder page's ownership + outage/not-found split:
  1. Auth + lecturer role redirects.
  2. Quiz select `.select("id, class_id, title, mode, status, time_limit_sec").eq("id", id)` → **`error` → destructive error panel** vs `notFound()` (no-oracle).
  3. Owner check: `classes` `.eq("id", quiz.class_id).eq("lecturer_id", user.id)` → 404.
  4. **Parallel reads, each with explicit `.select(...)` and error branching** (a DB outage renders the destructive error panel — **never** an empty "not attempted" dashboard; only `error === null` + zero rows is the empty state):
     - `quiz_sessions`: `.select("id, quiz_id, student_id, mode, status, score, started_at, submitted_at, last_activity_at, face_unavailable_at, face_exempt, face_fail_streak")` `.eq("quiz_id", id).order("started_at", { ascending: false }).limit(200)` — **the GET envelope minus `verify_nonce`** (D8).
     - `getClassRoster(supabase, quiz.class_id)`.
     - question count: `questions` `.select("id", { count: "exact", head: true })`.
     - `face_checks`: `.select("id, session_id, checked_at, matched, distance, trigger, suspected_replay, too_frequent")` `.in("session_id", sessionIds)` — **guarded empty** (skip when `sessionIds.length === 0`). `checked_at` is `NOT NULL` (default `now()`); the timeline treats it as always present — no null-safety branch.
     - `lecturer_audit_view`: `.select("id, actor_id, subject_id, action, created_at, event_quiz_id, event_session_id")` **`.in("subject_id", sessionStudentIds)`** (guarded empty; bounded by `.limit(200)` on sessions) — the view predicate already gates readability (quiz-attributable branch via `is_lecturer_of_quiz`, legacy branch via current enrollment), so the RSC posts the students' ids and lets `derive.ts`/`assembleResultsRows` apply the D6 attribution in JS. **Bound note (pinned):** ≤200 sessions keeps each `.in` GET ≈ 7.5 KB of URL — safe at demo scale under the common 8 KB reverse-proxy limit; revisit if the cap changes. Production bound plus a `.limit(500)` on the view read for symmetry (legacy-heavy students).
  5. `assembleResultsRows(...)` (`nowMs = Date.now()`) → props. **Truncation honesty:** if `sessions.length === 200`, pass `truncated = true` and the client renders "showing the most recent 200" (F7). **Roster-bound note:** `getClassRoster` silently caps at 100 (`ROSTER_LIMIT`) — for a >100-student class a session student may render `studentName: null`/"Removed student" and "Not attempted" is incomplete; accepted at demo scale, documented in §4.
  6. **Mid-flight reset branch (D13) — play-client/pipeline build step:** in `play-client.tsx` answer/submit handling and `use-face-pipeline.ts` verify/post handling, add an explicit **`not_owner`/404 branch** → terminal dead screen "This attempt was reset by your lecturer — ask them to restart you" (mirror of the P7 `not_enrolled` explicit-state precedent); no auto-retry, no re-submit, overlay suppressed like `submitted`/`dead`. Route pin already in Step 3; the client screen itself is asserted in E5b.
- **`results-dashboard-client.tsx`** — presentational only:
  - Overview: quiz title + mode/status badges + counts (attempted / completed / flagged / abandoned / in progress).
  - Session rows (roster-style `ul`): student name ("Removed student" fallback), started/submitted, **status badge** (`abandoned`/`in_progress`/`flagged`/`completed`), score `score / total` (null → `—`), face summary chip (`summarizeFaceChecks`).
  - Expandable **integrity timeline** per row (D6 attribution — `session_reset` markers only; face checks with `suspected_replay`/`too_frequent`/`distance`/`trigger` labels); `face_unavailable_at` marker; **legacy `unlock`/`exempt_face`/`consent_revoked`/`self_recover` markers render ONCE under a student-level "Student history" aggregate** (origin unknowable — never merged into a session timeline).
  - **Actions per assessment row:** **Unlock** (enabled only when `flagged` → `POST /api/face/unlock`), **Face-exempt** (dialog with required reason → `POST /api/sessions/[id]/exempt-face`), **Reset** (destructive `Dialog` confirm → `DELETE /api/sessions/[id]/reset`). Each calls the route then `router.refresh()`. **Reset 404 → success** (D7); confirm button cools off post-success. Action errors → `role="alert"` per row.
  - `verify_nonce` structurally absent (projection + type); "Not attempted" roster group (D11); `truncated` banner (F7).
  - Accessibility: real `<button>`s, confirm dialog focus trap.
- **Navigation wiring** (2 tiny edits): class-detail quizzes list rows + builder header each gain a "Results" link to `/lecturer/quizzes/${id}/results`.
- **No new shadcn components/generated code.**

### Step 5 — E2E (plan + spec outlines; full specs drafted at implementation, frozen post-rewrite)
> Given the upcoming UI rewrite, this section is the **contract** the rewrite must keep: selectors are finalized during implementation and assert high-level behavior (roles/text, not class names). All P8 specs reuse `helpers.ts`; the E2E suite stays unblocked by Docker (CompreFace + AI mocked).
>
> **EXECUTION STATUS (deferred):** the specs are DRAFTED but **`test.skip`ped** (`test.skip(true, "Deferred until UI rework completes")`) with a header note — the pre-rework dashboard is a deliberately-thin demo path and the pre-existing face E2E baseline (E3/E6/E7) is not green in the uncommitted local tree, so gate-executing these now would be noise. Remove the skip and run the three specs after the UI rework lands; this section (the full spec outlines below) is the contract they must keep.

- **`e2e/helpers.ts` additions**: `createAssessmentAndPublish` (wraps `createQuizWithQuestions` with mode=Assessment, untimed); `openResults(page, quizTitle)` (class → quiz builder → "Results"); `resolveServiceClient()` + **`staleActiveSession(admin, { sessionId, quizId, studentId })`** — reads `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` from env (present in CI: playwright.config loads `.env.local`, CI writes it). **Seam contract (host allow-list):** guarded by an **equality** check that the service URL host is in the explicit allow-list `{127.0.0.1, localhost}` (NOT a substring match). The original `NODE_ENV !== "production"` co-gate was removed (the weaker of the two — `npx playwright test` leaves it undefined); host equality is the sole gate; **never referenced by app code**; **upsert semantics** — for an assessment session it must **UPDATE** the existing `(quiz_id, student_id)` row's `last_activity_at`/`status` in place (INSERT would violate `one_assessment_attempt`) and INSERT only when no row exists.
- **`e2e/e13-attendance.spec.ts`** — **E13b (attendance = session; gate)**, UNTIMED, `testInfo.setTimeout(120_000)`, `test.skip(!LECTURER_INVITE_CODE, …)`, `Date.now()`-stamped emails/titles:
  1. Lecturer: class + UNTIMED assessment (2 Q) + publish.
  2. Student A: register → join → **enroll via `enrollViaFacePage` (fake-face seam)** → start (gate clears with a real `'start'` check) → answer → submit. Produces a face-check timeline.
  3. Student B: register → join → start → answer → submit (**unseamed** click-first → `face_unavailable_at` marker).
  4. Student C: register → join → start → answer Q1 → **do not submit** (in-progress).
  5. Student D: register → join → start → answer Q1 → **do not submit**; then **D's page/context is closed (or navigated to `about:blank`) so no periodic face check can re-touch `last_activity_at`**, and only then `staleActiveSession` **UPDATEs D's existing session** to `last_activity_at = now − 3h` (deterministic abandoned — no time-freeze, no INSERT collision; spec comment ties this to the §5 robot-touch limitation).
  6. Lecturer opens results: **exactly 4 rows** — A completed (score), B completed (score), C `in_progress`, D `abandoned`. A's timeline has ≥1 face check; B's row shows the unavailable marker; scores asserted; **`verify_nonce`/`correct_index` absent** — asserted on the rendered DOM (the reads are RSC, so there is no lecturer fetch to filter — E11's network filter is reworded accordingly).
- **`e2e/e5b-reset.spec.ts`** — **E5b (gate)**, UNTIMED, `testInfo.setTimeout(120_000)`, `test.skip(!LECTURER_INVITE_CODE, …)`, stamped emails. Reaches the E5 locked state with **its own** stamped students (Playwright gives no cross-spec fixtures), then:
  1. Lecturer: results → Reset (confirm dialog) → row disappears.
  2. Student: Start again → **succeeds** (one-attempt released) → answers → submits → new completed row.
  3. **D13 dead-screen assertion (folded in, mid-flight):** the retake (step 2) proceeds, and while the student's play tab is open **on a question of the new session** the lecturer resets that row mid-flight → the student's next answer POST surfaces the terminal **"This attempt was reset by your lecturer"** dead screen (NOT a 404 loop). (An EndScreen-parked tab cannot exercise this — overlays/POSTs are suppressed there; the assertion must be mid-quiz.) The retake-completion path is asserted separately after the reset.
  4. Audit: via `resolveServiceClient()`, `audit_events` has a `session_reset` row with `metadata.session_id`/`quiz_id` (D13 route-level).
- **`e2e/e14-results-actions.spec.ts`** — **optional, non-gate**: flagged session (E6-style) → **Unlock button** (not the raw route) → overlay clears / status `active`; **Face-exempt** (reason dialog) with a bad-webcam student → `face_exempt` reflected; confirm-and-cancel dialogs.
- **Teardown:** both gate specs run `test.afterEach`/`afterAll` cleanup via the service client (delete seeded session rows, quiz/class cascade, `admin.auth.admin.deleteUser` for created users) — or, matching the existing E2E convention of no-cleanup, this is stated explicitly in §5 as an accepted local-DB growth cost. **Decision (pinned): cleanup IS added** for the seeded DB rows (they are foreign to the existing convention); users follow the existing leave-in-place convention.
- **Regression:** full suite green (E3/E13 timer-gate, E4/E5/E6/E7/E8/E9/E9b/E9c/E10/E11/E12) — the P8-adjacent subset is E5/E7/E10/E11/E12/E9b; E7's unlock stays route-based in its own spec (the button path is E14's job, so the demo-killers don't double-cover UI).

### Step 6 — Config + verification
- `vitest.config.ts`: coverage keys from §3 Step 2 (`lib/results/**` + thresholds) + the reset-route thresholds entry **under the existing `src/app/api/sessions/**` include** (no `include` edit needed): `"src/app/api/sessions/[id]/reset/route.ts": { lines: 60, statements: 60, functions: 60, branches: 50 }` (mirrors the sibling session routes). RSC/UI excluded (E2E-covered).
- `package.json`: `"verify:results": "node scripts/verify-results.mjs"`. `.github/workflows/ci.yml`: `verify:results` step after `verify:face`.
- Verification matrix (full house matrix incl. asset integrity):
  ```bash
  npm run lint && npm run typecheck && npx vitest run && npx vitest run --coverage
  node scripts/verify-security.mjs && node scripts/verify-classes.mjs && node scripts/verify-quizzes.mjs
  node scripts/verify-ai.mjs && node scripts/verify-sessions.mjs && node scripts/verify-face.mjs
  node scripts/verify-results.mjs        # NEW — D13-reset / I21-D / authZ / D-view / race / status+mode matrix (live DB)
  node scripts/verify-mediapipe.mjs
  npx playwright test                      # incl. e13-attendance (E13b), e5b-reset (E5b)
  npm run build && graphify update .
  ```

---

## 4. Robustness / edge-case matrix

| Area | Guard |
|---|---|
| Reset releases the one-attempt slot | Partial unique index is row-scoped; cascade delete frees the slot atomically; I21 route test + E5b E2E + verify-results probe. |
| Student can't reset | `requireLecturer` route guard + `not_lecturer` RPC gate (both layers); route test + probe. |
| Wrong-lecturer / guessed id (no oracle) | Ownership predicate in the locked `WHERE` → foreign rows are **never row-locked** (P7 invariant); `not_owner` for both not-found and not-owned. |
| Practice-mode reset | RPC mode gate → `not_assessment` (400), status unchanged, no audit row; route test + probe. |
| Failed reset → false success | Route `if (error) → 503` + `payload.ok === true` shape-assert; RPC-raise probe + route test. |
| Second/concurrent reset | Second DELETE → `not_owner` → 404; client maps 404 to success (row already gone); confirm cools off. |
| Mid-flight reset (student live) | Answer/verify/submit after reset → 404 `not_owner`; **play-client/pipeline explicit `not_owner` dead-screen branch** (D13) — no retry loop; route-test pin. |
| Reset of a `flagged` session erases its face_checks | The cascade deletes the evidence that flagged it; the `session_reset` audit row is the residue. Accepted for the demo supervisor model (a lecturer can already unlock/exempt; reset is the stronger, audited action). Documented, not hidden. |
| Restart racing an in-flight reset | Transient `already_attempted` on Start; retry after refresh succeeds (unique index is the arbiter). **Documented-only — no automated pin** (the single-threaded FakeSupabase stubs cannot interleave a start; the real race is a stated acceptance, optional `rpcResult` seed): noted, not a gate. |
| Audit view leaks other classes | Curated projection (no raw `metadata`); `event_quiz_id`-branch gated by `is_lecturer_of_quiz`; legacy branch = current enrollment only; D-view probes incl. **cross-class** and **self-unenroll** behavior. |
| Reset trail survives self-unenrollment | `session_reset` rows carry `event_quiz_id` → quiz-attributable branch does not depend on current enrollment (probe). |
| `metadata` biometric/flagged-session leak | View projects scalar `event_quiz_id`/`event_session_id` only — no `face_enroll` status, no `flagged_sessions`, no exempt reasons (D28 spirit). |
| `face_checks` `.in` with zero sessions | Guarded empty (fetch skipped); empty state renders. |
| `flagged`/`completed` labeled abandoned | Never — D5 precedence + unit-pinned. |
| Abandoned boundary / NULL / future / coercion | `>` strict (exactly 2h → `in_progress`); NULL/future/unparseable → never stale; `Date.parse` accepts ISO string or ms (unit-pinned). |
| Non-`live` quiz status (`draft`) | Treated as the closed branch → `abandoned` (unreachable via app paths — `start_quiz_session` requires `live`; pinned for exhaustiveness in the D5 table + U-T4). |
| Comparator NULL/unparseable timestamps | Sorted as epoch 0 (deterministic — never `NaN`), same `Date.parse` as D5; U-T4d pin. |
| Timed-quiz dead session labeled `in_progress` | Accepted (U-T4 has no deadline rule): a timer-expired-but-unsubmitted session shows `in_progress` until stale; labels do not reflect the server timer. Documented, not fixed. |
| Robot-touch limitation | `record_face_check` refreshes `last_activity_at` every ~30–45s while a question is displayed → a parked-but-open tab is not flagged abandoned. Spec-faithful (U-T4); documented in §5. |
| Null `score` (active/abandoned) | Rendered `—`, never 0; `score:number|null` preserved. |
| Non-owner / unauthenticated results page | RSC owner filter → 404/no-oracle; role redirects identical to builder. |
| `verify_nonce` / `correct_index` / `explanation` leak | Explicit `.select()` projections (envelope-minus-nonce); `session_answers` unread (D10); type-level absence is the backstop, not the guard; DOM assertion in E13b. |
| RSC outage vs empty | Every parallel read's `error` renders the destructive panel; only `error === null` + zero rows is the empty state (F4). |
| Session-without-roster (removed student) | Row kept with `studentName: null` → "Removed student"; audit markers may be absent for removed students (subject-granular branch) — documented, row never dropped. |
| >200 sessions | `.limit(200)` + `truncated` banner ("showing the most recent 200") — no silent truncation. |
| Roster `.limit(100)` (getClassRoster `ROSTER_LIMIT`) | For a >100-student class a session's student may render `studentName:null`/"Removed student" and "Not attempted" is incomplete. Accepted at demo scale; documented, not fixed in v1. |
| `.in` query size | ≤200 sessions keeps each `.in` ≈ 7.5 KB of URL (under the 8 KB reverse-proxy bound); future cap changes revisit it (documented in Step 4). |
| Torn RSC read | A session deleted mid-render holds its already-fetched row; `router.refresh()` converges; no assertion required. |
| Timeline attribution across a student's sessions | D6 rule: only `event_session_id`-matched (`session_reset`) rows merge into a session timeline; **legacy rows (origin unknowable) render only in the student-level "Student history" aggregate — never merged**; unit-pinned (U-T4d). |
| Unmatched attributable audit row (torn read / truncation) | Dropped, reconciled on `router.refresh()`; unit-pinned. |
| Timeline sort stability | timestamp ASC → type-priority tie-break → `id` ASC (mirrors 0008 ordering discipline); unit-pinned. |
| Practice / lecturer sessions | No integrity controls on practice rows (buttons render only for assessment); derivation still applies. |
| Action failures (route 409/503/404) | `role="alert"` error surface per row/action; reset-404-is-success; client stays interactive. |
| E2E determinism | UNTIMED assessments; **D's tab is closed before the `staleActiveSession` UPDATE** (no periodic face check can re-touch `last_activity_at` — E13b flake closed); mock AI/CompreFace; `testInfo.setTimeout(120_000)`; stamped emails/titles; service-seam two-gate guard (host allow-list) + teardown. |

---

## 5. Risks / open items

- **UI rewrite coupling.** The dashboard is deliberately thin but the E2E selectors still bind to it. Mitigation: high-level selectors (roles/text) only; the E2E contract (§3 Step 5) is the handoff to the rewrite. The durable surface (RPC, view, `lib/results`, reset route, play-client 404 branch) is untouched by presentation churn.
- **`audit_events` granularity.** Legacy `unlock`/`exempt_face`/`consent_revoked` rows pre-date session metadata — the view exposes them only at **student** granularity (current enrollment). New `session_reset` rows are fully attributable and survive unenrollment. The dashboard shows per-session `session_reset` markers + student-level legacy markers. (Optional follow-up: add `session_id`/`quiz_id` metadata to `unlock_session`/`exempt_face_session` in a later migration — deliberately out of scope to avoid touching audited P7 RPCs.)
- **`reset_session` trust.** Reset of a `completed` session is a supervisor decision that erases the completed outcome. Mitigation: lecturer-only, mode-gated, audited, destructive-UI-confirmed; the `session_reset` row is the permanent trail (DB-level; surfaced in the next session's timeline or DB-only for non-retakers — accepted).
- **Mid-flight reset UX.** A student actively answering when the lecturer resets gets a terminal `not_owner` dead screen (D13) — asserted end-to-end in E5b (the student's open play tab shows the dead screen, not a 404 loop). Fair for the "dead laptop" scenario; documented, not hidden.
- **Service-role seam in E2E.** `resolveServiceClient()` needs `SUPABASE_SERVICE_ROLE_KEY`; CI always provides it (workflow writes `.env.local`). If absent locally, the spec **skips the abandoned sub-assertion** (belt-and-braces) — the derivation is unit-covered (U-T4), so the gate isn't hollow. Seam is gated by a **host allow-list equality check** (`127.0.0.1`/`localhost`) — the original `NODE_ENV` co-gate was removed as the weaker, always-undefined-under-Playwright half; teardown-deleted.
- **Timeline honesty.** Per-session timelines show only `session_reset` markers (origin known) + face checks; legacy `unlock`/`exempt_face`/`consent_revoked`/`self_recover` markers are origin-unknowable and appear only in the student-level "Student history" aggregate — never claimed as session truth.
- **`student_roster_view` does not expose `face_enrollment_status`** — the dashboard doesn't show per-student enrollment; the enroll banner already exists student-side, and `GET /api/sessions/[id]` carries it where needed. Accepted.
- **No per-question breakdown in v1** (D10) — accepted; trivial to add via the existing RLS later.
- **Abandoned uses `last_activity_at`**, which periodic face verifies refresh every 30–45s while a question is displayed — a parked-but-open assessment tab is not classified abandoned. Spec-faithful to U-T4 / PLAN §1, superseding the PLAN_PHASE7 §4 "started_at + deadline" note (deviation recorded in §8.6).
- **Demo-killers unaffected** — E6/E7/E12/E8/D1 untouched; E7 unlock stays route-based.

---

## 6. Gate traceability

| Gate | Proven by |
|---|---|
| **U-T4** (exhaustive abandoned derivation: closed-quiz + stale + boundary + precedence + null/future) | `lib/results/derive.test.ts` (+ U-T4b/c/d) |
| **I21** (reset route contract: delete + cascade + audit + authZ + CSRF + 429 + no-false-200 + second-reset-404 + answer-after-reset-404) | `results-sessions-routes.test.ts` (FakeSupabase `_resetSession`) — **route-plumbing only** |
| **I21-D (live)** (one-attempt slot release + cascade against the real DB) | `scripts/verify-results.mjs` (I21-D probe) |
| **E5b** (lecturer resets attempt → re-take + audited) | `e2e/e5b-reset.spec.ts` — **deferred (skipped) until the UI rework lands**; the reset+audit path is live-proven by `verify-results.mjs` (D13-reset / I21-D) |
| **E13b** (attendance = sessions; abandoned renders; timelines; no `verify_nonce`) | `e2e/e13-attendance.spec.ts` — **deferred (skipped) until the UI rework lands**; the derivation is unit-pinned (U-T4/U-T4d) |
| **D13** (audit on privileged actions — `session_reset` included) | `scripts/verify-results.mjs` (D13-reset) |
| Earlier gates stay green | verify-* + vitest + Playwright + build regression |

---

## 7. Docs to update

- `TESTING.md` — **keep** the existing U-T4 row (§2.5) + its P8-gate note (already correct — do not re-add); **keep** the existing I21 row (§4) and E5b row (§5); **rename** the line-270 §5 row `E13 → E13b` ("Attendance = session", amended to 4 students: A/B completed, C in-progress, D abandoned); **update the §9 P8 gate row (line 344): `U-T4 · I21 · E5b, E13 → U-T4 · I21 · E5b, E13b`**; add a note registering the new probe IDs (`D13-reset` / `I21-D` / `D-view` in `verify-results.mjs`) and the non-gate unit suffixes (U-T4b/c/d).
- `PLAN.md` — §6 P8 gate row → `U-T4 · I21 · E5b, E13b (audit rows verified via D13)` (parenthetical kept).
- `HANDOFF.md` — §6 "how to start P8" → mark results dashboard done (execution-time), add the P8 verification matrix + §9 audit pointer.
- `SECURITY_AUDIT.md` — note `reset_session` + `lecturer_audit_view` grants (checked); note the `E13 → E13b` doc resolution.
- `docs/PLAN_PHASE8.md` — this file (§9 audit→fix log).

---

## 8. Execution expectations

### 8.1 Deliverables checklist (execution time — not part of this planning task)
- [x] `0011_results.sql` (reset_session RPC + lecturer_audit_view) + regen + aliases line + `verify-results.mjs` (18/18 green).
- [x] `lib/results/` + U-T4/U-T4b/c/d tests + coverage keys.
- [x] Reset route + I21 tests + FakeSupabase `_resetSession` stub.
- [x] results RSC + client + navigation links (thin; rewrite-owned).
- [x] play-client/pipeline `not_owner` (mid-flight reset) branch.
- [x] E13b + E5b (+ E14 optional) specs + `staleActiveSession` seam — **drafted + skipped pending the UI rework** (rework-deferral note in each spec header).
- [x] CI step + full verification matrix.

### 8.2 Verification matrix (as §6)
Runs the full house matrix plus `verify:results` and the new E2E specs; build/lint/typecheck clean.

### 8.3 Final state (expected)
- Unit/integration: U-T4 suite + I21 + route/authZ tests added; coverage per-file thresholds pass.
- DB/RLS: `reset_session` + `lecturer_audit_view` D-probes (incl. cross-class, self-unenroll, race) green; earlier harnesses stay green.
- E2E: E13b/E5b (+E14) specs DRAFTED but SKIPPED pending the UI rework (see §3 Step 5); after the rework, run them + the E3/E4/E5/E6/E7/E8/E9/E9b/E9c/E10/E11/E12/E13 (timer-gate) regression.
- Build/lint/typecheck/graphify clean.

### 8.4 Related notes / cross-references
- TESTING U-T4 (line 87; P8-gate note line 91) is the pinned abandoned spec; PLAN §1 (line 95) is its authority.
- PLAN_PHASE7 §4's "abandonment anchors on `started_at` + deadline" note conflicts with the master spec; superseded (see §8.6).
- Handoff P7 §6 points P8 at `GET /api/sessions/[id]` + `face_checks`/`audit_events` + "a lecturer view for audit_events" — exactly this plan.

### 8.5 Out of scope (deliberately, for the rewrite)
Per-question correctness view, pagination/sorting controls, CSV/export, badges/table UI primitives, per-student enrollment-status column, close-quiz route, live-refresh websockets, `metadata` backfill of legacy audit rows.

### 8.6 Deviations (explicitly flagged)
- **Reset mechanism** (PLAN §2 `DELETE /api/sessions/[id]/reset`): same contract, audited, same slot-release semantics — but implemented as a **security-definer RPC** (D2), not a raw table DELETE (the RPC-only-writes invariant; the dead DELETE policy stays unused).
- **Abandonment anchor** (PLAN_PHASE7 §4): P7's "started_at + deadline" note is **superseded** by PLAN §1 / TESTING U-T4 ("2h of no `last_activity_at` updates"). D5 implements the master spec; the P7 note is a doc-vs-doc conflict resolved in favor of the master.
- **Practice-mode reset is forbidden** (`not_assessment`): a scope restriction beyond PLAN §2's prose (which says "deletes the session" without a mode qualifier) — deliberate, to keep the write surface consistent with the one-attempt model.
- **Audit visibility granularity** (D4): new rows are quiz-attributable; legacy rows are student-granular. This is a documented capability limit, not a regression.

### 8.7 Documented duplicates resolved
- TESTING.md `E13` is listed twice (P7 timer-gate at line 269, P8 attendance at line 270) **and** referenced at line 344 (§9 gate row). Resolution: **P8 attendance = E13b**; all three occurrences updated (§7/D12).

### 8.8 Plan consistency with repo invariants (self-check)
- No `process.env` in `lib/results/` (pure). No new npm deps; no new shadcn components; no new env vars (the E2E service-key read reuses `SUPABASE_SERVICE_ROLE_KEY`; the seam is two-gated).
- Session writes RPC-only (D2); no-oracle everywhere (`not_owner` folds non-existent + non-owned; `not_lecturer` vs `not_owner` distinguish role from ownership); never-row-lock-a-foreign-id (D2 locked-query).
- Lecturer reads = RSC + RLS + explicit projections (D1/D8); view grants minimal (select only); raw `metadata` never projected (D4).

### 8.9 Review loop (this planning task)
- Draft v1 → critique subagents (security · robustness · clean-code/testing · plan-consistency) → iteration-1 fixes incorporated → §9 logs each. Re-audit until no Critical/High/Medium remains.

---

## 9. Review findings & audit-fix log (this planning task)

### Iteration 1 (security 10 / robustness 22 / clean-code 12 / consistency 6 findings — all actioned)
- **[H] `reset_session` lock-ordering** (sec F4, rob F-10, cons F1): was lock-then-gate → now single locked query with `is_lecturer_of_quiz` in the `WHERE` (never row-lock a foreign id). Applied in D2/Step 1.
- **[H] Route false-success 200** (sec F1, rob F-12): missing transport guard + shape assert → D9/Step 3 now pin `if (error) → 503` + `payload.ok === true` + a route test/probe.
- **[H] Audit-view cross-lecturer disclosure + revocable trail** (sec F2/F3, rob F-6/M-2): view re-scoped to event-attributable (`event_quiz_id` → `is_lecturer_of_quiz`) + curated scalar projection (no raw `metadata`; D28/F10); legacy rows documented subject-granular; cross-class + self-unenroll D-probes added.
- **[H] D5 mapping contradiction** (rob F-1): exhaustive truth table; `DisplayStatus` reduced to four members; `active`/`paused` → `in_progress` when fresh.
- **[H] RSC outage-vs-empty ambiguity** (rob F-4): per-read `error` branching → error panel, never an empty dashboard.
- **[H] Mid-flight reset undefined** (rob F-9): D13 + play-client/pipeline `not_owner` branch + route-test pin.
- **[H] Timeline misattribution** (rob F-14): D6 `event_session_id`-matched attribution + legacy aggregate; unit-pinned.
- **[H] E13b unique-index collision + unenrolled A** (rob F-17/F-18, clean F, cons F4): `staleActiveSession` **UPDATEs** existing rows (no INSERT); student A enrolls via `enrollViaFacePage`; exact 4-row assertion; D-student added.
- **[M] `verify_nonce` by projection, not type** (sec F5, rob F-5): explicit `.select()` literals everywhere (envelope-minus-nonce).
- **[M] Reset stub must gate quiz ownership** (clean): `_resetSession` mirrors `is_lecturer_of_quiz`; role-only drift of `_unlockSession`/`_exemptFaceSession` documented as out-of-scope.
- **[M] Dead FakeSupabase view stub** (rob M-4, clean): removed; view semantics proven live by `verify-results.mjs` only.
- **[M] Docs baseline errors** (clean, cons F2): TESTING keeps existing U-T4/I21/E5b rows (no re-add); §9 gate row + PLAN §6 row repointed to E13b with the D13 parenthetical kept.
- **[M] D5/P7 abandonment citation** (cons F3): PLAN_PHASE7 §4 note is contrary → recorded as a superseded deviation in §8.6; D5 rationale points at TESTING U-T4.
- **[M/L] Route template** (clean, rob F-12): dropped the body-less "Zod" step; D9 corrected.
- **[L] verify-results cleanup, aliases line, verify-mediapipe in matrix, coverage-key wording, second-reset-404, restart-race, torn read, >200 truncation banner, mode gate, practice reset** — applied to §3/§4/§6. **`checked_at` NOT NULL note** added to Step 4's face_checks bullet. **`per-step gates (Steps 2/3)`** added to §3 Steps 2 and 3 (executable vitest + lint/typecheck gates).

### Iteration 2 (security 5 / robustness 7 / clean-code 8 / SQL 9 findings — all actioned, no CRITICAL)
- **[H] E13b D-student flake** (rob #4, sql M6): a periodic face check on D's open tab could re-touch `last_activity_at` after the stale UPDATE → D's tab is **closed before** `staleActiveSession` runs; spec comment ties it to the robot-touch limitation (Step 5, §4 matrix).
- **[H] §9 iteration-1 log accuracy** (clean): "per-step gates (Steps 2/3)" and "`checked_at` NOT NULL note" were claimed but absent → gates added to Steps 2/3 and the `checked_at` note added to Step 4.
- **[H] "RPC-raise → 503" live probe unconstructible** (sec, clean #4, sql Q3): `reset_session` has no raising input and a Node harness can't invoke routes → reworded to assert only the RPC's typed-error surface; the 503 mapping is proven **only** by the route test (`rpcResult`/`rpcError` seam). Also added the `rpcResult` first-line override to `_resetSession` (house stub discipline).
- **[M] D5 missing `draft`/non-`live` status** (rob #1): added the row to the D5 table + U-T4 (treat non-live as the closed branch).
- **[M] D6 legacy attribution** (rob #3): with one-attempt-per-quiz, "exactly one session" is trivially true → legacy rows (origin unknowable) are **never merged into a session timeline**; they render only in the student-level "Student history" aggregate (D6 rewritten; U-T4d + §4 matrix + client bullet updated).
- **[M] Comparator NULL/unparseable timestamp → `NaN`** (rob #2): pinned epoch-0 sentinel + `Date.parse` reuse + U-T4d case.
- **[M] View grants rely on non-invoker view** (sql Q2): pinned `security_invoker = false` (not a PG-default accident) + `nullif(…,'')::uuid` defensive guard (future malformed metadata can't break the view for all lecturers).
- **[M] D-view probe vacuously forgot to seed legacy rows** (sql Q3): verify-results provisioning now also creates a flagged→`unlock_session` legacy row so the NULL-branch + self-unenroll sub-assertions have data.
- **[M] Status-matrix choreography underspecified** (sql Q3): pinned service-role direct status seeding (status arrival is `verify-face`'s job; this harness tests reset-on-status only).
- **[M] View projection key-absence probe missing** (sec): added a D42-style `select("*")` probe asserting the view's keys are exactly the curated set and `metadata` is absent.
- **[M] I21 slot-release attribution** (sql Q4, clean): split §6 into the route-contract row (FakeSupabase, routing only) + a live **I21-D** slot-release row (verify-results).
- **[M] D13 had no build step** (clean #3): added a Step-4 client branch (play-client/pipeline `not_owner` dead screen) + folded the dead-screen assertion into E5b.
- **[L] Stale-seam host gate** (sec #4): equality against `{127.0.0.1, localhost}` allow-list (the original `NODE_ENV` co-gate was removed — host equality is the sole gate).
- **[L] Wording/misc**: reset-route threshold pinned `{60,60,60,50}`; dangling `else.`; "audit row seeded" → "present after inline push"; `delete … where id = v_session.id`; full `on function public.reset_session(uuid)` grant form; `reset_session` sketch self-containment note (header "identical to `unlock_session` framing"); §8.3 bare `E13` → `E13 (timer-gate)`; `.in`-size + roster-`limit(100)` bound notes; documented legacy cross-lecturer visibility probe + SECURITY_AUDIT line.

### Iteration 3 (final coherence audit — CONVERGED; 3 MEDIUM + 4 LOW actioned)
- **[M] E5b D13 dead-screen assertion unwritable as described** (EndScreen-parked tab fires no answer/verify/submit POSTs) → reworded to a **mid-flight retake** assertion (student on a question of the new session; lecturer resets; next answer POST surfaces the dead screen); retake-completion asserted separately (Step 5).
- **[M] View `nullif` guard was projection-only** (the WHERE predicate still used unguarded `(… ->> 'quiz_id')::uuid` — a future malformed value would raise and break the view for every lecturer) → `nullif(…,'')::uuid` applied in BOTH the SELECT and the WHERE (incl. the `is_lecturer_of_quiz` argument) (Step 1.2).
- **[M] `buildIntegrityTimeline` signature parenthetical admitted legacy rows** ("or null for the aggregate") → contradicted U-T4c/D6; rewritten to "already pre-filtered to `event_session_id = session.id`; legacy rows go to `assembleResultsRows` only" (Step 2).
- **[L] `security_invoker = false` "not a PG default"** → reworded (it IS the default; the warning is about flipping it, not dropping a non-default flag) (Step 1.2).
- **[L] Loose TESTING citation "U-T4 (line 87–91)"** → cited "line 87; P8-gate note line 91" (§8.4).
- **[L] "`in_progress`/`active`"** in the timed-quiz matrix row → dropped `/active` (four-member `DisplayStatus` has no `active`) (§4).
- **[L] Reset 200 body ambiguous** → Step 3.8 explicitly returns the RPC payload `{ok, deleted_session_id, student_id, quiz_id}`.

**Verdict:** no CRITICAL/HIGH/MEDIUM remains. The plan is internally consistent, self-contained, and §9's log matches the body text. Loop closed.

---

## 10. Execution audit-fix log (implementation time — this task)

The implementation was audited by three parallel explore subagents (security/robustness, style/efficiency, SQL/test-coverage), then re-audited. Two rounds; round 2 converged (fixes verified + fresh findings actioned).

### Iteration 1 (3 parallel audits — all MEDIUM/LOW actioned, no CRITICAL/HIGH)
- **[M] Question-count read error swallowed** → `results/page.tsx` now destructures `totalQuestionsError` + destructive panel (a `score / 0` on partial outage is impossible now).
- **[M] Vacuous type-surface "pin"** (`Object.keys({} as Row)` is a runtime no-op) → compile-time `@ts-expect-error` pins VERIFIED to fire (TEMP field → TS2578); round-2 upgraded to type-alias pins after the value-pin form was shown not to fire under strict mode.
- **[M] Dashboard `busyRow` single-id race** → per-row `Set<string>`; [M] `notAttempted` O(n·m) + 4 summary filters → single-pass reduce + `Set`.
- **[M] Pre-existing flagged-poll nonce guard was dead code** (nested inside the retry block where `allowNonceRetry` is always true → a stale nonce could clear the flagged overlay w/o a server-verified match) → hoisted outside; deduped reset; indentation fixed.
- **[M] `nullif(…,'')::uuid` only guarded empty strings** (malformed non-empty value still broke the view for ALL lecturers) → `safe_audit_uuid(text)` helper (UUID-shape regex, case-insensitive, brace-tolerant) in BOTH projection + predicate.
- **NEW (round 2) [M] Flagged-poll GET 404 never terminated** after a lecturer resets a *flagged* session → the poll re-armed forever behind the overlay; `tick()` now treats `404` + unknown-status-non-ok as terminal (`onReset`/dead).
- **NEW (round 2) [M] Torn read could merge a `session_reset` marker into the very session it deleted** (ghost "reset and kept going" timeline) → `session_reset` always routes to the student-level `legacyHistory` aggregate (never a session timeline), enforced in `assembleResultsRows` AND defensively in `buildIntegrityTimeline`; unit-pinned.
- **[L]** audit read cap ORDER BY (deterministic newest-first); face_checks read capped; `_resetSession` gate → class ownership (was `created_by`); `is_lecturer_of_quiz` fake stub aligned to class ownership too; practice-fixture quiz mode; route dead-`?? internalError` cleanup; `toEpochMs` numeric-string coercion; `byId` tie-break helper; removed redundant audit pre-sort; `legacyHistory` per-row copy (no aliasing); removed dead `ResultsDashboardData` type/re-export; TimelineEvents keys kind+at+id (dup-key safety); reset-404 dead text single-sourced; D13 dead-screen overlay order (`onReset` before `setStatusBoth`); D-view (f) asserts grant-present (no vacuous pass); D-view (c) asserts reset succeeded first; harness cleanup deletes audit rows; D13 asserts full return shape; tests added (exact-now, all-null checked_at, unparseable created_at, practice derivation, second-lecturer-owns-other, unknown-key 503, null-payload 503, deleted-reset-surfaces-in-history, torn-read-reset-guard).

### Iteration 2 (re-audit) — fixes 2–15 verified correct; residual documentation
- Type pins upgraded to type-alias form (value-pin form manufactured a TS2322 that kept the directive "used" even after the field was added — pinned + documented in-test).
- `unlock/exempt` routes returning `nextNonce` to the lecturer: P7-scope residual, documented in SECURITY_AUDIT (inert — a lecturer is never the session owner).
- **Verdict:** no CRITICAL/HIGH/MEDIUM remains post-fix. All verification re-run green: lint, typecheck, **561/561** vitest, coverage thresholds, `verify-results` **18/18**, regression harnesses (sessions 19/19, face 50/50, quizzes 42/42, classes 21/21, security 3/3, ai 16/16, mediapipe intact), build clean. E2E P8 specs remain deferred+pending the UI rework (§3 Step 5).
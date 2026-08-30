# InnoVision — Technical Architecture & Data Flow

> **Audience:** engineers who want to understand how the app actually works —
> what happens on each request, where data lives, and which component talks to
> which. File paths, RPC names, and table names are real; follow them in the
> code while reading.

---

## Table of contents

1. [What the product is](#1-what-the-product-is)
2. [Stack & runtime topology](#2-stack--runtime-topology)
3. [Request lifecycle (who runs what)](#3-request-lifecycle-who-runs-what)
4. [Auth, roles, and identity](#4-auth-roles-and-identity)
5. [Data model at a glance](#5-data-model-at-a-glance)
6. [The security model (read this before touching routes)](#6-the-security-model)
7. [Feature walkthroughs — end-to-end data flow](#7-feature-walkthroughs)
   - 7.1 Classes & enrollment
   - 7.2 Quiz authoring (manual + AI generation)
   - 7.3 File upload → extraction/OCR pipeline
   - 7.4 Quiz lifecycle: draft → live → closed
   - 7.5 Assessment session: the core loop
   - 7.6 Face verification protocol (the deepest part)
   - 7.7 Gesture answering (hand tracking)
   - 7.8 Incident clips (pre-incident video)
   - 7.9 Results & reveal gating
   - 7.10 Notifications
   - 7.11 Student practice quizzes & sharing
   - 7.12 Media: question images, avatars, student AI generation
8. [i18n](#8-i18n)
9. [Testing map](#9-testing-map)
10. [Environment variables](#10-environment-variables)

---

## 1. What the product is

InnoVision is a **proctored classroom quiz platform**:

- **Lecturers** create classes with join codes, author quizzes (manually or via
  AI from uploaded lecture material), publish them live, monitor attempts, and
  review results + integrity footage.
- **Students** join classes, enroll their face once, then take assessments
  where a webcam verifies *they* are the one answering. Answers can be given
  by **holding up fingers** (MediaPipe hand tracking) or by clicking.
- **Students can also author private practice quizzes** and share them by link
  code — these are ungraded and stateless on the server side of play.

The defining constraint that shapes most of the architecture:
**the client is never trusted.** Every verdict (face match, score, timer,
state transition) is computed or re-validated server-side, mostly inside
Postgres functions.

---

## 2. Stack & runtime topology

```
┌────────────────────────── Browser ──────────────────────────┐
│  Next.js 16 App Router (React 19 + React Compiler)          │
│  ├─ Server Components: all data fetching for pages          │
│  ├─ Client islands: quiz player, vision trackers, dialogs   │
│  ├─ MediaPipe tasks-vision (vendored WASM): face + hand     │
│  └─ next-intl (en / ms)                                     │
└──────────────┬──────────────────────────────────────────────┘
               │ fetch (JSON) / supabase-js (RLS-scoped)
┌──────────────▼──────────────────────────────────────────────┐
│  Next.js server (Node)                                      │
│  ├─ /api/* route handlers (~36) — self-authenticating       │
│  ├─ Server actions: login / register / locale               │
│  └─ "server-only" modules hold all secrets                  │
└──────────────┬──────────────────────────────────────────────┘
               │ PostgREST (supabase-js) — user JWT or service role
┌──────────────▼──────────────────────────────────────────────┐
       │  Supabase (self-hosted local / hosted)                     │
       │  ├─ Postgres: tables, RLS on everything, SECURITY DEFINER   │
       │  │   RPCs own every sensitive write                         │
       │  ├─ Auth (GoTrue): sessions, cookies via @supabase/ssr      │
       │  ├─ Storage: private buckets (quiz-sources, incident-footage│
       │  │   question-images, avatars — last two zero-policy)        │
       │  └─ Realtime: notifications channel                         │
└──────────────┬──────────────────────────────┬───────────────┘
               │ HTTP                          │ HTTP
┌──────────────▼─────────────┐  ┌─────────────▼───────────────┐
│  CompreFace (Docker)       │  │  GLM-OCR (vLLM, optional)   │
│  face enroll/detect/       │  │  OpenAI-compatible chat for │
│  recognize (1:N gallery)   │  │  OCR + AI question gen      │
└────────────────────────────┘  └─────────────────────────────┘
```

Key files: `package.json`, `next.config.ts` (security headers, React
Compiler), `proxy.ts` (middleware), `supabase/migrations/0001–0024`
(authoritative schema), `src/lib/supabase/{server,client,admin,middleware}.ts`.

---

## 3. Request lifecycle (who runs what)

### Page navigation

```
GET /student/classes
  → proxy.ts middleware (proxy.ts:4)
      • updateSession() refreshes the Supabase session cookie if needed
      • SKIPS /api/*, static assets, /mediapipe/*, /models/*
        (every API route self-authenticates — see proxy.ts comments)
  → src/app/(student)/layout.tsx (async server component)
      • reads profile (role gate), seeds NotificationBell counts
  → src/app/(student)/student/classes/page.tsx (async server component)
      • createClient() (user-JWT supabase) → .from("student_class_view")…
      • redirects to /login when unauthenticated
      • renders <StudentClassesClient rows={…}/> (client island) with
        plain serializable props only
```

Rules the codebase follows:

| Concern | Where it lives |
|---|---|
| Session cookie refresh | `proxy.ts` → `lib/supabase/middleware.ts` |
| Page data fetching | async Server Components (`page.tsx`) |
| Mutations | `/api/**` route handlers (never server actions except auth forms) |
| Secrets | `import "server-only"` modules (`lib/ai/client.ts`, `lib/face/server/*`, `lib/supabase/admin.ts`) |
| Role gating | layout-level redirect + per-route guards |

### API mutation preamble (every mutating route follows this order)

```
guard (requireUser/requireLecturer/requireQuizOwner/…)   ← auth + ownership
→ checkSameOrigin(request)                                ← CSRF (403 cross-origin)
→ rateLimit(`scope:${userId}`)                            ← in-memory sliding window
→ content-length check                                    ← reject oversized bodies pre-parse
→ await request.json() in try/catch                       ← invalid_json 400
→ Zod schema.safeParse(body)                              ← invalid_body 400
→ business call (RPC / query)
→ typed error mapping to HTTP (404 no-oracle / 403 / 409 / 503)
```

Shared helpers live in `src/lib/http.ts` (response builders,
`checkSameOrigin`, `checkBodyLimit`, `firstIssueMessage`) and
`src/lib/classes/guards.ts` (`requireUser`, `requireLecturer`,
`requireClassOwner`, …). Ownership helpers: `requireQuizOwner` joins
quiz → class → lecturer so a non-owner gets the same 404 as a missing row
(**no-oracle**: responses never distinguish "doesn't exist" from "not yours").

---

## 4. Auth, roles, and identity

- **Supabase Auth (GoTrue)** owns credentials + sessions; the app stores
  nothing password-related. PKCE code exchange lands in `/auth/callback`.
- **`profiles` table (id = auth.users.id)** carries `role`
  (`'student' | 'lecturer'`), `full_name`, `locale`, consent/enrollment state.
  Created by trigger `handle_new_user` (migration 0001) which **hardcodes
  `role='student'`** — client-supplied metadata is ignored (role-escalation
  fix).
- **Lecturer promotion** happens only in the `register` server action
  (`src/lib/auth/register.ts`): the submitted invite code is compared against
  a hash of `LECTURER_INVITE_CODE` using `extensions.digest` in
  **constant time**; on match the action upserts `profiles.role='lecturer'`.
  The DB restricted-columns trigger (`protect_profile_restricted_columns`,
  migration 0019) rejects any direct client write to `role` /
  `consent_given_at` unless an RPC set the `app.consent_write` GUC.
- **Locale** is a cookie (`LOCALE_COOKIE_NAME`), read by
  `src/i18n/request.ts`; users change it via the `/api/locale`-backed switch
  (server action `setLocale`), stored on `profiles.locale` too.

Login/register flows: `src/app/(auth)/login/page.tsx`,
`src/app/(auth)/register/page.tsx` (client components calling server actions
in `src/lib/auth/*.ts`). Redirects after login pass through
`sanitizeRedirect` (kills protocol-relative, backslash, encoded-CRLF, and
cross-origin targets).

---

## 5. Data model at a glance

All migrations live in `supabase/migrations/`; generated types in
`src/lib/types/database.ts` (regenerate with `npm run gen:types`).

```
profiles ──┬──< classes (lecturer_id, join_code unique, archived_at)
           │         └──< class_enrollments >── students (profiles)
           │         └──< quizzes (class_id, created_by, mode, status,
           │                  time_limit_sec, results_revealed_at,
           │                  auto_reveal_on_complete, shuffle_questions,
           │                  source_file_url…)
           │                  └──< questions (order_index, type
           │                        [mcq|true_false|multi_select], options[],
           │                        correct_index (null on multi),
           │                        correct_indices (multi only), explanation)
           │                  └──< quiz_sessions (student_id, status, mode,
           │                        verify_nonce uuid, face_fail_streak,
           │                        focus_pause_count, paused_at, score,
           │                        face_exempt, started_at/submitted_at…)
           │                        ├──< session_answers (unique(session_id,
           │                        │    question_id), selected_index,
           │                        │    selected_indices (multi only),
           │                        │    is_correct)   ← is_correct column-revoked
           │                        ├──< face_checks (similarities[], matched,
           │                        │    trigger, frame_hash — frames NEVER stored)
           │                        ├──< session_advisories (adv_type, count)
           │                        └──< incident_clips (storage_path, reason,
           │                             duration_ms, recorded_from)
           ├──< student_quizzes (created_by, share_code nullable unique)
           │         └──< student_quiz_questions (same shape as questions)
           ├──< notifications (recipient_id, type, payload jsonb,
           │                   dedupe_key, seq identity, read_at)
           ├──< audit_events (actor_id, subject_id, action, metadata)  ← RLS deny-all
           └──< class_join_attempts (fail_count, locked_until)         ← RLS deny-all
```

Statuses:

- `quizzes.status`: `draft → live → closed` (one-way; enforced by trigger).
- `quiz_sessions.status`: `active ↔ paused → completed`, plus `flagged`
  (terminal until lecturer unlock/exempt).

Views worth knowing (all definer-owned, `security_barrier`):

| View | Purpose |
|---|---|
| `student_class_view` | enrolled classes without `join_code`/lecturer columns |
| `student_quiz_view` | LIVE quizzes of enrolled classes (+ reveal metadata, retake config) |
| `student_session_view` | own sessions incl. `verify_nonce` + `attempt`; score NULL until revealed |
| `lecturer_session_view` | lecturer-visible sessions incl. score + `attempt`, never nonce |
| `student_results` / breakdown views | reveal-gated score + per-question review (latest completed attempt) |
| `student_quiz_player_question_view` | shared practice play: omits `correct_index`/explanation behind barrier |

---

## 6. The security model

Five layers, in the order an attacker meets them:

1. **AuthN per route.** Middleware deliberately skips `/api/*`; every handler
   calls a guard first. There is no route that trusts the cookie implicitly.
2. **Ownership joins (no IDOR).** Guards resolve ownership server-side
   (`requireQuizOwner` → class.lecturer_id; `requireStudentQuizOwner` →
   `created_by`; session RPCs re-check `student_id = auth.uid()` inside the
   function). Wrong-owner = same 404 as missing (**no existence oracle**).
3. **RLS everywhere.** Every public table has RLS enabled. Sensitive tables
   (`audit_events`, `class_join_attempts`) have **zero policies** — reachable
   only through SECURITY DEFINER RPCs.
4. **RPCs own sensitive writes.** Anything that changes assessment state goes
   through a `SECURITY DEFINER` function that re-validates caller identity +
   state machine rules under row locks (`for update`) or advisory locks.
   All pin `set search_path = public`; `CREATE` on schema public is revoked
   (anti shadow-object hijack); pgcrypto calls are schema-qualified.
5. **Column-level secrecy.** Students cannot SELECT `questions.correct_index`
   (no policy grants non-creators), cannot read `session_answers.is_correct`
   or `quiz_sessions.score` directly (column-revoked, migration 0012) — those
   values are re-exposed only through reveal-gated views.

Additional hardening: CSRF via Origin check (`checkSameOrigin`),
per-user in-memory rate limits on every mutating route, body-size caps
pre-parse, magic-byte sniffing on video uploads, constant-time invite-code
compare, CSP currently Report-Only (`next.config.ts`), secrets only in
server-only modules, `.env.local` gitignored.

**Trust boundary note (documented residual risk):** the browser sends face
*similarity numbers* to `record_face_check`; the RPC recomputes the majority
verdict but cannot prove the numbers came from CompreFace. The route derives
them server-side from real frames; a student calling the RPC directly over
PostgREST could fabricate them. Mitigations and the signed-verdict design are
discussed in `docs/PLAN_INTEGRITY_SUITE.md`.

---

## 7. Feature walkthroughs

### 7.1 Classes & enrollment

```
Lecturer                          Student
────────                          ───────
POST /api/classes                 POST /api/classes/join {code}
  guard requireLecturer             guard requireStudent
  createClassWithRetry():           rate-limit + DB-side throttle:
    upsert classes w/ random          class_join_attempts (5 fails
    join_code, ignoreDuplicates       /10min → locked_until 15min)
    on join_code conflict;            RPC join_class(code):
    retry ≤3 on collision               locks attempt row, checks lockout,
                                        upper(trim(code)) lookup,
                                        archived check, insert enrollment
GET /api/classes/[id]               GET /api/classes (student projection
  roster = profiles ⋈ enrollments     via student_class_view — no codes)
```

Archiving (`PATCH {archived:true}` sets `archived_at`) propagates everywhere:
joins rejected (`class_archived`), new quizzes blocked, listings filtered.
Migration 0018 added the partial index that makes archived filtering cheap.

### 7.2 Quiz authoring (manual + AI generation)

**Manual builder** (`(lecturer)/lecturer/quizzes/[id]/builder/`):

```
POST   /api/quizzes/[id]/questions   → RPC append_question
PATCH  /api/quizzes/[id]/questions/[qid] → direct UPDATE (draft-only trigger backstop)
DELETE /api/quizzes/[id]/questions/[qid]
POST   /api/quizzes/[id]/reorder     → RPC reorder_questions (validates exact id set)
POST   /api/quizzes/[id]/import-questions → RPC save_quiz_questions(p_mode:'append',
       p_title/p_source_file_url/p_source_text := NULL so provenance is untouched).
       Client parses pipe-separated text into rows (preview + atomic reject);
       the route re-validates via QuestionInputSchema (Zod array 1..30, 512 KB
       body cap), maps camelCase→snake_case rows, and relies on the RPC's
       advisory-locked cap check (30) as the authority.
```

Validation is duplicated *deliberately*: Zod schemas in
`src/lib/quizzes/validation.ts` mirror DB CHECK constraints (title ≤200,
prompt ≤2000, options 2–5 ×≤500 distinct case-insensitively, explanation
≤2000). Titles are stripped of bidi/zero-width controls (`stripBidiControls`)
since they're rendered to rosters.

**AI generation** (`POST /api/ai/generate-quiz`, route ~450 lines):

```
{quizId, extractedText?|sourcePath?, questionCount, difficulty, …}
  1. guard+CSRF+rate(10/h)+body-cap(512KB)+auth-before-parse
  2. Text acquisition:
     a. extractedText provided → use as-is (≤400k chars, Zod-capped)
     b. else load file from private storage `quiz-sources/<uid>/…`
        → nativeExtract() server-side (pdfjs/mammoth/jszip; Node build;
          ≤25MB/file, ≤200 pages, zip-bomb caps, magic-byte validated)
        → low text density ⇒ 422 "run OCR in the browser"
  3. Prompt build (lib/ai/quiz-prompt.ts): strict JSON contract,
     language/difficulty/format steering; chat call via lib/ai/client.ts
     (OpenAI SDK, baseURL override; AbortController budget GENERATION_BUDGET_MS)
  4. Parse+validate output twice: JSON.parse guarded → AiQuizSchema (Zod)
     → normalizeOptions (dedupe/fold) → aiQuizToRows (DB-shaped)
     Invalid after one retry ⇒ 422, ZERO writes (atomic replace not reached)
  5. RPC save_quiz_questions(p_mode:'replace'|'append'):
     single transaction deletes+inserts+updates quiz title/source fields
```

`regenerate-question` is the same pipeline scoped to ONE question with an
in-flight guard keyed by questionId.

### 7.3 File upload → extraction/OCR pipeline

Uploads go straight browser → private bucket via supabase-js storage
(RLS: owner-folder prefix `(storage.foldername(name))[1] = auth.uid()`),
then `quiz.source_file_url` records the path. Extraction is chosen per file
in `GenerateFromFileDialog.tsx` → `src/lib/extract/pipeline.ts`:

```
File ─┬─ native (pdfjs/mammoth/jszip text layer)  ── good text ──► done
      └─ low/no text ─► OCR engine:
           ├─ tesseract.js (WASM, default, free)
           └─ glm (rasterize pages→PNG → httpChatCompletions to LOCAL
              vLLM endpoint; probeGlmModel() gates availability)
Multi-file batches: ≤5 files, ≤50MB total, sequential extract, aggregate cap.
```

The engine choice persists in localStorage; `OcrConfig` (defaults + GLM
endpoint/model) is injected server-side into the dialog's page — never read
from env in client code.

### 7.4 Quiz lifecycle: draft → live → closed

```
POST /api/quizzes/[id]/publish   draft→live   requires ≥1 question
                                 (route pre-check + cannot_publish_empty_quiz trigger)
                                 live→live idempotent; closed→live rejected 409
POST /api/quizzes/[id]/close     live→closed (one-way; trigger enforces;
                                 idempotent re-close → 200; draft → 409)
POST /api/quizzes/[id]/reveal    results_revealed_at flip — live OR closed
                                 (QC-2; draft → 409 quiz_not_revealable)
POST /api/quizzes/[id]/duplicate → RPC clone_quiz (AP-2; any source status —
                                 destination is ALWAYS a fresh draft via the
                                 quiz_status_transition trigger; destination
                                 class must be owned + unarchived → 409
                                 class_archived; the 30-question cap is
                                 deliberately NOT enforced on a faithful copy)
DELETE /api/quizzes/[id]         blocked 409 if any quiz_sessions exist
```

A DB trigger (`quiz_status_transition`) is the backstop for every transition
— the route can be raced, the trigger cannot. Publishing fires the
`notify_quiz_live` notification trigger; closing fires `notify_quiz_closed`
(see 7.10). Availability windows (`opens_at`/`closes_at`) gate STARTS and
ANSWERS at the RPC boundary (`quiz_not_open` / `quiz_window_closed`) and a
pg_cron job (`innovision-quiz-autoclose`, best-effort every 5 min) flips
past-window quizzes closed — windows never filter the student list;
visibility follows status only. Retake config (`allow_retake`/
`max_attempts`) and windows are live-quiz management (outside the DB
edit-freeze). Full record: PLAN_CLOSE_AND_SCHEDULE.md.

### 7.5 Assessment session: the core loop

Entry point: student clicks Start on a live quiz → `POST /api/sessions`
→ RPC `start_quiz_session` (two partial unique indexes enforce the
attempt invariant: `one_assessment_attempt_per_attempt` — one row per
(quiz, student, attempt) — and `one_active_assessment_attempt` — at most
one NON-completed attempt per (quiz, student); returns the existing
session on rejoin — crash-safe). Default config (`allow_retake=false`,
`max_attempts=1`) behaves as one attempt per student per quiz; when the
lecturer enables retakes (QC-4, migration 0032), a COMPLETED student
spawns attempt = max+1 while budget remains, and each attempt's evidence
(answers, face checks) is preserved. A stale non-completed session whose
window has PASSED is sealed completed on next start (evidence preserved;
the spawn itself is window-stopped).

The representative result is the LATEST completed attempt
(`student_results`, export, EndScreen all order by `started_at DESC`) —
never best-score.

Then the play page (`play/[sessionId]/page.tsx`, server component) loads the
envelope + first question via `student_session_view` and hands off to
`src/components/quiz/play-client.tsx` (client island) which owns:

- **Phase machine**: `gate → question → feedback → submitting/submitted |
  paused | recovering | flagged | timeUp | dead`
- **Face pipeline** (`use-face-pipeline.ts`): boots tracker, drives verify
  cadence, reacts to statuses
- **Timer**: UX countdown synced to `started_at + time_limit`; expiry forces
  submit (`timeUp` phase still allows one retry-submit)
- **Answers**: `POST /api/sessions/[id]/answer` → RPC `answer_question`
  - validates index against THAT question's option count (no clean-400
    pre-fetch by design)
  - stores `(selected_index)`; computes `is_correct` server-side
  - **assessment**: response is KEYLESS `{ok}` pre-reveal — the correct
    answer never crosses the wire until results are revealed
  - **practice**: response includes correctness + explanation immediately
- **Multi-select questions (QT-1, `type = 'multi_select'`)**: the answer
  key is `questions.correct_indices` (sorted+distinct int[], the scalar
  `correct_index` is NULL on multi rows); students submit
  `selectedIndices` (1..5 elements, each validated against THIS question's
  options, SQL NULLs rejected explicitly) which the RPC normalizes to
  sorted+distinct before grading as exact-set equality and storing in
  `session_answers.selected_indices` (scalar stays NULL). Grading is
  all-or-nothing — `is_correct` semantics are unchanged, so
  submit_session/scoring/gradebook structure is untouched. Multi rows are
  answered by taps (toggle + Confirm button) OR gestures (holding N
  fingers toggles presented option N, an open palm commits the set; a
  latch re-arms only after the pose changes, and the 4-option cap
  `questions_multi_option_cap` guarantees five fingers is never an option
  pose). Student-authored quizzes are v1-out-of-scope and BLOCKED by a
  CHECK on `student_quiz_questions`.
- **Per-student shuffling (QT-3, opt-in `quizzes.shuffle_questions`)**:
  when on, the play page permutes the question array AND each question's
  options into "presented" space, deterministically derived from
  (sessionId, question id) by `src/lib/sessions/shuffle.ts` (FNV-1a →
  mulberry32 → Fisher-Yates; pure integer ops, shared client + server).
  Nothing is stored: resume/multi-device reloads re-derive the identical
  order, and a retake (new session id) reshuffles. The client translates
  presented→canonical indices BEFORE the POST, so the wire, RPC, and
  `session_answers` stay canonical; stored canonical indices are translated
  back for resume seeds and the EndScreen breakdown (lecturer surfaces and
  exports stay canonical — one answer key across all students). The gesture
  layer needs no changes (finger N selects presented slot N-1; translation
  happens downstream). Presentation obfuscation, not a security boundary:
  the RPC still validates and grades whatever canonical index arrives. The
  flag is DRAFT-FROZEN (`quiz_not_draft_edit`) — the permutation is only
  stable because question rows/options are draft-frozen too, and the
  `"questions"` scope is positional (a future live-question editor would
  desync the mapping). Student practice quizzes (no session row) are out
  of scope.
- **Pause sources (all server-mediated)**:

| Source | Trigger | Effect |
|---|---|---|
| face fail streak | 3 fails in last 5 checks | `paused` → recover flow (blink liveness + re-verify) |
| focus loss | visibility/blur advisories, debounced | 3rd strike auto-flags session |
| hand loss | MediaPipe loses both hands mid-hold | transient `hand_loss` pause (auto-resumes) |

Recovery paths out of `paused`/`flagged`:

```
student: POST /api/face/self-recover  → self_recover_session()
         (blink challenge → record_face_check; flagged is lecturer-only)
lecturer: POST /api/face/unlock       → unlock_session()   (resets counters,
                                       rotates nonce, credits paused time back)
          POST /api/sessions/[id]/exempt-face → exempt_face_session()
                                       (camera-off fallback; face_exempt=true,
                                       resets fail streak + focus counter)
          POST /api/sessions/[id]/reset → reset_session() (D13: voids attempt;
                                       student's next action hits 404 → dead screen)
```

Every one of those writes an `audit_events` row surfaced in the lecturer's
timeline (`lecturer_audit_view`).

**Submit**: `POST /api/sessions/[id]/submit` → RPC `submit_session`
(row-lock → compute score from `session_answers.is_correct` count → mark
completed → maybe auto-reveal — see 7.9).

### 7.6 Face verification protocol (the deepest part)

**Enrollment (once per student)** — `student/face/enroll/page.tsx`:

```
consent checkbox → POST /api/face/consent {consent:true} → grant_face_consent()
camera starts ONLY after consent (privacy invariant)
3 angles (front/left/right), each frame:
  waitForBlink(liveness) → captureBestFrame(centered, open eyes, lit)
POST /api/face/enroll {frames:[front,left,right]}  (route: api/face/enroll/route.ts)
  1. consent pre-check (frames must NEVER leave server w/o consent)
  2. if face_deletion_pending → deleteSubject() first (orphan hygiene)
  3. per-frame CompreFace /detect → pose validation (front |yaw|≤30°,
     sides 10–75°) → 400 pose_invalid otherwise
  4. per-frame /recognize → duplicate-identity scan (best NON-self match
     ≥0.45 passed to RPC)
  5. addSubjectExample(uid, frame) ×3
  6. RPC enroll_face(dup_subject, dup_similarity) → status 'enrolled'
     or 'pending_review' (lecturer clears via audit view)
  any failure → best-effort deleteSubject rollback (no orphan samples)
```

**Verification (during an assessment)** — driven by `use-face-pipeline.ts`:

```
cadence: periodic (30–45s) + on question transitions; nonce-chained:
  GET session → verify_nonce(N₀)
POST /api/face/verify {sessionId, frames[≤3], trigger, nonce:Nᵢ}
  route (api/face/verify/route.ts):
    1. guard/CSRF/rate(10/min)/frame-size caps
    2. consent+enrollment pre-check BEFORE any biometric leaves
    3. per non-empty frame: compreface.recognizeFaces(frame) (1:N search)
       selfSimilarity(faces, uid) — extracts CALLER's own similarity, so a
       lookalike classmate ranking top-1 cannot hurt the score
       empty frame = FAIL vote (integrity-conservative)
    4. RPC record_face_check(session, uid, similarities[], trigger, nonce, frame_hashes)
       - verifies nonce == session.verify_nonce → mismatch 409
       - rotates verify_nonce (replay protection)
       - matched = STRICT MAJORITY(similarities ≥ 0.5)
       - flat last-5 window: ≥3 fails → 'paused', writes face_checks row
         (hashes only — pixels never persisted)
  response: {matched, distance, sessionStatus, nextNonce, faceFailStreak}
```

Client statuses derived from that: `off → booting → ready → paused/
recovering → flagged/unavailable`. Tab-hide pauses the cadence and issues a
catch-up verify on return (nothing recorded while hidden).

**E2E mock seam**: fake tracker emits marker frames
(`FAKE_FRAME_MATCH/MISMATCH`); when `NEXT_PUBLIC_E2E_FAKE_SEAM === "1"` AND
`COMPREFACE_MOCK_ENABLED === "1"`, `compreface-client.ts` returns canned responses —
harness-only opt-in (`seam-gate.ts`), set only in `playwright.config.ts`'s
webServer env. Replaced the earlier `NODE_ENV ≠ production` gate, which went
dead when the suite switched to the production build (5f6b1da).

### 7.7 Gesture answering (hand tracking)

```
vendor'd MediaPipe tasks-vision HandLandmarker (public/mediapipe, /models)
lib/gestures/hand-tracker.ts  → per-frame landmark detection (RAF loop)
finger-count.ts               → landmarks → raised-finger bitmask
hold-confirm.ts               → hold N consecutive frames to commit an answer
hand-loss.ts                  → both hands gone mid-flow → pause signal
gesture-layer.tsx             → overlays: calibration, scan countdown,
                                finger HUD, hand-loss pause; input gating
```

Answer submission reuses the same `/answer` endpoint — fingers only replace
the click. Calibration (open-palm pose) is skippable → click-first fallback.
The whole subsystem is behind interfaces; E2E injects deterministic fakes
(`e2e/fake-hand-tracker.ts`) so CI never loads WASM models.

### 7.8 Incident clips (pre-incident video)

Ring buffer in `use-incident-recorder.ts`: MediaRecorder chunks kept in
memory (capped), continuously overwritten. On a status transition INTO
`paused/flagged/unavailable` the buffer is drained and uploaded:

```
POST /api/sessions/[id]/incident  (multipart: clip, reason, durationMs, recordedFrom)
  guard student-owner + assessment + status ∈ {active,paused,flagged}
  caps: 30MB, 6/min/user, post-submit cutoff
  magic-byte sniff (EBML/ftyp) → container-derived extension/content-type
  admin client uploads to PRIVATE incident-footage bucket
  + inserts incident_clips row (upload-then-insert with orphan cleanup)
```

Clean sessions upload nothing (privacy default); submit discards the buffer.
Lecturers watch clips in the results dashboard via 1h signed URLs generated
server-side with the service-role client.

### 7.9 Results & reveal gating

Score secrecy is enforced at three layers:

1. `session_answers.is_correct` and `quiz_sessions.score` are column-revoked
   from `authenticated`;
2. `student_session_view` exposes score ONLY when
   `is_student_reveal_allowed(quiz_id)` (practice always true; assessment
   when `results_revealed_at` set);
3. answers ack keylessly pre-reveal (7.5).

Reveal switches:

```
lecturer: PATCH /api/quizzes/[id]/reveal-settings {autoRevealOnComplete}
          POST   /api/quizzes/[id]/reveal            → sets results_revealed_at
auto:     submit_session flips it when the LAST fresh session completes
          AND the submitting student has no retake budget left (QC-4;
          advisory-lock serialized, 2h staleness window, works on closed quizzes)
```

Once revealed: student sees score + per-question breakdown
(`student_results` RPC); lecturer dashboard shows full matrix regardless.
Reveal fires the `notify_results_revealed` trigger (completed-assessment
sessions get one deduped notification).

Cross-quiz aggregate (RA-1, 2026-08-28): `/lecturer/classes/[id]/gradebook`
renders a student × quiz matrix from `lecturer_session_view` (representative
session per (student, quiz) via `selectRepresentativeSessions`, feed order
`started_at DESC, id DESC`); published-assessment columns only; cells show
scores regardless of reveal state but unrevealed COLUMNS carry a marker;
per-quiz averages + per-student cumulative %; same model drives
`GET /api/classes/[id]/gradebook-export` (Summary + compact per-quiz sheets,
10/min rate limit, class-owner guard). Pure model: `src/lib/results/gradebook.ts`.

Student results entry point (SQ-2, 2026-08-28): the quiz list
(`/student/quizzes`) joins the student's completed `student_session_view`
rows + `results_revealed_at` so completed+revealed cards link
"View results" → `/play/{sessionId}` (EndScreen), completed+unrevealed cards
show an "awaiting results" status chip (no link). Flagged sessions render no
chip (intentional divergence from the gradebook, which shows their scores).

### 7.10 Notifications

Write path is entirely trigger-driven (migration 0022) — application code
never inserts notifications:

| Trigger (on) | Creates |
|---|---|
| quiz → live | `quiz_live` to enrolled students |
| session → completed/flagged | digest to lecturer / receipt to student (digest counts DISTINCT students — retake-safe, 0032) |
| results revealed | `results_revealed` to completed sessions |
| enrollment inserted/deleted | welcome / removed notices |
| face status → pending_review | reviewer notice to lecturers |

Rows carry `dedupe_key` + `unique (recipient_id, dedupe_key) nulls not
distinct` → triggers are idempotent. Retention prunes old read rows.

Read path (`NotificationBell` island in both role layouts):

```
initial SSR count (layout) → realtime channel (postgres_changes)
  + visibility-aware polling fallback (mergeNotifications dedupes by id/seq)
mark-read via RPCs mark_notifications_read[_before]; optimistic with snapshot rollback
navigation probes resolve payload → deep link (or degrade gracefully offline)
```

### 7.11 Student practice quizzes & sharing

Deliberately simpler than assessments (migration 0023):

- No mode/status/timer machinery; caps enforced by DB triggers
  (25 quizzes/student, 50 questions/quiz).
- Authoring routes mirror the lecturer surface
  (`/api/student-quizzes/**`) but filter `created_by = auth.uid()`.
- **Sharing**: `share_code` (10-char alphabet, collision-retried) is minted
  ONLY by the `student_quiz_share_action` definer RPC — INSERT/UPDATE column
  grants exclude the column, so clients can neither set nor read it via
  table access. Actions: `share` (idempotent) / `unshare` (nulls → links die)
  / `regenerate`.
- **Play** (`/s/[code]` landing + player): resolves code via
  `resolve_shared_student_quiz` (uniform 404 for unknown/revoked);
  questions served through a security-barrier view WITHOUT answers;
  grading via `answer_student_question` RPC performs ZERO writes (creator
   cannot see who played — privacy by construction). Play is open to any
  authenticated user; authoring is student-only.

### 7.12 Media: question images, avatars, student AI generation

Migration 0028/0029 (plan: `docs/PLAN_MEDIA_AND_STUDENT_AI.md`). Shared
invariant: **storage paths never cross to the client** — rendering exchanges
question ids for short-TTL signed URLs through the API.

**Question images** — `image_path text` on both question tables, private
`question-images` bucket with ZERO client policies (incident-footage posture;
grants ≠ authorization). Writes ride the multipart API routes: declared
content-length gate → magic-byte sniff (PNG/JPEG/WebP ≤5 MB) → admin-client
upload `<uid>/<uuid>.<ext>` → guarded column UPDATE → best-effort old-object
remove AFTER success (races leave swept orphans; `npm run media:cleanup`).
Quiz DUPLICATION (AP-2) replicates objects because image DELETE removes them
(a sharing clone would break): `clone_quiz` copies `image_path` verbatim →
the route then copies each object server-side (`storage.copy`, path shape
re-validated first) and repoints the clone's column via the USER client →
per-image failure NULLs the clone's path (fail-closed); objects copied just
before a failed UPDATE are rolled back immediately. Until the phase lands the
clone transiently shares the source's object (same-owner, benign — a missing
object degrades to the sign route's clean 404). Reads go through the SECURITY
DEFINER RPC `resolve_question_image(question_id)`
— THE visibility boundary: class-owner any status / enrolled+live /
enrolled+closed+reveal-allowed (archived classes excluded) for assessment
questions; creator or shared-code-holder for practice questions. Everything
else folds into the same empty result → uniform 404. The sign route
(`GET /api/question-images/[qid]`, 60/min) clamps the RPC-provided TTL
(3600 s standard, **300 s for shared-practice** so unshare kills mints fast)
and re-validates the stored path shape before signing. Players see only a
`has_image` boolean on the views/RPC rows (`student_question_view`,
`student_quiz_player_question_view`, `student_results`) and fetch URLs via an
expiry-aware client hook.

**Avatars** — `profiles.avatar_path` (self-writable; NOT a restricted column),
private `avatars` bucket, contract `<uid>/avatar.<ext>`. Same route-mediated
upload + sniffing (≤2 MB); a camera BADGE on the topbar avatar opens the file
picker directly (one-click upload/replace) and the self-only signed URL is
served by `/api/profile/avatar`. Removal lives inside the account menu; no
other surface renders it (roster visibility deliberately out of scope).

**Matric numbers** — captured at registration (validated + uniqueness-guarded
by 0027's unique index) and READ-ONLY in the app thereafter: the profile menu
shows the value with no edit control, and corrections are dev/service-role
operations against the DB.

**Student AI generation** — `POST /api/student-quizzes/[id]/generate`
composes the SAME lib/ai pipeline as the lecturer route but guards on
creator ownership, hides steering/format controls in the shared dialog, and
saves atomically via `save_student_quiz_questions` (0025-parity bulk RPC:
is_student recheck, jsonb depth, counts under the VERBATIM 0023 advisory-lock
key `'student_quiz_append:'||quiz_id`). Cost guards: 5/h in-memory PLUS the
service-role-only `ai_generation_usage` daily counter. The quiz-sources
INSERT policy was WIDENED back to owner-folder-for-any-authenticated-user
(0007 had restricted it to lecturers) so students can upload source material
into `${uid}/${quizId}/…`.

---

## 8. i18n

- Library: `next-intl`. Locale resolution: cookie → `src/i18n/request.ts`
  (default `en`), messages in `src/messages/{en,ms}.json`.
- Server components: `getTranslations()`; client components:
  `useTranslations()`. Provider wraps the whole tree in `app/layout.tsx`.
- Shared failure panels (`components/layout/load-state.tsx`), error/404
  pages, and every API-error message rendered in the UI come from message
  keys — hardcoded copy is a lint/review smell here.
- `npm run check:i18n` enforces en↔ms key parity AND that every key
  referenced via `t(...)` exists (CI step).

---

## 9. Testing map

| Layer | Tooling | What it covers |
|---|---|---|
| Pure units | Vitest (`src/**/*.test.ts`) | scoring, timers, validation, gestures, liveness, merge logic, derive |
| Route tests | Vitest + `fake-supabase.ts` (a fake that mimics RLS/RPC semantics and THROWS on unknown filters) | every API route's guard/CSRF/rate-limit/validation/error-mapping contracts |
| AI boundary | MSW (`src/test/msw`) | mocked OpenAI-compatible endpoints |
| Live-SQL harnesses | `npm run verify:*` (needs local supabase) | RLS policies, RPC state machines, caps, secrecy probes (e.g. `verify:student-quizzes` SQ-D1–D9 + QT1-D8b/D10, `verify:media` MEDIA-D1–D12, `verify:quizzes` QT3-D1–D6 + QT1-D1/D2, `verify:sessions` D42–D55 + QT1-D3–D8a/D7, `verify:clone` AP2-D1–D11 + QT1-D9) |
| E2E | Playwright, chromium, dev-server + mock AI + CompreFace mock seam | full user journeys; `e16` is the integrity reference spec; specs skip loudly if `LECTURER_INVITE_CODE` unset; `e45` covers the multi-select journey (authoring, practice set-feedback, resume, keyless assessment + canonical-set probe, gesture-disabled contract) |
| Types/schema drift | `gen:types` + CI diff | database.ts vs migrated schema |
| Copy drift | `check:i18n` | en/ms parity + referenced-key existence |

Per-file coverage gates live in `vitest.config.ts` (browser-only glue is
explicitly 0-gated because E2E owns it).

---

## 10. Environment variables

See `.env.local.example` for the authoritative annotated list. Summary:

| Var | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | everywhere (browser + server) | anon key is RLS-scoped by design |
| `SUPABASE_SERVICE_ROLE_KEY` | admin client only (incident storage, results signing, register promotion) | server-only module; bypasses RLS |
| `LECTURER_INVITE_CODE` | register promotion | hashed compare; also required by e2e specs |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | `lib/ai/client.ts` (server) | OpenAI-compatible; e2e points at the mock server |
| `COMPREFACE_BASE_URL` / `_API_KEY` | `compreface-client.ts` (server) | self-hosted Docker |
| `COMPREFACE_MOCK_ENABLED` | same | `"1"` opts into canned responses (non-prod only) |
| `GLM_*` | extraction dialog config | optional local vLLM OCR |
| `PLAYWRIGHT_PORT`, `MOCK_AI_PORT` | e2e | defaults 3001 / 8787 |

---

*Generated during the Aug 2026 audit remediation. If behavior covered here
changes, update this doc in the same PR — see doc conventions in README.*

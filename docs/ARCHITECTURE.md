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
   7.6 Face verification protocol (the deepest part)
   - 7.7 Gesture answering (hand tracking)
   - 7.8 Incident clips (pre-incident video)
   - 7.9 Results & reveal gating (+ export)
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
│  ├─ /api/* route handlers (~51) — self-authenticating       │
│  ├─ Server actions: login / register / locale               │
│  └─ "server-only" modules hold all secrets                  │
└──────────────┬──────────────────────────────────────────────┘
               │ PostgREST (supabase-js) — user JWT or service role
┌──────────────▼──────────────────────────────────────────────┐
       │  Supabase (self-hosted local / hosted)                     │
       │  ├─ Postgres: tables, RLS on everything, SECURITY DEFINER   │
       │  │   RPCs own every sensitive write; pg_cron jobs (7):      │
       │  │   autoclose, silence flag, incident prune, AI-mark       │
       │  │   sweep + escalate, verify-silence + notify prunes       │
       │  ├─ Auth (GoTrue): sessions, cookies via @supabase/ssr      │
       │  ├─ Storage: private buckets (quiz-sources, incident-footage│
       │  │   question-images, avatars — last two zero-policy)        │
       │  └─ Realtime: notifications channel                         │
└──────────────┬──────────────────────────────┬───────────────┘
               │ HTTP                          │ HTTP
┌──────────────▼─────────────┐  ┌─────────────▼───────────────┐
│  InsightFace sidecar       │  │  GLM-OCR (vLLM, optional)   │
│  (single FastAPI/ONNX      │  │  OpenAI-compatible chat for │
│  container; /extract →     │  │  OCR + AI question gen;     │
│  512-d embedding + pose +  │  │  local leg OR Z.ai remote   │
│  MiniFASNet spoof verdict) │  │  leg behind one route       │
└────────────────────────────┘  └─────────────────────────────┘
```

Key files: `package.json`, `next.config.ts` (security headers, React
Compiler), `proxy.ts` (middleware), `supabase/migrations/0001–0067`
(authoritative schema — 64 files; 0061/0063/0064 are pgTAP test rounds under
`supabase/tests/`, not migrations),
`src/lib/supabase/{server,client,admin,middleware}.ts`.

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
`checkSameOrigin`, the streaming-capped body readers `readCappedJson` /
`readCappedText` / `readCappedFormData`, `firstIssueMessage`) and
`src/lib/classes/guards.ts` (`requireUser`, `requireLecturer`,
`requireClassOwner`, …). Ownership helpers: `requireQuizOwner` joins
quiz → class → lecturer so a non-owner gets the same 404 as a missing row
(**no-oracle**: responses never distinguish "doesn't exist" from "not yours").

---

## 4. Auth, roles, and identity

- **Supabase Auth (GoTrue)** owns credentials + sessions; the app stores
  nothing password-related. PKCE code exchange lands in `/auth/callback`
  (shared by password recovery AND Microsoft institutional SSO — the route
  hardens failed exchanges with a local signOut whose cookie deletions ride
  the RETURNED redirect response).
- **`profiles` table (id = auth.users.id)** carries `role`
  (`'student' | 'lecturer'`), `full_name`, `locale`, consent/enrollment state.
  Created by trigger `handle_new_user` (latest definition 0038) which
  **hardcodes `role='student'`** — client-supplied metadata is ignored
  (role-escalation fix); 0038 additionally maps the OIDC `name` claim to
  `full_name` for Microsoft SSO users (password signups keep setting
  `full_name` metadata explicitly).
- **Microsoft institutional SSO (AU-2, 2026-08-31)**: `signInWithOAuth`
  (provider `azure`, tenant-specific authority configured dashboard-side)
  starts in `src/lib/auth/sso.ts`; the shared callback enforces a SECOND
  trust layer — `src/lib/auth/institutional.ts` allowlists
  `INSTITUTIONAL_EMAIL_DOMAINS` (case-insensitive exact match, fail-closed
  when unset) and rejects personal Microsoft accounts with a local signOut +
  `/login?message=sso-domain`. Same-email password accounts auto-link (no
  data merge). OAuth-provisioned students have `matric_no NULL` — the
  student layout gates them behind one-time `/matric-capture`
  (`src/lib/auth/matric-capture.ts`, server-side 0027 validation + role
  check) until captured.
- **Locale** is a cookie (`LOCALE_COOKIE_NAME`), read by
  `src/i18n/request.ts`; users change it via the server action `setLocale`
  (no HTTP route — there is no `/api/locale`), stored on `profiles.locale`
  too.
- **Lecturer promotion** happens only in the `register` server action
  (`src/lib/auth/register.ts`): the submitted invite code is compared against
  a hash of `LECTURER_INVITE_CODE` using `extensions.digest` in
  **constant time**; on match the action upserts `profiles.role='lecturer'`.
  The DB restricted-columns trigger (`protect_profile_restricted_columns`,
  migration 0019) rejects any direct client write to `role` /
  `consent_given_at` unless an RPC set the `app.consent_write` GUC.
- **Institutional-domain gate in the trigger itself (0050)**: `handle_new_user`
  reads the `app.institutional_email_domains` GUC in the one chokepoint every
  provisioning path passes (password signup, OAuth, admin API) — an unset GUC
  means no restriction, a set one refuses foreign domains at the DB layer,
  closing the public GoTrue signup bypass.
- **Matric numbers**: SSO-provisioned students have `matric_no NULL` — the
  student layout gates them behind one-time `/matric-capture`
  (`src/lib/auth/matric-capture.ts`, server-side 0027 validation + role
  check) until captured. A captured `matric_no` is IMMUTABLE via
  self-service (0046) and can never enter the reserved `99xxxx` namespace
  (0027 CHECK + 0038 signup validation, 6-digit format).

Login/register flows: `src/app/(auth)/login/page.tsx`,
`src/app/(auth)/register/page.tsx` (client components calling server actions
in `src/lib/auth/*.ts`). Redirects after login pass through
`sanitizeRedirect` (kills protocol-relative, backslash, encoded-CRLF, and
cross-origin targets; ALSO re-checks its own output for dot-segment
re-entry — `/a/..//evil.com` normalizes to a `//host` path that would
otherwise pass the input checks). The same `?redirect=` contract is threaded
by the QR class-join feature through ALL THREE auth paths: password login
(`login-form.tsx`), register (`register/page.tsx` reads + sanitizes, pushes
post-signup; `register.ts` additionally passes it as the email-confirmation
`emailRedirectTo` so the confirm round-trip lands on the target), and SSO
(`startInstitutionalSso({redirect})` re-sanitizes server-side and appends
the param to the callback `redirectTo`; `SSO_START_RATE` is 60/min —
classroom-NAT scale, since a lecture hall shares one egress IP).

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
            │                  gestures_enabled (0052, draft-frozen),
            │                  source_file_url, sources jsonb provenance…)
            │                  └──< questions (order_index, type
            │                        [mcq|true_false|multi_select|short_text],
            │                        options[], correct_index (null on multi),
            │                        correct_indices (multi only), explanation,
            │                        answer_key (short_text rubric — revoked),
            │                        max_score, image_path — all key columns
            │                        column-revoked from authenticated, 0054)
            │                  └──< quiz_sessions (student_id, status, mode,
            │                        verify_nonce uuid, face_fail_streak,
            │                        focus_pause_count, fullscreen_pause_count,
            │                        hand_pause_count, face_fail_count,
            │                        last_pause_reason, face_exempt,
            │                        score NUMERIC, started_at/submitted_at…)
            │                        ├──< session_answers (unique(session_id,
            │                        │    question_id), selected_index,
            │                        │    selected_indices (multi only),
            │                        │    answer_text (short_text), skipped,
            │                        │    mark_status [pending|marked|
            │                        │    needs_review|failed], mark_score
            │                        │    (0/0.5/1 ladder), attempt_version,
            │                        │    is_correct)   ← is_correct, mark_*,
            │                        │    answer_text column-revoked (0048/0054)
            │                        ├──< face_checks (similarities[], matched,
            │                        │    trigger, nonce, frame_poses, frame_hash
            │                        │    — frames NEVER stored)
            │                        ├──< session_advisories (adv_type, count)
            │                        └──< incident_clips (storage_path, reason,
            │                             duration_ms, recorded_from)
            ├──< student_quizzes (created_by, share_code nullable unique)
            │         └──< student_quiz_questions (same shape as questions)
            ├──< notifications (recipient_id, type, payload jsonb,
            │                   dedupe_key, seq identity, read_at)
            ├──< audit_events (actor_id, subject_id, action, metadata)  ← RLS deny-all
            ├──< class_join_attempts (fail_count, locked_until)         ← RLS deny-all
            ├──< profile_face_samples (pgvector 512-d, zero policies,   ← service_role only
            │                         one row per (profile, angle), 0039)
            └──< ai_marking_ledger (idempotency_key unique, status,     ← service_role only
                  attempts ≤3, claim_token 5-min lease, tokens/usd spend,
                  day; RLS deny-all, 0057)                              
```

Statuses:

- `quizzes.status`: `draft → live → closed` (one-way; enforced by trigger).
- `quiz_sessions.status`: `active ↔ paused → completed`, plus `flagged`
  (terminal until lecturer unlock/exempt) and `abandoned` (sealed stale
  attempts — 0056).
- `session_answers.mark_status`: `pending → marked | needs_review | failed`
  (short_text AI-marking state machine, 0052).

Views worth knowing (all definer-owned, `security_barrier`):

| View | Purpose |
|---|---|
| `student_class_view` | enrolled classes without `join_code`/lecturer columns |
| `student_quiz_view` | LIVE quizzes of enrolled classes (+ reveal metadata, retake config, `gestures_enabled`) |
| `student_closed_revealed_quiz_view` | closed+revealed read path (QC-2 twin of the above) |
| `student_session_view` | own sessions incl. `verify_nonce` + `attempt`; score NULL until revealed |
| `lecturer_session_view` | lecturer-visible sessions incl. score + integrity counters + `pending_count`, never nonce |
| `student_question_view` / `student_quiz_player_question_view` | questions with NO answer key of any kind behind the barrier |
| `lecturer_questions_view` | owner-predicated view with FULL answer keys — the ONLY key-bearing read path for lecturers (base-table key columns revoked in 0054) |
| `student_answers_view` | own answers; `answer_text`/`skipped` ungated (resume), `mark_status`/`mark_score` reveal-gated |
| `lecturer_answers_view` | full per-answer matrix for the quiz's lecturer |
| `student_results` (RPC) | reveal-gated score + per-question review incl. `answer_key` (latest completed attempt) |

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
5. **Column-level secrecy.** Students cannot SELECT `questions.correct_index`,
   `correct_indices`, `answer_key`, `explanation`, or `image_path`, cannot
   read `session_answers.is_correct`/`mark_score`/`mark_status` or
   `quiz_sessions.score` directly (column-revoked: 0012, re-done properly in
   0048/0054 with explicit column grants) — those values are re-exposed only
   through reveal-gated views/RPCs. The posture is "revoke the table, then
   grant explicit safe columns" (the 0048 lesson: column revokes were no-ops
   while a table grant stood).

Additional hardening: CSRF via Origin check (`checkSameOrigin`),
per-user in-memory rate limits on every mutating route, body-size caps
pre-parse, magic-byte sniffing on video uploads, constant-time invite-code
compare, CSP currently Report-Only (`next.config.ts`), secrets only in
server-only modules, `.env.local` gitignored.

**Trust boundary (face similarity numbers) — CLOSED (0045/0047/0067).** The
browser once sent raw similarity numbers to `record_face_check`; a student
calling the RPC over PostgREST could fabricate them. Now:
`app_private.verify_proof_secret` (HMAC key generated at migration time,
fully revoked from client roles) is read ONLY by the server route via the
service-role-only `get_verify_proof_secret()`; the route mints
`HMAC-SHA256(secret, "sessionId:nonce:frameHash")` proofs that the RPC
verifies (double-HMAC compare) inside the transaction, and a per-session
attempt ledger (`app_private.face_verify_attempts`, 600/10 min) burns budget
on every attempt. 0067 extends the same mechanism to ANSWERS: the answer
route mints a second "answer proof" HMAC over the canonical answer fields,
so identity verification and grading commit together or not at all.

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

**QR scan-to-enroll deep link (2026-09-12)**: the lecturer class detail page
renders a QR (`react-qr-code`, pure SVG) of `{origin}/join/{joinCode}` —
hidden on archived classes. `/join/[code]` is a TOP-LEVEL route (the
`/matric-capture` pattern) reachable by both roles: middleware bounces
anonymous scanners to `/login?redirect=/join/CODE` (`/join` is deliberately
NOT in `PUBLIC_ROUTES` — the authenticated-bounce would destroy the lecturer
branch), then the page branches by `profiles.role`: students get a
confirm-and-join island (POST `/api/classes/join`; every typed error mapped
to a localized `join.*` key via the pure `joinErrorKey` table), lecturers
get an informational card, and malformed codes get a neutral card. The page
performs ZERO class lookups by code — the API stays the sole authority (the
no-oracle rule). The return journey threads `?redirect=` through the password
login, the register signup (including `emailRedirectTo` on the
email-confirmation round-trip), and the SSO `redirectTo` — see §4. Plan:
docs/plans/PLAN_QR_CLASS_JOIN.md.

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

**Generation event stream** (Phase 2 of docs/plans/agentic-generation.md): both
generate routes speak TWO protocols on the same POST. Default stays the legacy
JSON above. With `Accept: application/x-ndjson` the route responds 200 with an
NDJSON event stream (`src/lib/ai/events.ts` — stage/ping/reasoning/
content_delta/error/cancelled/saved_refresh_failed/done). Two-segment error
contract: guards that run before the stream opens (CSRF, body cap, auth,
ownership, draft, rate limit, in-flight, validation) keep their JSON statuses;
everything after the stream opens — INCLUDING parse-phase failures — is an
`error` event with the same code (contract revision documented in the plan).
The in-flight guard returns the distinct code `already_running` (vs
`rate_limited` for quota). Heartbeats (`{"type":"ping"}`, 12s) cover silent
phases only; the client's dead-stream detector keys on 30s of no bytes.
Cancelling aborts the upstream call and SKIPS the save (no zombie rows) and
releases the in-flight slot. `reasoning`/`content_delta` events carry raw,
unvalidated model text — clients must render them as inert plain text in an
aria-hidden region (S7 posture). The stream client is the in-dialog
generating view inside `GenerateFromFileDialog` (`GenerationProgress` +
`useGenerationStream`): step 2 morphs into a status strip + collapsed
"Thinking" accordion, the strip morphs into the outcome card at terminal
states, and the builder refreshes at the `done` EVENT (never at CTA click).
The former full-page console route (`/lecturer/quizzes/[id]/generating`,
sessionStorage handoff) is retired. `/api/extract/ocr` is deliberately NOT
stream-ified (its typed JSON errors are consumed by the dialog step 1).

**Grounded web search (topic mode)** (docs/plans/grounded-search.md —
`src/lib/ai/tinyfish.ts`, SERVER-ONLY like the AI client): lecturers can
generate from a TOPIC instead of files. The route's `prepareWebSource`
orchestrates plan (`planSearchQueries` — one small AI call embedding the
topic verbatim, falling back to direct-topic search on ANY failure) →
TinyFish Search (free, `X-API-Key`) → score/select (term overlap + position
decay, URL dedupe, 2-per-hostname cap) → TinyFish Fetch (free, one batch of
≤3 pages as markdown, links/images disabled) → fenced UNTRUSTED corpus
(12k chars/source, `MAX_AGGREGATE_CHARS` aggregate, ``` → ''' escape,
forged `=== WEB SOURCE` prefixes scrubbed). The stream adds a `search` stage
(ordered AFTER the parse-skip so the rail stays truthful) and
`tool_call`/`tool_result` events (server chrome: issued queries, result
counts, skipped fetches). Error codes: `search_unavailable` (key unset /
401-class → 503), `search_failed` (network/5xx/429-after-retry/ALL pages
failed → 502), `search_corpus_thin` (fetches OK but <200 chars → 422) —
GenerationProgress maps these to localized strip copy. Provenance persists
via `save_quiz_questions_web` (migration 0041 — the generate route's only
save RPC; migration 0040 introduced it and 0041 extended it with
`p_source_paths` so EVERY uploaded file gets a provenance entry, fixing the
under-count where a multi-file build showed "1 source" beside a
`SOURCE [1/2]` preview fence):
`quizzes.sources` gains `{kind:"web", url, title, retrieved_at, query}`
entries beside the legacy storage-path shape (permanently mixed — the 0016
freeze trigger; file and web entries combine additively). The builder renders
them as external-link chips
(`SourceChips`); students never see citations (Phase 7 accepted tradeoff).
Every citation is a URL we actually fetched — fabrication impossible by
construction. The feature flag `TINYFISH_API_KEY` (empty string counts as
absent) hides the UI mode and the route rejects with `search_unavailable`.

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

**Sealing (vs submitting).** `quiz_autoclose` also SEALS in-flight
active/paused assessment sessions of closed quizzes (flagged sessions are
excluded — no `submitted_at` write ever happens: **sealed ≠ submitted**).
A scoreless completion (sealed or abandoned) is materialized by the
`quiz_sessions_seal_score` BEFORE-trigger → `assign_seal_score()`, which
computes the D10 SUM and sets the `app.session_sealing` GUC so
`notify_session_terminal` suppresses the bogus submit mail. Stale-paused
sessions are additionally sealed at next `start_quiz_session`. Every seal
writes a `session_sealed` audit row (0066).

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
  cadence, reacts to statuses. Face enforcement (and per-answer identity
  binding) is gated on `quiz.gestures_enabled === true` — a gestures-off
  quiz runs the whole verification stack silently OFF.
- **Timer**: server-seeded `remainingMs` (the client never reads its own
  clock to start) counted down monotonically; expiry forces submit (`timeUp`
  phase still allows one retry-submit). `dead` means the session was sealed
  server-side by `quiz_autoclose` — never by a client timer.
- **Answers: `POST /api/sessions/[id]/answer` → RPC `commit_answer`
  (migration 0067) — answers and identity verification commit TOGETHER.**

  For a gesture-enabled assessment session (`mode='assessment' AND
  quizzes.gestures_enabled AND NOT face_exempt`) the RPC requires a nonce +
  exactly 3 frames + 3 server-computed similarities, verifies a second HMAC
  "answer proof" over the canonical answer fields (length-prefixed
  `questionId|selectedIndex|sorted-dedup selectedIndices|answerText|skipped`),
  then calls `record_face_check(...)` and `answer_question(...)` in ONE
  transaction under one row lock. A face non-match aborts the answer and
  returns `face_mismatch` with the `faceCheck` payload; a proof forgery dies
  at `proof_invalid`. Non-gesture sessions (practice, lecturer-exempt,
  gestures-off) delegate straight to `answer_question` — which is now
  REVOKED from `public`/`anon`/`authenticated`: `commit_answer` is the only
  public entry point (direct PostgREST grading bypass closed).

  - validates index/set/text against THAT question's shape (no clean-400
    pre-fetch by design); schedule/timer gates run BEFORE the face gate so a
    lapsed exam reports `quiz_window_closed`/`time_expired`, not
    `face_verification_required`
  - **assessment**: response is KEYLESS `{recorded:true}` pre-reveal — the
    correct answer never crosses the wire until results are revealed
    (replay of an answered question is also keyless `already_answered`)
  - **practice**: response includes correctness + explanation immediately
    (and re-answering is an upsert; assessment is one-shot first-answer-wins)
  - a second-face advisory (`report_session_advisory 'second_face'`) fires
    fire-and-forget when the frames showed 2 faces
  - rate limits: 60/min per user + 30/min per session (tightened because
    each short_text answer queues an AI marking call)

  **Question types on the wire** (`AnswerSchema` — exactly one of):
  `selectedIndex` (mcq/true_false), `selectedIndices` (multi_select, 1..5
  elements, normalized sorted+distinct before grading as exact-set equality
  against `correct_indices`; all-or-nothing `is_correct`), `answerText`
  (short_text, trimmed 1..500 chars → lands `mark_status='pending'` and a
  ledger row; contributes 0 to every score until the AI finalizer writes —
  see 7.5c), or `skipped` (terminal in assessment; a graded-0 row, not an
  absence). Student-authored quizzes are pinned to mcq/true_false
  (`student_questions_no_new_types`).
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
- **The gesture toggle (`quizzes.gestures_enabled`, 0052)**: quiz-level kill
  switch, frozen while live (`quiz_status_transition` rejects changes on a
  non-draft quiz — no "arm the pad for some students" hazard). OFF means:
  gesture layer is a passthrough with an "off" chip, hand-loss pause never
  fires, face pipeline returns `off`, and `commit_answer` delegates straight
  to `answer_question` — NO per-answer identity check. The verify-silence
  cron is toggle-aware (candidacy requires `gestures_enabled = true`) so
  gesture-off sessions are never silence-flagged. `short_text` never arms
  the AnswerPad (`TYPE_HAS_FINGER_INPUT` allow-list: mcq, true_false,
  multi_select — gesture multi-select caps at 4 options so five fingers is
  always the palm-commit pose; `questions_multi_option_cap`).
- **Pause sources (all server-mediated)**:

| Source | Trigger | Effect |
|---|---|---|
| face fail streak | 3 fails in flat last-5 checks (verdict = strict majority of ≥3 frames ≥ 0.5 vs the student's OWN baseline) | `paused` → recover flow (blink liveness + re-verify, timer credit capped at 120 s); lifetime `face_fail_count` never resets |
| frozen-frame replay | a MATCHED verdict whose frame bytes hash identically to BOTH previous commits (3× identical) | `paused` — a static image is being resubmitted (E2E mock seam + one-retry nonce-resend pair carved out) |
| focus loss | DEBOUNCED (900 ms) window blur while visible | `focus_pause_count++`; **3rd strike auto-flags**; on an already-paused session the count persists WITHOUT touching `last_activity_at` (no freshness fuzzing) |
| hand loss | MediaPipe loses both hands mid-hold | transient `hand_loss` pause; `hand_pause_count++` and **auto-flags at 3** (mirrors focus since 0044) |
| fullscreen exit | fullscreenchange exit while armed | `fullscreen_pause_count++` but **NEVER auto-flags** (0043: repeat exit→think→recover cycling is lecturer-visible; escalation stays with the lecturer). Blur/fullscreen same-gesture duplicates dedupe via a shared pause stamp; the pause route coalesces replays in a 10 s window per (user, session, reason) |
| verify silence | pg_cron `flag_verify_silent_sessions`: active GESTURE-ENABLED assessment, last face check >300s old, ≥2 answers after it, answered within 90s, no fresh+corroborated camera-outage claim, `resume_grace_until` expired, quiz still live | auto-flags (`auto_flag_verify_silence` audit) — closes the "client stopped sending verifies" bypass. audit-5 M1 (0062): `submit_session` and the `quiz_autoclose` seal arm evaluate the SAME predicate (`session_verify_silent`) at finalization, because a session that submits between cron ticks was otherwise never flagged by any writer |

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

**Session lifecycle audit (audit-5 O1, migration 0066).** In addition to the
adjudication actions above, the three lifecycle writers now emit audit rows:
`session_started` (`start_quiz_session`), `session_submitted` (`submit_session`,
carrying the score), and `session_sealed` (`quiz_autoclose`, set-based, taken
before the seal UPDATE). These make start/submit/seal observable without
inferring from `submitted_at` or notifications.

**Structured error logging (audit-5 O3).** `src/lib/log.ts` (`logError`) emits
ONE JSON line — `{level, msg, ts, error, subsystem, errorCode, sessionId}` — so
a verify-503 → cron-flag → answer-409 incident shares a `sessionId` correlate.
Adopted in the answer/verify/start/submit routes.

**Integrity snapshot (audit-5 O2/O5, migration 0065).** `integrity_snapshot(
window_hours)` (service-role only) returns `flags24h`/`flagsByAction`/
`flaggedNow`/`sealed`/`submitted`/`started`/`pendingMarks`. `/api/health`
surfaces it as `integrity` for a lecturer, so a mass false-flag deploy or a
seal/abandonment spike is visible without reading day-bucketed mail. Enabling
index: `audit_events(action, created_at desc)`.

**Submit**: `POST /api/sessions/[id]/submit` → RPC `submit_session`
(row-lock → compute score → mark completed → maybe auto-reveal — see 7.9).
The score is the **D10 single scoring arithmetic** (0055/0056), used by
EVERY score writer (submit ×2, seal, AI finalize, override, `student_results`):

```
SUM(COALESCE(mark_score, CASE WHEN is_correct THEN 1 ELSE 0 END))
  WHERE mark_status <> 'pending'      -- a pending answer contributes exactly 0
```

`quiz_sessions.score` is NUMERIC (half-marks would round under int4).
`submit_session` is deliberately permissive about *submitting* ("timer stops
ANSWERS, not submits") and, on re-submit, recomputes the D10 score so a
post-submit lecturer override reaches the student's re-read (0066 C5-7).

### 7.5c short_text AI marking (v4.9, migrations 0051–0059)

short_text answers are marked by an AI worker, asynchronously, under spend
and epoch guards:

1. **Ledger** — `ai_marking_ledger` (service_role only; carries answer text
   indirectly): `idempotency_key` (`session:question:attempt_version`),
   `attempts` cap 3, 5-minute `claim_token` lease, `day` for reconciliation,
   tokens/USD spend booked on every call so the caps actually trip.
2. **Claim — `sweep_ai_marks()`** (cron `innovision-ai-mark-sweep`, every
   minute): per-quiz daily spend caps via `check_mark_spend` (50k tokens /
   $5, fail-closed), claim ≤10 rows `FOR UPDATE SKIP LOCKED`, mint one
   claim_token, COMMIT, then `pg_net`-POST the worker (locks released before
   the 45s model call).
3. **Worker — `POST /api/internal/ai-mark-sweep`** (server-to-server;
   bearer `AI_MARK_WORKER_KEY` vs Vault/`app.settings`, constant-time
   compare, fail-closed 401 before body read): re-verifies each row's
   claim_token BEFORE any model call (a superseding sweep owns stale rows),
   fences the untrusted student answer (backtick + fence-char escaped),
   strict Zod contract `{score: 0|0.5|1, confidence, rationale ≤300}`,
   temperature 0, then writes back through `finalize_ai_mark` — epoch guard
   on `attempt_version` (a lecturer override invalidates in-flight AI
   writes), score ≥0.5 ⇒ `is_correct=true`, out-of-ladder ⇒ `needs_review`,
   D10 recompute.
4. **Escalation — `escalate_stale_marks()`** (cron every 5 min; also invoked
   by the worker route): attempts ≥3 → `needs_review` (lecturer adjudicates
   via `override_answer_mark` — bumps `attempt_version`, recomputes, and
   re-publishes the reveal through the `app.mark_overridden` GUC arm of
   `quiz_reveal_once`).
5. **Reveal coupling**: a quiz with ANY `pending` answer is never
   auto-revealed (`quiz_autoclose`/`submit_session` zero-pending term —
   reveal is irreversible, so it waits for the sweep). The student's
   EndScreen polls `student_pending_count` (a COUNT, not an oracle — never
   which, never their marks) and the lecturer's session view carries
   `pending_count`. Practice short_text has NO AI path (no spend budget):
   `mark_status='needs_review'`, never scored.

### 7.5b Client integrity hardening (deterrence tier)

Assessment-mode-only, env-kill-switchable (`NEXT_PUBLIC_INTEGRITY_HARDENING_OFF=1`,
`src/lib/integrity/hardening-gate.ts` — the Playwright harness sets it so the
main e2e suite runs hardening-free; the opt-in `e51` spec runs against a
hardening-ON build). Deterrence, NOT enforcement — the server secrecy layer
(the key never reaches the client) is the real control, and a devtools user
bypasses all of it:

- **Copy prevention** (`question-card.tsx`): `user-select:none` +
  `onCopy`/`onCut`/`onContextMenu` preventDefault on the question section.
  The `selectstart` guard was deliberately cut (a11y friction, no marginal
  deterrence).
- **Fullscreen lockdown** (`use-fullscreen-guard.ts`): entered at the gate
  Begin click (gesture-scoped — a later `ready` transition has no transient
  activation), exited deliberately on terminal phases; any exit while armed +
  active POSTs `pause(reason:'fullscreen_exit')` (plain pause). Blur and
  fullscreen-exit fire from the same app switch — a shared 2s pause stamp
  (`sharedPauseStampRef`) dedupes them so the focus counter and the incident
  recorder each act once. No auto re-request on Esc (the gesture is
  consumed); Recover re-enters. iOS Safari no-ops (no
  `documentElement.requestFullscreen`).
- **Server-recorded second-face advisory** (`second-face.ts` + verify route):
  the sidecar returns ALL faces per frame; the route now reports `second_face`
  when ≥2 of the submitted frames carry an extra face (det ≥0.6, ≥15% of the
  primary's area, center ≥1 span displaced). The client's own attention
  monitor is suppressible by a tampered browser; the frames the server judged
  are not. Review-only (advisory chip), 55s-throttled.

Also fixed in 0042: `prune_expired_incident_clips()` existed since 0021 but
was never scheduled — now daily pg_cron (`innovision-incident-prune`).

### 7.6 Face verification protocol (the deepest part)

**Enrollment (once per student)** — `student/face/enroll/page.tsx`:

```
consent checkbox → POST /api/face/consent {consent:true} → grant_face_consent()
camera starts ONLY after consent (privacy invariant)
3 angles (front/left/right), each frame:
  waitForBlink(liveness) → captureBestFrame(centered, open eyes, lit, angle)
    — `angle` gates on the SHARED per-angle yaw band (lib/face/pose-gate.ts):
      front |yaw|≤15, sides 10–45 (neutral-relative). The blended quality
      score alone cannot fail on yaw (0 points past 45°, 95/120 clears ≥90),
      so without this the capture gate is decorative (prod 2026-09-21).
POST /api/face/enroll {frames:[...], yawReadings:[...]}  (route: api/face/enroll/route.ts)
  1. consent pre-check (frames must NEVER leave server w/o consent)
  2. per-frame sidecar /extract → pose validation via
     `checkEnrollPoseServer`: the client's accepted yawReading is judged
     against the SAME band (the student was guided by it), while the
     sidecar's ABSOLUTE yaw is an anti-tamper sanity bound (≤75°). Missing
     reading → strict absolute bands (front ≤30, sides 10–120).
     Reject → 400 pose_invalid + `pose_<reason>` message (both dev and prod)
  3. per-frame duplicate-identity scan (best NON-self match
     ≥0.45 passed to RPC)
  4. RPC enroll_face(dup_subject, dup_similarity) → status 'enrolled'
     or 'pending_review' (lecturer decides via the classes-dashboard
     review panel — audit-5 M4 added approve_face_enrollment +
     list_pending_face_enrollments; before that reject had no caller)
  any failure → no samples written (the RPC is one transaction)

Enrollment is refused while ANY live assessment session exists
(`live_assessment`) — audit-5 M3, migration 0062: the previous "first-time
mid-session enrollment allowed" carve-out let a never-enrolled student bind
an arbitrary face mid-quiz. Assessment START now also requires consent
(`consent_required`) and refuses `pending_review`
(`face_enrollment_pending`) — audit-5 M2. A hard `enrolled` requirement was
deliberately NOT adopted (camera-off / camera-death students complete
click-first per PLAN risk 7; the pre-start UI gate remains the enrollment
nudge).
```

**Yaw-space contract (do not relitigate).** The tracker reports yaw RELATIVE to
a per-user calibrated neutral (nose-offset proxy, positive = user's left); the
sidecar reports ABSOLUTE 3D-68 degrees. The client ships its accepted reading
so both sides judge one space — the server never re-derives yaw in a different
space than the student was guided by. See `src/lib/face/pose-gate.ts`.

**Verification (during an assessment)** — driven by `use-face-pipeline.ts`:

```
cadence: periodic (30–45s, jittered) + a 'start' gate (explicit Begin click
  + blink liveness + anti-replay HEAD-TURN challenge) — the per-question
  verify POST was REMOVED: the identity check is now taken atomically with
  the answer commit (commit_answer, 0067). Bounded precheck deferral
  (lighting / mid-commit hand / unaligned face, max 2) then captures anyway
  — the server judges the real frame. Cadence paused while the tab is
  hidden; catch-up verify on return.
GET session → verify_nonce(N₀)
POST /api/face/verify {sessionId, frames[≤3], trigger, nonce:Nᵢ}
  route (api/face/verify/route.ts):
    1. guard/CSRF/rate(10/min)/frame-size caps
    2. baseline pre-check (face_baseline_status) BEFORE any biometric leaves
    3. per non-empty frame: sidecar /extract → pick the ONE primary face
       (largest bbox, det_score ≥ floor — never max-over-faces) →
       compare_face_baseline(emb): max cosine vs the student's OWN stored
       samples (1:1-by-baseline; no gallery search is callable by students)
       empty frame / no qualifying face = FAIL vote (integrity-conservative)
       spoof gate: per-frame MiniFASNet verdict; FACE_SPOOF_ENFORCE=1 in
       prod forces similarities to 0 on a spoof verdict (fail-closed)
    4. route mints the HMAC verify-proof (never the client) →
       RPC record_face_check(session, uid, similarities[], trigger, nonce,
       frame_hashes, proof, poses)
       - verifies nonce == session.verify_nonce → mismatch 409, rotates it
       - verifies the HMAC proof (double-HMAC compare) → forgery dies here
       - per-session attempt throttle (600/10 min, success or fail burns)
       - matched = STRICT MAJORITY(similarities ≥ 0.5)
       - flat last-5 window: ≥3 fails → 'paused'; writes the face_checks row
         (hashes + pose trail only — pixels never persisted)
       - too-frequent (<2s) / suspected-replay (identical frame hash)
         advisories recorded ON the row
  response: {matched, distance, sessionStatus, nextNonce, faceFailStreak}
```

Client statuses: `off / unavailable / exempt / gate / ready / paused /
recovering / flagged` (8-state machine). Transport-failure backstops:
consecutive transport failures or 429s degrade to `unavailable` and arm the
outage claim (`report_face_unavailable`) BEFORE the silence cron can
false-flag — the claim must be fresh AND corroborated (a real
`face_checks` row or `face_verify_attempted_at` within 10 min) to exempt a
session from silence-flagging.

**E2E mock seam**: fake tracker emits marker frames
(`FAKE_FRAME_MATCH/MISMATCH`); when `NEXT_PUBLIC_E2E_FAKE_SEAM === "1"` AND
`FACE_MOCK_ENABLED === "1"`, `insightface-client.ts` returns canned responses —
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

1. `session_answers.is_correct`/`mark_score`/`mark_status` and
   `quiz_sessions.score` are column-revoked from `authenticated`;
2. every read funnels through reveal-gated views/RPCs behind
   **`is_student_reveal_allowed(quiz_id)`** (0049 body — THE authoritative
   gate): practice always; assessment requires `results_revealed_at` set
   AND NOT (quiz live AND the CALLER has an in-flight session) — a live-quiz
   retake also masks attempt 1's correctness, deliberately;
3. answers ack keylessly pre-reveal (7.5).

Reveal switches:

```
lecturer: PATCH /api/quizzes/[id]/reveal-settings {autoRevealOnComplete}
          POST   /api/quizzes/[id]/reveal            → sets results_revealed_at
          (one-way, live OR closed — QC-2 closed-before-reveal recovery;
           refuses 409 quiz_in_progress when an in-flight session has already
           ANSWERED something; idempotent 200 {already:true}; the
           quiz_reveal_once trigger is the backstop)
auto:     submit_session flips it when NO fresh (≤2h) active/paused/flagged
          session remains AND no answer anywhere in the quiz is
          mark_status='pending' (L4 — reveal waits for the AI sweep because
          reveal is irreversible) AND the submitting student has no retake
          budget left (QC-4; advisory-lock serialized, works on closed quizzes)
override: override_answer_mark (lecturer adjudication) can UN-publish
          (results_revealed_at → NULL) only through the app.mark_overridden
          GUC arm of quiz_reveal_once, then the notify trigger re-fires
```

Once revealed: student sees score + per-question breakdown
(`student_results` RPC — single no-oracle gate `not_revealed` for
everything else, D10 score in both branches); lecturer dashboard shows the
full matrix regardless. Reveal fires the `notify_results_revealed` trigger
(completed-assessment sessions get one deduped notification).

**Quiz results export** (`GET /api/quizzes/[id]/export`, PLAN_MATRIC_EXCEL_EXPORT):
lecturer .xlsx via exceljs — Summary / Key / Distribution sheets including
per-question item analysis. Owner guard + CSRF + 10/min; ALL reads on the
user-JWT client under RLS (the barrier views — `createAdminClient()` is
deliberately forbidden here); 200-session/20k-answer caps with a truncation
warning; pending AI marks render as a neutral label. The cross-quiz
gradebook export (`GET /api/classes/[id]/gradebook-export`) shares the same
pure model family (`src/lib/results/*`).

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

On-screen item analysis (RA-2, 2026-08-31): the results dashboard gains a
collapsible "Question insights" section fed by the SAME export model
(`buildExportModel` + `summarizeQuestionStats` via
`src/lib/results/insights.ts`) — the RSC adds two reads (full question rows +
`lecturer_answers_view`, 20k cap + truncation flag) and passes a separate
serializable prop (`QuestionInsightsModel`; `ResultsSessionRow` never widens
with key fields). Per-question % correct + per-option pick bars; hints for
<30% correct (`LOW_CORRECT_THRESHOLD`) and never-picked distractors (key
options excluded).

Student quiz list deadline visibility (SQ-1/SQ-4, 2026-08-31): the list
consumes `student_quiz_view`'s `opens_at/closes_at` read-only — "Due …" chips
(amber <24h, grey past/comfortable), deadline sort (future closing-soonest
first, then undated by created_at DESC, past-closed last; pure
`list-order.ts`), and `?class=<id>` drill-down from class cards with a
removable filter chip (invalid ids → empty list; RLS backstops visibility).

Practice Try Again + resume dead-end (SQ-3, 2026-08-31): the EndScreen and
inline end-state "Try again" POST `/api/sessions` and route into the fresh
session (the practice rejoin select matches active/paused only, so a
completed attempt always yields a new session id); when every question is
answered (all-answered resume seed), the feedback button acts as
Finish → submit, eliminating the stranded no-actionable-button state.

AX-3 (2026-08-31): the timed assessment's countdown is `role="timer"`
(aria-live off); discrete sr-only milestones announce T-10m/5m/1m polite and
<30s assertive-once (`src/lib/a11y/timer-milestones.ts`, twin-pinned to the
HUD's `WARNING_THRESHOLD_MS`); answer commits and action-zone phase swaps
announce politely.

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
| E2E | Playwright (chromium desktop + mobile projects + a nowebsearch project for the web-search flags spec; 78 specs), dev-server + mock AI + `FACE_MOCK_ENABLED` mock seam | full user journeys; `e16` is the integrity reference spec; `e52` is the QR-join reference spec (deep-link + auth bounce chain); `e45` covers the multi-select journey; `e53`/`e54`/`e55` cover gestures-off, short_text, and AI marking; `e59` is the opt-in demo walk-up suite; specs skip loudly if `LECTURER_INVITE_CODE` unset |
| DB / RLS suites | pgTAP (`supabase/tests/`, `npx supabase test db`) | audit-round test suites (incl. 0063/0064 audit-5 rounds — concurrency + integrity gates) |
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
| `INSTITUTIONAL_EMAIL_DOMAINS` | `lib/auth/institutional.ts` + the 0050 DB trigger gate | comma-separated university domain allowlist; unset = no restriction |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | `lib/ai/client.ts` (server) | OpenAI-compatible; e2e points at the mock server |
| `AI_STREAM_IDLE_TIMEOUT_MS` | `lib/ai/client.ts` chatStream (server) | inter-chunk abort for streaming generations (default 90000; e2e harness sets 3000 for the stall scenario) |
| `AI_MARK_WORKER_URL` / `AI_MARK_WORKER_KEY` | AI marking worker provisioning | actuals live in DB Vault/`app.settings` (provisioned by `deploy/sync-migrations.sh`); env only seeds deploy tooling |
| `INSIGHTFACE_BASE_URL` / `FACE_SIDECAR_TOKEN` | `insightface-client.ts` (server) | self-hosted sidecar (loopback-only) |
| `FACE_MOCK_ENABLED` | same | `"1"` opts into canned responses (non-prod only, paired with `NEXT_PUBLIC_E2E_FAKE_SEAM`) |
| `FACE_SPOOF_ENFORCE` | face verify route + answer route | `"1"` in prod: a spoof verdict forces all similarities to 0 (fail-closed) |
| `GLM_*`, `ZAI_*` | extraction dialog + `/api/extract/ocr` | GLM_PROVIDER=local (vLLM) or remote (Z.ai API, billed); spend-governor vars cap it — see GLM_OCR_SETUP.md |
| `TINYFISH_API_KEY` | `lib/ai/tinyfish.ts` (server) | grounded web search flag; empty = UI hidden + route 503 |
| `TRUSTED_PROXY_COUNT`, `TRUSTED_ORIGINS` | deploy proxy posture | VPS runs NGINX in front of the app |
| `E2E_RATE_LIMIT_DISABLED`, `NEXT_PUBLIC_E2E_FAKE_SEAM`, `NEXT_PUBLIC_INTEGRITY_HARDENING_OFF`, `NEXT_PUBLIC_DEMO_MODE`, `PROD_ENV_STRICT` | harness / kill switches | never 1 in prod (`prod-guards.ts` + `instrumentation.ts` fail-closed gate) |
| `PLAYWRIGHT_PORT`, `MOCK_AI_PORT` | e2e | defaults 3001 / 8787 |

---

*Reconciled against the working tree 2026-09-25 (migrations through 0067,
v4.9 gesture-off + short_text AI marking, audit-5 hardening). If behavior
covered here changes, update this doc in the same PR — see doc conventions
in README.*

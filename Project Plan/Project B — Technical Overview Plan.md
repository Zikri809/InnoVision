# Project B — Technical Overview Plan

Companion to: `Project B — Adaptive Anti-Cramming Planner afd25f202b8a4f76bfb66db37540cf53.md`
This file covers **how** we build it. The other file covers **what** and **why**.

> **v2 amendments** (from 3-agent review): pilot stage removed — E2E tests replace it as validation gate. Vercel Cron replaced by Supabase pg_cron (Hobby tier = 1 cron/day, kills 5-min tick). RLS/service-key rule added. Engine spec gaps resolved (§7). Schema extended. See §11 for full change log.

---

## 1. Confirmed stack

| Layer | Choice | Status |
| --- | --- | --- |
| Framework | Next.js (App Router) + TypeScript | Confirmed |
| API | Next.js Route Handlers (`app/api/...`) | Confirmed |
| Backend-as-a-service | Supabase (PostgreSQL + Auth + Storage) | Confirmed |
| UI component library | **shadcn/ui** + Tailwind CSS | Confirmed |

## 2. Proposed additions (flagged before use)

Each entry below is a tech choice I recommend. **Nothing here is final — confirm or replace each one.**

| # | Tech | Purpose | Why this one |
| --- | --- | --- | --- |
| 1 | **Vercel** (hosting) | Deploy web app + API routes | Native Next.js host, zero config |
| 2 | ~~Vercel Cron~~ → **Supabase pg_cron + Edge Function** | Reminder tick every 5 min | Vercel Hobby allows only 1 cron/day; pg_cron is per-minute and free |
| 3 | **grammY** | Telegram bot framework | Modern TS-first, webhook mode fits Next.js API routes |
| 4 | **OpenAI / Anthropic vision API** (one, behind adapter) | Bounded AI: extract exam/lecture schedule fields from images | Structured output (JSON schema) support; only AI call in the whole system |
| 5 | **pdfjs-dist** | PDF page-count extraction server-side | Runs in Node without native deps (pdf-parse breaks on serverless) |
| 6 | **Vitest** | Unit tests for engine + state machine + reminders | Fast, TS-native, no config vs Jest |
| 7 | **Playwright** | E2E happy-path tests — **now the validation gate** (replaces pilot) | Covers 14-step demo script on web + mocked Telegram |
| 8 | **zod** | Validate API inputs + AI extraction output schema | Same schema validates extraction JSON and text parsing |
| 9 | **Tailwind CSS** | Styling base under the chosen UI library | Confirmed — shadcn/ui is Tailwind-native |
| 10 | **Supabase migrations CLI** | Version-controlled DB schema | Schema in git, reproducible environments |

**Explicitly NOT used** (per plan §7): vector DB, embeddings, LangChain/agents, Redis/queue infra, OCR engines, WhatsApp API. Vision-LLM-only for extraction (no self-hosted OCR; revisit if monthly extraction cost > ~$50 ≈ 2–5k images).

## 3. Architecture

```
Browser (Next.js pages) ──────────┐
                                  │
Telegram webhook (grammY) ────────┼── Next.js API routes
   /api/telegram/webhook          │    ├── /api/engine/*        (pure route engine)
                                  │    ├── /api/sessions/*      (state machine)
Supabase pg_cron ─────────────────┤    ├── /api/reminders/tick  (called by Edge Function, CRON_SECRET)
   every 5 min → Edge Function    │    ├── /api/extract/schedule (vision adapter)
     → POST /api/reminders/tick   │    └── /api/telegram/*      (linking, outbound send)
                                  ↓
                     Supabase
                     ├── Postgres (all tables, RLS on)
                     ├── Auth (email; Telegram ID linked to user row)
                     └── Storage (PDF slide decks, timetable images)
```

Rules:
- **Engine is a pure module** (`lib/engine/`). No DB, no I/O — input objects in, plan objects out. Week 1 tests run against it directly.
- Telegram webhook calls the same service functions as web routes. Zero duplicated planning logic.
- One AI call site: `/api/extract/schedule`. Everything else deterministic.
- **DB access rule (security):** server routes run without user JWT → RLS is bypassed by the service key. All queries go through one helper `db/forStudent(studentId)` which injects the `student_id` filter. The raw service client is never imported anywhere else. One RLS test proves the anon key cannot read cross-student rows.
- **Extraction adapter is an interface** (`lib/extraction/types.ts`: `ScheduleExtractor.extract(imagePath) → ExtractedScheduleDraft`). MVP impl = vision LLM. Swap to OCR+text-LLM later touches one file.
- **Telegram never sends PDF files** (bot API 20MB limit) — deep links into web session instead.
- **Async extraction:** webhook returns 200 immediately, processes via `waitUntil`, delivers result as a new message — avoids serverless timeout + Telegram webhook retry duplication.
- Extraction images deleted from Storage on confirm/reject (PII hygiene).

## 4. Database schema (Supabase/Postgres)

```sql
profiles         (id uuid pk references auth.users, email, phone_number, timezone, telegram_chat_id, telegram_link_code)
courses          (id, student_id fk, name, status, buffer_minutes_consumed int default 0, created_at)
                 -- no total_pages column: workload derives from documents.page_count sum
examinations     (id, course_id fk, exam_date, start_time, finish_time, venue, input_method, confirmed_by_student)
availability_blocks (id, student_id fk, course_id fk null, type check('lecture','work','club','busy','quiet','rest'),
                     day_of_week smallint null, specific_date date null, start_time, finish_time,
                     recurring_weekly bool, input_method, confirmed_by_student)
documents        (id, course_id fk, filename, storage_path, page_count, file_hash)
study_sessions   (id, course_id fk, document_id fk, slide_start, slide_end, activity_type,
                  scheduled_at timestamptz, started_at timestamptz null, completed_at timestamptz null,
                  response check('DONE','SKIP') null, state, manually_edited bool default false)
confusion_notes  (id, study_session_id fk, student_text, created_at)
reminder_log     (id, study_session_id fk, channel, sent_at, status)
extraction_drafts (id, student_id fk, image_path, extracted_json, status check('pending','confirmed','rejected'))
processed_updates (telegram_update_id bigint pk, processed_at)   -- webhook idempotency
plan_runs        (id, course_id fk, engine_version, inputs_json, output_hash, created_at)  -- determinism proof
events           (id, student_id fk, name, payload jsonb, created_at)  -- funnel metrics
```

Notes on v2/v3 changes:
- **No page-count question anywhere**: students don't know their page count. It comes ONLY from PDF upload (`documents.page_count`, auto-extracted). Course creation = name only. Total workload = sum of the course's document page counts. UI says "pages" never "slides" (4-up handouts undercount slides 4×).
- **`started_at`** on sessions: enables reminder→start latency metric. State machine timestamps it on entering STUDYING.
- **`processed_updates`**: insert-first, process-second → duplicate webhook delivery can't double-apply DONE/SKIP.
- **`manually_edited`**: replan regenerates future sessions EXCEPT flagged ones — they become fixed anchors.
- **`buffer_minutes_consumed`**: review buffer spending is tracked; remaining buffer = 20% total − consumed.
- **`plan_runs`**: store inputs + engine version + output hash per generation; demo replays one to prove determinism.
- **`profiles.reminder_time` dropped**: reminder derives solely from `study_sessions.scheduled_at − offset`. Session moves → reminder moves. No second source of truth.
- **All timestamps `timestamptz` UTC.** Convert to student-local only at display and at cron tick. Pilot pinned to `Asia/Kuala_Lumpur`; other timezones rejected for now.
- RLS policies on every table for browser access; server uses `db/forStudent` helper (§3 rule).
- **Concurrency guard:** session responses use `UPDATE study_sessions SET state=$1 WHERE id=$2 AND state=$3 RETURNING` — 0 rows = stale, reject. Prevents double-apply when web + Telegram both open.

## 5. Module layout

```
app/
  (web)/                 -- pages: onboarding (quick-plan path), plan, today, session, progress, courses
  api/
    engine/plan/route.ts
    sessions/[id]/respond/route.ts
    reminders/tick/route.ts       -- called via Edge Function from pg_cron, CRON_SECRET header check
    extract/schedule/route.ts     -- vision call, writes extraction_drafts (async via waitUntil)
    telegram/webhook/route.ts     -- grammY webhook handler (insert processed_updates first)
    telegram/link/route.ts        -- generate link code
lib/
  engine/                -- PURE: availability, division, debt, risk bands, repair rules (see §7)
  sessions/stateMachine.ts        -- IDLE → STUDYING → RECALL → CONFUSION → COMPLETED
  telegram/bot.ts, commands.ts, truncate.ts   -- 4096-char limit helper + test
  extraction/types.ts, prompt.ts, schema.ts (zod), visionExtractor.ts
  pdf/pageCount.ts
  db/client.ts           -- service client (private), forStudent.ts (only export used by routes)
supabase/
  migrations/
  functions/reminder-tick/        -- Edge Function invoked by pg_cron, POSTs to /api/reminders/tick
tests/
  engine/*.test.ts       -- ~15 hand-written scenarios (Week 1 exit criterion)
  stateMachine.test.ts   -- all transitions + invalid-state rejection + concurrent-response guard
  reminders.test.ts      -- fake-clock, no-send inside busy/quiet/rest, retry + log
  rls.test.ts            -- anon key cannot read cross-student rows
  e2e/demo.spec.ts       -- Playwright: 14-step demo script (the validation gate)
```

## 6. External service requirements

- **Supabase project**: enable Auth (email), Storage buckets `documents` + `schedule-images` (private), apply migrations, enable `pg_cron` extension, deploy `reminder-tick` Edge Function, schedule: `select cron.schedule('reminder-tick', '*/5 * * * *', ...)` net-http POST to the app.
- **Telegram**: BotFather token; webhook with secret-token header; account linking via one-time code; deep links carry a one-time token that auto-establishes the web session on mobile (else phone demo hits login wall).
- **Vision API key**: one provider, structured-output mode, only from `/api/extract/schedule`.
- **Vercel**: env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, `CRON_SECRET`). No Vercel Cron needed. Hobby tier fine — long work (page count, vision) runs async, not in request path.
- **Local dev**: `supabase start` so engine and API tests need no cloud.

## 7. Engine specification (resolves review gaps E1–E15)

These rules are now **normative** — hand-write engine tests against them:

1. **Incomplete course** → status `unscheduled`, excluded from planning until BOTH a confirmed exam date AND at least one uploaded PDF exist. Dashboard prompts for whichever is missing.
2. **Multiple exams per course** → plan against earliest confirmed exam_date. Per-exam ranges deferred.
3. **Past exam** → course status `expired`, excluded from route, shown on progress page only.
4. **`current_slide` is derived** (max slide_end of DONE sessions + 1) — not stored. Completed = union of DONE slide intervals, overlaps deduped. Initial offset settable at course creation ("already studied pages 1–50").
5. **Revision debt** is per-course, in pages: (planned cumulative pages by today) − (DONE pages). Redistributed only within that course's remaining windows. Never crosses courses.
6. **Cross-course ordering** within a window: exam_date ascending, then course created_at. Greedy fill. The "Priority score" formula from main plan §5 is **deleted** — date ordering replaces it.
7. **Review buffer = final 20% of total available minutes** (walk windows backward from exam), NOT 20% of days.
8. **Windows smaller than minimum session (3 pages)** are unused. Remainder <3 pages merges into final session (may exceed standard size, cap 15).
9. **SKIP** = range returns to course's unplanned pool; normal replan redistributes it. No special "recovery task" mechanism — next day's first session IS the recovery.
10. **Buffer spending** (recovery option 3) adds to `buffer_minutes_consumed`; engine recomputes remaining buffer each replan.
11. **Replan** regenerates all future sessions except `manually_edited` ones, which are fixed anchors.
12. **Midnight-crossing blocks** (finish ≤ start) attach to start's day_of_week and end next day. All block times interpreted in `profiles.timezone`.
13. **Risk bands** — `r = required pages/day ÷ planned pages/day`: r ≤ 1 on track; r ≤ 1.25 attention; r ≤ 1.5 cramming risk; infeasible only when workload > total capacity at max session size. Bands are thresholds on capacity ratio, not predictions.
14. **Missed session** = window ended >2h ago with null response; cron marks it and triggers replan.
15. **Cram mode**: <3 days to exam → skip review-buffer reservation automatically. Infeasible copy: "X pages/day needed — pick what to drop", never silent overload.

## 8. Week-by-week technical mapping

| Week | Technical deliverables |
| --- | --- |
| **1 — engine** | Repo scaffold, Supabase local + migrations, auth skeleton, `lib/engine` per §7, ~15 Vitest scenarios (timezone-safe placement, SKIP redistribution, infeasible branch, buffer-in-minutes, midnight-crossing, cram mode), `pdf/pageCount.ts` + test, `db/forStudent` + RLS test. Deploy to Vercel day 1. |
| **2 — web loop** | **Quick-plan onboarding** (course name → exam date → PDF upload → instant plan with default evening windows; refine later — no page-count question, student can't answer it), CRUD pages, PDF upload → Storage with auto page-count, Today's Session (timer, DONE/SKIP, recall prompt, confusion note), plan view + manual correction (`manually_edited`) + risk bands, draft-confirmation screen with "type manually instead" escape. |
| **3 — AI + Telegram** | `/api/extract/schedule` (async, `extraction_drafts` gate); Telegram adapter (linking, today's route, reminders, DONE/SKIP, recall, notes, deep links with one-time-token auto-login, 4096 truncation); pg_cron + Edge Function tick with `reminder_log`; `processed_updates` idempotency; extraction-draft 24h nudge; message cap 2/day + auto-PAUSE after 3 ignored. |
| **4 — E2E + freeze** | Playwright suite: 14-step demo script + core flows (quick-plan, SKIP replan, extraction confirm, reminder tick with fake clock). 2–3 friendly-user dry run on real phones (not a pilot — just smoke). Fix breaking bugs only, record demo video, freeze. |

## 9. Testing plan (E2E replaces pilot as validation gate)

| Layer | Tool | Coverage |
| --- | --- | --- |
| Engine (pure) | Vitest | ~15 scenarios per §7, hand-written first; agents implement until green |
| Session state machine | Vitest | All transitions + invalid-state rejection + concurrent-response guard (stale state → 0 rows → reject) |
| Reminder tick | Vitest (fake timers) | No send inside busy/quiet/rest; missed-session marking (>2h); retry on failure; `reminder_log` written |
| Webhook idempotency | Vitest | Duplicate `telegram_update_id` → processed once |
| RLS | Vitest + local Supabase | Anon key cannot read cross-student rows |
| Extraction | Vitest + 5–10 real timetable images | Field accuracy measured; draft never stored without confirmation |
| API routes | Vitest | Auth required, zod rejects bad input |
| **E2E (gate)** | **Playwright** | 14-step demo script (plan §15) + quick-plan onboarding + SKIP→replan + extraction confirm. All green = Week 4 exit. Telegram side tested against mocked bot API. |

**Replaces pilot:** no 8–10 student cohort, no success metrics, no survey. Validation = green E2E suite + dry-run users. If a real pilot is wanted later, it is a post-competition decision with its own plan (recruitment, consent, instrumentation already present via `events`/`started_at`).

## 10. Cut list if Week 3 slips

1. Manual text schedule parsing → manual form covers it.
2. Lecture-schedule image extraction → keep exam-image extraction only.
3. Telegram recall prompt → web-only recall still demos.

## 11. v2 change log (from 3-agent review)

| Change | Driver |
| --- | --- |
| Pilot removed; E2E = validation gate | User decision |
| Vercel Cron → pg_cron + Edge Function | Hobby tier: 1 cron/day, 10s timeout |
| `db/forStudent` single-access rule + RLS test | Service key bypasses RLS; cross-student leak risk |
| `started_at`, `events`, `processed_updates`, `plan_runs`, `buffer_minutes_consumed`, `manually_edited` columns | Metrics, idempotency, determinism proof, buffer tracking, manual-edit preservation |
| `total_pages` rename, then removed entirely; workload = sum of document page counts | 4-up PDFs undercount slides 4×; students don't know their page count |
| Reminder from `scheduled_at − offset` only | Two sources of truth → stale reminders after replan |
| Engine §7 rules 1–15 | 15 spec gaps where implementers would invent behavior |
| Priority score formula deleted | Dead code once ordering = exam_date asc |
| Quick-plan onboarding path | 5–6 screens before first value = signup death |
| Deep-link one-time-token auto-login | Mobile demo hits login wall otherwise |
| Telegram: no PDF sends, 4096 truncation, msg cap, draft nudge | Bot API limits + notification fatigue + draft limbo |
| Async extraction via `waitUntil` | Serverless timeout + webhook retry duplication |
| v3: course creation = name only; page count from PDF upload only; course inactive until exam + PDF both exist | Students can't answer "how many pages" |
| Concurrency guard on session respond | Web + Telegram double-apply corrupts debt |
| Friendly-user dry run Week 3 exit | First real-user contact shouldn't be demo day |
| UI library: **shadcn/ui** + Tailwind confirmed | Designer decision (2026-08-01); removed from §12 open decisions |

## 12. Open decisions

| Question | Owner | Needed by |
| --- | --- | --- |
| Vision provider (OpenAI vs Anthropic) | Team | Start of Week 3 |
| Session-length defaults (3 / 5–10 / 15 pages) | Team | Week 1 engine tests |
| Timezone pinned to Asia/Kuala_Lumpur | Team | Week 1 (confirmed by v2) |
| Risk-band cutoffs (1 / 1.25 / 1.5) | Team | Week 1 engine tests |

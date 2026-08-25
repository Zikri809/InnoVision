# InnoVision — Documentation Index

> **Start here.** This is the authority map: which document is CURRENT, which
> is a historical record, and which has been superseded in part. When a plan
> and the code disagree, the code + migrations win — then update the doc.
>
> Last reconciled: 2026-08-24 (after notifications 0022 and student practice quizzes 0023).

## ✅ Current / authoritative

| Doc | Scope |
|---|---|
| **ARCHITECTURE.md** | How the app works end to end: stack topology, request lifecycle, data model, the 5-layer security model, and per-feature data-flow walkthroughs (face verify protocol, session state machine, reveal gating, notifications, practice quizzes). Start here. |
| **PLAN_INTEGRITY_SUITE.md** | Face verification (1:1-by-lookup multi-frame voting), focus-loss pause, session advisories, incident recording. Migrations 0020+0021. THE source of truth for the face/integrity pipeline. |
| **PLAN_NOTIFICATIONS.md** | Per-user notification feed (migration 0022): bell island, polling/merge/dedup, i18n copy, role-layout wiring. THE source of truth for notifications. |
| **PLAN_STUDENT_PRACTICE_QUIZZES.md** | Student-created practice quizzes (migration 0023): creator-only authoring, unlisted share codes minted ONLY via definer RPC, stateless server-side grading, DB-side caps, `/s/[code]` play. THE source of truth for the SQ feature (post-critique final). |
| **PLAN_MATRIC_EXCEL_EXPORT.md** | Matric numbers (migration 0027: 6-digit, 99xxxx reserved) + lecturer Excel export (`/api/quizzes/[id]/export`, exceljs, 3 sheets). Post-audit final; three subagent review iterations. |
| **TESTING.md** | Test plan by layer: Vitest units, route tests, SQL harnesses (`verify:*.mjs`), E2E inventory. ⚠️ The Phase-7-era body predates the integrity suite — the suite's tests (I-vote/focus/advisory route tests, incident route tests, `vote`/`attention`/`vad` units, e16, verify-face 59 checks) are catalogued in PLAN_INTEGRITY_SUITE.md §5 instead; the student-quizzes suite lives in TESTING.md §2.7 + the E17 row. |
| **COMPREFACE_SETUP.md** | Self-hosted CompreFace Docker setup (enrollment subjects, API keys, mock mode for E2E). |
| **GLM_OCR_SETUP.md** | Optional GLM-OCR (vLLM) extraction engine setup. |
| **COSTS.md** | Infra/service cost breakdown for MVP scale. |

## 🏗️ Executed plans (design records — accurate history, not current spec)

Each phase plan documents WHAT was built and WHY at the time. Read for
context/invariants; verify details against code.

| Doc | Shipped |
|---|---|
| PLAN_PHASE2.md | Classes, join codes, roster |
| PLAN_PHASE3.md | Manual quiz builder |
| PLAN_PHASE4.md | Text extraction + AI generation |
| PLAN_PHASE5.md | Click-first play screen, server-authoritative timer |
| PLAN_PHASE6.md | Gesture layer, hand tracking, hand-loss pause |
| PLAN_PHASE7.md | Original (embedding-era) face plan — never shipped as written |
| PLAN_PHASE7_COMPREFACE_MIGRATION.md | CompreFace migration (0010) — executed; ⚠️ verify verdict/margin sections superseded by 0020 |
| PLAN_PHASE8.md | Results dashboard, reset, audit views (integrity suite later extended this surface) |
| PLAN_AI_QUIZ_GENERATION_SUITE.md | Multi-file ingestion, steering, difficulty, append mode |
| PLAN_QUIZ_METADATA_EDITING.md | Quiz title/mode/time-limit editing |
| PLAN_REVEAL_RESULTS.md | One-way results reveal |

## 📜 Superseded / snapshots (do NOT cite as current)

| Doc | Why |
|---|---|
| HANDOFF.md | Phase-7-era session handoff; §3–§5 describe embeddings/margin rule that no longer exist. Kept for session-history context only. |
| SECURITY_AUDIT.md | Point-in-time audit of the Phase-1 scaffold (2026-08-08). Later hardening (0005–0021) not reflected. |
| PLAN.md | The original master plan. Phases executed via their own docs; data-model/API sections drifted. Trust `supabase/migrations/` + routes. |

## 🔑 Current-state quick facts

- **Stack**: Next.js (App Router) · Supabase (Postgres, Auth, Storage) ·
  MediaPipe tasks-vision (face landmarker + hand landmarker, vendored) ·
  self-hosted CompreFace (Docker) · optional GLM-OCR (vLLM).
- **Migrations**: `supabase/migrations/0001…0023` — authoritative schema.
  Regenerate types after schema changes: `npm run gen:types`.
- **Face pipeline (current)**: enroll 3 angles → gate (blink + `'start'`
  verify) → periodic/question re-verification with **up-to-3-frame majority
  voting** against the caller's own CompreFace subject → FLAT last-5 fail
  window (3 fails ⇒ flagged). Three pause sources coexist, all server-side:
  face fail (`paused`), gesture hand-loss (`hand_loss`, transient), and
  debounced focus-loss (`focus_lost`, 3rd strike ⇒ flagged). Tab-hide records
  nothing (cadence pause + catch-up verify). Details: PLAN_INTEGRITY_SUITE.md
  §1b/§2/§2b.
- **Student practice quizzes (current)**: students author practice-only
  quizzes (no mode/status machinery), play them statelessly (grading RPC
  performs ZERO writes — creators cannot see who played, by construction),
  and share via unlisted 10-char codes. `share_code` is minted ONLY by the
  `student_quiz_share_action` definer RPC — INSERT/UPDATE column grants
  exclude it, closing the revoked-code hijack vector. Caps: 25 quizzes/
  student, 50 questions/quiz (DB-side triggers). Play routes are open to ANY
  authenticated user; authoring is student-only. Details:
  PLAN_STUDENT_PRACTICE_QUIZZES.md.
- **Demo seed**: `npm run seed:demo` provisions a realistic semester (2
  lecturers, 10 students, closed quiz with revealed history, shared student
  quizzes at `/s/STUDYHARD2` and `/s/EXAMPREP24`). Password `Password123!`.
  Face setup is intentionally not seeded.
- **Verification commands**:
  ```bash
  npm run test            # vitest units + route tests
  npm run typecheck       # tsc --noEmit
  npm run lint            # eslint
  npm run db:reset        # rebuild local DB from migrations (destructive)
  npm run gen:types       # regenerate src/lib/types/database.ts
  npm run verify:face     # live-SQL face RPC harness (needs local supabase)
  npm run verify:student-quizzes # SQ RLS/RPC/cap probes SQ-D1–D9 (21 checks)
  npm run face:report     # threshold-tuning report over recorded face_checks
  npm run incident:cleanup # delete incident clips older than 30d (cron-able; no scheduler wired)
  npm run verify:sessions # …plus verify:classes/quizzes/ai/results/security
  npm run check:i18n      # en <-> ms key parity
  npx playwright test     # E2E (needs LECTURER_INVITE_CODE in .env.local)
  ```
- **Known debt**: legacy E2E specs (e3/e5/e6/e7/e9b/e10–e15) still carry
  pre-integrity-suite choreography drift; shared helpers were repaired
  (2026-08-22) so they run deep into their own assertions. `e16-integrity.spec.ts`
  is the green reference for face flows.

## 📝 Doc conventions

- Every plan doc carries a status banner near the top (`EXECUTED`,
  `HISTORICAL`, superseded notes). If you change behavior covered by a doc,
  update its banner/body in the same change — or this index stops being true.
- New feature work: write a `PLAN_<FEATURE>.md`, mark it EXECUTED when it
  ships, and list it here.

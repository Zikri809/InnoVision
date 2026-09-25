# InnoVision — Documentation Index

> **Start here.** This is the authority map: which document is CURRENT, which
> is a historical record, and which has been superseded in part. When a plan
> and the code disagree, the code + migrations win — then update the doc.
>
> Last reconciled: 2026-09-25 (ARCHITECTURE.md refresh: migrations 0036–0067,
> commit_answer atomic answer+identity commit, InsightFace sidecar replacing
> CompreFace prose, short_text AI marking pipeline, v4.9 gesture toggle,
> audit-5 gates — GLM-OCR provider toggle + VPS deployment docs reconciled
> 2026-09-14).

## ✅ Current / authoritative

| Doc | Scope |
|---|---|
| **ARCHITECTURE.md** | How the app works end to end: stack topology, request lifecycle, data model, the 5-layer security model, and per-feature data-flow walkthroughs (face verify protocol, session state machine, reveal gating, notifications, practice quizzes). Start here. |
| **PLAN_INTEGRITY_SUITE.md** | Face verification (1:1-by-baseline multi-frame voting + HMAC verify proofs, commit_answer atomic answer+identity commit), focus-loss pause, session advisories, incident recording. Verified against migrations through 0067. THE source of truth for the face/integrity pipeline. |
| **PLAN_NOTIFICATIONS.md** | Per-user notification feed (migration 0022, extended through 0048: quiz_closed fan-out, session_unlocked pin, urgent-tier retention + unread caps): bell island, polling/merge/dedup, i18n copy, role-layout wiring. THE source of truth for notifications. |
| **PLAN_STUDENT_PRACTICE_QUIZZES.md** | Student-created practice quizzes (migration 0023, extended: AI generation 0029, creator-only SELECT 0045, image ownership 0046): creator-only authoring, unlisted share codes minted ONLY via definer RPC, stateless server-side grading, DB-side caps, `/s/[code]` play. THE source of truth for the SQ feature (post-critique final). |
| **PLAN_MATRIC_EXCEL_EXPORT.md** | Matric numbers (migration 0027: 6-digit, 99xxxx reserved) + lecturer Excel export (`/api/quizzes/[id]/export`, exceljs, 3 sheets, view-based reads per 0054/0060, 200-session/20k-answer caps). Post-audit final; three subagent review iterations. |
| **TESTING.md** | Test plan by layer: Vitest units, route tests, SQL harnesses (`verify:*.mjs`), E2E inventory (77 specs). ⚠️ The Phase-7-era body predates the integrity suite — the suite's tests (I-vote/focus/advisory route tests, incident route tests, `vote`/`attention`/`vad` units, e16, verify-face ~85 checks) are catalogued in PLAN_INTEGRITY_SUITE.md §5 instead; the student-quizzes suite lives in TESTING.md §2.7 + the E17 row. |
| **INSIGHTFACE_SETUP.md** | Self-hosted InsightFace sidecar (single container, stateless; embeddings in Supabase). |
| **GLM_OCR_SETUP.md** | Optional GLM-OCR extraction engine setup — the **local** Docker/vLLM leg (§1–§5, §7–§8) and the **remote Z.ai API** leg (§6: `GLM_PROVIDER=remote`, `layout_parsing`, envelope precedence, billed probe cache, spend governor, OWED live-curl list). |
| **COSTS.md** | Infra/service cost model: VPS + hosted Supabase + Z.ai OCR. Every number tagged MEASURED / ESTIMATED / UNVERIFIED; the superseded Vercel-Hobby model is kept in §5 as history. |
| **DEPLOY_VPS.md** | **Operator runbook** for the vCPU VPS deployment: Supabase dashboard pass, `link→push→repair` schema workflow, the BUILD-vs-RUNTIME env split, `TRUSTED_PROXY_COUNT`, container bring-up, Caddy/TLS/ufw, tokens + kill switches, cutover, the atomic backup/restore with RPO/RTO, free-tier quotas, and the smoke checklist. The *how* to the plan's *why*. |
| **PLAN_VPS_DEPLOYMENT.md** | The deployment plan: laptop + GLM toggle (local vLLM ↔ Z.ai API) and vps-remote (vCPU VPS + hosted Supabase + Z.ai API). Reviewed design draft — see its banner for what is now IMPLEMENTED vs OWED-LIVE. |

## 🗺️ Roadmap (planned work — not yet spec)

| Doc | Scope |
|---|---|
| **roadmap/README.md** | Master index + MANDATORY workflow for planned feature work: pre-implementation reconciliation against the codebase, implementation, move-out to executed `PLAN_*.md`, and final folder deletion. Domain plans live in `roadmap/PLAN_R_*.md`. |

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
| PLAN_CLOSE_AND_SCHEDULE.md | Quiz close + closed-reveal recovery + availability windows + retakes (QC-1..QC-4, migrations 0030–0032) |

> Partial domain shipments that stay recorded inside their `roadmap/PLAN_R_*.md`
> implementation logs (plan docs move out only when the whole domain ships):
> AU-1 forgot/reset password (2026-08-28); RA-1 cross-quiz gradebook +
> SQ-2 student results entry point (2026-08-28, no migration); SQ-5 camera
> failure taxonomy + IO-1 unlock notification (2026-08-29, migration 0033);
> QT-3 per-student shuffling (2026-08-29, migration 0034); AP-1 bulk import +
> AP-2 quiz duplication (2026-08-29, migration 0035, `clone_quiz`); QT-1
> multi-select questions with gesture toggle/commit answering (2026-08-30,
> migrations 0036+0037).

## 📜 Superseded / snapshots (do NOT cite as current)

| Doc | Why |
|---|---|
| HANDOFF.md | Phase-7-era session handoff; §3–§5 describe embeddings/margin rule that no longer exist. Kept for session-history context only. |
| SECURITY_AUDIT.md | Point-in-time audit of the Phase-1 scaffold (2026-08-08). Later hardening (0005–0021) not reflected. |
| PLAN.md | The original master plan. Phases executed via their own docs; data-model/API sections drifted. Trust `supabase/migrations/` + routes. |

## 🔑 Current-state quick facts

- **Stack**: Next.js 16 (App Router, React 19) · Supabase (Postgres, Auth,
  Storage) · MediaPipe tasks-vision (face landmarker + hand landmarker,
  vendored) · self-hosted **InsightFace sidecar** (single FastAPI/ONNX
  container — replaced the CompreFace stack, migration 0039) · optional
  GLM-OCR with **two legs** behind one route (`GLM_PROVIDER=local` →
  Docker/vLLM, free; `remote` → the Z.ai API, billed — `GLM_OCR_SETUP.md`
  §6).
- **Deployment**: two targets — the **laptop stack** (local Supabase + local
  GLM-OCR container) and the **vCPU VPS** (Next.js + InsightFace images from
  GHCR, hosted free-tier Supabase, Z.ai OCR; no GPU, no vLLM container).
  Operator runbook: `DEPLOY_VPS.md`; CI/CD: `DEPLOY_CICD.md`; cost model:
  `COSTS.md`.
- **Migrations**: `supabase/migrations/0001…0067` (64 files — 0061/0063/0064
  are pgTAP test rounds under `supabase/tests/`) — authoritative schema.
  Regenerate types after schema changes: `npm run gen:types`.
- **Face pipeline (current)**: enroll 3 angles → gate (blink + head-turn +
  `'start'` verify) → periodic 30–45s re-verification with up-to-3-frame
  majority voting against the caller's own baseline → FLAT last-5 fail
  window (3 fails ⇒ flagged). **The per-answer identity check is atomic with
  grading** (migration 0067 `commit_answer`: HMAC answer-proof + face verify
  + `answer_question` in ONE transaction; `answer_question` is no longer
  directly callable). Verify proofs are HMAC-signed server-side
  (`app_private.verify_proof_secret`) — a student cannot fabricate
  similarities over PostgREST. Three pause sources coexist, all server-side:
  face fail (`paused`), gesture hand-loss (`hand_loss`, flags at 3), and
  debounced focus-loss (`focus_lost`, 3rd strike ⇒ flagged); fullscreen exits
  are counted but never auto-flag. The verify-silence cron is
  gesture-toggle-aware; finalization (submit + autoclose seal) re-checks the
  same silence predicate. Tab-hide records nothing (cadence pause + catch-up
  verify). Details: PLAN_INTEGRITY_SUITE.md + ARCHITECTURE.md §7.5–7.6.
- **short_text AI marking (v4.9)**: AI-marked rubric questions via
  `ai_marking_ledger` (service-role only) + a two-phase sweep: pg_cron claim
  → pg_net POST → `/api/internal/ai-mark-sweep` worker → `finalize_ai_mark`
  (epoch-guarded). 0/0.5/1 mark ladder; daily spend caps (50k tokens / $5
  per quiz); pending answers contribute 0 and BLOCK auto-reveal; lecturer
  override (`override_answer_mark`) bumps the epoch and can re-publish the
  reveal. Gesture toggle (`quizzes.gestures_enabled`, draft-frozen) turns
  the whole per-answer verification stack OFF for a quiz.
- **Scoring**: one arithmetic everywhere —
  `SUM(COALESCE(mark_score, CASE WHEN is_correct THEN 1 ELSE 0 END)) WHERE
  mark_status <> 'pending'` (D10); `quiz_sessions.score` is NUMERIC.
  Sealed ≠ submitted (autoclose seals scoreless completions via the
  `assign_seal_score` trigger).
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
- **Hosted-project tooling**: the same seed/cleanup scripts accept `--remote`
  to target the hosted Supabase project via `.env.production.local` (instead
  of the local seam in `.env.local`). Remote runs are guard-gated: they need
  `ALLOW_PROD_SEED=1` or an interactive confirm (type the project ref).
  ```bash
  npm run db:reset:remote    # wipe hosted data: auth users cascade + all 4 storage buckets
  npm run seed:demo:remote   # seed the hosted project (schema via `supabase db push`)
  npm run seed:scenarios:remote [first|normal|extreme]
  node scripts/media-cleanup.mjs --remote [--dry-run]
  node scripts/face-reset.mjs --remote
  ```
  The remote reset never touches schema — migrations go through `db:push`.
  Verify/mass-fixture scripts (`verify-*.mjs`) remain local-only by design.
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
  npm run verify:clone    # clone_quiz AP-2 probes (14 checks; ownership/archived/fidelity/cap-free)
  npm run verify:silence  # verify-silence cron predicate probes
  npm run check:i18n      # en <-> ms key parity + referenced-key existence
  npm run check:env       # every env key read in src/** is documented in .env.local.example
  npx supabase test db    # pgTAP suites in supabase/tests/ (audit rounds incl. 0063/0064)
  node scripts/vps-smoke.mjs --base-url <origin> --email <lecturer> --password <pw>  # VPS smoke (ops gate O4; node invocation, not an npm script)
  npx playwright test     # E2E, 77 specs (needs LECTURER_INVITE_CODE in .env.local)
  ```
- **Known debt**: legacy E2E specs (e3/e5/e6/e7/e9b/e10–e15) still carry
  pre-integrity-suite choreography drift; shared helpers were repaired
  (2026-08-22) so they run deep into their own assertions. `e16-integrity.spec.ts`
  is the green reference for face flows; `e51` is the opt-in hardening-ON
  suite.

## 📝 Doc conventions

- Every plan doc carries a status banner near the top (`EXECUTED`,
  `HISTORICAL`, superseded notes). If you change behavior covered by a doc,
  update its banner/body in the same change — or this index stops being true.
- New feature work: write a `PLAN_<FEATURE>.md`, mark it EXECUTED when it
  ships, and list it here.

# InnoVision — Direct InsightFace Migration Plan (Replacing CompreFace)

> **Status:** REVISED (v3) — implemented. The v1 draft was audited through
> three adversarial review rounds (9 subagent reviews, all findings
> integrated); this document is the reviewed design. Key v1 defects that are
> fixed here: route/RPC privilege contradiction, `find_duplicate_face`
> probing oracle, `face_deletion_pending` drop breaking `enroll_face`,
> enroll atomicity loss, E2E seam death via the env rename, the cutover
> deadlock, and the cosine-vs-CompreFace-similarity clamp.
> **Predecessors:** `docs/PLAN_PHASE7_COMPREFACE_MIGRATION.md` (CompreFace baseline), `docs/PLAN_INTEGRITY_SUITE.md` (authoritative verify & majority-voting contract), `supabase/migrations/0020_integrity_suite.sql` + `0021_integrity_audit_fixes.sql` + `0039_insightface.sql`.
> **Scope:** Server-side inference & database storage only. **Client-side webcam UI, blink detection, and Playwright E2E seam remain 100% untouched.**

---

## 1. Executive Summary

CompreFace was a heavy wrapper around InsightFace (5 containers, internal
Postgres, split-brain sync, manual bootstrap). This migration deploys
InsightFace directly as **a single, stateless FastAPI/ONNX sidecar**
(`docker/insightface/`) and moves enrolled embeddings into **Supabase
(`profile_face_samples`, pgvector 512-d)**:

- **1 container instead of 5**; ~350–500 MB RAM (det + 3d68-landmark +
  recognition modules only, `WEB_CONCURRENCY=1`).
- **Zero-config**: no admin UI, no API key registration; `docker compose up
  -d insightface-service` → `GET /health`.
- **Supabase as the single source of truth**: atomic enrollment, consent
  revoke purges biometrics in ONE transaction, cascade deletes.
- **1-shot extraction**: each frame yields detection, pose (yaw/pitch/roll),
  and the 512-d embedding in a single `POST /extract`.

## 2. Locked Decisions (v3 — post-audit)

| # | Decision | Choice | Notes |
|---|---|---|---|
| L1 | Packaging | `docker/insightface/`: python:3.11-slim multi-stage; insightface 0.7.3 sdist needs `build-essential` + preinstalled `numpy==1.26.4`/`cython` + `--no-build-isolation` | buffalo_l.zip pinned by sha256 (`80ffe37d…ca2f`), baked into the runtime user's HOME |
| L2 | Models | buffalo_l restricted to `detection + landmark_3d_68 + recognition` | **`1k3d68` MUST stay** — pose comes only from the 3d68 landmark model (output shape 3309); 2d106det never emits pose. Pose array order is `[pitch, yaw, roll]` |
| L3 | Client contract | Zero changes to `IFaceTracker`/`useFaceTracker`/`captureFrame` | markers `FAKE_FRAME_MATCH`/`MISMATCH` unchanged |
| L4 | Storage | `profile_face_samples` (unique(profile_id, angle), RLS enabled **zero policies**, all grants revoked except service_role); **no ivfflat** (exact scan at classroom scale; `max(1-dist)` can't use ANN anyway) | migration **0039** (0030 was taken) |
| L5 | Extraction API | `POST /extract` → `{faces:[{embedding(512,L2-normalized), yaw, pitch, roll, det_score, bbox}]}` | merges CompreFace detect+recognize+add |
| L6 | Pose gates | front \|yaw\| ≤ 30°; sides 10–75°; skipped in mock mode (mock yaw = 0 would fail sides) | route-side, on the selected primary face |
| L7 | Duplicate detection | **INTERNAL to `enroll_face(p_samples jsonb)`** — no standalone RPC. `find_duplicate_face` from v1 was a biometric probing oracle (arbitrary-embedding 1:N search leaking other students' `profile_id`) and silently no-ops under a service-role client (`auth.uid()` NULL) | ≥ 0.45 → `pending_review` |
| L8 | Verify parity | `record_face_check` (0020/0021) **UNTOUCHED**; route computes per-frame similarity via `compare_face_baseline` (caller-own max cosine, clamped to [0,1]) | **Clamp is mandatory** — 0021's validator rejects `< 0`; raw ArcFace cosine is routinely negative for non-matches |
| L9 | Consent revocation | `revoke_face_consent` purges samples in-transaction (+ `samples_deleted` audit count); `confirm_face_subject_deleted` + `face_deletion_pending` dropped (all referencing RPCs rewritten BEFORE the drop) | one atomic transaction |
| L10 | Server isolation | `src/lib/face/server/insightface-client.ts` (`import "server-only"`) | replaces compreface-client |
| L11 | E2E seam | Two-flag gate kept (`NEXT_PUBLIC_E2E_FAKE_SEAM=1` build-inlined + `FACE_MOCK_ENABLED=1` runtime). Mock embedding = **uid-derived deterministic unit vector** (sha256) — same-student enroll/verify dot ≈ 1.0; cross-student |cos| ≈ 0.04 « 0.45 so the internal dup check never flags the second E2E student. MISMATCH → `{faces:[]}` → 0-vote **through** `record_face_check` (streak specs need the fail rows) | mock enroll inserts REAL samples via the real RPC |
| L12 | Zero manual setup | No API keys; health = `GET /health` (urllib probe — slim has no curl) | |
| L13 | Network | Loopback-only publish `127.0.0.1:8000` (proven pattern); optional `FACE_SIDECAR_TOKEN` header guards bind drift | set it in production |
| L14 | Access model | **Definer-RPC-only** — routes NEVER hold a service-role client. `CREATE FUNCTION` grants EXECUTE to PUBLIC by default: every new RPC revokes `public, anon` then grants `authenticated` | |
| L15 | Multi-face frames | Single-face selection (pure `selectPrimaryFace` in `src/lib/face/embedding.ts`): det_score ≥ 0.6 → largest bbox → nearest center → index. **Never max-over-faces** (a second person must not drag the score UP); no qualifying face → 0-vote | det_score floor uncalibrated — see §6 |
| L16 | Error keys | `compreface_unavailable/error` → `insightface_unavailable/error`; `invalid_samples` added. Mechanical: `rpc-mapping.ts`, `outcome.ts` (+ their tests), client, route docs. No i18n/client switches | the 503 body must not lie |

## 3. Security Model (v3)

1. **No student-callable gallery search.** v1's `find_duplicate_face` granted
   to `authenticated` was a confirmed biometric identification oracle
   (arbitrary vector in → other student's `profile_id` + similarity out) with
   a caller-controlled threshold (hill-climbing surface). v3 folds the dup
   check into `enroll_face`; the answer is 1 bit (`pending_review` vs
   `enrolled`) and **throttled**: attempts counted via the caller's own
   enroll audit rows, 3 per 10 minutes, `rate_limited` returned beyond.
   Attempts, NOT outcomes — counting only `pending_review` clears on every
   negative probe.
2. **Deny-by-default biometrics.** RLS enabled with zero policies; all table
   grants revoked from `anon`/`authenticated`; access via
   `enroll_face` / `compare_face_baseline` / `face_baseline_status` /
   `revoke_face_consent` (all security definer, `search_path = public,
   extensions`, operators qualified `OPERATOR(extensions.<=>)`).
3. **Atomicity.** Enroll: `for update` lock on the caller's profile row →
   gates → strict jsonb validation (typed `invalid_samples`, never an
   uncaught vector-cast 500) → internal dup check → delete-then-insert →
   GUC-guarded status write, ONE transaction. Revoke: purge + flag + audit in
   one transaction.
4. **Preserved invariants.** Server never trusts a client verdict; nonce
   rotation + frame-hash replay detection; FLAT last-5 window; majority
   voting; GUC enrollment guard (`app.face_enroll` + `app.face_enroll_actor`);
   consent pre-check BEFORE any sidecar call; no raw frame retention;
   loopback-only sidecar.
5. **Pre-existing residual risk (documented, unchanged).** `record_face_check`
   trusts route-supplied `p_similarities` and is directly callable by an
   authenticated session owner (fabrication bypasses the face check; the
   nonce is readable via the own-session SELECT policy). Pre-dates this
   migration; v3 neither widens nor mitigates it. Logged for
   `docs/SECURITY_AUDIT.md`.

## 4. Cutover (the hard part)

Existing students are `enrolled` with **zero samples** (raw frames were never
stored — backfill impossible). v1's "migration nulls status" deadlocks:
verify → `not_enrolled` → re-enroll → ever-enrolled (audit rows) + live
session → `live_assessment`. v3:

1. **No migration writes to profiles.**
2. **Pre-start gate:** the play page and student quizzes page additionally
   require `face_baseline_status().present` — cutover students see the enroll
   CTA, never start a quiz they can't verify.
3. **Verify-route guard:** `present=false` → 403 `not_enrolled` before any
   sidecar call (belt-and-braces for in-flight sessions in the deploy window;
   those degrade honestly and finish via lecturer exempt/unlock — **deploy
   outside quiz hours**).
4. **Ever-enrolled redefined:** samples-exist OR audit-rows — a cutover
   student is genuinely never-enrolled under the new regime, so mid-session
   FIRST-TIME enrollment stays possible (0010's deadlock break preserved).
   `pending_review` students are left untouched (no evidence destruction;
   the migration nulls nothing).
5. **Rollback honesty:** 0039 is forward-only (Supabase has no
   down-migrations; old code cannot run against the new schema). Rollback =
   pre-cutover `supabase db dump` + git tag → revert code → restore dump →
   restart CompreFace (stop the sidecar first — port 8000 conflict; keep
   CompreFace images/volumes intact during the stability window). Volume
   disposal (`docker compose down -v`) is a **biometric-data disposal step**,
   sequenced only after a green stability window (≥14 days).

## 5. Testing & Gates

- **Unit (Vitest, 1382 passing):** route suites re-target the mocked
  `insightface-client`; `fake-supabase.ts` models `enroll_face(p_samples)`,
  `compare_face_baseline`, `face_baseline_status` in lockstep with 0039 (the
  two baseline stubs deliberately do NOT consume the global `rpcResult` seam
  — the verify-route error tests seed the seam for `record_face_check`,
  which runs after them). New: `embedding.test.ts` (cosine, selection
  determinism, floor). Deleted: deletion-pending lifecycle + lookalike-top1
  tests (their subject matter is retired: no gallery exists).
- **SQL harness (`npm run verify:face`):** six `enroll_face` call sites
  migrated to `p_samples: enrollSamples(seed)` (deterministic unit vectors —
  identical seeds give cosine 1.0); duplicate probe = S3 enrolling S1's
  stored vector; revoke pin now asserts sample purge. New probes recommended:
  RLS deny on `profile_face_samples` from `authenticated`; empty-baseline
  `compare_face_baseline` → `{present:false}`.
- **E2E:** two-flag seam; webServer env renamed (`FACE_MOCK_ENABLED`,
  `INSIGHTFACE_BASE_URL`); `FACE_SMOKE` gates the new
  `e2e/insightface-smoke.spec.ts` (health, 512-d unit-norm embedding,
  same-image ≥ 0.9, impostor < 0.5). `vitest.config.ts` 0-coverage key
  renamed.
- **CI:** zero compreface references existed; `gen:types` diff committed
  (types drift gate); `supabase db reset` replays 0001(create vector) →
  0010(drop) → 0039(guard + recreate) — pgvector ships in the Supabase
  postgres image.

## 6. Calibration (pre-production gate)

0.5/0.45 were calibrated to **CompreFace's reported similarity scale**, not
raw cosine. Expected ArcFace r50 genuine ~0.55–0.85 / impostor ~0.0–0.35, so
0.5 likely holds — but measure before enforcing:

1. Pre-cutover `scripts/face-calibrate.mjs` (or a `--sidecar` mode on
   `face:report`): POST `e2e/fixtures/faces/*.jpg` + 2–3 volunteers × 3
   angles through `/extract`; compute genuine/impostor distributions; gate =
   ≥95% genuine ≥ t AND ≥95% impostor < t.
2. The SQL constants live INSIDE RPC bodies (0021 `record_face_check`
   `FACE_SIMILARITY_MIN := 0.5`; 0039 `enroll_face`
   `DUP_SIMILARITY_MIN := 0.45`) + TS mirrors (`constants.ts:19,25`) — all
   four locations change together via a full-body carry-forward migration
   (0032 house rule). Post-cutover, `face:report` works unchanged
   (`face_checks.distance = 1 − max(p_similarities)`); note the scale epoch
   break when reading historical rows.
3. The det_score ≥ 0.6 floor is likewise uncalibrated — log the distribution
   in the smoke spec before pinning; a too-high floor causes 0-vote storms
   (availability), never false accepts.

## 7. File Changes Matrix (actual)

| File | Status |
|---|---|
| `supabase/migrations/0039_insightface.sql` | NEW — table+RLS, enroll_face(jsonb), compare_face_baseline, face_baseline_status, revoke rewrite, drops |
| `docker/insightface/{Dockerfile,requirements.txt,app/main.py}` | NEW — sidecar |
| `src/lib/face/embedding.ts` (+ `.test.ts`) | NEW — pure vector math + primary-face selection |
| `src/lib/face/server/insightface-client.ts` | NEW (replaces `compreface-client.ts`, DELETED) |
| `src/app/api/face/{verify,enroll,health,consent}/route.ts` | EDIT |
| `src/app/play/[sessionId]/page.tsx`, `src/app/(student)/student/quizzes/page.tsx` | EDIT — baseline pre-start gate |
| `src/lib/face/{rpc-mapping,outcome,types,schemas}.ts` (+ tests) | EDIT — key rename |
| `src/app/api/quizzes/__tests__/fake-supabase.ts`, `src/app/api/sessions/__tests__/face-session-routes.test.ts` | EDIT |
| `src/lib/types/database.ts` | REGEN (gen:types) |
| `docker-compose.yml`, `.env.local.example`, `playwright.config.ts`, `vitest.config.ts`, `package.json` | EDIT |
| `scripts/{verify-face.mjs,face-reset.mjs}` | EDIT; `scripts/compreface-cleanup.mjs` | DELETE |
| `e2e/insightface-smoke.spec.ts` | NEW; `e2e/compreface-smoke.spec.ts` | DELETE |
| `docs/{INSIGHTFACE_SETUP.md,ARCHITECTURE,TESTING,README,PLAN,SECURITY_AUDIT}.md` | NEW/EDIT; `docs/COMPREFACE_SETUP.md` | DELETE |

Historical plan docs (`PLAN_PHASE7*`, `PLAN_INTEGRITY_SUITE`, `HANDOFF`,
`roadmap/`) keep their supersession banners and stay untouched.

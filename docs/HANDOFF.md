# InnoVision — Session Handoff (Phase 7 DONE → CompreFace migration)

> **⚠️ Since this handoff was written, Phase 7's face pipeline was MIGRATED to CompreFace** — see `docs/PLAN_PHASE7_COMPREFACE_MIGRATION.md`. The migration is implemented: the client-side `FaceEmbeddingProvider`/`ImageEmbedder`/pgvector-embedding approach is GONE, replaced by a server-side CompreFace Docker service. The description below is the **pre-migration** baseline; read the migration doc for the current architecture.
>
> Purpose: give a fresh session full context without re-reading the large PLAN docs.
> Read this file first. `docs/PLAN_PHASE7.md` has the full implementation + audit-fix log (§8); `docs/TESTING.md` has the test plan.

---

## 1. Where we are

**Phase 7 (Face pipeline) is COMPLETE and fully audited.** All work is on `main`. The audit→fix→re-graphify loop ran and converged clean (no remaining Critical/High findings — see `PLAN_PHASE7.md` §8).

Phases done: **1 Scaffold → 2 Classes → 3 Manual builder → 4 Extraction + AI generation → 5 Play screen (click-first) → 6 Gesture layer → 7 Face pipeline** (this phase).

**Next phase (per PLAN.md §6): Phase 8 — Results dashboard.** P7 exposes only routes + minimal status reads for lecturer actions; the results dashboard (unlock/exempt buttons, face-check timeline incl. `suspected_replay`, `unavailable`, revocation markers, session reset) is P8.

## 2. Verified green baseline (run these to confirm)

```bash
npm run lint          # 0 errors, 0 warnings
npm run typecheck     # clean
npx vitest run        # 507/507 (37 files)
npx vitest run --coverage   # per-file thresholds pass (incl. lib/face + app/api/face + lib/vision/camera)
node scripts/verify-security.mjs   # 3/3
node scripts/verify-classes.mjs    # 21/21
node scripts/verify-quizzes.mjs    # 42/42
node scripts/verify-ai.mjs         # 16/16
node scripts/verify-sessions.mjs   # 19/19 (D1/D1b/D2-D4/D7/D9/D42-D47)
node scripts/verify-face.mjs       # D10/D11/D13/D14 + P7 pins (needs Supabase up)
node scripts/verify-mediapipe.mjs  # vendored assets intact (SHA-256 vs MANIFEST)
npx playwright test    # E2E (E1a/E1/E1b/E2/E2b/E2c + E4/E5/E10/E11 + E8/E9/E9b + E3/E3b/E6/E7/E12/E13)
npm run build          # succeeds
```

Prereqs for the harnesses/E2E: **Docker Desktop running** + local Supabase up (`npx supabase start`), `.env.local` populated (gitignored; see `.env.local.example`). `.env.local` currently has the local Supabase keys; `AI_API_KEY` is blank (use a dummy `test-key` for CI; E2E uses the mock AI server).

## 3. What Phase 7 delivered

- **Migration `0009_face.sql`** — `face_check_trigger` enum (`start`/`question`/`periodic`); `face_checks` (RLS owner/lecturer select-only, RPC-only writes; advisory `suspected_replay`/`too_frequent` flags); `audit_events` (service-role only; P8 adds a lecturer view); `quiz_sessions.face_unavailable_at`; **actor-bound guard trigger** on `profiles.face_embedding` (service-role writes INTENTIONALLY blocked — `auth.uid()` NULL); RPCs `enroll_face` / `revoke_face_consent` / `record_face_check` (14-step pinned order, FLAT last-5 window, nonce rotation inside one locked txn) / `self_recover_session` / `pause_session` / `unlock_session` / `exempt_face_session` / `report_face_unavailable`; **redefined `submit_session`** (`active`/`paused` submit; `flagged` → `session_not_active`).
- **`src/lib/face/`** — pure, env-free logic: `constants.ts` (incl. `FACE_DISTANCE_MAX=0.4` mirror-not-enforcement header), `types.ts` (re-exports `FaceCheckTrigger`; `IFaceTracker` seam; **`FaceEmbeddingProvider`** — the swappable embedding-model interface), `cosine.ts`, `schemas.ts` (single `embeddingSchema` owner + `serializeEmbedding` bit-stable), `liveness.ts` (`BlinkDetector`), `streak.ts` (FLAT last-5), `recovery.ts`, `cadence.ts` (`PeriodicCadence` + `shouldScheduleFaceCheck`), `outcome.ts` (`resolveVerifyOutcome`/`faceStatusFromCheckResult`), `rpc-mapping.ts` (common-key table), `fake-seam.ts` (typed E2E accessors). Unit tests U-F1–U-F7c + I22 (68 tests).
- **Shared camera** — `src/lib/vision/camera.ts` (token refcount + coalesced in-flight `getUserMedia` + supersede guard; SOLE `track.stop()` owner). `camera.test.ts` (winner-live + loser-stopped-once). **`hand-tracker.ts` refactored** — `stop()` releases the ref, NEVER stops shared tracks.
- **`src/lib/face/face-tracker.ts`** — browser-only `FaceTracker` (shared stream, FaceLandmarker CPU + swappable `ImageEmbedderFaceEmbeddingProvider`, blink liveness fail-fast hidden). **PHASE 7 DEVIATION** (see §5): the plan's `FaceEmbedder` task + `face_embedder.task` DO NOT EXIST in `@mediapipe/tasks-vision`; the embedding model is a swappable provider + a documented manual drop-in at `public/models/face_embedding.tflite`.
- **Routes** — `/api/face/enroll` (5/min), `/api/face/verify` (10/min), `/api/face/self-recover` (10/min), `/api/face/consent` (5/min), `/api/face/unlock` (lecturer, 10/min), `/api/sessions/[id]/exempt-face` (lecturer, 10/min), `/api/sessions/[id]/pause` (20/min), `/api/sessions/[id]/face-unavailable` (10/min), `GET /api/sessions/[id]` (60/min; `verify_nonce` for own student ONLY). Route tests I1–I6c/I20-ext + session additions (89 tests total across face-routes + face-session-routes).
- **UI** — `use-face-tracker.ts` (shared boot; availability-before-enrollment), `use-face-pipeline.ts` (8-state machine: gate/ready/paused/recovering/flagged + nonce + verifyLock/pendingVerify + cadence + flagged poll + tab-hide + hand-loss pause), `FaceVerifier` (presentational overlays; suppressed on submitted/dead), `FaceGate` (consent recap + liveness + Begin + live countdown prop), face-enroll page + client (consent, blink, 5-frame capture, revoke), `student-quizzes-client.tsx` enroll banner, `play-client.tsx` wiring (`sessionPaused` gate, answer-409 real-status, `submitNow` timeUp-preserving branches), `gesture-layer.tsx` `sessionPaused` input gate.
- **E2E** — `e2e/fake-face-embedder.ts` (StrictMode-idempotent; match V / mismatch −V; `triggerBlink`; `setFacePeriodic`), `e2e/helpers.ts` face additions, specs E3/E3b (enroll + gate + timer-gate E13), E6 (pause/flag cycle), E7 (lecturer unlock), E12 (continuous verify + reload-gate + periodic observation + blocked-answer proof), E9b rework (server-side hand-loss pause + blink recovery). E5/E11 get timeout belt-and-braces.
- **Config** — `verify:face` npm script; CI step; `vitest.config.ts` coverage include + per-file thresholds for `lib/face/**` + `app/api/face/**` + `lib/vision/camera.ts` (`face-tracker.ts` 0-key browser-only).

## 4. Key security/robustness invariants (do not regress)

- **Server never trusts a client verdict.** `record_face_check` computes `matched` from the stored embedding vs the submitted RAW embedding; `0.4` + 5s grace are SQL constants. No `matched` parameter exists.
- **`record_face_check` is ONE atomic RPC** — `for update` serializes concurrent verifies; the FLAT last-5 window (3 fails → flagged; a pass never flags the current check) lives inside the same locked transaction. Ordering pinned `checked_at DESC, id DESC`.
- **Actor-bound guard trigger** on `profiles.face_embedding` — only `enroll_face` (which sets both GUCs in-transaction) can write it; direct/borrowed-GUC/service-role writes are blocked (D-probes).
- **Session writes are RPC-only** (P5 invariant extended): `face_checks` RPC-write + select-only (RLS owner/lecturer); `audit_events` service-role only.
- **Consent revocation is session-coupled** — clears consent + embedding, FLAGS every in-progress assessment, deletes face_checks only for own completed sessions, audits. **Re-consent does NOT un-flag** (lecturer decision).
- **`flagged` is lecturer-only** — `self_recover_session` on flagged → 403; `unlock_session`/`exempt_face_session` are lecturer-only + completed-gated; `submit_session` rejects `flagged` (flag survives; no score banked).
- **The assessment gate is NOT bypassable by reload** — RSC seeds `exists(face_checks)` → `hasFaceChecks`; `'ready'` requires ≥1 recorded check; seeding precedence pinned.
- **Nonce discipline** — `verify_nonce` rotates per check inside the lock; stale nonce → `nonce_mismatch` (client refetches via GET and retries ONCE); flagged poll writes the GET nonce before re-verifying.
- **One camera, three consumers** — `camera.ts` sole `track.stop()` owner; token refcount + supersede guard; gesture stop never kills the face feed.
- **CSRF** `checkSameOrigin()` on all state-changing face routes; per-user rate limits (enroll 5, verify 10, consent 5, self-recover 10, unlock 10, exempt 10, pause 20, face-unavailable 10, GET 60).

## 5. Known remaining / accepted (documented in PLAN_PHASE7 §5)

- **PHASE 7 DEVIATION — face embedding model.** The plan pinned a `FaceEmbedder` task + `face_embedder.task` (192-dim) from `@mediapipe/tasks-vision`. That task DOES NOT EXIST (verified `1.0.1` and the latest RC — no `FaceEmbedder`/`FaceRecognizer` class; the model URL 404s). Implemented instead: a **swappable `FaceEmbeddingProvider` interface** (`src/lib/face/types.ts`) with a default `ImageEmbedderFaceEmbeddingProvider` consuming a self-hosted 192-dim TFLite model at `public/models/face_embedding.tflite`. **That file is a MANUAL DROP-IN** — until present, the manifest records it as `missing` (verify-mediapipe passes with a warning) and the pipeline reports face `'unavailable'` (click-first passthrough). To enable face verification: drop a 192-dim face-embedding TFLite at `public/models/face_embedding.tflite`, re-run `node scripts/vendor-mediapipe.mjs`, and commit the manifest update. The 192-dim `vector(192)` schema + cosine + all server logic are unchanged; swap the provider to use any future model.
- **Anti-replay is honest, not magic** — the nonce stops naive captured-request replay; it cannot stop a student looping their own uploaded embedding. The FLAT window hard-flags continuous V/−V alternation at the 3rd fail in any sliding 5-window; bounded ≤5-check framing leaves a visible ≤2-fail record + advisory flags. True identity needs post-MVP challenge-response / device attestation.
- **Deviations from PLAN §2 API table** — `GET /api/sessions/[id]`; `POST /api/sessions/[id]/pause`; `POST /api/face/consent`; `POST /api/sessions/[id]/face-unavailable`. All authZ'd, rate-limited, RPC-backed.
- **`submit_session` semantics change** — `paused` submits; `flagged` submits rejected until a lecturer decision. No existing test pinned the old behavior.
- **Timer counts gate time** — a timed assessment can auto-submit score-0 if it expires during the gate/blink (pinned by the E13 timer-gate E2E). Demo-killers are UNTIMED.
- **Post-unlock single-fail re-flags** (integrity-conservative); only a pass clears the current check.
- **Camera-off / persistent-camera-death students** complete assessments click-first (PLAN risk 7 accepted) and are recorded (`face_unavailable_at` boot / FLAT-window flags for mid-quiz nulls).
- **P7 exposes only routes + minimal status reads for lecturer actions** — the results dashboard (unlock/exempt buttons, face-check timeline incl. `suspected_replay`, `unavailable`, revocation markers) is P8.
- **CSP/Permissions-Policy (P9)** still deferred (`media-src 'self' blob:`, `Permissions-Policy: camera=(self)`).
- **E2E availability assumption** — unseamed face boot must fail fast (headless camera denial) for the mouse-based assessment E2E to stay green; E5/E11 get timeout belt-and-braces; the seam is never installed there.

## 6. How to start Phase 8 (Results dashboard)

**Phase 8 is now IMPLEMENTED** (`docs/PLAN_PHASE8.md` §8 executed): `reset_session` RPC + `lecturer_audit_view` (migration `0011_results.sql`), `lib/results/` (U-T4 + U-T4b/c/d), `DELETE /api/sessions/[id]/reset` (I21) + route tests, the results RSC + thin dashboard client + nav links, the play-client/pipeline `not_owner` dead-screen branch (D13), `scripts/verify-results.mjs` (18/18: D13-reset / I21-D / authZ / status+mode matrix / D-view / race pin), and the deferred E2E specs. The P8 E2E specs (E13b/E5b/E14) are **skipped pending the planned UI rework** — they are the contract the rewrite must keep.

1. Confirm the baseline above is green (docker + supabase up).
2. Re-run the P8 verification matrix (PLAN_PHASE8 §6/§8.2): `node scripts/verify-results.mjs` **18/18**, vitest **551**, coverage thresholds, E2E E5b/E13b/E14 after the UI rework.
3. `docs/PLAN_PHASE8.md` §9 logs the planning audit→fix iterations (converged); the implementation audit→fix loop re-happened here and re-converged.
4. Graphify is installed (`C:\Users\mohdz\.local\bin\graphify.exe`); run `graphify update .` after changes.

## 7. Commit history (P7)

```
<commits added during this phase — see git log>
```

## 8. P7 gate summary (final)

- **Unit/integration:** 507 vitest tests (37 files), coverage thresholds pass (lib/face pure modules ≥80% stmts/lines/funcs + ≥70% branches; app/api/face routes 60/60/60/50; camera.ts 80/80/80/70; face-tracker.ts 0-key browser-only).
- **DB/RLS/RPC:** verify-sessions 19/19; verify-face 50/50 (D10/D11/D13/D14 + P7 pins + audit-loop window/threshold/numeric/exempt/quiz-live/null-subject probes); earlier harnesses stay green (security 3/3, classes 21/21, quizzes 42/42, ai 16/16); verify-mediapipe assets intact (manifest clean — no missing markers).
- **E2E:** E3/E3b/E6/E7/E12/E13 (demo-killers) + E9b rework; E4/E5/E10/E11/E8/E9 regression.
- **Build/lint/typecheck/graphify:** all clean.

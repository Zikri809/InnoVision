# InnoVision — Phase 7 CompreFace Migration Plan

> **Status:** EXECUTED — the CompreFace migration is implemented. `docker-compose.yml` (loopback-bound), migration `0010_compreface.sql` (face_embedding dropped, face_enrollment_status + frame_hash + GUC guard added, RPCs redefined), `lib/face/*` (frame-based schemas, server CompreFace client), API routes (enroll/verify/consent/health), UI (3-angle enroll wizard, gate explicit-Begin, pipeline frame-based), FakeSupabase + route tests, E2E fake-tracker + CompreFace mock. Verification: vitest 507/507, coverage thresholds pass, verify-face 50/50 (D10/D11/D13/D14 + D-col-priv + margin + suspicion + reject + tie-break + audit-loop window/threshold/numeric/exempt/quiz-live/null-subject probes), all earlier verify scripts green, mediapipe manifest clean, build clean. E2E face specs updated (E3/E3b/E13/E6/E7/E12/E9b) — see §3 Step 8 for the remaining E2E timing notes.
> **Predecessor:** Phase 7 (Face Pipeline) as executed — see `docs/PLAN_PHASE7.md` (the "before" state; now SUPERSEDED-bannered).
> **Design source:** `docs/PLAN_PHASE7.md` §architecture-design (the CompreFace design document at the top of the file).
> **Phase 7 migration deliverable:** Docker CompreFace alongside the Next.js app → browser sends webcam frames to Next.js API routes → CompreFace handles detection/alignment/embedding/matching → auth.uid-keyed subject registry → multi-angle enrollment → duplicate-identity detection → verification-lite with margin rule → all existing security invariants preserved (server-only verdict, atomic window, nonce rotation, GUC-guarded enrollment status).
> **Gate tests (TESTING §9):** **U-F1–U-F7c** (U-F1–U-F3 adapted) · **D10, D11, D13, D14** · **I1–I6c, I20, I22** · **E3, E3b, E6, E7, E12** · **E9b**. All earlier gates stay green. Test IDs are preserved; assertions are adapted to the new architecture.

---

## 1. Current state (the "before")

**Architecture (what exists — adapt or replace):**

The existing Phase 7 runs face recognition **entirely client-side**:

1. `FaceTracker` (`src/lib/face/face-tracker.ts`, 364 lines) boots in the browser, loads vendored MediaPipe `FaceLandmarker` (blendshapes for blink liveness) + a swappable `FaceEmbeddingProvider` (default `ImageEmbedderFaceEmbeddingProvider` consuming a self-hosted TFLite model).
2. The client captures a 192-dim embedding from the webcam, POSTs it to `/api/face/verify`.
3. The server stores `profiles.face_embedding vector(192)` (pgvector) and computes cosine distance `<=>` inside `record_face_check` — **the server never trusts a client verdict**.
4. Enrollment: client captures 5 frames, averages them, POSTs the averaged embedding to `/api/face/enroll`.
5. Liveness: `BlinkDetector` (`src/lib/face/liveness.ts`) driven by FaceLandmarker blendshapes — runs client-side.
6. **Known gap (the trigger):** `face_embedding.tflite` is a manual drop-in that doesn't exist yet → face reports `unavailable` → click-first passthrough.

**What stays the same (invariants — do NOT regress):**

These are security/robustness invariants from the executed Phase 7 that MUST survive the migration:

1. **Server never trusts a client verdict.** The RPC is directly callable by authenticated students via PostgREST (`grant execute to authenticated`). Under CompreFace, the route calls CompreFace and passes the **raw CompreFace response metadata** (`p_subject text, p_similarity float4, p_second_subject text, p_second_similarity float4`) to the RPC. The RPC **re-derives** `matched` from SQL constants (`FACE_SIMILARITY_MIN`, `FACE_MARGIN_MIN`) — no `p_matched` parameter exists. A direct PostgREST call without valid CompreFace metadata cannot forge a pass.
2. **`record_face_check` is one atomic security-definer RPC.** The `for update` lock, FLAT last-5 window, nonce rotation, and status transitions all stay in SQL. The RPC receives CompreFace metadata (not a verdict) and computes the verdict internally.
3. **The FLAT sliding window** (3 fails in last 5 → flagged; pass never flags current). Unchanged.
4. **Nonce discipline** — `verify_nonce` rotates per check. Unchanged.
5. **Consent revocation is session-coupled.** Unchanged (CompreFace subject deletion is best-effort + retriable).
6. **`flagged` is lecturer-only.** Unchanged.
7. **Gate is not bypassable by reload.** Unchanged.
8. **One camera, three consumers** — `camera.ts` refcounted shared stream. Unchanged.
9. **CSRF + rate limits on all state-changing routes.** Unchanged.
10. **No face images stored in our database.** CompreFace stores embeddings internally; our DB stores only metadata.
11. **Enrollment status is GUC-guarded.** The existing `profiles_face_embedding_guard` trigger pattern is **reinstated** for `face_enrollment_status` — only `enroll_face` (which sets the GUC in-transaction) can write it. Direct PATCH via PostgREST is blocked. RLS self-update policy is column-restricted.

**What changes (architectural shift):**

| Aspect | Before (MediaPipe) | After (CompreFace) |
|---|---|---|
| Embedding computation | Client-side (MediaPipe ImageEmbedder) | Server-side (CompreFace /recognize) |
| What crosses the wire | 192-dim float array | Base64 JPEG frame |
| Matching | pgvector `<=>` in SQL RPC | CompreFace /recognize returns subject + similarity; RPC re-derives `matched` from metadata + SQL constants |
| Enrollment | 5-frame average → pgvector `vector(192)` | 3-angle capture → CompreFace /subjects API; RPC records status (GUC-guarded) |
| Storage | `profiles.face_embedding vector(192)` | CompreFace subject registry (subject name = `auth.uid()`); `profiles.face_enrollment_status` (GUC-guarded) |
| Liveness (blink) | Client-side FaceLandmarker blendshapes | **Stays client-side** (FaceLandmarker remains for blink only) |
| Duplicate detection | None | CompreFace /recognize before enrollment → suspicion flag |
| Model management | Manual TFLite drop-in (missing) | CompreFace Docker container (bundled models) |
| Database | pgvector extension required | pgvector extension dropped; CompreFace is the registry |

---

## 2. Locked decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| L1 | **CompreFace runs in Docker alongside Supabase** | `docker-compose.yml` at repo root. CompreFace services: `compreface-core`, `compreface-api`, `compreface-postgres`. Ports bound to **`127.0.0.1` only** (`127.0.0.1:8000:8000`) — NOT exposed to the LAN. CompreFace's Postgres (internal port 3306) is NOT host-bound at all. | Security: classroom WiFi must not reach CompreFace. The Next.js route talks to it over loopback. |
| L2 | **Browser sends a frame image, NOT an embedding** | The client captures a JPEG frame from the webcam `<video>` (via canvas `toDataURL`), POSTs it to `/api/face/verify`. The Next.js route forwards it to CompreFace `/recognize`. The client NEVER holds an embedding or similarity score it could forge. | Closes the client-forgery attack. |
| L3 | **`IFaceTracker` interface restructured; stays the test seam** | `{ start(); captureFrame(): Promise<string \| null>; waitForBlink(timeoutMs): Promise<'passed'\|'failed'>; stop() }`. `captureFrame()` returns a base64 JPEG data URL (or null when no face is detected). `waitForBlink` stays (FaceLandmarker blendshapes, client-side). E2E fake via `window.__INNOVISION_FAKE_FACE_TRACKER__` + `__INNOVISION_FAKE_FACE_CONTROL__` (same mechanism; `captureFrame` replaces `captureEmbedding`). | Mirrors the P6/P7 seam pattern. |
| L4 | **CompreFace is the subject registry; `auth.uid()` = subject name** | Enrollment creates/updates a CompreFace subject named by the student's `auth.uid()` (globally unique, already the PK). The `profiles.face_embedding vector(192)` column is **dropped** (migration `0010`). pgvector extension is dropped. | One global registry; recognition responses directly identify the student. |
| L5 | **`record_face_check` receives CompreFace METADATA, not a verdict — the RPC re-derives `matched` from SQL constants** | New signature: `record_face_check(p_session_id uuid, p_subject text, p_similarity float4, p_second_subject text, p_second_similarity float4, p_trigger face_check_trigger, p_nonce uuid, p_frame text)`. The RPC: (1) locks the row; (2) checks consent/mode/quiz-live/exempt/status (unchanged); (3) **computes `matched` itself**: `v_matched := (p_subject = auth.uid()::text AND p_similarity >= 0.5 AND (p_second_similarity IS NULL OR (p_similarity - p_second_similarity) >= 0.15))`; (4) `v_distance := 1.0 - p_similarity`; (5) `v_frame_hash := encode(digest(p_frame, 'sha256'), 'hex')` (RPC-computed, not caller-supplied — the replay advisory is trustworthy); (6) inserts `face_checks`; (7) FLAT window; (8) rotate nonce; (9) return. **No `p_matched` parameter exists.** A direct PostgREST call without valid CompreFace metadata cannot forge a pass (the `p_subject = auth.uid()` check + threshold re-derivation is the enforcement). | **CRITICAL SECURITY:** the RPC is `grant execute to authenticated` — any student can call it via PostgREST. The verdict MUST be computed inside the RPC, not passed as a parameter. This preserves invariant #1. |
| L6 | **`enroll_face` RPC is GUC-guarded; status derived from CompreFace metadata** | New signature: `enroll_face(p_duplicate_subject text, p_duplicate_similarity float4)`. The RPC: (1) auth + student; (2) consent gate; (3) ever-enrolled live-session gate; (4) **derives status**: if `p_duplicate_similarity >= 0.45` AND `p_duplicate_subject <> auth.uid()::text` → `status = 'pending_review'`, else `status = 'enrolled'`; (5) sets GUC `app.face_enroll = 'on'` + `app.face_enroll_actor = auth.uid()::text`; (6) `UPDATE profiles SET face_enrollment_status = status WHERE id = auth.uid()`; (7) audit. **No `p_status` parameter** — the RPC derives it. **Residual risk (honestly stated):** a direct PostgREST call with `p_duplicate_similarity = 0` gets `status = 'enrolled'` (the RPC trusts the metadata). The GUC guard (L7) blocks direct column UPDATEs via PATCH, but NOT direct RPC calls (the RPC is security-definer and sets the GUC itself). The `p_subject = auth.uid()` check in `record_face_check` ensures the student can only pass as themselves. See §7 for the full threat model. | **CRITICAL SECURITY:** the GUC guard + column-level REVOKE blocks direct column writes. Direct RPC calls are a documented residual risk (same threat model as the existing embedding-forgery risk). |
| L7 | **`face_enrollment_status` is GUC-guarded + column-level RLS restricted** | A new guard trigger `profiles_face_enrollment_guard` (mirrors the old `profiles_face_embedding_guard`): `BEFORE UPDATE OF face_enrollment_status` requires `app.face_enroll='on'` AND `app.face_enroll_actor = auth.uid()::text` else `not_authorized`. Additionally: `REVOKE UPDATE (face_enrollment_status) ON profiles FROM authenticated;` — the RLS self-update policy still allows updating `full_name` etc., but NOT this column. | **CRITICAL SECURITY:** closes the direct-PATCH-via-PostgREST attack on the new enrollment-status column. |
| L8 | **Threshold + margin rule (SQL constants, not route constants)** | `FACE_SIMILARITY_MIN = 0.5` (CompreFace similarity; match requires `≥`), `FACE_MARGIN_MIN = 0.15` (top match minus second-best), `FACE_SUSPICION_MIN = 0.45` (enrollment duplicate flag; **≤ SIMILARITY_MIN** so anything that would verify is caught at enroll). All three are **SQL constants** inside the RPCs — not route constants, not env vars. The route passes raw CompreFace metadata; the RPC applies the constants. | Kills lookalike misidentifications; calibration via stress tests (§8). The suspicion threshold is LOWER than the verify threshold (looser = catches more). |
| L9 | **Enrollment: multi-angle via CompreFace `/subjects/{subject}/examples`** | The client captures 3 angles (front, left ~30°, right ~30°), each as a JPEG frame. The route POSTs each to CompreFace `POST /api/v1/recognition/subjects/{subject}/examples`. Pose validation: the route calls CompreFace `/detect` for each frame and rejects angles outside the guided range (front: |yaw| < 25°, left: yaw 25–60°, right: yaw -60 to -25°). | Design doc §5; CompreFace handles multi-sample natively. |
| L10 | **Duplicate-identity detection at enrollment (all top-N, not just top-1)** | Before creating/updating a subject, the route calls CompreFace `POST /recognize` with each enrollment frame. The route passes the **best non-self match** (highest similarity where subject ≠ `auth.uid()`) to the RPC as `p_duplicate_subject` + `p_duplicate_similarity`. The RPC applies `FACE_SUSPICION_MIN` (SQL constant). If the best non-self similarity ≥ suspicion threshold → `pending_review`. | Catches one person enrolling under multiple accounts. Checking all top-N (not just top-1) avoids missing a similar different student when top-1 is self. |
| L11 | **Blink liveness stays client-side (MediaPipe FaceLandmarker)** | The `FaceTracker` still loads `face_landmarker.task` (vendored, CPU) for blink detection. This is the ONLY MediaPipe face model that remains. The `FaceEmbeddingProvider` interface and `ImageEmbedderFaceEmbeddingProvider` are **removed**. The `face_embedding.tflite` gap is eliminated. | Blink is cheap, client-side, no server round-trips. |
| L12 | **Quality gate runs client-side before sending a frame** | `FaceTracker.captureFrame()` uses the browser's native `FaceDetector` API (Chrome) if available; falls back to a FaceLandmarker-based check (face detected + eyes open). Fails → "adjust yourself" prompt, no frame sent. | Design doc §4 quality gate; saves a server round-trip. |
| L13 | **`face_unavailable_at` + `report_face_unavailable` stay** | If CompreFace is unreachable or the camera fails → `unavailable` (passthrough) + `face_unavailable_at` recorded. | Risk-7 gap still lecturer-visible. |
| L14 | **CompreFace availability probe replaces the embedding-model boot race** | `useFaceTracker` boots FaceLandmarker (for blink) + `GET /api/face/health` (CompreFace health probe) inside the `FACE_BOOT_TIMEOUT_MS` race. Mid-session CompreFace downtime is detected by the verify route returning 503 (handled by the pipeline's existing network-error cadence-reschedule), NOT by a periodic health probe. | Availability contract unchanged; only the probe target changes. |
| L15 | **E2E CompreFace mock: frame-marker inspection (NOT a client global)** | The E2E fake tracker returns deterministic frame marker strings: `"data:image/jpeg;base64,FAKE_FRAME_MATCH"` or `"data:image/jpeg;base64,FAKE_FRAME_MISMATCH"`. The Next.js route inspects the frame string (when `process.env.NODE_ENV !== 'production'` AND `process.env.COMPREFACE_MOCK_ENABLED === '1'`) and returns a canned CompreFace response without calling Docker. `setVerifyMode('match'|'mismatch')` controls which marker the fake tracker returns. **Two-flag guard** (`NODE_ENV` + `COMPREFACE_MOCK_ENABLED`) prevents production leakage. The `__INNOVISION_FAKE_COMPREFACE__` client global is NOT used (routes are server-side — they cannot read browser globals). | **CRITICAL:** the route is server-side; a client global is architecturally impossible. The frame-marker mechanism is the transport. The `COMPREFACE_MOCK_ENABLED` env is set in `playwright.config.ts` and by the route tests' `beforeAll`. |
| L16 | **Re-enrollment with admin approval** | `face_enrollment_status` transitions: `null` → `enrolled` / `pending_review` → `enrolled` (admin approves). Re-enrollment: the route detects an existing CompreFace subject (via `GET /subjects/{subject}`) and deletes old examples before adding new ones. On approval, the route calls CompreFace to swap samples, then calls `enroll_face` RPC. | Old samples never leave a student faceless mid-semester. |
| L17 | **Consent revocation: CompreFace deletion is retriable, not fire-and-forget** | The consent route calls `revoke_face_consent` RPC **first** (DB state cleaned: `face_enrollment_status = null`, sessions flagged). Then calls CompreFace `deleteSubject` (best-effort). If CompreFace is down, a `face_deletion_pending` flag is set on the profile (new column or an `audit_events` marker) and a retry mechanism (cron or next-enroll-time check) deletes the subject later. **Order: RPC first, then CompreFace** — so a CompreFace-down + RPC-success leaves the student unenrolled in the DB (verify fails → `not_enrolled`, which is correct), with the CompreFace subject queued for deletion. | Privacy: biometric data must be deleted when consent is revoked, even if CompreFace is temporarily down. |
| L18 | **`cosine.ts`, `FACE_EMBEDDING_DIM`, `FACE_DISTANCE_MAX`, `serializeEmbedding` are removed** | These were mirrors of the pgvector computation. Under CompreFace, the RPC receives similarity metadata. `cosine.ts` and its tests are deleted. | The matching logic moves to the RPC (via CompreFace metadata); the mirror is dead code. |
| L19 | **`face_checks.distance` = `1 - similarity`** | The RPC computes `distance = 1.0 - p_similarity` (lower = more similar, consistent with the existing column semantics). `suspected_replay` = RPC-computed `sha256(p_frame)` compared to the previous check's `frame_hash`. The `frame_hash` column stores the hash; the frame itself is never stored. | Preserves advisory signal; hash is server-computed (trustworthy). |
| L20 | **CompreFace client lives in `src/lib/face/server/compreface-client.ts`** | Server-only module with `import "server-only";` at the top. Physically separated from the pure-logic `lib/face/*.ts` modules. The pure-logic rule (`lib/face/*.ts` — no `process.env`) is preserved; the server I/O module is explicitly exempt and structurally isolated. | Prevents accidental client-bundle import; honors the repo rule. |
| L21 | **Body-size cap on frames** | `MAX_FRAME_BASE64_CHARS = 200_000` (~150 KB) in `constants.ts`. The verify + enroll routes check `frame.length > MAX_FRAME_BASE64_CHARS` → 413. Verify rate limit lowered to 10/min (cadence is 30–45s + Q-transitions; 10/min is 5× the realistic rate). Enroll rate limit stays 5/min. | DoS prevention; frames are 25× larger than the old 192-float payload. |
| L22 | **No raw images stored in our database** | CompreFace stores embeddings internally. Our database stores only `face_checks` (metadata + `frame_hash`) + `audit_events` + `profiles.face_enrollment_status`. The frame is ephemeral. | Privacy. |

---

## 3. Work breakdown

### Step 0 — Prereqs

1. Docker Desktop running (already required for Supabase).
2. CompreFace Docker images pulled (first run ~2 GB; cached after).
3. P7 baseline green (re-run the verification matrix from `PLAN_PHASE7.md` §8.2).
4. No new npm dependencies. `@mediapipe/tasks-vision@1.0.1` stays — still needed for `FaceLandmarker` (blink). The `ImageEmbedder` usage is removed but the package provides both.

### Step 1 — `docker-compose.yml` + CompreFace provisioning

1. **`docker-compose.yml`** at repo root. CompreFace services (official 1.2.0 layout):
   - `compreface-core` — InsightFace model container (CPU default for demo).
   - `compreface-api` — REST API server (recognition /verify /detect).
   - `compreface-admin` — admin REST backend (1.2.0 split the admin out of the API image).
   - `compreface-fe` — nginx: admin UI + `/api/v1` proxy; the only published port.
   - `compreface-postgres` — CompreFace's own Postgres (separate from Supabase's Postgres).
   - **Ports: `127.0.0.1:8000:80`** on `compreface-fe` (loopback only). CompreFace's Postgres is **NOT host-bound** (internal only).
   - **Named volumes** (not bind mounts): `compreface-postgres-data`, `compreface-api-logs`.
   - Environment: `POSTGRES_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `SPRING_PROFILES_ACTIVE=dev`.
2. **`.env.local.example`** — add:
   ```env
   COMPREFACE_BASE_URL=http://localhost:8000
   COMPREFACE_API_KEY=  # set after first run
   COMPREFACE_MOCK_ENABLED=0  # set to 1 for E2E/unit tests
   ```
   Remove the stale `FACE_MATCH_THRESHOLD=0.6` line (never read by the app).
3. **`.gitignore`** — add `/compreface-data/` (defensive; named volumes are used but this protects against a future bind-mount switch).
4. **`docs/COMPREFACE_SETUP.md`** (NEW) — setup guide: `docker compose up -d`, create the admin account + a Recognition application via the admin UI at `http://localhost:8000`, copy API key, verify `GET /api/v1/health` (with `x-api-key` header).
5. **`supabase/config.toml`** — **NO CHANGE**. CompreFace (port 8000) and its Postgres (internal) don't collide with Supabase's ports. CompreFace runs via `docker-compose.yml`, separate from `supabase start`.

### Step 2 — Migration `0010_compreface.sql` + types

**Migration step order (dependency-pinned):**

1. **`profiles` changes:**
   - `ALTER TABLE profiles DROP COLUMN IF EXISTS face_embedding;`
   - `ALTER TABLE profiles ADD COLUMN face_enrollment_status text;`
   - `ALTER TABLE profiles ADD COLUMN face_deletion_pending boolean not null default false;` (consent-revoke retry marker)
   - **Drop old guard:** `DROP TRIGGER IF EXISTS profiles_face_embedding_guard ON profiles;` `DROP FUNCTION IF EXISTS profiles_face_embedding_guard();`
   - **New guard:** `profiles_face_enrollment_guard()` — `BEFORE UPDATE OF face_enrollment_status`: require `app.face_enroll='on'` AND `app.face_enroll_actor = auth.uid()::text` (with `coalesce` for NULL-safety, same pattern as the old trigger). Service-role writes blocked (`auth.uid()` NULL).
   - **Column-level privilege:** `REVOKE UPDATE (face_enrollment_status) ON profiles FROM authenticated;` — the RLS self-update policy still allows updating `full_name` etc., but NOT this column. Only the `enroll_face` RPC (security definer, sets the GUC) can write it.
2. **`face_checks` changes:**
   - `ALTER TABLE face_checks ADD COLUMN frame_hash text;` (NOT indexed — read from the latest row via the existing `(session_id, checked_at)` index).
3. **Redefine `enroll_face` RPC:**
   ```sql
   enroll_face(p_duplicate_subject text, p_duplicate_similarity float4)
   ```
   - (1) auth + student; (2) consent gate; (3) ever-enrolled live-session gate (reads `face_enrollment_status IS NOT NULL` OR `exists(audit_events face_enroll/face_reenroll)`); (4) **derive status**: `if p_duplicate_similarity >= 0.45 AND coalesce(p_duplicate_subject,'') <> auth.uid()::text then 'pending_review' else 'enrolled'`; (5) set GUCs; (6) `UPDATE profiles SET face_enrollment_status = status WHERE id = auth.uid()`; (7) audit `face_enroll`/`face_reenroll`.
   - **No `p_status` parameter** — the RPC derives it.
   - **Direct PostgREST call residual risk (honestly stated):** A student calling `enroll_face(p_duplicate_subject: null, p_duplicate_similarity: 0)` directly via PostgREST gets `face_enrollment_status = 'enrolled'` in the DB. Combined with a direct `record_face_check(p_subject: <uid>, p_similarity: 0.9, ...)` call, the student can bypass CompreFace entirely. This is the **same residual risk** as the existing design (a student could forge an embedding that cosine-matches their stored one) — see §7 residual risk. The mitigation is the FLAT window (continuous verify), liveness (blink), and lecturer review. **The `p_subject = auth.uid()` check ensures the student can only pass as themselves** (no impersonation). An attacker who can call PostgREST directly can already do anything the student themselves could do (submit answers, start sessions) — the face-bypass is within the same threat model.
   - **Step 8 of `record_face_check` (enrollment check) MUST change:** the existing step reads `profiles.face_embedding` (dropped column). The migration changes it to read `profiles.face_enrollment_status IS NULL` → `not_enrolled`. This is a required edit, not "unchanged."
4. **Redefine `record_face_check` RPC:**
   ```sql
   record_face_check(
     p_session_id uuid,
     p_subject text,             -- CompreFace's top match subject name
     p_similarity float4,        -- CompreFace's top match similarity
     p_second_subject text,      -- CompreFace's second-best subject (nullable)
     p_second_similarity float4, -- CompreFace's second-best similarity (nullable)
     p_trigger face_check_trigger,
     p_nonce uuid,
     p_frame text                -- base64 JPEG (RPC hashes it; never stored)
   )
   ```
   - Steps 1–7 (lock, consent, mode, quiz-live, completed, exempt, paused/flagged) are **unchanged**.
   - Step 8 (was: check `profiles.face_embedding IS NULL`) → **CHANGED** to check `profiles.face_enrollment_status IS NULL` → `not_enrolled`. This is a required edit because the `face_embedding` column is dropped.
   - Step 9 (nonce check) — **unchanged**.
   - Step 10 (was: compute distance from stored embedding) → **RPC computes matched from metadata**:
     ```sql
     v_matched := (p_subject = auth.uid()::text
                   AND p_similarity >= 0.5
                   AND (p_second_similarity IS NULL OR (p_similarity - p_second_similarity) >= 0.15));
     v_distance := 1.0 - p_similarity;
     v_frame_hash := encode(digest(p_frame, 'sha256'), 'hex');  -- requires pgcrypto
     ```
   - Step 10b: `v_suspected_replay := (v_frame_hash = (SELECT frame_hash FROM face_checks WHERE session_id = ... ORDER BY checked_at DESC, id DESC LIMIT 1))`.
   - Steps 11–14 (insert, FLAT window, rotate nonce, return) are **unchanged**.
   - **`pgcrypto` extension** (`CREATE EXTENSION IF NOT EXISTS pgcrypto;`) for `digest()` — **must run BEFORE the `record_face_check` function redefinition** (step 4). Place it at the top of the migration (step 0) or at the start of step 4. Supabase may already have it; `IF NOT EXISTS` makes it idempotent.
5. **Update `revoke_face_consent` RPC:**
   - Same session-flagging + completed-face_checks-deletion logic.
   - `UPDATE profiles SET consent_given_at = null, face_enrollment_status = null, face_deletion_pending = true WHERE id = auth.uid()`.
   - **Keep the GUC-setting lines** (`set_config('app.face_enroll', 'on', true)` + `set_config('app.face_enroll_actor', auth.uid()::text, true)`) — the new guard trigger on `face_enrollment_status` requires the GUC, same as the old guard on `face_embedding`. The RPC is security-definer and sets the GUC before the UPDATE.
   - The route calls CompreFace `deleteSubject(auth.uid())` AFTER the RPC succeeds. If CompreFace is down, `face_deletion_pending` remains `true` for retry.
6. **Other RPCs** (`self_recover_session`, `pause_session`, `unlock_session`, `exempt_face_session`, `report_face_unavailable`, `submit_session`) — **unchanged**. **New RPC:** `reject_face_enrollment(p_student_id uuid)` — lecturer-only (in-RPC `is_lecturer_of_quiz` not applicable here — use `role = 'lecturer'` check + the student must be in one of the lecturer's classes); sets `face_enrollment_status = null`; audits `face_enroll_rejected`. Added to migration `0010`.
7. **Drop pgvector extension** (LAST, after all column/function references are gone): `DROP EXTENSION IF EXISTS vector;` (plain, no CASCADE — all dependents were dropped in steps 1–4).
8. **`npm run gen:types`** — `database.ts` regenerates: `profiles` loses `face_embedding`, gains `face_enrollment_status` + `face_deletion_pending`; `face_checks` gains `frame_hash`; RPC signatures change (`enroll_face`, `record_face_check`). **`aliases.ts` needs no manual edit** (passthrough re-export). **`database.ts` is the file that changes** — add to §4 matrix.
9. **`scripts/verify-face.mjs`** — update:
   - **Delete** D11b direct/other/service-role `face_embedding` UPDATE probes (guard trigger is gone, column is gone).
   - **Change** `enroll_face` calls: `{ p_embedding: V }` → `{ p_duplicate_subject: null, p_duplicate_similarity: 0 }`.
   - **Change** `record_face_check` calls: `{ p_session_id, p_embedding, p_trigger, p_nonce }` → `{ p_session_id, p_subject: <uid>, p_similarity: 0.9, p_second_subject: null, p_second_similarity: null, p_trigger, p_nonce, p_frame: 'test-frame' }`.
   - **Re-consent assertion**: SELECT `face_enrollment_status` (not `face_embedding`); assert `=== null` after revoke.
   - **New probe**: direct `PATCH /rest/v1/profiles` setting `face_enrollment_status='enrolled'` → blocked (column-level privilege).
   - **New probe**: direct RPC `record_face_check` with `p_subject = auth.uid()` but `p_similarity = 0.9` (bypassing CompreFace) → **this passes** (the RPC trusts the metadata) — document that the route is the sole CompreFace caller and the threat model is "student calls RPC directly without a real CompreFace check." **Mitigation:** the RPC cannot distinguish a real CompreFace response from a forged one. **This is an accepted residual risk** — the same risk exists in the current design (a student could forge an embedding that matches their stored one). The CompreFace architecture does NOT make this worse. The `p_subject = auth.uid()` check ensures the student can only pass as themselves (not as someone else). The threat of "student forges their own pass" is mitigated by the FLAT window (continuous verify) + liveness (blink) + lecturer review, same as before.
   - D10 (face_checks RLS) — unchanged.
   - D13 (audit rows) — unchanged.
   - D14 (nonce rotation) — updated params.
10. `npm run lint && npm run typecheck` clean (gate).

### Step 3 — `lib/face` pure-logic changes

| File | Action | Details |
|---|---|---|
| `constants.ts` | **EDIT** | Remove `FACE_EMBEDDING_DIM`, `FACE_DISTANCE_MAX`. Add `FACE_SIMILARITY_MIN = 0.5`, `FACE_MARGIN_MIN = 0.15`, `FACE_SUSPICION_MIN = 0.45`, `MAX_FRAME_BASE64_CHARS = 200_000`, `FRAME_QUALITY_MIN_SIZE = 80`, `FRAME_QUALITY_MAX_SIZE = 640`. Change `ENROLL_CAPTURE_FRAMES` from 5 to 3. Add `ENROLL_ANGLES = ['front', 'left', 'right']`, `ENROLL_ANGLE_YAW_RANGE = { min: 25, max: 60 }`. Keep `LIVENESS_TIMEOUT_MS`, `ENROLL_CAPTURE_MAX_ATTEMPTS`, `ENROLL_CAPTURE_MAX_MS`, `PERIODIC_*`, `FACE_BOOT_TIMEOUT_MS`, `FLAGGED_POLL_MS`, `EYE_*`, `MIN_VERIFY_INTERVAL_MS`. |
| `types.ts` | **EDIT** | `IFaceTracker.captureEmbedding()` → `captureFrame(): Promise<string \| null>`. Remove `Embedding` type. Remove `FaceEmbeddingProvider` interface. Remove `FaceCheckResult`/`FaceVerifyResponse` `distance` type change (stays `number \| null`). `FakeFaceControl.setVerifyMode` JSDoc updated (controls frame marker, not embedding vector). Add `FaceEnrollmentStatus = 'enrolled' \| 'pending_review'`. |
| `cosine.ts` | **DELETE** | No longer needed. |
| `cosine.test.ts` | **DELETE** | U-F1/U-F2/U-F3 replaced by route tests. |
| `schemas.ts` | **EDIT** | Remove `embeddingSchema`, `serializeEmbedding`. Add `frameSchema = z.string().min(1).max(MAX_FRAME_BASE64_CHARS)`. `EnrollSchema` → `{ frames: z.array(frameSchema).length(3) }`. `VerifySchema` → `{ sessionId, frame: frameSchema, trigger, nonce }`. `ConsentSchema`, `ExemptSchema`, `SessionIdSchema` unchanged. |
| `schemas.test.ts` | **EDIT** | Remove U-F4/U-F4b. Add frame-schema tests (empty string rejected, too-long rejected, wrong count rejected). |
| `liveness.ts` | **UNCHANGED** | |
| `liveness.test.ts` | **UNCHANGED** | U-F5. |
| `streak.ts` | **UNCHANGED** | |
| `streak.test.ts` | **UNCHANGED** | U-F6/U-F7c. |
| `recovery.ts` | **UNCHANGED** | |
| `recovery.test.ts` | **UNCHANGED** | U-F7/U-F7b. |
| `cadence.ts` | **UNCHANGED** | |
| `cadence.test.ts` | **UNCHANGED** | I22. |
| `outcome.ts` | **EDIT** | Add `duplicate_detected` branch → `{ next: 'gate', surfaceError: 'duplicate_detected' }`. Other branches unchanged. |
| `outcome.test.ts` | **EDIT** | Add `duplicate_detected` test. |
| `rpc-mapping.ts` | **EDIT** | Add `duplicate_detected` → 409, `compreface_unavailable` → 503, `invalid_frame` → 400, `pose_invalid` → 400. Other mappings unchanged. |
| `rpc-mapping.test.ts` | **EDIT** | Add tests for new mappings. |
| `fake-seam.ts` | **EDIT** | `getFakeFaceTracker()` shape-validation: check `captureFrame` instead of `captureEmbedding`. JSDoc line 7 updated. `getFakeFaceControl()` unchanged. |
| `fake-seam.test.ts` | **EDIT** | Update shape-validation for `captureFrame`. |
| `face-tracker.ts` | **REWRITE** | See Step 4. |

### Step 4 — Shared camera + face tracker rewrite

- **`src/lib/vision/camera.ts`** — **UNCHANGED**.
- **`src/lib/vision/camera.test.ts`** — **UNCHANGED**.
- **`src/lib/gestures/hand-tracker.ts`** — **UNCHANGED**.
- **`src/lib/face/face-tracker.ts`** — **REWRITE** (0-key coverage):
  - **Remove:** `FaceEmbeddingProvider`, `ImageEmbedderFaceEmbeddingProvider`, `FACE_EMBEDDING_MODEL_URL`, `MediaPipeImageEmbedder` type, `VisionModule.ImageEmbedder` field, the `ImageEmbedder` boot, `captureEmbedding()`.
  - **Keep:** `FaceLandmarker` boot (vendored `face_landmarker.task`, CPU, blendshapes), `waitForBlink()`, `BlinkDetector`, the rAF detection loop (`FRAME_INTERVAL_MS = 33` — the existing landmarker loop cap; stays as-is), `feedLiveness()` (blendshape parsing), the shared-stream acquire/release, the visibility handler, `stop()`.
  - **Add:** `captureFrame(): Promise<string | null>` — captures the `<video>` frame to a canvas, runs a quality gate (single face, size in `[FRAME_QUALITY_MIN_SIZE, FRAME_QUALITY_MAX_SIZE]`, both eyes open via blendshapes), returns a base64 JPEG data URL (or null). **`FRAME_CAPTURE_INTERVAL_MS` is NOT a new constant** — the existing `FRAME_INTERVAL_MS` caps the landmarker rAF loop; `captureFrame` is called on-demand (not in the loop), so no new interval constant is needed.
  - **Constants:** `FACE_LANDMARKER_MODEL_URL` stays. `FACE_EMBEDDING_MODEL_URL` removed. `BLINK_LANDMARKER_URL` and `WASM_ROOT` (module-private, line 75–76) **stay** — they're consumed by the `loadVision()` + `createLandmarker()` methods which are kept (FaceLandmarker boot stays).

### Step 5 — CompreFace client library

- **`src/lib/face/server/compreface-client.ts`** (NEW, server-only):
  - `import "server-only";` at the top.
  - `recognize(frame: string): Promise<{ subject: string | null; similarity: number; subjects: { subject: string; similarity: number }[] }>` — `POST /api/v1/recognition/recognize`.
  - `addSubjectExample(subject: string, frame: string): Promise<{ imageId: string }>` — `POST /api/v1/recognition/subjects/{subject}/examples`.
  - `deleteSubject(subject: string): Promise<void>` — `DELETE /api/v1/recognition/subjects/{subject}`.
  - `getSubject(subject: string): Promise<{ subject: string | null }>` — `GET /api/v1/recognition/subjects/{subject}` (for re-enroll detection).
  - `detect(frame: string): Promise<{ faces: { attributes: { pose: { pitch, roll, yaw } } }[] }>` — `POST /api/v1/detection/detect`.
  - `health(): Promise<boolean>` — `GET /api/v1/health`.
  - Uses `COMPREFACE_BASE_URL` + `COMPREFACE_API_KEY` from `process.env` (server-only).
  - **Mock mode:** when `process.env.NODE_ENV !== 'production'` AND `process.env.COMPREFACE_MOCK_ENABLED === '1'`, the client inspects the frame string for marker substrings (`FAKE_FRAME_MATCH`, `FAKE_FRAME_MISMATCH`) and returns canned responses without calling Docker.
  - Error handling: network errors → `{ error: 'compreface_unavailable' }`.

### Step 6 — API routes (revised)

- **`POST /api/face/enroll`** — **REWRITE**:
  - Input: `{ frames: string[] }` (3 base64 JPEGs).
  - Body-size check: each `frame.length > MAX_FRAME_BASE64_CHARS` → 413.
  - Flow: (1) guard → CSRF → rate-limit (5/min) → Zod; (2) for each frame: call CompreFace `/detect` → validate pose; (3) **duplicate check**: for each frame, call CompreFace `/recognize` → find the best non-self match (highest similarity where subject ≠ `auth.uid()`); (4) for each frame: call CompreFace `addSubjectExample(auth.uid(), frame)`; (5) call RPC `enroll_face(p_duplicate_subject, p_duplicate_similarity)` (the RPC derives `pending_review` vs `enrolled`); (6) return `{ ok: true, status }`.
  - Overrides: `consent_required`→403, `live_assessment`→409, `invalid_frame`→400, `compreface_unavailable`→503, `pose_invalid`→400.
- **`POST /api/face/verify`** — **REWRITE**:
  - Input: `{ sessionId, frame: string, trigger, nonce }`.
  - Body-size check: `frame.length > MAX_FRAME_BASE64_CHARS` → 413.
  - Flow: (1) guard → CSRF → rate-limit (**10/min** — lowered from 30) → Zod; (2) call CompreFace `recognize(frame)` → `{ subject, similarity, subjects }`; (3) extract top-2: `p_subject = subjects[0]?.subject ?? null`, `p_similarity = subjects[0]?.similarity ?? 0`, `p_second_subject = subjects[1]?.subject ?? null`, `p_second_similarity = subjects[1]?.similarity ?? null`; (4) call RPC `record_face_check(p_session_id, p_subject, p_similarity, p_second_subject, p_second_similarity, p_trigger, p_nonce, p_frame)` — **the RPC computes `matched` from these + SQL constants**; (5) return `FaceCheckResult`.
  - **Exempt short-circuit:** the RPC handles exempt sessions (step 6, returns `{matched:true, distance:null}` without computing) — the route does NOT call CompreFace for exempt sessions because the RPC short-circuits before the CompreFace-derived `matched` computation. **But the route calls CompreFace BEFORE the RPC** (it needs the metadata). **Decision:** the route calls CompreFace first, passes metadata to the RPC, and the RPC's exempt check (step 6) short-circuits before step 10 (the matched computation) — so the CompreFace call is "wasted" for exempt sessions. This is acceptable (exempt is rare; the alternative is a pre-fetch session-status read which adds latency). Document this.
  - Overrides: `nonce_mismatch`→409, `consent_required`→403, `not_enrolled`→403, `not_assessment`→400, `quiz_not_live`→409, `compreface_unavailable`→503, `invalid_frame`→400, `invalid_trigger`→400.
- **`POST /api/face/consent`** — **EDIT**:
  - `{consent:true}` → unchanged.
  - `{consent:false}` → (1) call `revoke_face_consent` RPC (DB: `face_enrollment_status = null`, `face_deletion_pending = true`, sessions flagged); (2) call CompreFace `deleteSubject(auth.uid())` (best-effort; if it fails, `face_deletion_pending` remains `true` for retry); (3) if CompreFace deletion succeeds, a follow-up RPC or route call clears `face_deletion_pending`. Update JSDoc: remove `UPDATE OF face_embedding` guard-trigger reference; change "clears consent + embedding" to "clears consent + face_enrollment_status; CompreFace subject deleted by the route."
- **`POST /api/face/self-recover`** — **UNCHANGED**.
- **`POST /api/face/unlock`** — **UNCHANGED**.
- **`POST /api/sessions/[id]/exempt-face`** — **UNCHANGED**.
- **`POST /api/sessions/[id]/pause`** — **UNCHANGED**.
- **`POST /api/sessions/[id]/face-unavailable`** — **UNCHANGED**.
- **`GET /api/sessions/[id]`** — **EDIT**: envelope adds `face_enrollment_status`. `verify_nonce` for own student only — unchanged.
- **`GET /api/face/health`** (NEW) — student/lecturer, 10/min. **GET — no CSRF** (read-only). Calls CompreFace `health()`. Returns `{ available: boolean }`.

### Step 7 — UI changes

- **`use-face-tracker.ts`** — **EDIT**: Boot: `Promise.all([tracker.start(), fetch('/api/face/health').then(r => r.ok)])` inside `FACE_BOOT_TIMEOUT_MS`. If either fails → `tracker.stop()` + `onUnavailable`. The `IFaceTracker` exposes `captureFrame()` instead of `captureEmbedding()`.
- **`use-face-pipeline.ts`** — **EDIT** (8 concrete edit sites):
  1. Line 189–193: `captureOrNull()` return type → `Promise<string | null>`; calls `tracker.captureFrame()`.
  2. Line 224–228: `postVerifyInternal` parameter → `frame: string | null`.
  3. Line 231: `const payloadFrame = frame ?? "";` (empty string sentinel — replaces `Array.from({ length: 192 }, () => 0)`).
  4. Line 237: `body: JSON.stringify({ frame: payloadFrame, trigger, nonce, sessionId })`.
  5. Line 262: recursive nonce-retry passes `payloadFrame`.
  6. Line 334: `const frame = await tracker.captureFrame();`.
  7. Line 339: `await postVerifyInternal(frame, trigger, nonceRef.current, true);`.
  8. Lines 336–338: comment rewritten — "POST a sentinel empty frame → CompreFace returns no subject → RPC computes matched=false → fail row in the window."
- **`FaceVerifier`** — **UNCHANGED**.
- **`FaceGate`** — **UNCHANGED**.
- **`face-enroll-client.tsx`** — **REWRITE**: 3-angle capture wizard (front → left → right). Each angle: blink → capture 1 frame → the route validates pose. The "5-frame average" is removed. **Delete** the `FACE_EMBEDDING_DIM` import (line 13), the `averageEmbeddings` helper (lines 261–265), `framesRef: useRef<number[][]>` → `useRef<string[]>`, and the `embedding.length === FACE_EMBEDDING_DIM` check (line 124). Enrollment POST sends `{ frames: [front, left, right] }`. If route returns `pending_review` → "Enrollment pending review." "Revoke consent" stays.
- **`src/app/play/[sessionId]/page.tsx`** (RSC) — **EDIT** (3 line changes):
  1. Line 131: `.select("consent_given_at, face_embedding")` → `.select("consent_given_at, face_enrollment_status")`.
  2. Line 186: cast → `{ consent_given_at: string | null; face_enrollment_status: string | null }`.
  3. Line 188: `const enrolled = ownProfile?.face_enrollment_status === 'enrolled';` (NOT `IS NOT NULL` — `pending_review` must NOT count as enrolled).
- **`src/app/(student)/student/quizzes/page.tsx`** (RSC) — **EDIT** (2 line changes):
  1. Line 17: `.select("role, consent_given_at, face_embedding")` → `.select("role, consent_given_at, face_enrollment_status")`.
  2. Line 87: `enrolled={Boolean(profile.face_embedding)}` → `enrolled={profile.face_enrollment_status === 'enrolled'}`.
- **`src/app/(student)/student/face/enroll/page.tsx`** (RSC) — **EDIT** (2 line changes):
  1. Line 24: `.select("role, consent_given_at, face_embedding")` → `.select("role, consent_given_at, face_enrollment_status")`.
  2. Line 47: `enrolled={Boolean(profile.face_embedding)}` → `enrolled={profile.face_enrollment_status === 'enrolled'}`.
- **`src/components/quiz/play-client.tsx`** — **EDIT**: `enrolled` prop source changes (the RSC feeds it). Logic unchanged.
- **`src/app/(student)/student/student-quizzes-client.tsx`** — **EDIT**: enroll banner reads `face_enrollment_status` (fed by the RSC).
- **`src/lib/classes/roster.ts`** — **EDIT** (comment-only, line 24): change "expose biometric data (face_embedding)" to "expose biometric data (face_enrollment_status)".
- **`src/components/gestures/gesture-layer.tsx`** — **UNCHANGED**.

### Step 8 — E2E test changes

- **`e2e/fake-face-embedder.ts`** → **RENAME to `e2e/fake-face-tracker.ts`** + **REWRITE**:
  - `captureFrame()` replaces `captureEmbedding()`. Returns `"data:image/jpeg;base64,FAKE_FRAME_MATCH"` (match) or `"data:image/jpeg;base64,FAKE_FRAME_MISMATCH"` (mismatch).
  - `setVerifyMode` controls which marker. `triggerBlink()` + `setFacePeriodic()` stay identical.
  - The local `type FakeTracker` interface's `captureEmbedding()` → `captureFrame()`.
- **`e2e/helpers.ts`** — **EDIT**:
  - `installFakeFaceTracker` → uses `fake-face-tracker.ts`.
  - `enrollViaFacePage` → 3-angle sequence: Click Start → wait "Blink now" (front) → `triggerFaceBlink` → wait "Turn left" → wait "Blink now" (left) → `triggerFaceBlink` → wait "Turn right" → wait "Blink now" (right) → `triggerFaceBlink` → wait for redirect. Comment "5 frames" → "3 angles".
  - `passAssessmentGate`, `setFaceVerifyMode`, `triggerFaceBlink`, `setFacePeriodic` — unchanged.
- **`playwright.config.ts`** — **EDIT**: add `COMPREFACE_BASE_URL: 'http://localhost:8000'`, `COMPREFACE_API_KEY: 'test-key'`, `COMPREFACE_MOCK_ENABLED: '1'` to the `env` block. No new `webServer` (CompreFace Docker not required for E2E — the mock handles it).
- **E2E specs** (`e3-face-enroll.spec.ts`, `e6-pause-flag.spec.ts`, `e7-unlock.spec.ts`, `e12-continuous.spec.ts`, `e9b-hand-loss.spec.ts`):
  - **E3**: enroll sends 3 frames via the helper. Rest unchanged.
  - **E3b**: the `fetch('/api/face/enroll')` body changes from `{ embedding: Array(192)... }` to `{ frames: [3 fake frame strings] }`. Test title "no embedding" → "no enrollment". The 403 `consent_required` assertion stays.
  - **E6/E7/E12/E9b**: **NO direct spec edit needed** — the helper + fake-tracker rename carry the change. The specs call `setFaceVerifyMode`/`triggerFaceBlink` (unchanged signatures). The `captureFaceVerifyPosts` body inspection still works (trigger is unchanged; the body key changes from `embedding` to `frame` but the specs inspect `trigger`, not `embedding`). Remove from §4 matrix or mark "UNCHANGED (transitively affected)."

### Step 9 — FakeSupabase + route test changes

- **`src/app/api/quizzes/__tests__/fake-supabase.ts`** — **EDIT** (6 touchpoints):
  1. Line 640: `const ever = profile.face_embedding != null` → `profile.face_enrollment_status != null`.
  2. Lines 649–652: the `invalid_embedding` regex block → **deleted** (no embedding param).
  3. Line 654: `profile.face_embedding = embedding` → derive status from `p_duplicate_similarity` (mirroring the RPC): `const status = (args?.p_duplicate_similarity >= 0.45 && args?.p_duplicate_subject !== studentId) ? 'pending_review' : 'enrolled'; profile.face_enrollment_status = status;`.
  4. Lines 705, 714, 721: `record_face_check` stub changes from "compute matched from p_embedding vs stored" to "read p_matched/p_distance/p_frame_hash directly" — **wait, the RPC no longer accepts p_matched.** The FakeSupabase stub must mirror the new RPC: it receives `p_subject`, `p_similarity`, `p_second_subject`, `p_second_similarity`, `p_frame` and **computes matched** the same way the SQL does (`p_subject = uid AND p_similarity >= 0.5 AND margin`). This is critical for route tests to work.
  5. Line 872: `profile.face_embedding = null` → `profile.face_enrollment_status = null; profile.face_deletion_pending = true;`.
  6. **NEW**: add `face_deletion_pending` to the mock's profile `Row` type (mirrors migration `0010`'s new column).
- **`src/app/api/face/__tests__/face-routes.test.ts`** — **REWRITE**:
  - Delete `embedding()` helper + `EMBEDDING_STR` constant.
  - `seedProfile`: `face_embedding: EMBEDDING_STR` → `face_enrollment_status: 'enrolled'`.
  - I2: sends 3 frames; mocks CompreFace `addSubjectExample` + `detect` + `recognize`. Asserts `face_enrollment_status = 'enrolled'`.
  - I3: frame validation (empty, too long, wrong count → 400).
  - I4: CompreFace mock returns `{ subject: uid, similarity: 0.9 }`. Assert `matched: true`.
  - I5/I5b/I5c: CompreFace mocks for match/mismatch.
  - I6/I6b/I6c: unchanged logic.
  - I20-ext: unchanged.
  - **New I-dup**: CompreFace returns a different subject with similarity 0.8 → `pending_review`.
  - **New I-margin**: two subjects with close similarities (0.55, 0.50) → no match (margin < 0.15).
  - **New I-compreface-down**: CompreFace mock throws → 503.
  - **New I-pose**: wrong yaw → 400.
  - **New I-health**: `/api/face/health` returns `{ available: true/false }`.
  - **New I-exempt**: exempt session → RPC short-circuits (CompreFace call still happens but RPC returns `matched:true, distance:null`).
  - `invalid_embedding` → `invalid_frame` in mapFaceError overrides.
- **`src/app/api/sessions/__tests__/face-session-routes.test.ts`** — **EDIT**:
  - Line 233: `seedProfile({ ..., face_embedding: null })` → `face_enrollment_status: null`.
  - Line 244: `seedProfile({ ..., face_embedding: "[1,2]" })` → `face_enrollment_status: 'enrolled'`.
  - Line 252: `expect(profile?.face_embedding).toBeNull()` → `expect(profile?.face_enrollment_status).toBeNull()`.
  - GET-envelope tests: ADD assertion that `body.face_enrollment_status` is present.

### Step 10 — Config + verification

- **`vitest.config.ts`**:
  - Remove `cosine.ts` coverage key (deleted).
  - Add `src/lib/face/server/compreface-client.ts` — 0-key (server I/O, route-tested).
  - `face-tracker.ts` stays 0-key. Other keys unchanged.
- **`package.json`**:
  - `verify:face` unchanged.
  - Add `"compreface:start": "docker compose up -d compreface-core compreface-api compreface-postgres"`, `"compreface:stop": "docker compose stop compreface-core compreface-api compreface-postgres"`, `"compreface:cleanup": "node scripts/compreface-cleanup.mjs"` (deletes CompreFace subjects for profiles with `face_deletion_pending = true`).
  - `@mediapipe/tasks-vision@1.0.1` stays (FaceLandmarker for blink).
- **`.github/workflows/`** — `ci.yml` EXISTS and already runs `verify:face` (`supabase start` + `db reset` then all `verify-*.mjs`). `verify:face` needs Supabase only — it never calls CompreFace (all RPC probes pass metadata directly); vitest/playwright use the mock (`COMPREFACE_MOCK_ENABLED=1`) and don't need Docker either.
- **`scripts/verify-quizzes.mjs`** — **EDIT**: update MED-3 probe (lines 418, 423, 433) — change `.select("id, full_name, face_embedding")` to `.select("id, full_name, face_enrollment_status")`; update the assertion from `!("face_embedding" in ...)` to `!("face_enrollment_status" in ...)` or re-think the probe (the status column is a non-sensitive string `'enrolled'`/`'pending_review'` — the MED-3 "biometric secrecy" concern may no longer apply to a status column; consider asserting the lecturer can't see `face_enrollment_status` OR keep the secrecy check since the status reveals enrollment state).
- **`scripts/verify-mediapipe.mjs`** — **EDIT**: remove `face_embedding.tflite` from the manifest. Keep `face_landmarker.task`.
- **`scripts/vendor-mediapipe.mjs`** — **EDIT**: remove `face_embedding.tflite` vendoring step.
- **`public/models/MANIFEST.json`** — **EDIT**: remove the `face_embedding.tflite` entry (currently a `{ missing: true }` marker).
- **`src/types/face.d.ts`** — **NO EDIT NEEDED** (contains only `unknown` ambient declarations; no `captureEmbedding` reference). The fake-tracker type change happens inside `e2e/fake-face-tracker.ts`.
- **`src/lib/types/aliases.ts`** — **NO MANUAL EDIT** (passthrough re-export; regeneration handles it).
- **`src/lib/types/database.ts`** — **REGENERATE** via `npm run gen:types`: drops `profiles.face_embedding`; adds `profiles.face_enrollment_status` + `profiles.face_deletion_pending`; adds `face_checks.frame_hash`; RPC signatures change (`enroll_face`, `record_face_check`).
- **`docs` updates:**
  - `PLAN_PHASE7.md` — add `⚠️ SUPERSEDED` banner at top pointing to this file.
  - `HANDOFF.md` — update §2 (face module list), §5 (deviation resolved), §10 (verify-mediapipe passes without missing marker).
  - `TESTING.md` — update: line 14 "cosine similarity" removed; §2.1 header changed; U-F1–U-F3 marked adapted; U-F4 changed; D11 description → `face_enrollment_status`; D28 → `face_enrollment_status`; add new test IDs (I-dup, I-margin, I-compreface-down, I-pose, I-health).
  - `PLAN.md` — §0 locked decisions (face stack = CompreFace); inline schema sample (line 31); verify route description (line 104).
  - `SECURITY_AUDIT.md` — add `SUPERSEDED` banner or update line 101 reference.
- **Verification matrix**:
  ```bash
  npm run lint && npm run typecheck && npx vitest run && npx vitest run --coverage
  node scripts/verify-security.mjs && node scripts/verify-classes.mjs && node scripts/verify-quizzes.mjs
  node scripts/verify-ai.mjs && node scripts/verify-sessions.mjs && node scripts/verify-face.mjs  # Supabase only — never calls CompreFace
  node scripts/verify-mediapipe.mjs
  npx playwright test && npm run build
  graphify update .
  ```

---

## 4. File-by-file migration matrix

| File | Action | Summary |
|---|---|---|
| `docker-compose.yml` | **NEW** | CompreFace services (loopback-bound ports; named volumes). |
| `docs/COMPREFACE_SETUP.md` | **NEW** | Setup guide. |
| `.env.local.example` | **EDIT** | Add `COMPREFACE_*` vars; remove stale `FACE_MATCH_THRESHOLD`. |
| `.gitignore` | **EDIT** | Add `/compreface-data/` (defensive). |
| `supabase/config.toml` | **NO CHANGE** | No port conflict. |
| `docs/PLAN_PHASE7.md` | **EDIT** | `⚠️ SUPERSEDED` banner. |
| `docs/HANDOFF.md` | **EDIT** | §2, §5, §10 updated. |
| `docs/TESTING.md` | **EDIT** | U-F1–U-F4 adapted; D11/D28 updated; new test IDs. |
| `docs/PLAN.md` | **EDIT** | §0 locked decisions; inline samples. |
| `docs/SECURITY_AUDIT.md` | **EDIT** | Update `face_embedding` reference. |
| `supabase/migrations/0010_compreface.sql` | **NEW** | Drop `face_embedding` + old guard; add `face_enrollment_status` + `face_deletion_pending` + `frame_hash` + new guard; redefine `enroll_face` + `record_face_check`; update `revoke_face_consent`; add `pgcrypto`; drop `vector` extension. |
| `src/lib/types/database.ts` | **REGENERATE** | `gen:types` — RPC signatures + column changes. |
| `src/lib/types/aliases.ts` | **NO EDIT** | Passthrough re-export. |
| `src/lib/face/constants.ts` | **EDIT** | Remove embedding constants; add CompreFace/quality/body-size constants. |
| `src/lib/face/types.ts` | **EDIT** | `captureFrame`; remove `Embedding`/`FaceEmbeddingProvider`; add `FaceEnrollmentStatus`; update JSDoc. |
| `src/lib/face/cosine.ts` | **DELETE** | |
| `src/lib/face/cosine.test.ts` | **DELETE** | |
| `src/lib/face/schemas.ts` | **EDIT** | Frame schema; remove `serializeEmbedding`. |
| `src/lib/face/schemas.test.ts` | **EDIT** | Frame validation tests. |
| `src/lib/face/liveness.ts` | **UNCHANGED** | |
| `src/lib/face/liveness.test.ts` | **UNCHANGED** | |
| `src/lib/face/streak.ts` | **UNCHANGED** | |
| `src/lib/face/streak.test.ts` | **UNCHANGED** | |
| `src/lib/face/recovery.ts` | **UNCHANGED** | |
| `src/lib/face/recovery.test.ts` | **UNCHANGED** | |
| `src/lib/face/cadence.ts` | **UNCHANGED** | |
| `src/lib/face/cadence.test.ts` | **UNCHANGED** | |
| `src/lib/face/outcome.ts` | **EDIT** | Add `duplicate_detected`. |
| `src/lib/face/outcome.test.ts` | **EDIT** | Add `duplicate_detected` test. |
| `src/lib/face/rpc-mapping.ts` | **EDIT** | Add `duplicate_detected`→409, `compreface_unavailable`→503, `invalid_frame`→400, `pose_invalid`→400. |
| `src/lib/face/rpc-mapping.test.ts` | **EDIT** | Add new mapping tests. |
| `src/lib/face/fake-seam.ts` | **EDIT** | `captureFrame` shape validation + JSDoc. |
| `src/lib/face/fake-seam.test.ts` | **EDIT** | `captureFrame` shape test. |
| `src/lib/face/face-tracker.ts` | **REWRITE** | Remove embedder; add `captureFrame` + quality gate. |
| `src/lib/face/server/compreface-client.ts` | **NEW** | CompreFace REST client (server-only, `import "server-only"`). |
| `src/lib/vision/camera.ts` | **UNCHANGED** | |
| `src/lib/vision/camera.test.ts` | **UNCHANGED** | |
| `src/lib/gestures/hand-tracker.ts` | **UNCHANGED** | |
| `src/lib/classes/roster.ts` | **EDIT** | Comment-only: `face_embedding` → `face_enrollment_status`. |
| `src/app/api/face/enroll/route.ts` | **REWRITE** | 3-frame + CompreFace + duplicate + pose. |
| `src/app/api/face/verify/route.ts` | **REWRITE** | Frame → CompreFace → metadata → RPC. |
| `src/app/api/face/consent/route.ts` | **EDIT** | Revoke: RPC first, then CompreFace delete; update JSDoc. |
| `src/app/api/face/self-recover/route.ts` | **UNCHANGED** | |
| `src/app/api/face/unlock/route.ts` | **UNCHANGED** | |
| `src/app/api/face/health/route.ts` | **NEW** | CompreFace health probe (GET, no CSRF). |
| `src/app/api/sessions/[id]/exempt-face/route.ts` | **UNCHANGED** | |
| `src/app/api/sessions/[id]/pause/route.ts` | **UNCHANGED** | |
| `src/app/api/sessions/[id]/face-unavailable/route.ts` | **UNCHANGED** | |
| `src/app/api/sessions/[id]/route.ts` (GET) | **EDIT** | `face_enrollment_status` in envelope. |
| `src/app/api/quizzes/__tests__/fake-supabase.ts` | **EDIT** | 6 touchpoints (ever-enrolled, regex block, enroll stub, record_face_check stub, revoke stub, `face_deletion_pending` Row type). |
| `src/app/api/face/__tests__/face-routes.test.ts` | **REWRITE** | CompreFace mocks; frame-based tests; new test IDs. |
| `src/app/api/sessions/__tests__/face-session-routes.test.ts` | **EDIT** | `face_enrollment_status` seeding/assertions; GET envelope. |
| `src/components/face/use-face-tracker.ts` | **EDIT** | Boot: FaceLandmarker + CompreFace health probe. |
| `src/components/face/use-face-pipeline.ts` | **EDIT** | 8 concrete edit sites (captureFrame, frame sentinel, POST body). |
| `src/components/face/face-verifier.tsx` | **UNCHANGED** | |
| `src/components/face/face-gate.tsx` | **UNCHANGED** | |
| `src/app/(student)/student/face/enroll/face-enroll-client.tsx` | **REWRITE** | 3-angle capture wizard. |
| `src/app/(student)/student/face/enroll/page.tsx` (RSC) | **EDIT** | SELECT + `enrolled` derivation (2 lines). |
| `src/app/play/[sessionId]/page.tsx` (RSC) | **EDIT** | SELECT + cast + `enrolled` derivation (3 lines). |
| `src/app/(student)/student/quizzes/page.tsx` (RSC) | **EDIT** | SELECT + `enrolled` derivation (2 lines). |
| `src/components/quiz/play-client.tsx` | **EDIT** | `enrolled` prop source. |
| `src/app/(student)/student/student-quizzes-client.tsx` | **EDIT** | Enroll banner. |
| `src/components/gestures/gesture-layer.tsx` | **UNCHANGED** | |
| `src/types/face.d.ts` | **NO EDIT** | Values stay `unknown`. (JSDoc ref to `fake-face-embedder.ts` becomes stale but is non-functional; optionally update.) |
| `e2e/fake-face-embedder.ts` → `e2e/fake-face-tracker.ts` | **RENAME + REWRITE** | `captureFrame`; frame markers. |
| `e2e/helpers.ts` | **EDIT** | 3-angle enroll; fake-tracker import. |
| `e2e/e3-face-enroll.spec.ts` | **EDIT** | 3-frame enroll; E3b body change. |
| `e2e/e6-pause-flag.spec.ts` | **UNCHANGED** | Transitively affected by helpers. |
| `e2e/e7-unlock.spec.ts` | **UNCHANGED** | Transitively affected. |
| `e2e/e12-continuous.spec.ts` | **UNCHANGED** | Transitively affected. |
| `e2e/e9b-hand-loss.spec.ts` | **UNCHANGED** | Transitively affected. |
| `playwright.config.ts` | **EDIT** | Add `COMPREFACE_*` env vars. |
| `scripts/verify-face.mjs` | **EDIT** | New RPC signatures; remove embedding probes; add column-level-privilege probe. |
| `scripts/verify-quizzes.mjs` | **EDIT** | MED-3 probe: `face_embedding` → `face_enrollment_status` (lines 418, 423, 433). |
| `scripts/verify-mediapipe.mjs` | **EDIT** | Remove `face_embedding.tflite`. |
| `scripts/vendor-mediapipe.mjs` | **EDIT** | Remove `face_embedding.tflite` references (lines 18, 46, 193, 200, 203, 257, 288). |
| `public/models/MANIFEST.json` | **EDIT** | Remove `face_embedding.tflite` entry. |
| `vitest.config.ts` | **EDIT** | Remove `cosine.ts` key; add `compreface-client.ts` 0-key. |
| `package.json` | **EDIT** | Add `compreface:start`/`compreface:stop` scripts. |

---

## 5. Test migration matrix

| Test ID | Current | After migration |
|---|---|---|
| U-F1 (cosine identical) | `cosine.test.ts` | **DELETED**. |
| U-F2 (cosine orthogonal) | `cosine.test.ts` | **DELETED**. |
| U-F3 (match boundary) | `cosine.test.ts` | **REPLACED** — route test: CompreFace mock returns similarity at boundary; assert `matched` flips at `FACE_SIMILARITY_MIN`. |
| U-F4 (embedding validation) | `schemas.test.ts` | **REPLACED** — frame schema validation. |
| U-F4b (serializeEmbedding) | `schemas.test.ts` | **DELETED**. |
| U-F5 (blink) | `liveness.test.ts` | **UNCHANGED**. |
| U-F6 (FLAT 3-in-5) | `streak.test.ts` | **UNCHANGED**. |
| U-F7/U-F7b/U-F7c | `recovery.test.ts` + `streak.test.ts` | **UNCHANGED**. |
| I1–I6c, I20 | `face-routes.test.ts` | **REWRITTEN** (CompreFace mocks). |
| I22 (cadence) | `cadence.test.ts` | **UNCHANGED**. |
| D10 | `verify-face.mjs` | **UNCHANGED**. |
| D11 | `verify-face.mjs` | **EDITED** — `face_enrollment_status`; new RPC signature. |
| D13 | `verify-face.mjs` | **UNCHANGED**. |
| D14 | `verify-face.mjs` | **EDITED** — new params. |
| E3/E3b/E13 | `e3-face-enroll.spec.ts` | **EDITED** — 3-frame enroll. |
| E6/E7/E12/E9b | E2E specs | **UNCHANGED** (transitively affected). |
| **NEW** I-dup | `face-routes.test.ts` | Duplicate detection. |
| **NEW** I-margin | `face-routes.test.ts` | Margin rule. |
| **NEW** I-compreface-down | `face-routes.test.ts` | CompreFace unavailable → 503. |
| **NEW** I-pose | `face-routes.test.ts` | Pose validation. |
| **NEW** I-health | `face-routes.test.ts` | Health probe. |
| **NEW** I-exempt | `face-routes.test.ts` | Exempt short-circuit. |
| **NEW** D-col-priv | `verify-face.mjs` | Direct PATCH `face_enrollment_status` → blocked. |

---

## 6. Robustness / edge-case matrix

| Area | Guard | Change? |
|---|---|---|
| Student forges `matched=true` via PostgREST | RPC computes `matched` from CompreFace metadata + SQL constants; no `p_matched` param. A direct RPC call must provide valid `p_subject`/`p_similarity` — `p_subject = auth.uid()` is required for a pass. | **Adapted** (enforcement stays in RPC). |
| Student self-sets `enrolled` via PostgREST | GUC guard on `face_enrollment_status` + column-level `REVOKE UPDATE`. | **NEW guard** (replaces the old embedding guard). |
| Direct PATCH `profiles.face_enrollment_status` | Column-level privilege revoked; guard trigger blocks. | **NEW**. |
| Replayed verify | Nonce checked+rotated; `frame_hash` (RPC-computed `sha256(p_frame)`) advisory. | **Adapted** (hash is server-computed). |
| Window laundering | FLAT last-5. | **Unchanged**. |
| Concurrent verifies | `for update` serializes; client `verifyLock` + rate limit (10/min). | **Adapted** (lower rate limit). |
| Threshold/grace forgery | SQL constants in RPC. | **Unchanged** (stays in RPC). |
| Wrong dims / NaN / empty | `frameSchema` (non-empty string, max size) → 400/413. | **Adapted**. |
| Verify on completed/non-assessment/closed/non-enrolled/revoked | Typed errors. | **Unchanged**. |
| Gate bypass by reload | `hasFaceChecks` seeding. | **Unchanged**. |
| Answer-409 stale mirror | Client GETs real status. | **Unchanged**. |
| Single fail after unlock | FLAT window. | **Unchanged**. |
| Submit while paused/flagged | Paused submits; flagged rejected. | **Unchanged**. |
| `submitNow` failure branches | `phaseRef.current`. | **Unchanged**. |
| Timer through gate/recovery/paused | Server-anchored. | **Unchanged**. |
| Persistent camera-null mid-quiz | `captureFrame` returns null → sentinel frame → CompreFace returns no subject → fail row. | **Adapted**. |
| Tab-hide | Cadence paused; catch-up verify. | **Unchanged**. |
| Camera/face boot failure | `FACE_BOOT_TIMEOUT_MS` + CompreFace health probe → `unavailable`. | **Adapted**. |
| Gesture stop kills face/tracks | `camera.ts` sole `track.stop()`. | **Unchanged**. |
| StrictMode / unmount | `disposedRef`/`bootIdRef`. | **Unchanged**. |
| Verify response lost after rotation | `nonce_mismatch` → refetch + retry once. | **Unchanged**. |
| Blink timeout | `LIVENESS_TIMEOUT_MS`. | **Unchanged**. |
| Flagged student waits forever | Poll (8s). | **Unchanged**. |
| Pause/recover loop abuse | FLAT window. | **Unchanged**. |
| Re-shown hand answers server-paused session | `sessionPaused` gate. | **Unchanged**. |
| Children-mount churn | Children suppressed only in `'gate'`. | **Unchanged**. |
| Tracker released too early | Only on `submitted`/`dead`/unmount. | **Unchanged**. |
| Mid-session revoke | Sessions flagged; re-consent doesn't un-flag. | **Unchanged**. |
| `face_checks` growth | Index `(session_id, checked_at)`. | **Unchanged**. |
| Practice / lecturer sessions | Face `off`. | **Unchanged**. |
| CompreFace Docker down mid-quiz | Route returns 503 → pipeline treats as fail → FLAT window → eventually `flagged` (or `unavailable` if health probe fails at boot). | **NEW**. |
| CompreFace Docker down at consent revoke | `face_deletion_pending = true`; retry at next-enroll or manual `compreface:cleanup` script. CompreFace `DELETE` 404 treated as success (idempotent). | **NEW**. |
| CompreFace subject deleted out-of-band (admin UI/crash) | DB says `enrolled` but CompreFace has no subject → verify fails → FLAT window → `flagged`. Fails safe; lecturer exempts. No auto-reconciliation for MVP. | **NEW**. |
| `pending_review` blocks assessment | Gate treats `!== 'enrolled'` as `not_enrolled`; lecturer `reject_face_enrollment` RPC clears status to `null` → student re-enrolls. | **NEW**. |
| Duplicate enrollment | CompreFace `/recognize` before enrollment → `pending_review`. | **NEW**. |
| Lookalike false accept | Margin rule (top minus second-best ≥ margin, in RPC). | **NEW**. |
| CompreFace port exposure (LAN) | Ports bound to `127.0.0.1` only. | **NEW**. |
| TOCTOU (CompreFace call vs RPC) | RPC re-checks all state (consent/mode/quiz-live/exempt/status) at T2; CompreFace verdict is best-effort at T1. Client `verifyLock` bounds concurrency. | **NEW (documented)**. |
| Frame body-size DoS | `MAX_FRAME_BASE64_CHARS` check → 413; rate limit 10/min. | **NEW**. |
| E2E mock leaks to production | Two-flag guard (`NODE_ENV !== 'production'` AND `COMPREFACE_MOCK_ENABLED === '1'`). | **NEW**. |

---

## 7. Risks / open items

- **⚠️ Residual risk: direct RPC call without CompreFace.** A student can call `record_face_check` via PostgREST with forged `p_subject = auth.uid()` + `p_similarity = 0.9`. The RPC will compute `matched = true`. A student can also call `enroll_face` directly to set `face_enrollment_status = 'enrolled'` without a real CompreFace subject. Combined, a student can bypass CompreFace entirely via two PostgREST calls. This is the SAME residual risk as the current design (a student could forge an embedding that matches their stored one). The mitigation is the FLAT window (continuous verify), liveness (blink), and lecturer review — same as before. **The `p_subject = auth.uid()` check ensures the student can only pass as themselves** (not impersonate someone else). An attacker who can call PostgREST directly can already do anything the student themselves could do.
- **⚠️ CompreFace API key security.** The key is a shared application secret — anyone with it has full CRUD on all CompreFace subjects. The key is stored in `.env.local` (gitignored) or Vercel env vars (server-only, never shipped to the client). **Risk:** if the key leaks, an attacker can enumerate all enrolled subject names (= all `auth.uid()` values — a user-ID oracle) and poison/delete subjects. **Mitigation:** (a) treat the key as a secret (never commit, rotate if compromised); (b) `docs/COMPREFACE_SETUP.md` must mandate changing the CompreFace admin UI default password (`admin`/`admin`) as a required step; (c) the CompreFace admin UI is loopback-only (`127.0.0.1:8000`); (d) consider HMAC-ing `auth.uid()` with a server-side pepper before using it as the CompreFace subject name (post-MVP — would prevent user-ID enumeration if the key leaks). For MVP: `auth.uid()` as subject name is acceptable (the key is server-only and loopback-bound).
- **⚠️ Consent-revoke CompreFace deletion retry.** The `face_deletion_pending` flag is set when CompreFace is down at revoke time. **Retry mechanism:** the enroll route checks `face_deletion_pending` on the profile at enrollment time and deletes the old CompreFace subject before creating a new one. Additionally, a manual cleanup script (`npm run compreface:cleanup`) deletes all `face_deletion_pending = true` subjects. The retry is best-effort with no bounded SLA for MVP (documented as a known gap; biometric data may persist in CompreFace until the next enroll or manual cleanup). CompreFace `DELETE` returning 404 (subject already gone) is treated as success (idempotent).
- **⚠️ CompreFace subject out-of-band deletion.** If a subject is deleted via the CompreFace admin UI or a crash, the DB still says `enrolled`. Verify calls will fail (no CompreFace subject → `matched = false` → FLAT window → eventually `flagged`). This fails safe (student can't pass) but incorrectly penalizes the student. **Mitigation:** the lecturer sees `flagged` + can exempt. No automatic reconciliation for MVP (documented as a known gap).
- **⚠️ `pending_review → rejected` transition.** A student with `face_enrollment_status = 'pending_review'` (duplicate detected) cannot enroll mid-session (ever-enrolled gate). If the lecturer **rejects** the pending review, the status transitions to `null` (via a new lecturer-only RPC `reject_face_enrollment` or the existing consent-revoke path). The student can then re-enroll. The `pending_review` state blocks the assessment gate (the gate treats `face_enrollment_status !== 'enrolled'` as `not_enrolled`). **New RPC:** `reject_face_enrollment(p_student_id uuid)` — lecturer-only, sets `face_enrollment_status = null`, audits `face_enroll_rejected`. Added to migration `0010`.
- **⚠️ CompreFace Docker image size (~2 GB).** Pre-pull before demo day.
- **⚠️ E2E must NOT require CompreFace Docker.** The `COMPREFACE_MOCK_ENABLED=1` env + frame-marker inspection handles all E2E.
- **⚠️ CompreFace subject lifecycle.** If a student is deleted from `auth.users`, their CompreFace subject is NOT automatically deleted. Mitigation: consent-revoke flow + cleanup script. Document as a known gap.
- **⚠️ Consent revoke + CompreFace deletion is not atomic across two systems.** `face_deletion_pending` + retry mechanism mitigates. The RPC-first ordering ensures the DB is consistent (student unenrolled) even if CompreFace deletion fails.
- **⚠️ Exempt sessions waste a CompreFace call.** The route calls CompreFace before the RPC's exempt short-circuit. Acceptable (exempt is rare). Alternative: pre-fetch session status (adds latency). Decision: accept the waste.
- **Threshold calibration.** `FACE_SIMILARITY_MIN`, `FACE_MARGIN_MIN`, `FACE_SUSPICION_MIN` are starting values. Stress test (§8) calibrates them.
- **`pgvector` extension removal.** Safe — only `profiles.face_embedding` used it. Migration step order pinned (drop column → drop guard → redefine RPCs → drop extension).
- **CSP/Permissions-Policy (P9):** still deferred.

---

## 8. Stress test plan

High priority:
- [ ] False rejects on real students — enroll 5–10 volunteers, verify a week later.
- [ ] Concurrent load — ~40 parallel recognize calls, measure latency.
- [ ] Lookalike false accepts — calibrate `FACE_MARGIN_MIN`.
- [ ] Bad enrollment poisoning — bad frame → quality gate rejects.

Medium priority:
- [ ] Threshold grey zone — retry band consideration.
- [ ] Roster mismatch — verified face not in class → rejection.
- [ ] Re-enroll/delete flow — old CompreFace examples deleted.
- [ ] Two faces in frame — CompreFace returns multiple → route rejects.

Lower priority:
- [ ] Spoofing sanity — phone photo test; blink-check effectiveness.
- [ ] Container failure mid-quiz — kill CompreFace; fail-open to "unverified."
- [ ] LAN latency — verify over classroom WiFi (loopback only — N/A for CompreFace; the route calls it over loopback).

---

## 9. Gate traceability

| Gate | Proven by | Change? |
|---|---|---|
| U-F1/U-F2 | — | **DELETED**. |
| U-F4b (serializeEmbedding) | — | **DELETED**. |
| U-F3 | Route test with CompreFace mock | **REPLACED**. |
| U-F4 | `schemas.test.ts` | **REPLACED**. |
| U-F5 | `liveness.test.ts` | **Unchanged**. |
| U-F6 | `streak.test.ts` | **Unchanged**. |
| U-F7/U-F7b/U-F7c | `recovery.test.ts` + `streak.test.ts` | **Unchanged**. |
| D10/D11/D13/D14 | `verify-face.mjs` | **Edited**. |
| D-col-priv (NEW) | `verify-face.mjs` | **NEW**. |
| I1–I6c, I20 | `face-routes.test.ts` | **Rewritten**. |
| I-dup/I-margin/I-compreface-down/I-pose/I-health/I-exempt (NEW) | `face-routes.test.ts` | **NEW**. |
| I22 | `cadence.test.ts` | **Unchanged**. |
| Outcome mapping | `outcome.test.ts` | **Edited**. |
| RPC mapping | `rpc-mapping.test.ts` | **Edited**. |
| Camera refcount | `camera.test.ts` | **Unchanged**. |
| E3/E3b/E13 | E2E specs | **Edited** (3-frame enroll). |
| E6/E7/E12/E9b | E2E specs | **Unchanged** (transitively affected). |
| Earlier gates | verify-* + vitest + Playwright + build | **Unchanged**. |
| Coverage | per-file thresholds | **Edited**. |
| Asset integrity | `verify-mediapipe.mjs` | **Edited**. |

---

## 10. Next steps

- [ ] Review + approve this plan.
- [ ] Step 1: `docker-compose.yml` + CompreFace + `COMPREFACE_SETUP.md`.
- [ ] Step 2: Migration `0010_compreface.sql` + types + `verify-face.mjs`.
- [ ] Step 3: `lib/face` pure-logic changes.
- [ ] Step 4: `face-tracker.ts` rewrite.
- [ ] Step 5: `compreface-client.ts`.
- [ ] Step 6: API route rewrites.
- [ ] Step 7: UI changes (3 RSC pages + enroll wizard + pipeline).
- [ ] Step 8: E2E (fake-tracker rename, CompreFace mock, config).
- [ ] Step 9: FakeSupabase + route test rewrites.
- [ ] Step 10: Config + verification matrix.
- [ ] Audit→fix loop.

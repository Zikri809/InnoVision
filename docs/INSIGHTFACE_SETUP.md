# InsightFace Setup (Face Recognition)

The face pipeline runs on a **single stateless sidecar**: FastAPI + ONNX
Runtime with the `buffalo_l` model pack (SCRFD detection + 3D-68 landmark
pose + ArcFace recognition). Enrolled embeddings live in **Supabase**
(`profile_face_samples`, migration 0039) — the sidecar holds no data, has no
admin UI, and needs **no API key**.

## Fresh clone

```bash
docker compose up -d insightface-service   # first build downloads a ~275 MB model zip + wheels
curl http://127.0.0.1:8000/health          # {"status":"ok","model":"buffalo_l",...}
npm run dev
```

That's it. There is no browser signup, no service creation, no key copying
(CompreFace's old bootstrap is gone).

- The sidecar binds `127.0.0.1:8000` only — classroom WiFi can never reach it.
- `FACE_SIDECAR_TOKEN` is an optional shared secret against bind drift;
  **set a real value for production deployments**. NOTE: `docker compose`
  reads `.env` (project root) or the shell environment — NOT `.env.local` —
  so either `export FACE_SIDECAR_TOKEN=…` before `docker compose up` or put
  it in a project-root `.env`. The Next.js side reads it from `.env.local`
  as usual (both sides must match). The token guards `/extract` only;
  `/health` is intentionally unauthenticated (leaks only the model name).
- Expect **~350–500 MB RAM** for the sidecar (one worker; models restricted
  to detection + landmark + recognition). Budget accordingly if you also run
  the GPU-less glm-ocr vLLM mode (~3–4 GB) on a 16 GB machine.
- Model weights are baked into the image at build time — the container never
  downloads anything at runtime.

## E2E / unit tests (no Docker)

The Playwright suite runs the **production build** with the two-flag mock
seam (`NEXT_PUBLIC_E2E_FAKE_SEAM=1` + `FACE_MOCK_ENABLED=1`, set by
`playwright.config.ts`'s webServer env). Marker frames never reach the
sidecar; mock enrollments insert real (uid-derived, deterministic) vectors
through the real `enroll_face` RPC. See `docs/TESTING.md` §1.

## Real-model smoke (optional, opt-in)

```bash
npm run face:start
FACE_SMOKE=1 npm run test:face-smoke
```

Validates `/health`, 512-d unit-norm extraction, same-image cosine ≥ 0.9,
impostor cosine < 0.5 against `e2e/fixtures/faces/*.jpg` (synthetic faces).

## Ops scripts

| Script | What it does |
|---|---|
| `npm run face:start` / `face:stop` | start/stop the sidecar container |
| `npm run face:reset` | wipe `profile_face_samples` + face checks + consent flags (dev DB only) |
| `npm run verify:face` | authoritative RPC/RLS/security harness against local Supabase |
| `npm run face:report` | threshold report over recorded `face_checks` |

## Cutover & rollback

- **Cutover:** no profiles rows are rewritten by migration 0039. Pre-migration
  enrollees have empty baselines; the pre-start gate (play + quizzes pages)
  sends them to re-enroll instead of failing verifies mid-quiz. Deploy
  outside quiz hours.
- **Rollback:** 0039 is forward-only. Before cutover take `supabase db dump
  -f pre-insightface.sql` + a git tag; rollback = stop the sidecar (port
  8000 conflict), revert code, restore the dump, restart CompreFace. Keep the
  CompreFace images/volumes during the stability window.
- **Disposal:** the old `compreface-postgres-data` volume contains student
  biometric embeddings AND raw enrollment images. After a green stability
  window (≥14 days), dispose deliberately: `docker compose down -v` (or
  `docker volume rm innovision_compreface-postgres-data
  innovision_compreface-api-logs`). This is a security step, not
  housekeeping — record it.

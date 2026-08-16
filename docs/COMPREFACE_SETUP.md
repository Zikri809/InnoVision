# CompreFace Setup Guide

> Part of the Phase 7 CompreFace migration (`docs/PLAN_PHASE7_COMPREFACE_MIGRATION.md`). CompreFace is the self-hosted face recognition backend — it runs in Docker alongside Supabase, and the Next.js API routes call it over loopback only.

## 1. Prereqs

- Docker Desktop running (already required for local Supabase via `supabase start`).

## 2. Start CompreFace

```bash
# Pull + start all three services (first run pulls ~2 GB; cached after).
docker compose up -d compreface-postgres compreface-core compreface-api
# Or the npm shorthand:
npm run compreface:start
```

Stop:

```bash
docker compose stop compreface-core compreface-api compreface-postgres
# Or: npm run compreface:stop
```

## 3. Create a Recognition application + copy the API key (one-time)

1. Open the admin UI: `http://localhost:8000` (loopback only — not reachable from the LAN).
2. **IMPORTANT: change the default admin password** (`admin` / `admin`) before doing anything else. The admin UI gives full CRUD over all subjects; anyone with localhost access must not be able to log in with defaults.
3. Create a **Recognition** application.
4. Copy the application's **API key** from the app detail page.
5. Set it in your server env (`.env.local`):

```env
COMPREFACE_BASE_URL=http://localhost:8000
COMPREFACE_API_KEY=<the-key>
COMPREFACE_MOCK_ENABLED=0
```

## 4. Verify

```bash
curl http://localhost:8000/api/v1/health
# {"status":"UP"} (or similar) when the API is healthy.
```

## 5. Security notes

- CompreFace's ports are bound to `127.0.0.1` only (see `docker-compose.yml`). The Next.js routes talk to it over loopback — classroom WiFi cannot reach it.
- `COMPREFACE_API_KEY` is a **shared application secret**: anyone with it has full CRUD on all subjects (enroll a face under any subject name, delete any subject). Never ship it to the client; never commit it.
- The key is per-application, not per-user. All user isolation happens in the Next.js routes + Postgres RLS.
- Biometric data lives only in the CompreFace Postgres named volume (`compreface-postgres-data`). It is never committed to the repo.

## 6. Test / mock mode

E2E and unit tests do NOT require a running CompreFace container. Set:

```env
COMPREFACE_MOCK_ENABLED=1
```

The Next.js routes then short-circuit the CompreFace call when the request frame carries the `FAKE_FRAME_MATCH` / `FAKE_FRAME_MISMATCH` markers produced by the E2E fake tracker. This is guarded by `NODE_ENV !== "production"` AND `COMPREFACE_MOCK_ENABLED === "1"` — it cannot activate in a real deployment.
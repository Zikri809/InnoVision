# CompreFace Setup Guide

> Part of the Phase 7 CompreFace migration (`docs/PLAN_PHASE7_COMPREFACE_MIGRATION.md`). CompreFace is the self-hosted face recognition backend — it runs in Docker alongside Supabase, and the Next.js API routes call it over loopback only.

## 1. Prereqs

- Docker Desktop running (already required for local Supabase via `supabase start`).

## 2. Start CompreFace

```bash
# Pull + start all five services (first run pulls ~2 GB; cached after).
docker compose up -d
# Or the npm shorthand:
npm run compreface:start
```

The stack mirrors the official `exadel-inc/CompreFace` 1.2.0 layout, which split the
admin engine and the web UI out of the inference API:

| Service             | Image                        | Role                                               |
|---------------------|------------------------------|----------------------------------------------------|
| `compreface-postgres` | `postgres:12`              | CompreFace DB (named volume — biometrics, never committed) |
| `compreface-core`   | `exadel/compreface-core:1.2.0` | ML workers (internal only)                     |
| `compreface-api`    | `exadel/compreface-api:1.2.0`  | recognition /verify /detect engine (internal only) |
| `compreface-admin`  | `exadel/compreface-admin:1.2.0` | admin REST backend (internal only)             |
| `compreface-fe`     | `exadel/compreface-fe:1.2.0`   | nginx — admin UI + `/api/v1` proxy; the ONLY published port `127.0.0.1:8000:80` |

Stop:

```bash
docker compose stop
# Or: npm run compreface:stop
```

## 3. Create the admin account + a Recognition application (one-time)

1. Open the admin UI: `http://localhost:8000` (loopback only — not reachable from the LAN).
   - **Browser note:** use a plain window / incognito, NOT the browser profile that is logged
     into the app on `localhost:3000` — the app's Supabase auth cookies (path `/` on
     `localhost`) are also sent to `localhost:8000` and make nginx abort requests with
     `400 Request Header Or Cookie Too Large`.
2. CompreFace **1.2.0 has no default `admin`/`admin` login.** First run shows a **Sign Up**
   form — create the admin account (name + email + password). There is nothing to change
   "from defaults"; choose a strong password at creation time.
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
# health now requires the API key (the previous no-header curl returns 400)
curl -H "x-api-key: $COMPREFACE_API_KEY" http://localhost:8000/api/v1/health
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
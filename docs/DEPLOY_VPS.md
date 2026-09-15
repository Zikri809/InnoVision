# Deploying InnoVision to a vCPU VPS — operator runbook

> **Status:** PROCEDURE — the commands are real and copy-pasteable; the values
> you must fill in are marked `<…>`.
> **Date:** 2026-09-14.
> **Design:** `docs/PLAN_VPS_DEPLOYMENT.md` (Target B, §B1–§B3, gates S1–S6 /
> O1–O5 / G1–G10). This file is the *how* that plan §10.1 found missing — read
> the plan for the *why*.
> **Verified against:** `Dockerfile`, `docker-compose.yml`, `Caddyfile`,
> `next.config.ts`, `src/lib/ai/*`, `src/lib/request-ip.ts`,
> `src/lib/prod-guards.ts`, `src/instrumentation.ts`, `scripts/*`,
> `supabase/migrations/*` at commit state 2026-09-14.
>
> **⚠️ Every UNVERIFIED item is marked as such.** This deployment has never been
> executed end to end on a VPS: the image has not been built there, the schema
> push has not been run against the hosted project from this procedure, and the
> backup round-trip has not been rehearsed. Where a step can *silently succeed
> while doing nothing*, it says so.

> **AUTOMATED PIPELINE — read [`docs/DEPLOY_CICD.md`](./DEPLOY_CICD.md) first if
> you want `git push` to deploy.** That file covers the CI → GHCR → VPS
> pipeline: build after CI passes, SOPS+age secrets, the SSH rollout, and
> rollback. This file remains the *host* runbook — Supabase project setup,
> schema push, DNS, backups, cutover — and the reference for working on the box
> directly when the pipeline fails.
>
> **Two topology changes this runbook predates:**
> 1. **The host runs NGINX on :80/:443**, so §7's Caddy section does not apply.
>    Use `deploy/nginx/innovision.conf` for the site config. The compose `caddy`
>    service is now profile-gated (`profiles: ["tls"]`), so a bare
>    `docker compose up -d` can no longer start it into a port conflict with
>    nginx — that failure mode was a crash-looping Caddy beside a healthy stack,
>    which reads as "nothing is wrong" until you check the restart counter.
> 2. **The images are built in CI and pulled from GHCR**, not built on the VPS.
>    §6's `docker compose build app` still works for a local image, but the
>    deployed path sets `APP_IMAGE`/`INSIGHTFACE_IMAGE` in the project-root
>    `.env` and runs `docker compose pull`. See `COSTS.md` §2.1 for why.

## Table of contents

1. [Prereqs + topology](#1-prereqs--topology)
2. [Supabase dashboard pass (B1)](#2-supabase-dashboard-pass-b1)
3. [Schema workflow (B1.9)](#3-schema-workflow-b19)
4. [VPS env (B1.8)](#4-vps-env-b18)
5. [`TRUSTED_PROXY_COUNT`](#5-trusted_proxy_count)
6. [Container bring-up (B3/O1)](#6-container-bring-up-b3o1)
7. [Caddy + TLS + firewall (B3.3)](#7-caddy--tls--firewall-b33)
8. [Tokens + kill switches (B3.2/B3.4/S1/S5)](#8-tokens--kill-switches-b32b34s1s5)
9. [Cutover (§7.5)](#9-cutover-75)
10. [Rollback — a REAL atomic restore (§7.5/O3)](#10-rollback--a-real-atomic-restore-75o3)
11. [Quotas (O2)](#11-quotas-o2)
12. [Verification (§6/O4)](#12-verification-6o4)
13. [Failure-mode quick reference](#13-failure-mode-quick-reference)

---

## 1. Prereqs + topology

### 1.1 What runs where

```
Student/lecturer browsers (public origin, HTTPS)
  │
  ▼
VPS (vCPU only, no GPU, Ubuntu LTS, Docker + compose plugin)
  ├─ caddy        :80/:443 → reverse_proxy app:3000   (TLS + HTTP→HTTPS)
  ├─ app          Next.js standalone image, publishes 127.0.0.1:3000 ONLY
  └─ insightface-service  publishes 127.0.0.1:8000 ONLY
  ✗ glm-ocr       NOT SCHEDULED — profile-gated (`profiles: ["gpu"]`)
Supabase HOSTED free-tier   https://<project-ref>.supabase.co
Z.ai PaaS API               https://api.z.ai/api/paas/v4   (server-side only)
TinyFish Search/Fetch       free tier, server-side, unchanged
kenari.id AI gateway        `AI_BASE_URL`, server-side, unchanged
```

**Why the vLLM container is not scheduled here.** `glm-ocr` carries
`profiles: ["gpu"]` in `docker-compose.yml`, so a bare `docker compose up`
skips it. Two independent reasons it must stay off this host: (a) the service
declares an NVIDIA device reservation, which fails at **create** time without
the toolkit; (b) the CPU fallback wants `mem_limit: 16g` / `cpus: "8.0"` to
deliver ~30 s/page, which is not a usable OCR engine at classroom scale. GLM-OCR
runs on the **Z.ai API** here — `GLM_PROVIDER=remote` (see
`docs/GLM_OCR_SETUP.md` §6).

### 1.2 Host prereqs

| Item | Value | Notes |
|---|---|---|
| OS | Ubuntu LTS (22.04 / 24.04) | UNVERIFIED on other distros |
| Docker Engine + compose plugin | current | `docker compose version` must work (the files use the compose spec, not v1) |
| vCPU / RAM | ≥2 vCPU, ≥4 GB RAM, ≥20 GB disk | **UNVERIFIED / sizing owed.** Measured: the insightface image is 903 MB content / 2.65 GB on disk; the app image is estimated 0.2–0.4 GB (UNVERIFIED — never built on a vCPU host). InsightFace is `mem_limit: 2g`; the app is `mem_limit: 2g` (PLACEHOLDER — load-test before pinning). |
| DNS | An `A` (and/or `AAAA`) record for `<your-host>` → the VPS IP, **set before first Caddy start** | ACME validates over the public name |
| Ports | 80 + 443 open inbound; 22 for SSH | See §7.3 for the ufw order |
| Outbound | 443 to `<ref>.supabase.co`, `api.z.ai`, `api.search.tinyfish.ai`, `api.fetch.tinyfish.ai`, your `AI_BASE_URL` | No inbound access to any of them |

### 1.3 Repo checkout on the VPS

```bash
# Deploy as a non-root user with docker group membership.
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
su - deploy

git clone <your-repo-url> /home/deploy/innovision
cd /home/deploy/innovision
git rev-parse --short HEAD          # record this: it is your rollback anchor
```

> ⚠️ **The VPS env is a FRESH file — never a copy of the laptop's `.env.local`.**
> The laptop file carries `localhost:*` defaults for the sidecars and Supabase;
> copying it produces a stack that boots and then fails in ways that look like
> application bugs. The `--remote` overlay in `scripts/lib/remote-env.mjs`
> applies to **scripts only**, never to the running app. Build the file from the
> table in §4.

---

## 2. Supabase dashboard pass (B1)

Create the hosted project first (free tier), then work through this section.
**This is a dashboard-only pass — no repo change is needed for any of it.**

### 2.1 Auth URLs + redirect allowlist

Dashboard → **Authentication → URL Configuration**.

| Field | Value | Failure signature if wrong |
|---|---|---|
| **Site URL** | `https://<your-host>` | Emailed confirmation / recovery links point at `localhost:3000` or the Supabase default |
| **Redirect URLs** (allowlist) | `https://<your-host>/auth/callback` | GoTrue rejects the redirect: the user lands on an error page instead of `/auth/callback`; the server log shows a GoTrue callback error. **The `/auth/callback` entry is mandatory** — every email-confirmation, recovery and SSO return path goes through it. |

Add every origin you will actually serve, one line each, including any staging
host:

```
https://<your-host>/auth/callback
http://localhost:3000/auth/callback      # keep for laptop development
```

Also set **Authentication → URL Configuration → Site URL** to the **production**
origin, and keep `SITE_URL` in the app env identical to it (§4) — two different
"site URLs" is the classic source of "the email link goes to the wrong host".

### 2.2 Azure SSO (only if institutional SSO is used)

Dashboard → **Authentication → Providers → Azure**.

- Tenant-specific config (single-tenant app registration), so personal Microsoft
  accounts never reach the consent screen.
- The redirect URI registered in Entra must be
  `https://<project-ref>.supabase.co/auth/v1/callback` (Supabase's callback, not
  yours).
- Then set `INSTITUTIONAL_EMAIL_DOMAINS` in the app env (§4) — it is the second
  trust layer; an empty list disables the SSO button entirely.

If SSO is not used, leave the provider disabled and `INSTITUTIONAL_EMAIL_DOMAINS`
empty. UNVERIFIED: this runbook has not driven the Entra consent flow.

### 2.3 SMTP

Dashboard → **Authentication → Emails / SMTP**. The built-in sender is rate
limited and unsuitable for real traffic. Configure a real SMTP provider
(host/port/user/password/from-address), then send a test.

Local dev sets `enable_confirmations = false` (`supabase/config.toml`); the
hosted project's equivalent is **Authentication → Providers → Email →
"Confirm email"**.

### 2.4 `enable_confirmations` — the decision

| Choice | Consequence |
|---|---|
| **Confirm email ON** (recommended for production) | Real addresses only; signup needs a working SMTP path and a click. Every unconfirmed signup is a support ticket if SMTP is misconfigured. |
| **Confirm email OFF** | Zero friction; anyone can register an address they do not own. Acceptable only for a closed demo. |

Record the choice here: `enable_confirmations = ______`.
Whatever you choose, `double_confirm_changes = true` (local) maps to
**"Secure email change"** — leave it on.

### 2.5 Realtime for `notifications`

Dashboard → **Database → Replication** → enable the `notifications` table on the
`supabase_realtime` publication.

The migration (`0022_notifications.sql`) adds the table to the publication
inside a guarded block that tolerates failure — so a hosted project can end up
with **no realtime membership and no error**. The app degrades gracefully
(polling is the consistency backbone, `HEALTHY_POLL_MS = 60_000` /
`UNHEALTHY_POLL_MS = 20_000`), which is exactly why this is easy to miss: the
bell still works, just up to 60 s late. Enable it anyway.

### 2.6 Data API **Max Rows**

Dashboard → **Project Settings → API → Max Rows** (underlying PostgREST
`PGRST_DB_MAX_ROWS`; local is `max_rows = 1000` in `supabase/config.toml`).

The hosted default clamps large reads. A cross-quiz gradebook does
`.limit(20_000)`; if the hosted project keeps the default, that read is silently
clamped to 1,000 rows and the symptom is *missing rows in an export*, not an
error (`docs/audit/audit-3-ledger.md`, B-F7). Set it deliberately — 10,000 is a
reasonable starting point — and record the value: `Max Rows = ______`.

### 2.7 ⚠️ A `db push` CLOBBERS dashboard tuning — the re-apply checklist

This is by design, not a bug: migrations own the bucket definitions and
re-assert them.

- `0028_media.sql` re-tightens bucket `file_size_limit` / `allowed_mime_types`
  for `question-images` and `avatars`;
- `0007_ai_generation.sql` resets `quiz-sources` to 25 MB;
- anything you tuned in the dashboard that a migration also sets is reverted.

**After every `supabase db push`, re-apply and re-verify this list:**

- [ ] Data API **Max Rows** (§2.6)
- [ ] Storage bucket size limits / allowed MIME types, if you had raised them
- [ ] SMTP settings, if the push touched the `auth` config surface (usually not,
      but re-send a test email after the first push)
- [ ] Realtime publication membership for `notifications` (§2.5)
- [ ] `pg_cron` jobs present and firing (§3.1, step 5)

---

## 3. Schema workflow (B1.9)

> The app and every `--remote` script talk to Supabase over **HTTPS/PostgREST**
> only — there is no `DATABASE_URL` anywhere in `scripts/`. The pooler/password
> below is needed **only by the Supabase CLI for schema operations**.

### 3.1 PRE-ENABLE — do this BEFORE the first push

Two extensions must exist before migrations run. Skipping this produces two
different, both-bad failure modes.

**Step 1 — `vector` in the `extensions` schema.**

Dashboard → **Database → Extensions** → enable **vector** and make sure its
schema is `extensions` (not `public`).

Why this is first: `0001_profiles.sql` installs `vector` **unqualified**
(whatever schema is first on the search path), while `0039_insightface.sql`
**hard-fails** if the extension is not in `extensions`:

```sql
raise exception 'pgvector extension must live in schema extensions (found elsewhere); drop and reinstall before migrating';
```

`db push` runs migrations in one sequence. If `vector` lands in `public`, 0039
aborts **mid-push**, leaving a partially applied migration and a
`schema_migrations` history that no longer matches the database.

**Step 2 — the pg_cron scheduler.**

Dashboard → **Database → Extensions** → enable **pg_cron**, then Dashboard →
**Database → Cron** (the scheduler UI). The migrations only create schedules
inside guarded blocks (`0019`, `0022`, `0030`, `0042`), and `create extension
pg_cron` needs superuser — so on a hosted project the push can succeed with
**ZERO jobs and no error at all**. That is the silent failure: the app looks
healthy while autoclose, the silence-flag integrity check and both prunes never
run.

**Step 3 — link, dry-run, push.**

```bash
cd /home/deploy/innovision
supabase login                                     # browser/device token
supabase link --project-ref <project-ref>          # prompts for the DB password
# Add --skip-pooler if the CLI should use the direct connection.
```

```bash
supabase db push --dry-run      # LIST ONLY: prints the migrations it would apply
```

Read the dry-run output before continuing. It must list the migrations that are
absent from the remote history — on a fresh project, that is the full set from
`0001` onward.

```bash
supabase db push                # applies them, records schema_migrations
```

> ⚠️ **`db push` only applies migrations ABSENT from the remote history.** It is
> not a "make remote match local" operation, and a migration that failed halfway
> is recorded as neither applied nor absent until you repair it (§3.2).

**Step 4 — confirm the history matches.**

```bash
supabase migration list --linked
```

Every row must show the same version in the LOCAL and REMOTE columns. A version
present locally and blank remotely means it did not apply.

**Step 5 — confirm the cron jobs actually exist.**

```bash
curl -s https://<your-host>/api/health | jq .        # anon: no `cron` key (gate S6)
```

The `cron` block is **lecturer-only** (gate S6) — an anonymous probe returns
`{ok, db:{reachable,latencyMs}, uptimeSec, checkedAt, elapsedMs}` and deliberately
makes no `cron_health()` call. To see the jobs, either log in as a lecturer and
hit `/api/health` from the browser, or query the scheduler directly (there is no
`db psql` subcommand in CLI 2.113.0 — use `db query`):

```bash
supabase db query --linked "select jobname, schedule, active from cron.job order by jobname;"
```

Expected — five rows, matching `0019/0022/0030/0042`:

| Job | Schedule |
|---|---|
| `innovision-retention` | `17 3 * * *` |
| `innovision-notifications` | `43 3 * * 6` |
| `innovision-quiz-autoclose` | `*/5 * * * *` |
| `innovision-flag-verify-silence` | `* * * * *` |
| `innovision-incident-prune` | `23 4 * * *` |

**Zero rows here means Step 2 did not take** — go back and enable pg_cron, then
re-run `supabase db push` (the schedules are inside the migration bodies, so
they will not re-run once the version is recorded as applied: re-create them
from the dashboard Cron UI, or `supabase migration repair <v> --status reverted`
first — see §3.2).

**Step 6 — verify storage RLS applied.**

Storage inserts are push-safe by construction (`0003` and `0020` insert buckets
with a do-nothing conflict clause; `0028` does an update; policies are
drop-if-exists + create), but verify rather than assume:

```bash
supabase db query --linked "select id, public, file_size_limit from storage.buckets order by id;"
```

Expected four buckets, all `public = f`:

| Bucket | Limit | Set by |
|---|---|---|
| `quiz-sources` | 26214400 (25 MB) | `0007` |
| `question-images` | 5242880 (5 MB) | `0028` |
| `avatars` | 2097152 (2 MB) | `0028` |
| `incident-footage` | (deny-by-default) | `0020` |

Then confirm the policies exist:

```bash
supabase db query --linked "select count(*) from pg_policies where schemaname = 'storage';"
```

**Step 7 — regenerate types for the hosted project.**

`scripts/gen-types.mjs` is pinned to `--local`, so it cannot do this. Run the CLI
directly (flags verified against pinned CLI 2.113.0):

```bash
npx supabase gen types typescript --project-id <project-ref> \
  --schema public --schema storage --schema cron > /tmp/database.ts
```

Diff it against `src/lib/types/database.ts` before replacing. Do **not** commit
hosted-generated types over the local ones blindly — the app's own type aliases
live in `src/lib/types/aliases.ts` and are separate. The hosted and local schemas
should be identical after a clean push; a diff means one of them drifted.

> `verify-*.mjs` stay **local-only by design** — they import `target-guard.mjs`
> and refuse a remote target (the single exception is `verify-mediapipe.mjs`,
> which is a network-free manifest-hash check). They are NOT a VPS gate; §12's
> smoke is what replaces them here.

### 3.2 `migration repair` — history-only surgery

`migration repair` rewrites `supabase_migrations.schema_migrations` and runs
**no SQL**. It is the tool for exactly one situation: the database state and the
recorded history disagree.

```bash
supabase migration repair <version> --status applied     # mark as applied (DB already has it)
supabase migration repair <version> --status reverted    # mark as unapplied (so push retries it)
```

Two real cases:

- **0039 aborted mid-push** (§3.1 Step 1). Some of its statements ran. Inspect
  what exists (`\d public.profile_face_samples`, `select * from
  pg_extension where extname='vector'`), finish or undo the partial work by
  hand, then `repair <0039 version> --status reverted` and re-push so the whole
  migration replays against a known state.
- **pg_cron jobs missing** (§3.1 Step 5). The migration is recorded as applied
  but created nothing. Either create the five schedules in the dashboard Cron UI
  (no history change needed), or `repair … --status reverted`, pre-enable
  pg_cron properly, and re-push.

⚠️ `repair --status applied` on a migration whose SQL never ran gives you a
history that lies. Never use it to "make the list green".

### 3.3 Data-only operations

```bash
# Wipe all hosted data (auth users cascade + all 4 buckets). NOT a schema op,
# NOT a restore — see §10.2.
npm run db:reset:remote

# Seed a demo semester.
npm run seed:demo:remote
```

Both are guard-gated. Since gate S2, the destructive path requires
`PROD_CONFIRM_TOKEN` **from the environment** (a committed fallback no longer
exists) and writes a `[prod-audit]` line:

```bash
PROD_CONFIRM_TOKEN=<secret> npm run db:reset:remote
```

> ⚠️ **The token must NOT be the project ref, the Supabase URL, or any value
> you can read out of `.env.production.local` / `.env.local`.** The gate now
> refuses those outright (`isCommittedProjectRef`): a value that is readable
> from the repo cannot act as a secret, so it is deny-listed rather than
> accepted. The historical project-ref literal survives in the source ONLY as a
> deny-list entry — do not "clean it up", it is what keeps the hole closed. Pick
> a fresh out-of-band secret. The answer you type is read **without echo**, so
> it will not appear on your terminal or in a recorded session.

`ALLOW_PROD_SEED=1` still bypasses the prompt (announced + audited) but supplies
no token — and therefore cannot be deny-listed; treat it as a deliberately
unaudited escape hatch, not a convenience. The audit log defaults to
`.prod-audit.log` on the operator's machine and is gitignored — **it is not a
durable record until you ship it off-host** (set `PROD_AUDIT_LOG` to a mounted
volume or forward the stdout lines).

---

## 4. VPS env (B1.8)

### 4.1 Two env files, two mechanisms

| File | Read by | Contains |
|---|---|---|
| **`.env.local`** (project root, gitignored) | the `app` service via compose `env_file:`, and the `insightface-service` / `glm-ocr` / `caddy` services via compose interpolation | **RUNTIME** env: server-only secrets + per-request knobs |
| **`.env`** (project root, gitignored) | compose interpolation for **build args** and for the sidecar/caddy `environment:` blocks | **BUILD-TIME** family (`NEXT_PUBLIC_*`, `ALLOWED_HOSTS`, `TRUSTED_ORIGINS`, `SITE_URL`), plus `SITE_HOST`, `ACME_EMAIL`, `FACE_SIDECAR_TOKEN`, `VLLM_API_KEY` |

There is **no `env_file` mechanism for build args** — that is why the build-time
family lives in `.env` and is passed through `args:` in the compose `app` service.
Compose reads `.env`, not `.env.local`.

### 4.2 Change / stay / must-stay-unset

| Var | VPS value | Class | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` | **BUILD** | Decides both the browser's Supabase target AND the `/sb` rewrite gate |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | hosted anon key | **BUILD** | `src/lib/env.ts` **throws** at boot on an empty value |
| `SUPABASE_SERVICE_ROLE_KEY` | hosted service-role key | RUNTIME | Server-only. Never a build arg, never `NEXT_PUBLIC_*` |
| `SITE_URL` | `https://<your-host>` | **BUILD** + runtime read | Server-side origin for emailed links (`src/lib/auth/site-url.ts` prefers it over the public one) |
| `NEXT_PUBLIC_SITE_URL` | `https://<your-host>` | **BUILD** | Public origin; feeds `ALLOWED_HOSTS` |
| `ALLOWED_HOSTS` | `<your-host>` | **BUILD** | Extra hostnames for the Next action/dev allowlist (wildcards OK). **A first-class alias for `ALLOWED_ORIGINS`** — `next.config.ts` reads both, so setting either works. Also folded in from `TRUSTED_ORIGINS`/`SITE_URL`/`NEXT_PUBLIC_SITE_URL` |
| `TRUSTED_ORIGINS` | `https://<your-host>` | **RUNTIME** | The ONE origin var read per request (`checkSameOrigin`) |
| `ALLOWED_ORIGINS` | *(empty unless needed)* | **BUILD** | Extra hostnames only |
| `TRUSTED_PROXY_COUNT` | `1` for Caddy-only, `2` for tunnel+Caddy, `0` for direct | RUNTIME | §5 — **MANDATORY `0` for direct access** |
| `SITE_HOST` | `<your-host>` | compose (caddy) | Caddy serves and requests a cert for exactly this name |
| `ACME_EMAIL` | your email, or empty | compose (caddy) | ACME expiry notices. **Genuinely optional** — the Caddyfile uses `email "{$ACME_EMAIL:}"` (quoted, empty default) because a bare `email` directive with an empty value is a PARSE ERROR that crash-loops caddy with no TLS |
| `INSIGHTFACE_BASE_URL` | *(do not set)* | — | Compose **overrides** it to `http://insightface-service:8000`; the app default `http://localhost:8000` would resolve inside the app's own container |
| `FACE_SIDECAR_TOKEN` | long random secret | RUNTIME + compose | **Same value on BOTH sides** (§8.1) |
| `FACE_SPOOF_ENFORCE` | `1` | RUNTIME | Anti-spoof enforcement (§8.2) |
| `GLM_PROVIDER` | `remote` | RUNTIME | The Z.ai leg; see `docs/GLM_OCR_SETUP.md` §6 |
| `ZAI_BASE_URL` | `https://api.z.ai/api/paas/v4` | RUNTIME | Root already carries `/api/paas/v4` |
| `ZAI_API_KEY` | Z.ai key | RUNTIME | Server-only |
| `OCR_GLM_MODEL` | `glm-ocr` | RUNTIME | Same id on both legs |
| `GLM_REMOTE_MAX_PAGES` | `30` (interim) | RUNTIME | 100-vs-30 conflict unresolved |
| `GLM_DAILY_TOKEN_CAP` | `2000000` | RUNTIME | Per-user/day |
| `GLM_TOKEN_PRICE_PER_MILLION` | `0.03` | RUNTIME | Cost logging only |
| `GLM_SPEND_LEDGER_PATH` | `/var/lib/innovision/glm-spend-ledger.json` | RUNTIME | **Must live on the `glm-ledger` volume** (compose sets this) or the daily cap resets on every redeploy. Per-host; keep single-instance |
| `GLM_PROBE_TTL_MS` / `GLM_PROBE_NEGATIVE_TTL_MS` | `300000` / `30000` | RUNTIME | Probe cache (the remote probe is BILLED) |
| `PROD_ENV_STRICT` | `1` (pinned in `docker-compose.yml`) | RUNTIME | Arms the fail-closed prod gate (§8.3). **Pinned by compose, not by `.env.local`** — compose `environment:` beats `env_file:`, so a stale `.env.local` carrying `0` cannot disarm it. ⚠️ Do NOT set it in a developer's `.env.local`: the Playwright harness pins it off, but a bare `next start` / `node server.js` with it set will REFUSE TO BOOT |
| `INSTITUTIONAL_EMAIL_DOMAINS` | your domains, or empty | RUNTIME | SSO second trust layer |
| `LECTURER_INVITE_CODE` | your code | RUNTIME | Empty disables lecturer self-signup |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | as today | RUNTIME | Quiz generation gateway |
| `TINYFISH_API_KEY` | as today | RUNTIME | Absent = web-topic mode hidden |
| `GLM_BASE_URL` | *(do not set)* | — | Local leg only; inert on the remote leg |
| `VLLM_API_KEY` | *(do not set)* | — | No local container on this host. ⚠️ `inspectProdEnv` demands it when the LOCAL leg is active — with `GLM_PROVIDER=remote` it is not required |
| `GLM_OCR_REVISION` | *(do not set)* | — | Container-only |
| `E2E_RATE_LIMIT_DISABLED` | **must stay unset or `0`** | RUNTIME | Kill switch (§8.4) |
| `NEXT_PUBLIC_E2E_FAKE_SEAM` | **must stay unset or `0`** | **BUILD** (inlined) | Kill switch |
| `NEXT_PUBLIC_INTEGRITY_HARDENING_OFF` | **must stay unset or `0`** | **BUILD** (inlined) | Kill switch |
| `FACE_MOCK_ENABLED` | **must stay unset or `0`** | RUNTIME | Kill switch |
| `E2E_*`, `PLAYWRIGHT_*`, `MOCK_*`, `FULL`, `CI` | **must stay unset** | — | Harness-only |
| `ALLOW_PROD_SEED` | **must stay unset** | scripts | Bypasses the destructive-op prompt |
| `PROD_CONFIRM_TOKEN` | your out-of-band secret | scripts | Required by destructive `--remote` runs |
| `NODE_ENV`, `PORT`, `HOSTNAME` | *(do not set)* | — | The image sets them (`production` / `3000` / `0.0.0.0`) |

### 4.3 ⚠️ BUILD-time vs RUNTIME — the split that breaks deployments

Three families bake into the artifact at `next build` and **cannot** be changed
by editing the container's runtime environment:

1. **`NEXT_PUBLIC_*`** — inlined into the client bundle.
2. **`ALLOWED_HOSTS`** — read at module scope in `next.config.ts` to build
   `serverActions.allowedOrigins` / `allowedDevOrigins`.
3. **The `/sb` rewrite gate** — `rewrites()` runs once during
   `loadCustomRoutes`; `next start` serves the frozen routes manifest and never
   re-invokes it. A hosted build returns `[]` (no local-Kong proxy); any other
   value keeps the four local rules.

**Therefore: an origin change is a REBUILD + re-push with build args, not a
runtime env flip.** The compose `app` service declares them under `build.args:`
and reads them from the project-root `.env`:

```bash
# project-root .env — the build-time family + the caddy vars
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
NEXT_PUBLIC_SITE_URL=https://<your-host>
SITE_URL=https://<your-host>
TRUSTED_ORIGINS=https://<your-host>
ALLOWED_HOSTS=<your-host>
SITE_HOST=<your-host>
ACME_EMAIL=<you@example.com>
FACE_SIDECAR_TOKEN=<the same value the app reads>
```

> `NEXT_PUBLIC_E2E_FAKE_SEAM` and `NEXT_PUBLIC_INTEGRITY_HARDENING_OFF` are
> **pinned to `"0"`** in the compose build args on purpose — a harness-built
> image promoted to the VPS would otherwise carry them forever.

`TRUSTED_ORIGINS` is the exception: `checkSameOrigin` (`src/lib/http.ts`) reads
it **per request**, so it is runtime-flippable. Setting *only* `TRUSTED_ORIGINS`
at runtime does **not** fix silent server-action aborts — the action allowlist is
baked. That mismatch is the single most common misdiagnosis here.

### 4.4 Origin checklist — each misconfiguration's failure signature

| Where | Symptom | What it actually means |
|---|---|---|
| Supabase dashboard (Site URL / redirect allowlist) | User lands on an error page after clicking an emailed link; server log shows a GoTrue callback error | GoTrue refused the redirect — the `/auth/callback` entry is missing or the origin is wrong |
| `TRUSTED_ORIGINS` (runtime) | `403` with body `{"error":"invalid_origin"}` on API mutations | `checkSameOrigin` saw an Origin that differs from the bind host and is not allowlisted |
| `ALLOWED_HOSTS` / `NEXT_PUBLIC_SITE_URL` / `SITE_URL` (**build**) | Server actions **silently abort** — the login form appears to just reset, no error in the UI | Next's action CSRF check rejected the Origin; the allowlist was baked before the origin was known. Fix = rebuild |
| `SITE_URL` (build+runtime) | Emailed links carry the wrong origin (localhost, or the tunnel host) | `site-url.ts` fell back to GoTrue's Site URL or the request headers |

### 4.5 The image's startup log line

The app image prints its **effective baked decisions** once at boot — this is the
fastest way to catch a stale build:

```bash
docker compose logs app | head -20
# [entrypoint] /sb mode: hosted - /sb rewrites DISABLED (0 rules); the browser talks to the hosted project directly
# [entrypoint] baked NEXT_PUBLIC_SUPABASE_URL origin: https://<project-ref>.supabase.co
# [entrypoint] allowed hosts (serverActions.allowedOrigins): <your-host>
# [entrypoint] public site origin: https://<your-host>
# [entrypoint] TRUSTED_PROXY_COUNT: 1
# [entrypoint] listening on 0.0.0.0:3000 as uid 1000
```

If `/sb mode` says `local-Kong` on the VPS, the image was built with a local
`NEXT_PUBLIC_SUPABASE_URL` — rebuild with the build args. If `TRUSTED_PROXY_COUNT`
prints `<unset -> request-ip defaults to 1>`, see §5.

### 4.6 Build-time decisions that are NOT env

- **HSTS** ships on every response already (`max-age=63072000;
  includeSubDomains`, no `preload`). Do not add a second HSTS header in Caddy.
  Submit `preload` only once HTTPS-everywhere is proven for every subdomain.
- **CSP is Report-Only** today with a blanket `https:` in `connect-src`. It
  enforces nothing; watch the console (§12.3) before flipping it.
- **Cookies**: host-only, `SameSite=Lax`, no `Secure` anywhere. No VPS action
  needed.
- **WebSockets**: realtime goes directly to `wss://<ref>.supabase.co` (already in
  `connect-src`); no proxy config. Polling heals any drop.

---

## 5. `TRUSTED_PROXY_COUNT`

`src/lib/request-ip.ts` resolves the client IP as the entry **N from the right**
of `X-Forwarded-For`. Pin it to the REAL hop count or the per-IP budgets are
wrong in one of two directions.

| Posture | Value | Why |
|---|---|---|
| **Caddy only** (this runbook's default: Caddy directly on the internet, `reverse_proxy app:3000`) | **`1`** | Caddy appends the client IP; the rightmost XFF entry is proxy-written. The default already matches. |
| **Tunnel (Cloudflare etc.) in front of Caddy** | **`2`** | Two proxies append; take the entry two from the right |
| **No proxy at all** (app reached directly on `:3000`) | **`0` — MANDATORY** | See below |

> **Measured, because the naive assumption is wrong.** Caddy's behavior depends
> on `trusted_proxies`, which this `Caddyfile` now sets explicitly
> (`trusted_proxies private_ranges`). With it configured, a forged
> `X-Forwarded-For` is **discarded and replaced** by the real peer, and a
> two-hop chain yields two entries:
> ```
> direct→Caddy→backend, forged XFF  →  {"xff":"1.2.3.4, 172.22.0.1"}
> edge→Caddy→backend,   forged XFF  →  {"xff":"172.22.0.1, 172.22.0.4"}
> ```
> Feeding those through `clientIpFromHeaders`: `trusted=1` → Caddy's peer
> (correct for Caddy-only); `trusted=2` → the real client (correct for
> tunnel+Caddy). Without `trusted_proxies` Caddy collapses this to a
> single-entry XFF, and `trusted=2` then resolves to `"unknown"` — every client
> in one bucket. The `Caddyfile` also sets `header_up -X-Real-IP`, so a
> client-supplied `X-Real-IP` no longer reaches the app and can no longer feed
> the unconditional fallback below.
>
> **UNVERIFIED:** the tunnel row assumes a real `cloudflared` writes XFF the way
> the simulation did. Prove it with the forged-XFF test below against the live
> tunnel before trusting `2`.

### 5.1 Why `0` is mandatory for direct access, not merely conservative

When `X-Forwarded-For` is **absent**, `clientIpFromHeaders` falls back to
`x-real-ip` **unconditionally**:

```ts
return h.get("x-real-ip")?.trim() || "unknown";
```

That is exactly the header a Cloudflare tunnel strips, and it is fully
client-writable. So a direct-access deployment left at the default (`1`):

- an honest browser sends no forwarding header → every honest student collapses
  into **one shared bucket** (per-IP budgets become a global cap);
- a client that sends `X-Forwarded-For: <random>` → a **fresh bucket per
  request**, defeating every per-IP budget;
- a client that sends `x-real-ip: <anything>` → the fallback accepts it.

The only signal today is a once-per-process `console.warn`. Setting `=0` makes
the resolution return the constant `"direct"` — one shared bucket, rotation
defeated, no forged-IP acceptance. The cost is honest: per-IP budgets act as
global caps.

A value that is set but not a non-negative integer falls back to `0` **with a
warn**, and is also reported as a violation by the prod gate (§8.3) — so a typo
like `TRUSTED_PROXY_COUNT=0,` cannot silently select the permissive setting.

**Prove it, don't assume it.** From off-host, against the live origin:

```bash
# A forged XFF must NOT mint a new bucket. Send 40 requests with a rotating
# forged header at a budgeted endpoint; if the budget still trips, the hop
# count is right. (Endpoint choice: /api/health is 30/min per IP.)
for i in $(seq 1 40); do
  curl -s -o /dev/null -w "%{http_code} " \
    -H "X-Forwarded-For: 10.0.0.$i" https://<your-host>/api/health
done; echo
```

If the responses never include a `429`, either the count is wrong or you are
behind a proxy that strips the header (in which case the hop count is not what
you think it is). UNVERIFIED: this forged-XFF proof has not been run live.

---

## 6. Container bring-up (B3/O1)

### 6.1 Build or pull

**GHCR pull is RECOMMENDED over build-on-VPS.** The insightface image measures
903 MB content / 2.65 GB on disk locally, and its build compiles C extensions
(sdist + wheels) — vCPU build minutes are **UNVERIFIED** and plausibly tens of
minutes. The app image is estimated 0.2–0.4 GB (UNVERIFIED — never built on a
vCPU host).

Build on the VPS (simplest, needs the full source + a long first build):

```bash
cd /home/deploy/innovision
docker compose build app            # reads build args from project-root .env
docker compose build insightface-service
```

Or pull prebuilt images (recommended once you have a CI job publishing them):

```bash
# UNVERIFIED: no publish pipeline exists in the repo yet. Add
# `image: ghcr.io/<org>/innovision-app:<tag>` to the compose services and:
docker compose pull
```

### 6.2 Profile semantics — a bare `up` skips `glm-ocr`

```bash
docker compose up -d                 # app + insightface-service + caddy. glm-ocr NOT started.
docker compose up -d glm-ocr         # would start it — DO NOT on a GPU-less VPS
docker compose --profile gpu up -d   # laptop/GPU-host form
```

Compose-spec rule: a service **without** `profiles:` always starts; a service
**with** one starts only when that profile is requested. `glm-ocr` is the only
profiled service, which is what keeps a bare `up` from attempting an nvidia
device reservation on this host. `docker compose up -d` alone is the correct VPS
command.

### 6.3 The `app` service

| Field | Value | Note |
|---|---|---|
| Build | repo-root `Dockerfile`, multi-stage `node:22-slim` → `USER node` | Standalone output; `public/` + `.next/static` copied explicitly |
| Ports | `127.0.0.1:3000:3000` | **Loopback only.** Caddy reaches it over the compose network as `app:3000` |
| `env_file` | `.env.local` | RUNTIME only |
| `environment` | `INSIGHTFACE_BASE_URL: http://insightface-service:8000`, `NODE_ENV: production` | `GLM_PROVIDER` is deliberately NOT forced here — it comes from the env file |
| `depends_on` | `insightface-service: { condition: service_healthy }` | The app waits for the face sidecar's healthcheck; without it the first integrity calls hit a cold model load and time out (routes allow 5 s/call) |
| `restart` | `unless-stopped` | |
| `mem_limit` / `cpus` | `2g` / `2.0` | ⚠️ **PLACEHOLDERS, not measured.** Load-test at classroom scale before pinning. A too-low `cpus` quota shows up as SSE latency and healthcheck timeouts, not a crash |
| `logging` | json-file, 10m × 3 | Shared `x-logging` anchor |
| HEALTHCHECK | from the **image** | See §6.4 |

### 6.4 The decoupled HEALTHCHECK — liveness only, NEVER `cron.ok`

The image's probe (`/app/healthcheck.mjs`) exits 0 only when `/api/health`
returns `ok === true` **and** `db.reachable === true`.

It deliberately does **not** read `cron.ok`. Coupling Docker health to Supabase
pg_cron state would make cron staleness — a slow, recoverable condition — a
container-health event, and (per the Dockerfile's note) would zero the in-memory
rate-limit Maps and OCR in-flight counters on any restart, handing an abuser a
clean budget each cycle. Cron is an ops concern: alert on it from a monitor
(§12.4), never from the container runtime.

Because the probe asserts `db.reachable`, an **unreachable** database (including
a paused free-tier project) does flip the container to `unhealthy`. That is
intended — a stack that cannot reach its database cannot serve.

> **⚠️ What `unhealthy` actually does here — read this before relying on it.**
> Compose's `restart: unless-stopped` reacts to container **exit**, not to health
> status. An `unhealthy` container therefore **stays up and keeps serving**; it
> does not restart-loop on its own, and there is no autoheal sidecar in this
> compose file. The plan and the Dockerfile comment describe the coupling as a
> "restart loop" — that is the *risk* if you later add an autoheal/health-driven
> orchestrator, not the behaviour of this compose file today. Practically:
> **watch the health status yourself** (or alert on `/api/health` from outside),
> because nothing will restart the container for you.

```bash
docker compose ps                       # app must show (healthy)
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q app)
```

### 6.5 The caddy service

```bash
docker compose up -d caddy
docker compose logs -f caddy            # watch certificate issuance on first start
```

Requirements, all operational: DNS points here; ports 80 **and** 443 reachable
(ACME HTTP-01 uses 80); the `caddy-data` / `caddy-config` volumes exist (§7.1).
Body size is raised to 60 MB in the Caddyfile so a proxy-level limit cannot 413
the 25 MB quiz-source upload path.

---

## 7. Caddy + TLS + firewall (B3.3)

### 7.1 The two named volumes — and why

```yaml
volumes:
  - ./Caddyfile:/etc/caddy/Caddyfile:ro
  - caddy-data:/data          # ACME account key, issued certs, OCSP staples
  - caddy-config:/config
```

**Without `caddy-data` / `caddy-config`, every container recreate re-issues
certificates.** Caddy keeps its ACME account key and issued certs under `/data`;
in an anonymous container layer they vanish on the next `docker compose up` after
any config edit or image bump. Each recreate then burns a fresh issuance against
Let's Encrypt's limits (**50 certs per registered domain per week, 5 duplicate
certs per week**) — a handful of redeploys locks the domain out for a week with
no remedy but waiting.

Both are named volumes, so they survive `docker compose down`. **Never run
`docker compose down -v`** on this host: it deletes them.

```bash
docker volume ls | grep caddy          # caddy-data + caddy-config must exist
```

### 7.2 ufw — the ORDER matters

```bash
sudo apt-get update && sudo apt-get install -y ufw

sudo ufw allow 22/tcp        # 1. SSH FIRST — before the default deny exists
sudo ufw allow 80/tcp        # 2. ACME HTTP-01 + HTTP→HTTPS redirect
sudo ufw allow 443/tcp       # 3. HTTPS (+ HTTP/3 on UDP)
sudo ufw allow 443/udp
sudo ufw enable              # 4. NOW turn it on (default deny incoming)
sudo ufw status verbose
```

**`default deny` before `allow 22` locks you out of SSH.** `ufw enable` applies
the default-deny policy immediately; if 22 was not allowed first, the session
drops and the recovery path is the provider's console. Enabling ufw sets the
default-deny policy for you, so the four allows must precede it.

Then, optionally, deny the app ports explicitly:

```bash
sudo ufw deny 3000/tcp
sudo ufw deny 8000/tcp
```

> ⚠️ **This is belt-and-braces only, and it is silently ineffective once the app
> is containerized.** Docker writes its own iptables rules and its published
> ports bypass ufw's filter chain — `ufw deny 3000` does not stop a container
> that publishes `0.0.0.0:3000`. **The real control is the loopback bind**
> (`127.0.0.1:3000:3000`, `127.0.0.1:8000:8000` in the compose file). Verify the
> bind, not the firewall rule:

```bash
ss -ltnp | grep -E ':(3000|8000|80|443)\b'
# 3000 and 8000 MUST show 127.0.0.1, not 0.0.0.0 or [::]
docker compose ps --format '{{.Service}}\t{{.Ports}}'
```

### 7.3 SSH hardening + unattended upgrades

```bash
# On the VPS as a sudo-capable user. Install your public key FIRST and verify a
# second session works before disabling passwords.
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/'   /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'                 /etc/ssh/sshd_config
sudo sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/'      /etc/ssh/sshd_config
sudo sshd -t && sudo systemctl reload ssh

sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades     # enable the security pocket
```

`fail2ban` is optional. Keep `sudo` for the deploy user and do not add it to
unnecessary groups.

---

## 8. Tokens + kill switches (B3.2/B3.4/S1/S5)

### 8.1 `FACE_SIDECAR_TOKEN` — the same value on BOTH sides

```bash
openssl rand -hex 32          # generate once
```

Put the value in **two** places:

1. **project-root `.env`** — read by the `insightface-service` container as
   `FACE_SIDECAR_TOKEN: "${FACE_SIDECAR_TOKEN:-}"`;
2. **`.env.local`** — read by the app process, which sends it as the
   `x-sidecar-token` header.

```bash
grep -c '^FACE_SIDECAR_TOKEN=' .env .env.local     # both must be 1
```

**An empty token is a security failure, not a safe default.** The compose file
boots perfectly healthy with `${FACE_SIDECAR_TOKEN:-}` empty, and the app omits
the header when the token is empty — so the sidecar's `/extract` becomes an
**unauthenticated face-embedding oracle** for anything that can reach port 8000.
The loopback bind is the primary control; the token is the defense against bind
drift (a compose edit, `network_mode: host`, a shared Docker socket).

**Verify the header is actually enforced** (a wrong token must be rejected):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/health
# with a token set: 401/403 without the header, 200 with it
curl -s -o /dev/null -w "%{http_code}\n" -H "x-sidecar-token: $FACE_SIDECAR_TOKEN" http://127.0.0.1:8000/health
```

### 8.2 `FACE_SPOOF_ENFORCE=1`

Without it, a majority-spoofed verify is recorded for lecturer audit but never
enforced — a print/replay attack passes. Set it in `.env.local`. (Requires a
sidecar image built with the MiniFASNet weights baked in; the current image has
them.)

### 8.3 `PROD_ENV_STRICT=1` — arming the fail-closed gate

`src/lib/prod-guards.ts` runs once per server start from
`src/instrumentation.ts`'s `register()`. With `NODE_ENV=production` **and**
`PROD_ENV_STRICT=1`, any violation makes the process **exit(1)** — not merely
throw, because Next keeps the HTTP listener bound after a rejected `register()`
and the result would be a zombie answering 500 to every request.

Violations it catches:

- any harness kill switch set to `1`;
- `FACE_SIDECAR_TOKEN` empty while face is real (not both mock flags);
- `GLM_PROVIDER=remote` with an empty `ZAI_API_KEY`, **or** the local leg active
  with an empty `VLLM_API_KEY`;
- `TRUSTED_PROXY_COUNT` set but not a non-negative integer.

**How it is armed: the compose `app` service pins `PROD_ENV_STRICT: "1"` in its
`environment:` block.** That is deliberate — compose `environment:` beats
`env_file:`, so a stale or hand-edited `.env.local` cannot silently disarm the
gate:

```bash
docker compose config | grep PROD_ENV_STRICT    # expect: PROD_ENV_STRICT: "1"
```

> ⚠️ **Do not set `PROD_ENV_STRICT=1` in a developer's `.env.local`.** The
> Playwright harness pins it to `""` in both webServer env blocks (it arms the
> kill switches on purpose), and `playwright.config.ts` asserts that pin at
> config load — so the suite is safe. But a bare `next start` /
> `node .next/standalone/server.js` started with that value in the environment
> will refuse to boot, which looks like a mystery startup crash.

**Prove the gate works before you need it.** Break it deliberately, watch the
container die, then fix it:

```bash
# 1. Add E2E_RATE_LIMIT_DISABLED=1 to .env.local and restart.
docker compose up -d app
docker compose logs --tail=20 app
# EXPECTED: "[instrumentation] production env gate REFUSED to start this server
#            (S1/S5). Exiting instead of serving requests from a misconfigured stack."
# EXPECTED: the container is NOT (healthy) and keeps restarting.
# 2. Remove the line, restart, confirm healthy.
```

If the container comes up healthy with a kill switch armed, `PROD_ENV_STRICT` is
not set (or not reaching the process). That is a silent success — treat it as a
blocker.

### 8.4 The four kill switches that must be OFF

| Var | `1` means | Class |
|---|---|---|
| `E2E_RATE_LIMIT_DISABLED` | every per-route rate budget in the process is disabled | RUNTIME |
| `NEXT_PUBLIC_E2E_FAKE_SEAM` | with `FACE_MOCK_ENABLED`, face verification returns canned verdicts and verifies nothing | **BUILD** (inlined) |
| `FACE_MOCK_ENABLED` | server-side mock seam for the face client | RUNTIME |
| `NEXT_PUBLIC_INTEGRITY_HARDENING_OFF` | clipboard/fullscreen hardening never mounts | **BUILD** (inlined) |

```bash
# Must print nothing (or only commented lines).
grep -nE '^(E2E_RATE_LIMIT_DISABLED|NEXT_PUBLIC_E2E_FAKE_SEAM|FACE_MOCK_ENABLED|NEXT_PUBLIC_INTEGRITY_HARDENING_OFF)=1' \
  .env .env.local
```

The two `NEXT_PUBLIC_*` ones are **baked into the client bundle** — a harness
image promoted to the VPS carries them forever. That is why the compose build
args pin them to `"0"` and why a rebuild (not an env edit) is the only fix.

---

## 9. Cutover (§7.5)

### 9.1 Pre-flip

- [ ] **DNS TTL ≤ 300 s** on the record you are about to change, set at least one
      TTL period *before* the flip. A 24-hour TTL means a rollback takes a day.
- [ ] `SITE_URL` / `NEXT_PUBLIC_SITE_URL` pinned to the final origin **before**
      the build (§4.3) — an emailed link minted with the wrong origin is not
      fixable after the fact.
- [ ] Supabase dashboard pass complete (§2), schema pushed and verified (§3).
- [ ] VPS env file built from §4.2 (fresh, not copied) and the startup log line
      (§4.5) checked.
- [ ] `PROD_ENV_STRICT=1` armed and the deliberate-failure test (§8.3) passed.
- [ ] The four kill switches absent (§8.4).
- [ ] `TRUSTED_PROXY_COUNT` matches the real posture (§5).
- [ ] **Backup rehearsed** (§10.4) — do not flip before the restore has been
      proven once.
- [ ] Keep-alive decision made (§11.3).

### 9.2 The flip

```bash
# Point DNS at the VPS, wait for propagation, then:
dig +short <your-host>
curl -sI https://<your-host>/ | head -5          # expect HTTP/2 200 + HSTS
```

### 9.3 Post-flip smoke (see §12 for the full list)

```bash
node scripts/vps-smoke.mjs --base-url https://<your-host> \
  --email <lecturer@example.edu> --password '<password>' \
  --expect-cron --expect-provider remote
```

Pass `--expect-cron` only once the five jobs actually exist (§3.1 Step 5) — it
turns cron failures fatal, so on a project whose scheduler is still being enabled
it converts a known-incomplete state into a red run.

### 9.4 Keep-alive for free-tier pausing

Free-tier Supabase projects pause after ~7 days of inactivity, and **pausing
stops all five cron jobs** (§11.2). Two options:

- **Keep-alive**: an external monitor (or a cron on another host) that hits
  `https://<your-host>/api/health` every few minutes. This counts as activity for
  the project. UNVERIFIED: whether health-check traffic alone prevents pausing on
  the current free-tier policy — confirm in the Supabase dashboard's usage view
  before relying on it.
- **Supabase Pro ($25/mo)**: no pausing, no cron gap. See §11.3.

The app is designed to survive a pause: the container stays healthy (its
HEALTHCHECK is liveness + DB only, §6.4), the UI degrades, and the crons catch up
when the project resumes — except for the integrity checks that need to run
*while* a session is live (§11.2).

---

## 10. Rollback — a REAL atomic restore (§7.5/O3)

> **⚠️ `npm run db:reset:remote` is a DATA NUKE, NOT a restore.** It deletes
> every `auth.users` row (cascading through the whole app schema) and empties all
> four storage buckets. It restores nothing. Never reach for it during an
> incident.

### 10.1 The backup set

```bash
cd /home/deploy/innovision
mkdir -p backup/$(date +%F) && cd backup/$(date +%F)
# DIRECT connection (matches `supabase link --skip-pooler`). The pooler form is
# postgresql://postgres.<project-ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres
# Only needed for the pg_dump alternative below; the CLI form uses the linked
# project's credentials.
export PGURL='postgresql://postgres:<db-password>@db.<project-ref>.supabase.co:5432/postgres'
```

**(a) Schema + roles + data.** Primary form uses the CLI (already installed and
linked; no local `pg_dump` needed):

```bash
# App-owned schemas, schema only. NOTE: Supabase's MANAGED schemas (auth,
# storage internals) are excluded by default — that is why (c) exists.
supabase db dump --linked -s public,storage,cron --keep-comments -f schema.sql

# Data only, same schemas.
supabase db dump --linked --data-only -s public -f data.sql

# Role memberships (grants/ownership live in roles, not in the schema dump).
supabase db dump --linked --role-only -f roles.sql
```

Alternative with a local `pg_dump` (same result; requires the client tools and
the connection string above):

```bash
pg_dump "$PGURL" -s -n public -n storage -n cron --no-owner --no-acl -f schema.sql
pg_dump "$PGURL" --data-only -n public --no-owner --no-acl -f data.sql
pg_dump "$PGURL" --role-only -f roles.sql
```

UNVERIFIED: an explicit `-s auth` dump (to capture `auth.users` without the
Supabase-managed internals) has **not been tested** against a hosted project. Try
it in the rehearsal and record what it produces — do not rely on it in an
incident until you have:

```bash
pg_dump "$PGURL" -s -n auth --no-owner --no-acl -f auth-schema-UNTESTED.sql
```

**(b) Storage objects — per bucket.**

```bash
for b in quiz-sources question-images avatars incident-footage; do
  npx supabase storage cp -r --linked "ss:///$b" "./mirror/$b"
done
```

> The `ss:///` scheme is the CLI's storage-path form (`ss:///<bucket>/<prefix>`);
> `--linked` targets the linked project's Storage API. UNVERIFIED: that
> `storage cp -r` round-trips nested prefixes cleanly — check the mirror's object
> count against `npx supabase storage ls -r --linked ss:///<bucket>` before
> trusting it, and record the result in the rehearsal (§10.4).

> **What this mirror is NOT.** `storage cp` copies **objects only**. It does
> **not** carry: bucket size limits, allowed MIME types, RLS policies, object
> versions, or ownership metadata. Those come from the migrations (§3.1 Step 6)
> plus the dashboard knobs snapshot (c). Restoring objects into a bucket whose
> limits/policies were never re-applied gives you a bucket that looks full and
> rejects uploads.

**(c) Auth users + dashboard knobs.**

The `pg_dump` above excludes the `auth` schema, so export users through the
Admin API. `listUsers` defaults to **`perPage: 50`** and the repo's own script
uses `perPage: 1000` (`scripts/seed-demo.mjs`) — **`perPage: 1000` silently
truncates past 1000 users.** Paginate:

```bash
node --input-type=module -e '
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = [];
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  out.push(...data.users);
  if (data.users.length < 1000) break;
}
fs.writeFileSync("auth-users.json", JSON.stringify(out, null, 2));
console.log("exported", out.length, "users");
'
```

> This exports user records, not password hashes: an Admin-API re-create mints
> new credentials. Treat the exported file as **secret** (it carries emails) and
> do not commit it.

Snapshot the dashboard knobs by hand into a text file next to the dumps —
a `db push` clobbers them (§2.7):

```bash
cat > dashboard-knobs.txt <<'EOF'
Max Rows:
enable_confirmations:
Site URL:
Redirect URLs:
SMTP host / from:
Realtime: notifications publication enabled? (yes/no)
Bucket limits (quiz-sources / question-images / avatars / incident-footage):
EOF
${EDITOR:-vi} dashboard-knobs.txt
```

**(d) Env + code snapshot.**

```bash
cp /home/deploy/innovision/.env       ./env.snapshot
cp /home/deploy/innovision/.env.local ./env.local.snapshot
chmod 600 env.snapshot env.local.snapshot
git -C /home/deploy/innovision rev-parse HEAD > git-head.txt
docker compose config > compose-resolved.yml
```

> ⚠️ `env.snapshot` / `env.local.snapshot` contain every secret. Store the
> backup directory encrypted and off-host (`gpg -c`, or a private bucket). An
> unencrypted backup on the same VPS protects you from nothing.

### 10.2 RPO / RTO — stated honestly

| Metric | Value | Why |
|---|---|---|
| **RPO** (data loss window) | = the interval between backups. With daily dumps, up to 24 h of uploads/answers/incidents are unrecoverable. | There is no WAL archiving / PITR on this setup |
| **RTO** (time to restore) | **UNKNOWN until rehearsed.** Restoring schema + data + roles + objects + users is a multi-step manual procedure, not one command. | §10.4 |

The free tier does not include point-in-time recovery. If the RPO above is
unacceptable for real student data, that is a Supabase Pro decision (§11.3), not
a script.

### 10.3 Restore procedure

> ⚠️ Restoring a `pg_dump`-produced schema needs a real `psql` (the dumps carry
> `psql` meta-commands that `supabase db query --file` may not understand).
> Install the Postgres client tools on the VPS:
> `sudo apt-get install -y postgresql-client`.

```bash
# 1. Freeze writes: stop the app so nothing lands mid-restore.
docker compose stop app

# 2. Restore roles first (grants reference them), then schema, then data.
psql "$PGURL" -f roles.sql
psql "$PGURL" -f schema.sql
psql "$PGURL" --data-only -f data.sql
```

Then, in order:

1. Re-apply the dashboard knobs from `dashboard-knobs.txt` (§2.7 checklist).
2. Restore storage objects per bucket (`storage cp` in the reverse direction).
3. Re-create auth users from `auth-users.json` via the Admin API — they will need
   password resets, and their **IDs must be preserved** or every FK in `public`
   pointing at `auth.users` breaks. UNVERIFIED: whether the Admin API allows an
   explicit `id` on create in this version — **verify in the rehearsal**; if not,
   the practical restore is "re-create users, then re-link rows", which changes
   the shape of the recovery.
4. Reconcile `schema_migrations` (§10.5).
5. `docker compose start app`, then run the §12 smoke.

### 10.4 ⚠️ Rehearse it — the round-trip is UNTESTED

The procedure above has **never been executed end to end**. Known unknowns: the
`-s auth` dump shape; whether Admin-API user re-creation preserves IDs; whether
`storage cp -r` round-trips nested prefixes cleanly; whether `schema.sql` applies
without error against a database that already has Supabase's managed objects in
place.

**Rehearse on a throwaway project before cutover:**

1. Create a scratch Supabase project.
2. Push the schema, seed it, upload a few objects.
3. Run §10.1 → record the exact outputs.
4. Run `db:reset:remote` against the scratch project (deliberate wipe).
5. Run §10.3 → measure the real RTO and record every deviation.
6. Only then fill in the RPO/RTO table above.

Until that rehearsal is done, **O3 is procedure-only** and a real incident is an
experiment on production data.

### 10.5 `schema_migrations` divergence

If a restore lands the schema but not the history (or vice versa), the fix is
`migration repair` — history only, no SQL re-run:

```bash
supabase migration list --linked        # local vs remote
supabase migration repair <version> --status applied
supabase migration repair <version> --status reverted
```

Plan the repairs as part of the restore: after `psql -f schema.sql`, every
migration whose objects now exist must be marked `applied`, or the next
`db push` will try to replay it.

---

## 11. Quotas (O2)

### 11.1 The free-tier math

| Resource | Free tier | This app's reality |
|---|---|---|
| Database | **500 MB** | Face embeddings live in Postgres (`profile_face_samples`, pgvector 512-dim) and press this. Quiz/question/answer rows are small; the embeddings are not |
| Storage | **1 GB total across all 4 buckets** | **40 decks × 25 MB = 1 GB alone** — a single class's source PDFs can consume the whole allowance |
| Bandwidth | **~5 GB/mo** | Signed-URL image reads + uploads + API traffic |
| Auth MAU | 50,000 | Not a constraint at this scale |
| Realtime connections | 200 concurrent | Only `notifications` |

The retention/prune crons are **load-bearing infrastructure, not hygiene**: they
are what keeps `incident-footage` and the DB from growing without bound.

### 11.2 What pausing stops — all 5 crons, in order of damage

Free-tier pausing halts every `pg_cron` job. The order in which that hurts:

1. **`innovision-flag-verify-silence`** (`* * * * *`, every minute) — the
   integrity bypass. A verification that stops reporting is what this job
   detects; with the job stopped, a student can suppress verification with no
   flag. **This is the first break, and it is silent.**
2. **`innovision-quiz-autoclose`** (`*/5 * * * *`) — sessions do not close on
   schedule.
3. **`innovision-incident-prune`** (`23 4 * * *`) and **`innovision-retention`**
   (`17 3 * * *`) — nothing is pruned, so storage and DB grow toward the quota.
4. **`innovision-notifications`** (`43 3 * * 6`) — weekly digest/cleanup stalls.

The **quota death spiral**: pause → no prune → storage crosses 1 GB → uploads
fail (which is an exam-critical path) → the only fix is deleting data you may
still need. Alert on cron state (§12.4) rather than discovering this from a
lecturer's failed upload.

### 11.3 Keep-alive vs Pro — decide BEFORE cutover

| Option | Cost | Gets you |
|---|---|---|
| Keep-alive ping (§9.4) | $0 | No pause (UNVERIFIED against the current policy) |
| Supabase Pro | **$25/mo** | No pausing, no cron gap, plus daily backups and PITR-adjacent features that shrink the RPO in §10.2 |

Decide and record it here: `keep-alive / Pro = ______`.
If real student assessments run on this stack, the integrity-bypass window in
§11.2 is the argument for Pro.

---

## 12. Verification (§6/O4)

### 12.1 VPS smoke script (gate O4)

`scripts/vps-smoke.mjs` is **standalone on purpose** (node builtins + the repo's
`@supabase/*`): every `verify-*.mjs` harness refuses a non-loopback target by
design, so it cannot be the deployment gate. It imports nothing from
`scripts/lib` — in particular not `remote-env.mjs`, which would make a read-only
smoke abort on the missing `PROD_CONFIRM_TOKEN`.

```bash
node scripts/vps-smoke.mjs --base-url https://<your-host> \
  --email <lecturer@example.edu> --password '<password>' \
  --expect-cron --expect-provider remote
```

| Flag | Default | Effect |
|---|---|---|
| `--base-url` | `http://127.0.0.1:3000` | App origin under test |
| `--email` / `--password` | — | Lecturer account for the authenticated checks. The password is never printed |
| `--expect-cron` | off | Makes `cron.*` failures **fatal**. Use it for the post-cutover run, **not** while cron is still being enabled |
| `--expect-provider` | `any` | `local` \| `remote` \| `any` — warns when the OCR probe reports a different leg; `any` also warns about `local` on a non-loopback base URL. **Pass `remote` on the VPS** |
| `--allow-ocr-unavailable` | off | Records the OCR probe as **SKIP + a prominent warning** instead of a failure. Use it ONLY when OCR is deliberately unconfigured on this host |
| `--sb-url` / `--anon-key` | from env/`.env.local` | Supabase URL / anon key for the login round trip, when they are not discoverable |

What it asserts (hard — a failure exits non-zero):

1. `GET /api/health` → 200, `ok === true`, `db.reachable === true`;
2. `GET /api/extract/ocr` **unauthenticated** → 401/403 (the auth gate is ON);
3. a login round trip (an in-memory cookie jar driven through `@supabase/ssr`,
   with a raw `token?grant_type=password` fallback — if both fail the check fails
   loudly, never silently);
4. an authenticated quiz-session fetch (SKIPPED, non-fatal, when no session id
   can be discovered — a fresh deployment legitimately has none);
5. `GET /api/extract/ocr` **authenticated** → `available === true` **plus** the
   probe shape the picker needs (`provider`, `maxPages`, `reason`).

> **Item 5 is a real assertion, not a shape check.** A probe reporting
> `available: false` **FAILS** and prints the `reason` with an actionable hint
> (`unreachable` / `auth` / `misconfigured` / `disabled` / `rate_limited` /
> `error`). So the post-cutover command above correctly fails when the OCR leg is
> broken or the key is bad — that is the point. If your OCR is *deliberately*
> unconfigured, add `--allow-ocr-unavailable` and accept the SKIP + warning;
> never let it report PASS.

**It only REPORTS the `cron` block** unless `--expect-cron` is passed. That is
deliberate: `/api/health` returns `ok: true` even when `cron.degraded: true`, so
a smoke asserting top-level `ok` would pass a deployment whose five schedules are
all dead. **Assert on `cron.*`, never on `ok`.**

### 12.2 Manual smoke

```bash
# Liveness + DB reachability (the same assertion the container's healthcheck makes).
curl -s https://<your-host>/api/health | jq '{ok, db, uptimeSec}'
# anon response has NO `cron` key (gate S6) — that is correct, not a bug.
# Cost note: the anon probe is 1 request when healthy and up to 4 while PostgREST
# is flapping (the Supabase client conditionally retries HEAD on 520/503/network
# error, max 3). The lecturer path adds the auth + role lookups.
```

| Check | Command / action | Expected |
|---|---|---|
| Liveness | `curl -s .../api/health \| jq .ok` | `true` |
| DB | `... \| jq .db.reachable` | `true` |
| **Cron** (lecturer session) | log in as a lecturer, then `GET /api/health` | a `cron` block with `jobs[5]` and `missing: []`. ⚠️ `cron.ok` is DATA-DEPENDENT: on a fresh project `neverRan` is non-empty until each schedule has fired once, so `ok:false` there is honest, not broken. Judge by `missing` + `neverRan`, not by `ok` alone |
| Login round trip | sign in in the browser | lands authenticated, no silent form reset |
| Quiz session | open a class → quiz → session as a student | loads, timer runs |
| OCR (remote leg) | lecturer → generate from file → AI Vision Scanner | picker shows the engine with a Cloud badge; a small PDF extracts |
| Storage | upload a quiz source | object appears, no 413 |
| TLS | `curl -sI https://<your-host>` | `HTTP/2 200`, HSTS present |

> **Assert on `cron.*`, never on top-level `ok`.** `/api/health` returns
> `ok: true` even when `cron.degraded: true` — a monitor that watches only `ok`
> reports a healthy system while the integrity silence-flag job has been dead for
> days.

### 12.3 In-image smoke of BOTH export routes

The app image's `exceljs` handling is **PROVISIONAL**: `serverExternalPackages:
["exceljs"]` opts it out of bundling (runtime `require`), the per-quiz export
reaches it through a **static** import (`export-workbook.ts`), and the gradebook
export through a **dynamic** `import()`. The Dockerfile copies
`node_modules/exceljs` explicitly to make both resolve — but that is unproven
until exercised in the running container.

```bash
# As a lecturer in the browser, against the VPS:
#   1. per-quiz export  → /api/quizzes/<id>/export
#   2. gradebook export → the cross-quiz gradebook's export
# EXPECTED: a .xlsx download.
# ON FAILURE: a typed 503 — NEVER a raw 500.
docker compose logs --tail=50 app | grep -i exceljs
```

A typed 503 means the module failed to resolve (the documented failure mode). A
raw 500 means an unhandled error path — that is a **different, worse** bug: file
it, do not wave it through.

### 12.4 CSP console watch

CSP ships **Report-Only** with a blanket `https:` in `connect-src`; it enforces
nothing. Before flipping it to enforcing:

1. Open the app in a browser with devtools, walk the critical paths — login,
   class, quiz authoring, exam boot (MediaPipe), OCR, export.
2. Watch the console for `Content-Security-Policy-Report-Only` violations.
3. **No enforcement flip until the console is clean** over a real usage window.
   UNVERIFIED: no clean-console duration has been measured, and no `report-to`
   collector exists in the code.
4. When flipping: pin the exact Supabase and Z.ai origins instead of the blanket
   `https:`, and remember the enforce-time delta — direct-hosted signed URLs need
   `https://*.supabase.co` added to `img-src` and `media-src`. Never keep a
   blanket `https:`.

### 12.5 What NOT to run here

`verify-*.mjs` (`npm run verify:face`, `verify:sessions`, …) are **local-only by
design** — they import `target-guard.mjs` and refuse a remote target. Running
them against the VPS is not a gate; the smoke above is. `verify-mediapipe.mjs` is
the one exception (network-free manifest check) and it runs in CI.

---

## 13. Failure-mode quick reference

| Symptom | Likely cause | Where to look |
|---|---|---|
| Login form "just resets", no error | Server action aborted: the browser Origin is not in the **baked** action allowlist | §4.3/§4.4 — rebuild with `ALLOWED_HOSTS` + `NEXT_PUBLIC_SITE_URL`/`SITE_URL` |
| `403 {"error":"invalid_origin"}` on mutations | `checkSameOrigin` rejected the Origin (runtime) | `TRUSTED_ORIGINS` (§4.4) |
| Emailed link goes to `localhost:3000` | `SITE_URL` unset/wrong, or the dashboard Site URL is wrong | §2.1, §4.2 |
| Container healthy but every page 500s | `PROD_ENV_STRICT` gate is not the cause (it exits). Likely a missing runtime env value | `docker compose logs app` |
| Container restart-loops immediately | A prod-env violation with `PROD_ENV_STRICT=1` (the gate exits the process) | §8.3 — read the log line, it names the KEYS |
| Container shows `unhealthy` but keeps serving | Health status is not an exit: `restart: unless-stopped` ignores it | §6.4 — alert from outside |
| OCR picker hides the engine | Remote probe failing: bad key, no balance, no entitlement, or a rejected 1×1 PNG probe | `docs/GLM_OCR_SETUP.md` §6.4/§6.7 |
| OCR POST returns 503 `glm_model_unavailable` | `GLM_SPEND_DISABLED=1`, missing `ZAI_API_KEY`, or a 401/403 from Z.ai | `[glm-usage]` / route logs; §8 |
| OCR POST returns 429 `glm_spend_cap` | Per-user daily token cap reached | §6.5 in the GLM guide |
| `429` on honest traffic from one classroom | `TRUSTED_PROXY_COUNT` collapsed every per-IP budget into one bucket | §5 |
| Certificates re-issued on every redeploy | Missing `caddy-data` / `caddy-config` volumes | §7.1 |
| Cron jobs absent with no error | pg_cron was not pre-enabled before `db push` | §3.1 Step 2/Step 5 |
| Migration aborted midway | `vector` not in the `extensions` schema | §3.1 Step 1, §3.2 |
| Storage uploads rejected after a push | Dashboard bucket limits/knobs clobbered by the push | §2.7 |
| Export route returns 503 | `exceljs` did not resolve in the image | §12.3 |

---

## Appendix — commands that are wrong to run here

| Don't | Why |
|---|---|
| `npm run db:reset:remote` (as a restore) | DATA NUKE — deletes all users + all objects, restores nothing (§10) |
| `docker compose down -v` | Deletes `caddy-data` → certificate re-issuance into ACME rate-limit lockout (§7.1) |
| `docker compose up -d glm-ocr` | nvidia reservation fails at create; the CPU fallback is not usable at classroom scale (§1.1) |
| `supabase db reset` on the VPS | Local-seam only; it replays migrations in a local Docker Postgres |
| `npm run gen:types` for the hosted project | `gen-types.mjs` is pinned to `--local` (§3.1 Step 7) |
| `docker compose up` without `-d` | Holds the terminal; the app is a long-running service |
| Editing `.env.local` to fix an origin | `NEXT_PUBLIC_*` / `ALLOWED_HOSTS` / the `/sb` gate are BUILD-time (§4.3) — rebuild |

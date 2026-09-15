# CI → GHCR → VPS deployment runbook

**Scope:** how a commit on `main` reaches the VPS, and how to set that pipeline up
from scratch. This complements [`DEPLOY_VPS.md`](./DEPLOY_VPS.md), which covers
the *host* (Supabase project, migrations, DNS, backups, cutover).

> **Status: UNVERIFIED end-to-end.** Nothing in this pipeline has been executed
> against a real VPS. Every step that can *silently succeed while doing nothing*
> says so below, and each one has a check you can run to prove it did something.
> The scripts were verified locally to the extent possible: workflow YAML parses
> under the repo's own linter, the shell scripts pass `bash -n`, the guard logic
> was exercised (kill-switch and loopback-URL refusals, rollback idempotency),
> and the `.dockerignore` rules were confirmed with a real build-context probe.

---

## 1. The shape of it

```
  push to main
        │
        ▼
  ┌─────────────┐   CI (.github/workflows/ci.yml)
  │     CI      │   lint · typecheck · unit · 15 verify:* harnesses ·
  └─────────────┘   next build · Playwright
        │  conclusion == success
        ▼
  ┌─────────────┐   Deploy (.github/workflows/deploy.yml)
  │   resolve   │   the EXACT commit CI validated (workflow_run.head_sha)
  ├─────────────┤
  │   build     │   deploy/build-images.sh --push  →  ghcr.io/<owner>/innovision-{app,insightface}:<sha>
  ├─────────────┤   (runs in parallel with migrate — see §4.5)
  │   migrate   │   deploy/sync-migrations.sh  →  supabase db push + verify
  ├─────────────┤
  │   deploy    │   SSH → VPS   (needs: migrate — schema lands before the image serves)
  └─────────────┘        │
                         ├─ git checkout --force <sha>
                         ├─ sops --decrypt  →  .env.local (0600)
                         ├─ docker compose pull
                         ├─ docker compose up -d --wait     ← app + insightface ONLY
                         └─ verify: health · loopback binds · baked vars
                                  │
                                  ▼
                            node scripts/vps-smoke.mjs   (ops gate O4)
```

**The deploy ships code AND schema.** A new image against an un-migrated schema
500s on whichever page touches the newest migration, so `migrate` gates the
rollout: if the schema push fails, the VPS keeps running the previous image
against the previous schema rather than being handed a half-deploy.

**The VPS runs two containers.** `app` (Next.js, publishing `127.0.0.1:3000`) and
`insightface-service` (publishing `127.0.0.1:8000`). Both are loopback-only; the
host nginx owns `:80`/`:443` and forwards to `127.0.0.1:3000`.

Two services are **profile-gated and must not start here**:

| Service | Profile | Why it is off |
|---|---|---|
| `caddy` | `tls` | nginx already owns `:80`/`:443`. Caddy would crash-loop on `bind: address already in use` while every other container stayed green — a failure that is invisible unless you read the restart counter |
| `glm-ocr` | `gpu` | No GPU on this host. The nvidia device reservation fails at create time; the CPU fallback wants 16g/8cpu at ~30 s/page. OCR runs on the Z.ai API instead (`GLM_PROVIDER=remote`) |

`deploy/remote-deploy.sh` enforces the first of those explicitly (step 3 stops a
leftover caddy from a pre-profile compose revision) rather than trusting the
profile gate alone.

---

## 2. Why the image is built in CI and not on the VPS

`COSTS.md` §2.1 flags vCPU build minutes as **UNVERIFIED** and recommends GHCR
pull over build-on-VPS. The insightface image compiles insightface 0.7.3 from
sdist (a Cython mesh extension) and bakes sha256-pinned model weights; building
it on a 2-vCPU host would also put a multi-minute CPU spike on the same box that
is serving students. GitHub runners are free for public repos, and the image is
built once and pulled many times.

---

## 3. One-time VPS setup

Assumes Ubuntu LTS with Docker, the compose plugin, and nginx already running
(`DEPLOY_VPS.md` §1 covers the host itself).

### 3.0 Run the preflight first

```bash
bash deploy/vps-preflight.sh
```

Read-only — it changes nothing. Checks the tooling (including whether `sops`
exists, which Debian's default repos do not carry), host resources, the **two
measured nginx breakages** (`client_max_body_size` / `proxy_read_timeout`),
port bindings, firewall state, the checkout, the age key's mode, and outbound
reachability to GHCR / Z.ai / your Supabase project.

Every `FAIL` aborts a deploy or breaks a feature at runtime; it exits non-zero so
it can gate a script. Run it on a fresh host, and again after any host rebuild.

### 3.1 Deploy user and checkout

```bash
# As root, once.
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy          # docker group == root-equivalent; see the note
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh

# Authorize the CI key (its PUBLIC half; the private half is the VPS_SSH_KEY secret).
#   ssh-ed25519 AAAA... github-actions-deploy
cat >> /home/deploy/.ssh/authorized_keys <<'EOF'
<paste the public key here>
EOF
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

sudo -u deploy git clone <your-repo-url> /home/deploy/innovision
```

> ⚠️ **Membership in `docker` is equivalent to root.** The daemon runs as root and
> a member can mount the host filesystem into a container. That is unavoidable
> for this design (the deploy user must run `docker compose`), so the SSH key
> for this account is a production credential: restrict it to this repo's
> Actions, and prefer a dedicated key over reusing a personal one. The workflow
> reads it from the `VPS_SSH_KEY` secret only.

### 3.2 nginx

Install the reference site config and replace the two `server_name` lines plus
the `ssl_certificate` paths with your host:

```bash
sudo cp deploy/nginx/innovision.conf /etc/nginx/sites-available/innovision
sudo ln -sf /etc/nginx/sites-available/innovision /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The file documents every `proxy_set_header` and why it is load-bearing. Two are
security controls rather than plumbing — `X-Real-IP` (overwrites a client-forged
value that `request-ip.ts` would otherwise trust as a rate-limit key) and
`X-Forwarded-For $proxy_add_x_forwarded_for` (appends, so the app's
rightmost-hop counting is correct). `proxy_buffering off` is required for the
streamed AI/SSE endpoints to appear incrementally.

### 3.3 Firewall — the Docker quirk

```bash
sudo ufw allow 22/tcp     # SSH FIRST — before default-deny exists
sudo ufw allow 80/tcp     # ACME HTTP-01 + the HTTP→HTTPS redirect
sudo ufw allow 443/tcp
sudo ufw allow 443/udp    # HTTP/3, optional
sudo ufw enable           # NOW turn it on
```

> ⚠️ **`default deny` before `allow 22` locks you out of SSH.** `ufw enable`
> applies the policy immediately; recovery is the provider's console.

**The Docker quirk, stated plainly:** Docker publishes ports by writing its own
`iptables` rules, which **bypass ufw's filter chain**. `sudo ufw deny 3000` does
**not** stop a container that publishes `0.0.0.0:3000`. The ufw rule is
belt-and-braces at best and actively misleading at worst.

**The real control is the loopback bind** in `docker-compose.yml`
(`127.0.0.1:3000:3000`, `127.0.0.1:8000:8000`). Verify the bind, not the
firewall rule:

```bash
ss -ltnp | grep -E ':(3000|8000|80|443)\b'
# 3000 and 8000 MUST show 127.0.0.1, not 0.0.0.0 or [::]
```

`deploy/remote-deploy.sh` step 7 performs exactly this check on every deploy and
**fails the rollout** if either port is bound to anything but loopback. If you
want a firewall rule that genuinely covers Docker, the correct mechanism is a
rule in the `DOCKER-USER` chain (which Docker evaluates before its own) — but for
this topology the loopback bind already makes it unnecessary, and a redundant
rule is one more thing to misconfigure.

### 3.4 Secrets: SOPS + age

```bash
# On a trusted machine (not the VPS).
bash deploy/secrets/bootstrap.sh          # generates the age keypair, wires the recipient
sops deploy/secrets/prod.env.enc          # fill in the real values

# Copy ONLY the private key to the VPS.
ssh root@<vps> 'install -d -m 700 -o deploy -g deploy /etc/innovision'
scp deploy/secrets/innovision-prod.agekey root@<vps>:/etc/innovision/age.key
ssh root@<vps> 'chown deploy:deploy /etc/innovision/age.key && chmod 600 /etc/innovision/age.key'

git add deploy/secrets/prod.env.enc deploy/secrets/.sops.yaml
git commit -m "chore(secrets): encrypt production env with SOPS+age"
```

> ⚠️ **Losing the age private key makes the committed `.enc` unrecoverable.**
> There is no escrow. Keep a copy in a password manager; that copy is the backup
> of record. `remote-deploy.sh` refuses to decrypt if the key file is not mode
> `600` — a world-readable private key protects the file only from the git
> history.

See [`deploy/secrets/README.md`](../deploy/secrets/README.md) for rotation and
the reasoning behind SOPS+age over the alternatives.

### 3.5 The sidecar token — set it ONCE, in SOPS

`FACE_SIDECAR_TOKEN` is the only secret that must hold the **same value on two
sides**, read through two different mechanisms:

| Side | Where it is read from |
|---|---|
| `app` container | `.env.local` (decrypted from SOPS) |
| `insightface-service` container | the **project-root `.env`** via compose interpolation |

You only ever edit the SOPS file — **`remote-deploy.sh` step 4b mirrors the value
into the project-root `.env` on every deploy**, so the two sides converge no
matter which was edited. Set it once:

```bash
sops deploy/secrets/prod.env.enc
#   FACE_SIDECAR_TOKEN=$(openssl rand -hex 32)
```

> ⚠️ **Do not set it by hand on the host.** Editing only `.env` leaves the app
> sending a different token than the sidecar expects, and the sidecar rejects a
> mismatch with 401 (`docker/insightface/app/main.py:_check_token`) — so every
> face enrolment and verification stops working while `/api/health` stays green.
> The same drift in reverse (sidecar set, app empty) fails identically, because
> the client omits the header entirely when its own copy is empty.

> ⚠️ An **empty** token is a `prod-guards` violation under `PROD_ENV_STRICT=1`
> and the app **refuses to boot** — by design: an unauthenticated `/extract` is
> an embedding oracle for anything that can reach it. `remote-deploy.sh` prints a
> `WARN` when it finds the token empty rather than letting you discover it at
> boot. The thrown error names the key, never the value.

### 3.6 Build-time vars: GitHub config, not the VPS

These are **inlined by `next build` on the runner**, so they belong to the
*image*, not the host:

| Kind | Name | Value |
|---|---|---|
| Variable | `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| Secret | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | hosted anon key |
| Variable | `SUPABASE_PROJECT_REF` | `<project-ref>` — the schema-push target |
| Secret | `SUPABASE_DB_PASSWORD` | database password (schema push) |
| Secret | `SUPABASE_ACCESS_TOKEN` | Supabase CLI token, `sbp_…` (schema push) |
| Variable | `SITE_ORIGIN` | `https://<your-host>` |
| Variable | `ALLOWED_HOSTS` | `<your-host>` |
| Variable | `VPS_HOST` / `VPS_USER` / `VPS_PORT` | target host, deploy user, optional port |
| Secret | `VPS_SSH_KEY` | private key for the deploy user |
| Secret | `SMOKE_EMAIL` / `SMOKE_PASSWORD` | optional; enables the post-deploy smoke |

> **This is not a stylistic split.** `NEXT_PUBLIC_*`, `ALLOWED_HOSTS` and the
> `/sb` rewrite gate are frozen into the artifact. Verified in this repo:
> `.next/standalone` contains the literal Supabase URL and does **not** contain
> the string `process.env.NEXT_PUBLIC_SUPABASE_URL`. An origin change is a
> **rebuild**, not a runtime env flip.
>
> The failure this prevents: a VPS `.env.local` naming one origin while the image
> baked another. The stack boots healthy and the symptom appears later as "the
> login form silently resets" (a rewritten Host breaks the server-action CSRF
> check) or "every browser-direct Supabase call fails" (a baked `127.0.0.1`
> origin resolves to the *student's* machine). `remote-deploy.sh` step 7 reads
> back what the running container reports it baked and **fails the deploy** on a
> mismatch.

Runtime secrets (`SUPABASE_SERVICE_ROLE_KEY`, `ZAI_API_KEY`, …) are in SOPS and
reach the host only at deploy time. `deploy/secrets/prod.env.example` is the
authoritative annotated list.

### 4.5 Schema migrations

`deploy/sync-migrations.sh` runs as the `migrate` job: link → dry-run → push →
verify. It is **idempotent** — with nothing pending it reports "up to date" and
exits 0, so every deploy can run it unconditionally.

**Why migrations run in CI and not on the VPS.** `SUPABASE_ACCESS_TOKEN` and the
database password can `ALTER`/`DROP` every table in the project. The app needs
neither: it talks to Supabase over HTTPS/PostgREST with the service-role key.
Putting schema-mutating credentials on the internet-facing host would widen a
host compromise from "read the data" to "rewrite the schema". The Supabase CLI is
already a devDependency, so CI gets a `package-lock.json`-pinned version via
`npm ci` and nothing has to be installed on the VPS.

**Ordering.** `migrate` runs in parallel with `build` and gates `deploy`. The one
state this permits is *schema advanced, build failed, nothing rolled out* — the
old image ignores the new columns, so it is benign and the pipeline is red. The
opposite serialization would put the schema step behind the multi-minute
insightface build on every run for no safety gain.

**Before the first push**, two extensions must already exist on the hosted
project or the push will *succeed while doing nothing useful*:

| Extension | Schema | Why |
|---|---|---|
| `vector` | `extensions` | `0001` installs it unqualified; `0039` hard-fails if it is elsewhere, aborting the push **mid-sequence** |
| `pg_cron` | — | The schedules live in guarded blocks (`0019/0022/0030/0042`) and `create extension pg_cron` needs superuser, so the push reports **success with zero jobs** |

Both are checked by the script *before* it pushes, with instructions. The second
is the dangerous one: because the migration versions are then recorded as
applied, re-running `db push` will **not** retry the schedules — the app looks
healthy while autoclose, the silence-flag check and both prunes never run. That
is why the script re-counts `cron.job` *after* the push and fails if the count is
wrong.

> ⚠️ **`db push` only applies migrations ABSENT from the remote history.** It is
> not "make remote match local". It also **re-asserts migration-owned dashboard
> settings** — Data API Max Rows, bucket limits, Realtime membership are
> reverted by design. The script prints that checklist on every run;
> `DEPLOY_VPS.md` §2.7 has the full list.

**Rollback does not revert migrations.** See §5.

**Running it by hand:**

```bash
SUPABASE_PROJECT_REF=<ref> \
SUPABASE_DB_PASSWORD=<pw> \
SUPABASE_ACCESS_TOKEN=<sbp_…> \
bash deploy/sync-migrations.sh --dry-run     # list pending, change nothing
```

---

## 4. GitHub setup

1. **Secrets** — Settings → Secrets and variables → Actions → *Secrets*: add
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `VPS_SSH_KEY`, and optionally
   `SMOKE_EMAIL` / `SMOKE_PASSWORD`.
2. **Variables** — same page → *Variables*: add `NEXT_PUBLIC_SUPABASE_URL`,
   `SITE_ORIGIN`, `ALLOWED_HOSTS`, `VPS_HOST`, `VPS_USER`, `VPS_PORT`.
3. **Environment** — Settings → Environments → `production`. The deploy job
   targets it, which gives a deployment record in the UI. Add *required
   reviewers* here if you want a human approval before production.
4. **Package visibility** — the first push creates two GHCR packages, private by
   default. Either set both to **public** (Settings → Packages) or give the VPS
   a token with `read:packages` and export `GHCR_USER`/`GHCR_TOKEN` on the host.
   `remote-deploy.sh` logs in only when both are present.

> ⚠️ **A typo in `workflows: ["CI"]` means the deploy never fires**, and nothing
> reports it — the workflow simply never appears in a run. It must match `name:`
> in `ci.yml` exactly. After the first push, confirm a "Deploy" run appeared in
> the Actions tab; if only "CI" ran, that is the cause.

---

## 5. Day-to-day

### Normal deploy

Push to `main`. CI runs; on success Deploy builds, pushes, and rolls out.

### Manual deploy or rollback

Actions → **Deploy** → *Run workflow*:

| Input | Effect |
|---|---|
| *(none)* | Build + deploy the current `main` |
| `ref: <sha>` | Deploy a specific commit |
| `rollback: true` | Redeploy the previous image refs recorded on the VPS (no build) |
| `skip_build: true` | Re-run only the rollout; images must already exist |

Rollback is also available directly on the host:

```bash
ssh deploy@<vps> 'cd /home/deploy/innovision && bash deploy/remote-deploy.sh --rollback'
```

> ⚠️ **Rollback moves the image, not the database.** The `migrate` job is
> SKIPPED on a rollback (reverting an image must not advance the schema), so a
> rollback leaves the schema at whatever the failed deploy pushed. That is safe
> only because migrations here are **additive** (`drop-if-exists` + `create`,
> never `drop column`): the older image simply ignores columns it does not know
> about.
>
> If a migration was genuinely destructive, a rollback is the **wrong tool** —
> the old image will not find the column it needs, and the fix is a forward
> migration that re-adds it, or a restore from backup (`DEPLOY_VPS.md` §10).
> Check before rolling back:
>
> ```bash
> git log --oneline <last-good-sha>..<bad-sha> -- supabase/migrations/
> grep -l -E 'drop (table|column)|alter .* drop' supabase/migrations/*.sql
> ```

### Rotating a secret

**Which class you are changing decides what to do.** Getting this wrong is the
usual cause of "I rotated it and nothing changed".

| Class | Where it lives | How to rotate |
|---|---|---|
| **Runtime** — `ZAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `LECTURER_INVITE_CODE`, `FACE_SIDECAR_TOKEN`, … | SOPS (`deploy/secrets/prod.env.enc`) | `sops …`, commit, push. Applied on the next deploy |
| **Build-time** — `NEXT_PUBLIC_*`, `SITE_ORIGIN`, `ALLOWED_HOSTS` | GitHub secrets/variables | Change in GitHub, re-run Deploy. **A runtime change cannot affect these** |
| **Deploy-time** — `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | GitHub secrets (CI only) | Change in GitHub; used by the next `migrate` job |

```bash
# Runtime secret
sops deploy/secrets/prod.env.enc     # edit
git commit -am "chore(secrets): rotate X" && git push
```

Nothing in SOPS is read at build time, so no rebuild is needed. Compose
**recreates** the container when `env_file` content changes (verified), so the
new value takes effect without `--force-recreate`.

**Adding a new runtime secret:** add it to `deploy/secrets/prod.env.example`
first — the CI env-parity check (`npm run check:env`) fails if the app reads a
key the template does not document, which is deliberate: an undocumented key
ships as an invisible misconfiguration.

**Two rotation traps:**

- **`FACE_SIDECAR_TOKEN` must match on both sides.** The app reads it from
  `.env.local`; the sidecar reads it from the project-root `.env`. Step 4b of
  `remote-deploy.sh` mirrors it automatically on every deploy, so you only ever
  edit SOPS. Edit it by hand on the host instead and you get a 401 on every face
  call while `/api/health` stays green.
- **`LECTURER_INVITE_CODE` has a grace window.** Rotating it outright kills
  signups already in flight (the confirmation email lands after the rotation and
  finds no valid code). Put the old value in `LECTURER_INVITE_CODE_PREVIOUS`
  while rolling over, then delete that line a day later.

**Verifying a rotation took effect:**

```bash
ssh deploy@<vps> 'cd /home/deploy/innovision && docker compose exec app env | grep -c "^ZAI_API_KEY=."'
ssh deploy@<vps> 'cd /home/deploy/innovision && grep -c "^FACE_SIDECAR_TOKEN=." .env .env.local'   # expect 2
```

### Reading the rollout log

`remote-deploy.sh` prints seven numbered steps. What to look for:

| Step | Healthy output |
|---|---|
| 3 | `no caddy container running` |
| 4 | `decrypted … -> .env.local (mode 600)` |
| 6 | `app + insightface-service healthy` |
| 7 | `port 3000 bound to 127.0.0.1`, `baked Supabase origin matches` |

Every failure path prints a `FAIL` line naming the cause and leaves the previous
stack running where it can. The final line always prints the rollback command.

---

## 6. What is still owed

Tracked here so the gaps are visible rather than implied:

| Item | Why it matters |
|---|---|
| **A real end-to-end run** | Nothing here has executed against a live VPS. The first run is the real test |
| **The first `db push` has not been run from this script** | The `vector`/`pg_cron` pre-enable checks and the post-push verification are written from `DEPLOY_VPS.md` §3.1, but the hosted project's current extension state is unknown. The first run will tell you |
| **vCPU build minutes** | The reason CI builds instead of the VPS. Unmeasured; if CI build time becomes a problem, that is where to look |
| **Classroom-scale load test** | `mem_limit`/`cpus` for the `app` service are **placeholders**, explicitly unvalidated in `docker-compose.yml`. A too-low `cpus` quota surfaces as SSE latency and healthcheck timeouts, not a crash |
| **Backup round-trip rehearsal** | `DEPLOY_VPS.md` §10.4 — until rehearsed, the restore path is procedure-only, and a real incident would be an experiment on production data |
| **Dashboard re-apply after push** | §4.5's checklist is printed but **not enforced** — Data API Max Rows and bucket limits are reverted by a push and must be re-applied by hand until something automates it |
| **CSP duration + `report-to` collector** | `DEPLOY_VPS.md` §6 |
| **`GLM_REMOTE_MAX_PAGES` 30-vs-100** | Unresolved conflict; 30 is the conservative arm |
| **Image provenance / signing** | Images are pushed by tag, not signed. `cosign` would let the VPS verify the image came from this repo's CI |

---

## 7. Files added by this workstream

| File | Purpose |
|---|---|
| `.github/workflows/deploy.yml` | `workflow_run` → build + migrate → SSH rollout |
| `deploy/vps-preflight.sh` | **Read-only host check** — run before the first deploy (and after a rebuild). Exits non-zero on any blocking issue |
| `deploy/build-images.sh` | Builds both images; **the single source of truth for build args**. Runs in CI and locally |
| `deploy/sync-migrations.sh` | Pushes `supabase/migrations` to the hosted project, then verifies history/cron/buckets. Idempotent |
| `deploy/remote-deploy.sh` | The VPS-side rollout: decrypt → pull → up → verify → rollback hint |
| `deploy/nginx/innovision.conf` | Reference nginx site (SSE, upload size, proxy headers, hop count) |
| `deploy/secrets/` | SOPS+age: `.sops.yaml`, `prod.env.example`, `bootstrap.sh`, `README.md` |
| `.gitattributes` | Forces LF on `*.sh`/`Dockerfile`/`*.yml` — the repo is developed on Windows with `core.autocrlf=true`, which would otherwise commit CRLF and break `bash` on the VPS with `bad interpreter: /bin/bash^M` |
| `docker-compose.yml` (modified) | `caddy` profile-gated under `tls`; all three images parameterized as `${APP_IMAGE:-…}` etc. for GHCR |
| `.gitignore` / `.dockerignore` (modified) | SOPS plaintext + private keys excluded from git; secrets excluded from the **build context** (the Dockerfile does `COPY . .`) |

## 8. Common failures

| Symptom | Cause |
|---|---|
| Deploy workflow never appears in the Actions tab | `workflows: ["CI"]` does not match `name:` in `ci.yml` — a typo fails silently |
| `migrate` fails: "could not read the remote migration history" | The free-tier project is **paused** (after ~7 days idle). Resume it in the dashboard and re-run |
| `migrate` fails: "the 'pg_cron' extension is NOT enabled" | The schedules would have been recorded as applied without ever running. Enable `pg_cron`, then re-run |
| `migrate` fails: "the hosted project has migration(s) this checkout does NOT" | Histories diverged — a migration was pushed from an unmerged branch, or deleted locally. Reconcile per `DEPLOY_VPS.md` §3.2 |
| `remote-deploy.sh` step 7: "BUILD/RUNTIME MISMATCH" | The image baked a different origin than this deployment expects. An origin change is a **rebuild**, not an env flip |
| `remote-deploy.sh` step 4: "sops decryption failed" | `AGE_KEY_FILE` is not the key the `.enc` was encrypted to, or its mode is not 600 |
| App container restarts, logs name `prod-guards` violations | `PROD_ENV_STRICT=1` is doing its job — a kill switch is armed or a gated token is empty. The error names the key, never the value |
| Caddy restart counter climbing, everything else green | A leftover Caddy from a pre-profile compose revision is fighting nginx for `:80`/`:443`. Step 3 of `remote-deploy.sh` stops it |

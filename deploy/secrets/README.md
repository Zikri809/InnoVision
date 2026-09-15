# Production secrets (SOPS + age)

This directory holds InnoVision's production secrets in **encrypted** form. The
plaintext exists in exactly two places: on the VPS (decrypted at deploy time,
mode 0600) and transiently on an operator's machine while editing.

| File | Tracked? | What it is |
|---|---|---|
| `.sops.yaml` | ✅ yes | SOPS config — the age **public** key and the file-matching rule |
| `prod.env.example` | ✅ yes | Documented template with empty values; the source for the `.enc` |
| `prod.env.enc` | ✅ yes | The **encrypted** secrets. This is the committed artifact |
| `prod.env` | ❌ gitignored | Decrypted plaintext (never write this here) |
| `innovision-prod.agekey` | ❌ gitignored | The **private** key. Never commit |

## First-time setup

```bash
bash deploy/secrets/bootstrap.sh
```

This generates the age keypair, writes the public key into `.sops.yaml`, and
encrypts the template. It refuses to run if `.sops.yaml` already targets a
*different* key — replacing a recipient would lock out whoever holds the old
private key, and the recovery path (`sops updatekeys`) needs that old key.

Then fill in real values:

```bash
sops deploy/secrets/prod.env.enc
```

`sops` opens the decrypted content in `$EDITOR` and re-encrypts on save. Only the
values change in the committed diff; the structure stays readable.

## Day-to-day

```bash
sops deploy/secrets/prod.env.enc            # edit (decrypt → $EDITOR → encrypt)
sops updatekeys deploy/secrets/prod.env.enc # re-wrap after a recipient change
```

> ⚠️ **Use `--input-type dotenv --output-type dotenv` for any non-editor
> command.** sops infers the format from the file **extension**, and `.enc` tells
> it nothing — so it falls back to JSON and fails on a dotenv file with:
>
> ```
> Error unmarshalling input json: invalid character 'S' looking for beginning of value
> ```
>
> which reads like a corrupt file and sends you debugging the wrong thing. The
> plain `sops <file>` edit form above is fine (sops round-trips the format it
> decrypts), but piping, `--decrypt`, and `--encrypt` all need the explicit flags:
>
> ```bash
> sops --decrypt --input-type dotenv --output-type dotenv deploy/secrets/prod.env.enc
> ```

## How the encryption actually works

There is no background process and nothing is encrypted "on the fly". The model
is **encrypt once, at edit time; decrypt once, at deploy time**:

```
  YOUR MACHINE                              THE VPS
  ────────────                              ───────
  sops <file>        ← you edit plaintext
        │
        │  on save: encrypts each VALUE in place
        ▼
  prod.env.enc  ──── committed to git ────→  prod.env.enc
  (ciphertext only)                          (ciphertext only)
                                                   │
                                                   │  deploy time:
                                                   │  sops --decrypt
                                                   ▼
                                             .env.local  (mode 0600)
                                             read by the app container
```

**What the committed file looks like** — real output, with the values replaced by
ciphertext:

```ini
SUPABASE_SERVICE_ROLE_KEY=ENC[AES256_GCM,data:TSqj1iHa9…,iv:/pp12ccJpD…,tag:TzFE0pbC…,type:str]
ZAI_API_KEY=ENC[AES256_GCM,data:/z9A/sGnDMsJgZPt0Xo=,iv:5iOKmLV8iOEDFAzRZbVhKh2UR0sqG4JhhDCyv9O1qJQ=,tag:J46qJXTnm4bE2KFHNFRN/g==,type:str]
LECTURER_INVITE_CODE=ENC[AES256_GCM,data:pTv6klH7l8HE9xn2VRzmRWq+,iv:hRl9m/8B63JYV1LpEeyvc8wKZC3XlOa1BTAwyqPRPGg=,tag:SEfaYa5epn+Cj+KZ51o3dg==,type:str]
sops_age__list_0__map_enc=-----BEGIN AGE ENCRYPTED FILE-----…
sops_age__list_0__map_recipient=age10c7t9asxm6kvurn6k426xr9gmtph3z070y0jdd6mmw6vkanf0c9qkpcuvy
sops_lastmodified=2026-09-15T08:28:03Z
sops_mac=ENC[AES256_GCM,data:eIWbLp+goH250UdpsI4fNfayrXQpJuMG2KcX/RennYcaMySOD6Uxt633j2xECmJZz034okQWMqqv+EASI6T7UifhqyeABQTBlLi/+Bn98ex7PoBl+4FkB3wJ9B+U0ptklw34BAruP0v2V6gTLNzTxerLHG04ZgaWfOipaWg28GA=,iv:1pvqsy0OjlK+9EIW8S529cz9P9viVM3AzxebVdZOksk=,tag:1xqHtAbPmoDhXIqgZ4JnBQ==,type:str]
sops_unencrypted_suffix=_unencrypted
sops_version=3.12.2
```

Four things to notice:

1. **The KEYS stay readable** (`ZAI_API_KEY=` is plaintext). That is deliberate —
   it is what makes `git diff` on a rotation show *which* secret changed without
   revealing the value.
2. **Each value is separately encrypted** (AES-256-GCM). A change to one value
   re-encrypts only that line; the rest keep their ciphertext, so diffs stay
   small.
3. **The recipient line is the PUBLIC key.** It is in the file on purpose — that
   is how sops knows who can read it, and a public key is safe to publish.
4. **`sops_mac`** is an authenticated tag over the whole file. Editing the
   ciphertext by hand (or a truncated commit) fails the MAC rather than
   decrypting to garbage.

**The private key never enters git and never enters the image.** It exists in
exactly two places: your machine (`deploy/secrets/innovision-prod.agekey`, gitignored)
and the VPS (`/etc/innovision/age.key`, mode 600). Everything else — the repo, the
container image, the CI logs — holds only ciphertext and the public key.

**Verified by running it** (sops 3.12.2, age 1.3.1): encrypt → the plaintext is
absent from the `.enc`; decrypt with the right key → the original values return;
decrypt with a *different* key → `Failed to get the data key required to decrypt
the SOPS file. Group 0: FAILED`, and no output file is written.

## What is deliberately NOT here

The **build-time** family — `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`, `SITE_URL`,
`ALLOWED_HOSTS`, `ALLOWED_ORIGINS` — lives in **GitHub Actions secrets**, not
here.

## Adding or rotating a secret

There are **three classes**, and which one you are changing decides what has to
happen. Getting this wrong is the usual cause of "I rotated it and nothing
changed" or "I rotated it and face verification broke".

### Class 1 — runtime secrets (SOPS, this directory)

`ZAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `LECTURER_INVITE_CODE`,
`FACE_SIDECAR_TOKEN`, `AI_API_KEY`, `TINYFISH_API_KEY`, …

```bash
sops deploy/secrets/prod.env.enc     # decrypt → $EDITOR → re-encrypt
git add deploy/secrets/prod.env.enc && git commit -m "chore(secrets): rotate X"
git push                              # CI passes → deploy applies it
```

**Adding a new one:** add it to `prod.env.example` (with a comment saying what
it is), then `sops deploy/secrets/prod.env.enc` and fill in the value. The
template is the contract — if an app var is missing there, the CI env-parity
check fails (`npm run check:env`), which is deliberate: an undocumented key ships
as an invisible misconfiguration.

**Does the app pick it up?** Yes, on the next deploy. Verified: Compose
**recreates** a container when `env_file` *content* changes, even with no other
edit — measured by rotating a value and observing a new container ID with the new
value visible inside. You do not need `--force-recreate`.

**`FACE_SIDECAR_TOKEN` is special — it must match on two sides.** The app reads
it from `.env.local`; the `insightface-service` container reads it from the
project-root `.env` via compose interpolation. `remote-deploy.sh` step 4b
**mirrors it automatically on every deploy**, so you only ever edit the SOPS
file. If you edit it by hand on the host instead, you will get a 401 on every
face call while `/api/health` stays green — the sidecar rejects a mismatch
(`docker/insightface/app/main.py:_check_token`) and the app's client omits the
header entirely when its own copy is empty.

**Rotating `LECTURER_INVITE_CODE` has a grace mechanism.** Rotating it outright
breaks signups already in flight: a student submitted the old code, and their
email confirmation lands *after* the rotation, so the promotion half finds no
valid code and the signup dies with nothing actionable. Set the old value in
`LECTURER_INVITE_CODE_PREVIOUS` while rolling over, then delete that line a day
later.

### Class 2 — build-time values (GitHub, NOT here)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SITE_ORIGIN` /
`NEXT_PUBLIC_SITE_URL` / `SITE_URL`, `ALLOWED_HOSTS`, `ALLOWED_ORIGINS`.

These are **inlined by `next build`** on a GitHub runner, so changing them here
would do nothing. Rotate via Settings → Secrets and variables → Actions, then
re-run the Deploy workflow — **a runtime env change cannot affect them**, and an
origin change is a rebuild.

The mechanical proof, from this repo: `.next/standalone` contains the literal
Supabase URL and does **not** contain the string
`process.env.NEXT_PUBLIC_SUPABASE_URL`. Keeping them in both places would invite
exactly the divergence the runbook warns about — an image built against one
origin deployed beside an env file naming another. `remote-deploy.sh` step 7
verifies the running image actually baked what CI intended.

### Class 3 — deploy-time credentials (GitHub, CI-only)

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` (with `SUPABASE_PROJECT_REF` as a
variable) — used only by the `migrate` job, never by the app or the VPS. Rotate
them in GitHub secrets; the next deploy uses the new value.

**Rotating the database password** is the one that needs care: it is also stored
in Supabase, so change it there first (Dashboard → Settings → Database → Reset
database password), then update the GitHub secret. A deploy that runs in between
fails at the `migrate` job — which correctly gates the rollout, so the VPS keeps
serving the previous image rather than half-deploying.

## Verifying a rotation took effect

```bash
# Which image/env the running container actually has:
ssh deploy@<vps> 'cd /home/deploy/innovision && docker compose exec app env | grep -c "^ZAI_API_KEY=."'

# The sidecar token matches on both sides (count must be 2):
ssh deploy@<vps> 'cd /home/deploy/innovision && grep -c "^FACE_SIDECAR_TOKEN=." .env .env.local'
```

`remote-deploy.sh` prints a `WARN` if `FACE_SIDECAR_TOKEN` is empty, because that
is a `prod-guards` violation under `PROD_ENV_STRICT=1` and the app will refuse to
boot — the error names the key, never the value.


## ⚠️ The private key is the single point of failure

Losing `innovision-prod.agekey` makes the committed `.enc` **unrecoverable**.
There is no escrow and no recovery path — that is the trade-off age makes in
exchange for not depending on a cloud KMS, and it is the right trade for a host
you want to be able to rebuild without an account. Keep a copy in a password
manager and treat that copy as the backup of record.

On the VPS the key lives at `/etc/innovision/age.key`, owned by the deploy user,
mode **600**. `deploy/remote-deploy.sh` refuses to decrypt if the mode is
anything else — a world-readable private key protects the file only from the git
history, not from anything else on the box.

## Why SOPS + age rather than the alternatives

| Option | Why not |
|---|---|
| Plaintext `.env` on the VPS only | Nothing is versioned. A rebuild-from-nothing means reconstructing every secret from memory. This was the state before this directory existed |
| GitHub Actions secrets only | Cannot be read by the VPS at runtime, and putting the service-role key in CI widens its exposure to every workflow run for no benefit |
| A cloud KMS (AWS/GCP/Vault) | Requires an account, network access, and IAM plumbing to decrypt. Overkill for a single-VPS deployment, and it adds a dependency that can be down when you need to redeploy |
| Encrypted archive in the repo (gpg) | Workable, but `sops` gives per-value diffs and keeps the file structured, so a rotation is reviewable in a PR instead of being one opaque blob |

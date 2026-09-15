#!/usr/bin/env bash
#
# bootstrap.sh — first-time SOPS+age setup for production secrets.
#
# Run ONCE, on a trusted machine (an operator's laptop, not the VPS). It
# generates the age keypair, wires the public key into .sops.yaml, and encrypts
# the template into deploy/secrets/prod.env.enc.
#
#   bash deploy/secrets/bootstrap.sh
#
# Afterwards, edit secrets with:
#   sops deploy/secrets/prod.env.enc
#
# ── WHY AGE AND NOT A CLOUD KMS ──────────────────────────────────────────────
# Decryption must work on a bare VPS over SSH with no account, no network call,
# and no IAM role. age is a single binary and a single key file, which is the
# only shape that survives a provider outage or a rebuilt host. The trade-off is
# real and stated plainly: the key is a FILE, so losing it means losing the
# ability to decrypt the committed file (see step 3's warning).
#
# ── WHY THIS IS A SCRIPT ─────────────────────────────────────────────────────
# The setup has four steps that must agree with each other (key generated →
# recipient written into .sops.yaml → file encrypted to THAT recipient →
# decryption verified). Doing it by hand is how you end up with a .enc file
# encrypted to a placeholder recipient that nothing can open — a failure you
# discover at deploy time, on the VPS, with the old stack already stopped.

set -euo pipefail

cd "$(dirname "$0")/../.." || exit 1

SOPS_YAML="deploy/secrets/.sops.yaml"
TEMPLATE="deploy/secrets/prod.env.example"
ENC_FILE="deploy/secrets/prod.env.enc"
KEY_DIR="deploy/secrets"
KEY_FILE="${KEY_DIR}/innovision-prod.agekey"

step() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   \033[0;32mOK\033[0m  %s\n' "$*"; }
warn() { printf '   \033[0;33mWARN\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[0;31mFAIL\033[0m  %s\n' "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────

step "0/5  Preflight"

command -v sops >/dev/null 2>&1 || die "sops not found. Install:
    macOS   brew install sops
    Debian  apt-get install -y sops    (or grab the release binary)
    Windows winget install Mozilla.sops   (or use WSL — the deploy scripts are bash)
See https://github.com/getsops/sops/releases"
command -v age-keygen >/dev/null 2>&1 || die "age-keygen not found. Install:
    macOS   brew install age
    Debian  apt-get install -y age
    Windows winget install FiloSottile.age
See https://github.com/FiloSottile/age/releases"

[ -f "$SOPS_YAML" ] || die "missing $SOPS_YAML"
[ -f "$TEMPLATE" ] || die "missing $TEMPLATE"
ok "sops + age-keygen present"

# ── Step 1: keypair ──────────────────────────────────────────────────────────

step "1/5  age keypair"

if [ -f "$KEY_FILE" ]; then
  ok "reusing existing key $KEY_FILE"
else
  # The key file is gitignored (deploy/secrets/*.agekey). It is created 0600
  # here; on the VPS the same key must live at /etc/innovision/age.key with the
  # same mode, which deploy/remote-deploy.sh enforces before it will decrypt.
  age-keygen -o "$KEY_FILE" 2>/dev/null || die "age-keygen failed"
  chmod 600 "$KEY_FILE"
  ok "generated $KEY_FILE (mode 600)"
fi

# `age-keygen -y` prints the PUBLIC key for a private key file. Extracted here
# rather than stored separately so the pair cannot drift.
PUBKEY="$(age-keygen -y "$KEY_FILE" 2>/dev/null || true)"
[ -n "$PUBKEY" ] || die "could not derive the public key from $KEY_FILE — is it a valid age key file?"
info "public key: $PUBKEY"

# ── Step 2: wire the recipient into .sops.yaml ───────────────────────────────

step "2/5  Configure .sops.yaml"

# The committed .sops.yaml ships with an obvious placeholder so that a
# half-finished setup is visible rather than plausible. Replace it on first run;
# on later runs confirm it already matches.
if grep -q 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' "$SOPS_YAML"; then
  # Portable in-place edit: `sed -i` differs between GNU and BSD, so write a
  # temp file and move it. The recipient is the only thing replaced.
  awk -v key="$PUBKEY" '
    /age1qqqqqqqq/ { print "      " key; next }
    { print }
  ' "$SOPS_YAML" > "${SOPS_YAML}.tmp" && mv "${SOPS_YAML}.tmp" "$SOPS_YAML"
  ok "recipient written into $SOPS_YAML"
elif grep -q "$PUBKEY" "$SOPS_YAML"; then
  ok "$SOPS_YAML already targets this key"
else
  # A DIFFERENT key is already configured. Overwriting it would re-encrypt to
  # the new key and lock out whoever holds the old one — refuse and let the
  # operator decide (the recovery path is `sops updatekeys`, which requires the
  # OLD private key).
  die "$SOPS_YAML targets a DIFFERENT age key than $KEY_FILE.
    If you intend to ADD this key as an additional recipient, edit $SOPS_YAML
    by hand (a comma-separated list is allowed) and run: sops updatekeys $ENC_FILE
    Refusing to silently replace the existing recipient."
fi

# ── Step 3: encrypt ──────────────────────────────────────────────────────────

step "3/5  Encrypt the template"

if [ -f "$ENC_FILE" ]; then
  warn "$ENC_FILE already exists — leaving it ALONE."
  info "To add/rotate values:  sops $ENC_FILE"
  info "(Re-running the encrypt below would overwrite it with the template.)"
else
  # `sops --encrypt` reads the creation_rules from .sops.yaml, which is why the
  # recipient had to be wired in first.
  #
  # ⚠️ `--config` IS REQUIRED — not decoration.
  # sops auto-discovers .sops.yaml ONLY from the CURRENT directory (measured,
  # sops 3.13.3: it does not walk up/down the tree, and it does not resolve
  # relative to the input file). This script cd's to the REPO ROOT but the
  # config lives at deploy/secrets/.sops.yaml, so without --config the encrypt
  # fails with:
  #
  #     config file not found, or has no creation rules, ...
  #
  # `--filename-override` is ALSO required: path_regex matches the INPUT file's
  # path (prod.env.example), not the .enc the redirect creates, and the rule is
  # anchored to \.enc$ — without it: "no matching creation rules found".
  #
  # Both flags together, measured: encrypt succeeds and the result round-trips.
  sops --config "$SOPS_YAML" \
       --filename-override "$ENC_FILE" \
       --encrypt --input-type dotenv --output-type dotenv "$TEMPLATE" > "$ENC_FILE" \
    || { rm -f "$ENC_FILE"; die "encryption failed — see the --config/--filename-override note in this script"; }
  ok "wrote $ENC_FILE"
  info "The template's values are EMPTY — fill them in:  sops $ENC_FILE"
fi

# ── Step 4: prove it round-trips ─────────────────────────────────────────────

step "4/5  Verify decryption"

# The single most valuable check here: an .enc that cannot be decrypted is only
# discovered at deploy time, on the VPS, with the old stack already torn down.
# The flags MUST match what remote-deploy.sh uses, or this check would pass on
# a file the deploy cannot read.
if SOPS_AGE_KEY_FILE="$KEY_FILE" sops --decrypt \
     --input-type dotenv --output-type dotenv "$ENC_FILE" >/dev/null 2>&1; then
  ok "decrypts with $KEY_FILE"
else
  die "$ENC_FILE does NOT decrypt with $KEY_FILE. The deploy would fail. Check that .sops.yaml's recipient matches the public key above."
fi

# ── Step 5: what to do next ──────────────────────────────────────────────────

step "5/5  Next steps"

cat <<EOF

   1. Fill in the real values:
        sops $ENC_FILE

   2. Copy the private key to the VPS (ONLY the private key — never the
      decrypted env file, and never over a channel you would not send a
      password over):

        ssh root@<vps> 'install -d -m 700 /etc/innovision'
        scp $KEY_FILE root@<vps>:/etc/innovision/age.key
        ssh root@<vps> 'chown deploy:deploy /etc/innovision/age.key && chmod 600 /etc/innovision/age.key'

      ⚠️  LOSING THIS KEY MAKES THE COMMITTED FILE UNRECOVERABLE.
          There is no escrow. Keep a copy in a password manager and treat it as
          the backup of record.

   3. Commit the ENCRYPTED file (the plaintext is gitignored):
        git add $ENC_FILE $SOPS_YAML
        git commit -m "chore(secrets): encrypt production env with SOPS+age"

   4. Set the GitHub Actions secrets the BUILD needs (see
      docs/DEPLOY_CICD.md §4). These are separate from this file on purpose:
      they are inlined by \`next build\` on the runner, so the VPS never sees
      them and cannot change them.

EOF

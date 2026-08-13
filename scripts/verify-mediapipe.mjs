// Phase 6 — verify the committed MediaPipe assets against MANIFEST.json.
//
// Enumeration is PINNED: it hashes only the files under the two fixed
// directories (`public/mediapipe/` + `public/models/`), compares each against
// the manifest, rejects any manifest key containing `\`, `..`, a leading `/`,
// or a drive-letter prefix (forward-slash separators are required), and
// rejects unlisted files (tamper = extra file detected).
//
// Deterministic and network-free (assets are committed), so it is safe to run
// in CI after `npm run build`.
//
// Run: node scripts/verify-mediapipe.mjs
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_MEDIAPIPE = path.join(ROOT, "public", "mediapipe");
const PUBLIC_MODELS = path.join(ROOT, "public", "models");
const MANIFEST_PATH = path.join(PUBLIC_MODELS, "MANIFEST.json");

let failures = 0;
function fail(msg) {
  failures++;
  console.error(`FAIL  ${msg}`);
}
function ok(msg) {
  console.log(`PASS  ${msg}`);
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Collect relative paths (forward-slash keys) of every file under the two dirs.
function collectFiles(absDir, dirKey) {
  const out = [];
  if (!fs.existsSync(absDir)) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const key = `${dirKey}/${entry.name}`;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(abs, key));
    } else {
      out.push(key);
    }
  }
  return out;
}

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error("public/models/MANIFEST.json is missing. Run `node scripts/vendor-mediapipe.mjs` first.");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const files = manifest.files ?? {};
if (typeof files !== "object" || Array.isArray(files) || files === null) {
  console.error("FAIL  MANIFEST.json `files` must be an object mapping relative path → { sha256 }.");
  process.exit(1);
}

const manifestKeys = Object.keys(files);
for (const key of manifestKeys) {
  // Keys are relative forward-slash paths ("mediapipe/vision_bundle.mjs").
  // Reject anything that could escape the pinned dirs: backslash separators,
  // `..` traversal, or absolute paths (leading "/", drive letters).
  if (
    key.includes("\\") ||
    key.includes("..") ||
    key.startsWith("/") ||
    /^[A-Za-z]:/.test(key)
  ) {
    fail(`manifest key "${key}" is not a safe relative path — refusing to verify.`);
  }
}

const dirKeys = {
  [path.join("mediapipe")]: PUBLIC_MEDIAPIPE,
  [path.join("models")]: PUBLIC_MODELS,
};

// ── 1. Every manifest key must exist and hash-match ────────────────────────
let checked = 0;
for (const key of manifestKeys) {
  const entry = files[key];
  if (typeof entry !== "object" || entry === null || typeof entry.sha256 !== "string") {
    fail(`manifest entry for "${key}" is malformed (expected { sha256: string }).`);
    continue;
  }
  const abs = path.join(ROOT, "public", ...key.split("/"));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    fail(`manifest file missing (or not a file): ${key}`);
    continue;
  }
  const actual = sha256File(abs);
  if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
    fail(`SHA-256 mismatch for ${key}\n  expected: ${entry.sha256}\n  actual:   ${actual}`);
  } else {
    checked++;
  }
}

// ── 2. No unexpected files under the pinned dirs (tamper detection) ────────
for (const [dirKey, absDir] of Object.entries(dirKeys)) {
  const onDisk = collectFiles(absDir, dirKey);
  // MANIFEST.json is the manifest itself, not a tracked asset — skip it.
  const unlisted = onDisk.filter((k) => !(k in files) && !k.endsWith("/MANIFEST.json"));
  for (const k of unlisted) {
    fail(`unlisted file present under public/${dirKey}: ${k}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} integrity error(s). Do not deploy these assets.`);
  process.exit(1);
}

const wasmFiles = Object.keys(files).filter((k) => k.startsWith("mediapipe/wasm/") && k.endsWith(".wasm")).length;
ok(`manifest has ${manifestKeys.length} entries; ${checked} files hash-verified`);
ok(`pinned dirs have no unlisted files (bundle + ${wasmFiles} wasm + model)`);
console.log(`\nverify-mediapipe: all assets intact.`);

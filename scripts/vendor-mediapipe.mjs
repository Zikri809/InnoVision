// Phase 6 + 7 — vendor the MediaPipe runtime + hand/face landmarker models into
// `public/` so the app is self-hosted (venue Wi-Fi blocks Google CDN) and CI is
// network-free/deterministic.
//
// What it does:
//  1. Reads the package root from `node_modules/@mediapipe/tasks-vision`
//     (exits 1 with instructions if missing — run `npm i` first).
//  2. Always (re)copies `vision_bundle.mjs` → `public/mediapipe/` and the
//     `wasm/` directory → `public/mediapipe/wasm/` (idempotent overwrite).
//  3. Downloads `hand_landmarker.task` + `face_landmarker.task` →
//     `public/models/` ONLY if absent; the bytes are verified against hardcoded
//     SHA-256 hashes (fail loudly on mismatch/non-file/content-type). Writes
//     `public/models/MANIFEST.json`.
//  4. Verifies the vendored bundle makes NO external network calls
//     (`https://` occurrences must only be comments; a non-comment URL is a
//     hard failure).
//
// Run: node scripts/vendor-mediapipe.mjs
// After committing, `node scripts/verify-mediapipe.mjs` re-checks integrity
// (also wired into CI after `npm run build`).
import fs from "node:fs";
import https from "node:https";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PKG_ROOT = path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision");
const PUBLIC_MEDIAPIPE = path.join(ROOT, "public", "mediapipe");
const PUBLIC_MODELS = path.join(ROOT, "public", "models");

const BUNDLE_REL = "mediapipe/vision_bundle.mjs";
const WASM_DIR = "wasm";
const HAND_MODEL_REL = "models/hand_landmarker.task";
const FACE_LANDMARKER_REL = "models/face_landmarker.task";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_LANDMARKER_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HAND_MODEL_VERSION = "float16/1";
const FACE_LANDMARKER_VERSION = "float16/1";
// Hardcoded SHA-256 of hand_landmarker.task at HAND_MODEL_URL (verified once at
// vendoring time; the committed bytes + verify-mediapipe.mjs enforce it in CI).
const HAND_MODEL_SHA256 = "FBC2A30080C3C557093B5DDFC334698132EB341044CCEE322CCF8BCF3607CDE1";
// Hardcoded SHA-256 of face_landmarker.task at FACE_LANDMARKER_URL.
const FACE_LANDMARKER_SHA256 = "64184E229B263107BC2B804C6625DB1341FF2BB731874B0BCC2FE6544E0BC9FF";
const PACKAGE_VERSION = "1.0.1";

// The stock MediaPipe bundle embeds a Google telemetry logger that POSTs to
// this URL every 60s while a task graph is alive. Self-hosting must not phone
// home (venue Wi-Fi + privacy), so we neutralize it at vendor time by
// rewriting the URL to a local inert path — any accidental flush then fails
// fast with a local 404 instead of exfiltrating. The rewrite is applied to the
// COPY in public/mediapipe only; node_modules stays pristine.
const TELEMETRY_URL = "https://odml.pa.googleapis.com/v1/log";
const TELEMETRY_DISABLED_PATH = "/__mediapipe_telemetry_disabled__";

let failures = 0;
function fail(msg) {
  failures++;
  console.error(`ERROR: ${msg}`);
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const contentType = res.headers["content-type"] ?? "";
      if (!contentType.includes("application/octet-stream")) {
        res.resume();
        reject(new Error(`Unexpected content-type "${contentType}" for ${url}`));
        return;
      }
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on("finish", () => {
        out.close(() => {
          fs.renameSync(tmp, dest);
          resolve();
        });
      });
      out.on("error", (err) => {
        fs.rmSync(tmp, { force: true });
        reject(err);
      });
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`Timed out fetching ${url}`));
    });
  });
}

if (!fs.existsSync(path.join(PKG_ROOT, "package.json"))) {
  console.error(
    "node_modules/@mediapipe/tasks-vision is missing. Run `npm i` (or `npm ci`) first.",
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
if (pkg.version !== PACKAGE_VERSION) {
  console.error(
    `Version mismatch: vendored bundle is @mediapipe/tasks-vision@${pkg.version}, ` +
      `expected ${PACKAGE_VERSION}. Re-pin the dependency (--save-exact) and re-run.`,
  );
  process.exit(1);
}

// ── 1. Copy bundle + wasm (always, idempotent) ─────────────────────────────
fs.mkdirSync(PUBLIC_MEDIAPIPE, { recursive: true });
const bundleSrc = fs.readFileSync(path.join(PKG_ROOT, "vision_bundle.mjs"), "utf8");
if (bundleSrc.includes(TELEMETRY_URL)) {
  console.log(`Neutralizing bundled telemetry URL (${TELEMETRY_URL}) …`);
}
const bundlePatched = bundleSrc.split(TELEMETRY_URL).join(TELEMETRY_DISABLED_PATH);
fs.writeFileSync(path.join(ROOT, "public", ...BUNDLE_REL.split("/")), bundlePatched);
copyDir(path.join(PKG_ROOT, WASM_DIR), path.join(PUBLIC_MEDIAPIPE, WASM_DIR));
console.log(`Copied vision_bundle.mjs (telemetry-neutralized) + wasm/ → public/${BUNDLE_REL.split("/")[0]}/`);

// ── 2. Download models only if absent; always verify SHA-256 ────────────────
fs.mkdirSync(PUBLIC_MODELS, { recursive: true });

async function ensureModel(rel, url, sha256, label) {
  const dest = path.join(ROOT, "public", ...rel.split("/"));
  if (!fs.existsSync(dest)) {
    console.log(`Downloading ${label} …`);
    await download(url, dest);
    console.log("Download complete.");
  } else {
    console.log(`${label} already present — skipping download.`);
  }
  const hash = sha256File(dest).toUpperCase();
  if (hash !== sha256) {
    fail(
      `${label} SHA-256 mismatch.\n  expected: ${sha256}\n  actual:   ${hash}\n` +
        "The model changed or is corrupt. Do NOT commit it — fix the download, then re-run.",
    );
    return null;
  }
  return hash;
}

const handModelHash = await ensureModel(
  HAND_MODEL_REL,
  HAND_MODEL_URL,
  HAND_MODEL_SHA256,
  "hand_landmarker.task",
);
const faceLandmarkerHash = await ensureModel(
  FACE_LANDMARKER_REL,
  FACE_LANDMARKER_URL,
  FACE_LANDMARKER_SHA256,
  "face_landmarker.task",
);

// ── 3. Build the manifest over the two pinned directories ──────────────────
const manifest = {
  version: PACKAGE_VERSION,
  files: {},
};
function addDirToManifest(dirRel, absDir) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${dirRel}/${entry.name}`;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      addDirToManifest(rel, abs);
    } else {
      manifest.files[rel] = {
        sha256: sha256File(abs),
        sourceUrl: entry.name.endsWith(".wasm") || entry.name.endsWith(".mjs")
          ? `node_modules/@mediapipe/tasks-vision@${PACKAGE_VERSION}/${entry.name}`
          : undefined,
        version: PACKAGE_VERSION,
      };
    }
  }
}
manifest.files[BUNDLE_REL] = {
  sha256: sha256File(path.join(ROOT, "public", ...BUNDLE_REL.split("/"))),
  sourceUrl: `node_modules/@mediapipe/tasks-vision@${PACKAGE_VERSION}/vision_bundle.mjs`,
  version: PACKAGE_VERSION,
};
addDirToManifest("mediapipe/wasm", path.join(PUBLIC_MEDIAPIPE, WASM_DIR));
manifest.files[HAND_MODEL_REL] = {
  sha256: handModelHash,
  sourceUrl: HAND_MODEL_URL,
  version: HAND_MODEL_VERSION,
};
manifest.files[FACE_LANDMARKER_REL] = {
  sha256: faceLandmarkerHash,
  sourceUrl: FACE_LANDMARKER_URL,
  version: FACE_LANDMARKER_VERSION,
};

fs.writeFileSync(
  path.join(PUBLIC_MODELS, "MANIFEST.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

// ── 4. Bundle must make no external network calls ──────────────────────────
const bundleText = fs.readFileSync(path.join(ROOT, "public", BUNDLE_REL), "utf8");
const urls = [...bundleText.matchAll(/https?:\/\/[^\s"'`]+/g)].map((m) => m[0]);
const nonComment = urls.filter((u) => {
  const idx = bundleText.indexOf(u);
  return !/^\s*\/\//.test(bundleText.slice(Math.max(0, idx - 3), idx));
});
if (nonComment.length > 0) {
  fail(
    `vision_bundle.mjs references external URLs outside comments: ${nonComment.join(", ")}. ` +
      "Self-hosting would still phone home; investigate before committing.",
  );
}

if (failures > 0) {
  console.error(`\n${failures} error(s) — see above. Nothing was committed by this run's checks.`);
  process.exit(1);
}

const wasmFiles = fs.readdirSync(path.join(PUBLIC_MEDIAPIPE, WASM_DIR)).filter((f) => f.endsWith(".wasm"));
console.log(
  `\nVendored OK:\n  ${BUNDLE_REL}\n  mediapipe/wasm/ (${wasmFiles.length} .wasm files)\n  ${HAND_MODEL_REL} (${handModelHash})\n  ${FACE_LANDMARKER_REL} (${faceLandmarkerHash})\n  MANIFEST.json written.`,
);
console.log("Commit public/mediapipe/ + public/models/, then run `node scripts/verify-mediapipe.mjs`.");

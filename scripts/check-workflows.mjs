/**
 * CI-bootstrap workflow validation (H3-INFRA-F1 recurrence guard).
 *
 * An unparseable `.github/workflows/*.yml` does not fail any job — GitHub
 * falls back to naming every run `.github/workflows/ci.yml` and reports a
 * single anonymous failure, so a one-character YAML error silently disables
 * EVERY gate in the file. That has now happened twice (commits 1c258c3→50bfa19
 * and b466260), each time masked by a second breakage.
 *
 * This parses every workflow file with js-yaml and exits non-zero on a parse
 * error (or a missing `jobs:` map), so the failure is loud and early.
 *
 * Run: npm run lint:workflows
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, "..", ".github", "workflows");

let failures = 0;
let checked = 0;

let files;
try {
  files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
} catch (err) {
  console.error(`workflow lint: cannot read ${WORKFLOWS_DIR}: ${err.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`workflow lint: no workflow files found under ${WORKFLOWS_DIR}`);
  process.exit(1);
}

for (const file of files.sort()) {
  const full = join(WORKFLOWS_DIR, file);
  checked += 1;
  let doc;
  try {
    doc = yaml.load(readFileSync(full, "utf8"));
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${file}: ${err.message}`);
    continue;
  }
  if (!doc || typeof doc !== "object" || !doc.jobs || typeof doc.jobs !== "object") {
    failures += 1;
    console.error(`FAIL  ${file}: parses but has no top-level 'jobs' map`);
    continue;
  }
  const jobs = Object.keys(doc.jobs);
  console.log(`PASS  ${file}  — jobs: ${jobs.join(", ")}`);
}

if (failures > 0) {
  console.error(`\nworkflow lint: ${failures}/${checked} workflow file(s) failed to parse`);
  process.exit(1);
}
console.log(`\nworkflow lint: OK — ${checked} workflow file(s) parse with a jobs map`);

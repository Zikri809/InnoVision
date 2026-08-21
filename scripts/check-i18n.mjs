import fs from "fs";
import path from "path";

const en = JSON.parse(fs.readFileSync("src/messages/en.json", "utf8"));
const ms = JSON.parse(fs.readFileSync("src/messages/ms.json", "utf8"));

function flattenKeys(obj, prefix = "") {
  let keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

const enKeys = new Set(flattenKeys(en));
const msKeys = new Set(flattenKeys(ms));

let hasError = false;

// 1. Check EN -> MS
const missingInMs = [];
for (const key of enKeys) {
  if (!msKeys.has(key)) {
    missingInMs.push(key);
  }
}

// 2. Check MS -> EN
const missingInEn = [];
for (const key of msKeys) {
  if (!enKeys.has(key)) {
    missingInEn.push(key);
  }
}

console.log(`\n=== i18n Key Parity Check ===`);
console.log(`Total EN keys: ${enKeys.size}`);
console.log(`Total MS keys: ${msKeys.size}`);

if (missingInMs.length > 0) {
  hasError = true;
  console.error(`\n❌ Keys in en.json missing from ms.json (${missingInMs.length}):`);
  for (const k of missingInMs) console.error(`  - ${k}`);
}

if (missingInEn.length > 0) {
  hasError = true;
  console.error(`\n❌ Keys in ms.json missing from en.json (${missingInEn.length}):`);
  for (const k of missingInEn) console.error(`  - ${k}`);
}

if (!hasError) {
  console.log(`✅ Perfect en <-> ms key parity (${enKeys.size}/${msKeys.size})!`);
}

// 3. Scan code references
function getAllFiles(dir, exts = [".ts", ".tsx"]) {
  let res = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) {
      if (f !== "node_modules" && f !== ".next" && f !== ".git") {
        res.push(...getAllFiles(full, exts));
      }
    } else if (exts.includes(path.extname(full))) {
      res.push(full);
    }
  }
  return res;
}

const files = getAllFiles("src");
const missingByPath = {};

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  const useTransRegex = /const\s+([a-zA-Z0-9_]+)\s*=\s*useTranslations\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  const namespaces = {};
  while ((match = useTransRegex.exec(content)) !== null) {
    namespaces[match[1]] = match[2];
  }

  const getTransRegex = /const\s+([a-zA-Z0-9_]+)\s*=\s*await\s+getTranslations\(\s*(?:\{\s*[^}]*namespace:\s*["']([^"']+)["'][^}]*\}|["']([^"']+)["'])\s*\)/g;
  while ((match = getTransRegex.exec(content)) !== null) {
    namespaces[match[1]] = match[2] || match[3];
  }

  for (const [tVar, ns] of Object.entries(namespaces)) {
    const callRegex = new RegExp(`\\b${tVar}\\(\\s*["']([^"']+)["']`, "g");
    let callMatch;
    while ((callMatch = callRegex.exec(content)) !== null) {
      const key = callMatch[1];
      const fullPath = ns ? `${ns}.${key}` : key;
      if (!enKeys.has(fullPath) && !msKeys.has(fullPath)) {
        if (!missingByPath[fullPath]) {
          missingByPath[fullPath] = [];
        }
        missingByPath[fullPath].push(`${file}`);
      }
    }
  }
}

if (Object.keys(missingByPath).length > 0) {
  hasError = true;
  console.error(`\n❌ Code references missing translation keys (${Object.keys(missingByPath).length}):`);
  for (const [k, v] of Object.entries(missingByPath)) {
    console.error(`  - ${k} (used in ${[...new Set(v)].join(", ")})`);
  }
}

if (hasError) {
  console.error(`\n❌ i18n validation failed.`);
  process.exit(1);
} else {
  console.log(`✅ All code references validated.\n`);
  process.exit(0);
}

import fs from "fs";
import path from "path";

const en = JSON.parse(fs.readFileSync("src/messages/en.json", "utf8"));
const ms = JSON.parse(fs.readFileSync("src/messages/ms.json", "utf8"));

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
      const parts = fullPath.split(".");
      let curEn = en;
      let okEn = true;
      for (const p of parts) {
        if (curEn && typeof curEn === "object" && p in curEn) {
          curEn = curEn[p];
        } else {
          okEn = false;
          break;
        }
      }

      if (!okEn) {
        if (!missingByPath[fullPath]) {
          missingByPath[fullPath] = [];
        }
        missingByPath[fullPath].push(`${file}`);
      }
    }
  }
}

console.log("Unique missing fullPaths:", Object.keys(missingByPath).length);
for (const [k, v] of Object.entries(missingByPath)) {
  console.log(`- ${k} (used in ${[...new Set(v)].join(", ")})`);
}

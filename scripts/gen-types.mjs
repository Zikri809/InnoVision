// Regenerate Supabase TypeScript types as UTF-8 (cross-platform).
// The npm `>` redirect writes UTF-16 on Windows PowerShell, corrupting
// database.ts, so we shell out and write the file explicitly.
// Type aliases (UserRole, Profile) live in src/lib/types/aliases.ts and are
// NOT appended here, so regeneration can never drop them.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outPath = resolve("src/lib/types/database.ts");

try {
  const types = execFileSync(
    "npx",
    ["supabase", "gen", "types", "typescript", "--local"],
    { encoding: "utf8", shell: process.platform === "win32" },
  );

  writeFileSync(outPath, types.trimEnd() + "\n", "utf8");
  console.log(`Regenerated ${outPath}`);
} catch (err) {
  console.error(
    "Failed to regenerate Supabase types. Make sure local Supabase is running (`npm run supabase:start`) and migrations are applied.",
  );
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

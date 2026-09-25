// Demo booth one-command boot (docs/plans/PLAN_DEMO_MODE.md D7).
//
//   npm run demo:prep
//
// Steps (each logged; aborts on failure):
//   1. supabase start
//   2. supabase db reset
//   3. seed:demo
//   4. face:start (the InsightFace sidecar; skipped with --no-face)
//   5. demo-reset (walk-up refresh)
//   6. next build   (NEXT_PUBLIC_DEMO_MODE=1 MUST be present at build time —
//      the Edge middleware inlines it; see src/lib/demo/gate.ts)
//   7. next start -H 0.0.0.0
//
// The flag is exported for the build AND for `next start` (the runtime page
// branch reads it too). This script refuses to run with the flag absent.
import { execSync, spawn } from "node:child_process";

const FLAG = "NEXT_PUBLIC_DEMO_MODE";
if (process.env[FLAG] !== "1") {
  console.error(
    `\n${FLAG}=1 must be set in the environment before running demo:prep.\n` +
      "  PowerShell : $env:NEXT_PUBLIC_DEMO_MODE=1; npm run demo:prep\n" +
      "  bash       : NEXT_PUBLIC_DEMO_MODE=1 npm run demo:prep\n",
  );
  process.exit(1);
}

const NO_FACE = process.argv.includes("--no-face");

function run(cmd) {
  console.log(`\n>> ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: process.env, shell: true });
}

function main() {
  run("npx supabase start");
  run("npx supabase db reset");
  run("npm run seed:demo");
  if (!NO_FACE) run("npm run face:start");
  run("npm run demo:reset");

  console.log(`\n>> next build (with ${FLAG}=1)`);
  execSync("npx next build", { stdio: "inherit", env: process.env, shell: true });

  console.log(
    "\nBooth is about to start on http://0.0.0.0:3000\n" +
      "  presenter laptop : http://localhost:3000  (camera works — secure context)\n" +
      "  visitor phones   : http://<this-machine-LAN-IP>:3000  (no camera; walk-up needs none)\n" +
      "  run demo:reset between shows.\n",
  );
  const child = spawn("npx", ["next", "start", "-H", "0.0.0.0", "-p", "3000"], {
    stdio: "inherit",
    env: process.env,
    shell: true,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

try {
  main();
} catch (e) {
  console.error("\ndemo:prep failed:", e?.message ?? e);
  process.exit(1);
}

// Booth QR card generator (exhibition D10: booth card / poster + backup QR).
//
// Visitors scan SCAN23 once (auto-account + auto-join), then scan a subject
// QR to join that class and play its quizzes. All entry points are the REAL
// QR join flow (/join/<code>) — no special kiosk pages.
//
// Run:  node scripts/booth-qr.mjs --base-url https://<tunnel-link> [--out booth-card]
//   --base-url  public origin visitors reach (tunnel link, e.g. Cloudflare
//               quick tunnel). No trailing slash. REQUIRED.
//   --out       output dir for PNGs + printable HTML (default: booth-card/).
//               Generated + origin-specific, so it stays UNTRACKED (see
//               .gitignore /booth-card/). Regenerate whenever the tunnel link
//               changes — tunnel URLs rotate on every restart.
//
// Cards target the DEMO-LECTURER copies (ECN444/RSK444/SPK444) so the
// farah/rajesh accounts stay pristine for the lecturer-track demo.
import QRCode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const baseUrl = (arg("base-url") ?? "").replace(/\/+$/, "");
if (!/^https?:\/\/.+/.test(baseUrl)) {
  console.error("Usage: node scripts/booth-qr.mjs --base-url https://<tunnel-link> [--out booth-card]");
  process.exit(1);
}
const outDir = path.resolve(ROOT, arg("out", "booth-card"));
fs.mkdirSync(outDir, { recursive: true });

const CARDS = [
  { code: "SCAN23", title: "1 — Start here: Join the demo", sub: "Scan → tap Join the demo → play instantly (no camera, no signup)" },
  { code: "ECN444", title: "2 — ECON101 · Principle of Economics", sub: "Practice quiz (live) + Quiz 1 past results" },
  { code: "RSK444", title: "3 — RISK201 · Risk & Insurance", sub: "Practice quiz (live) + Quiz 1 past results" },
  { code: "SPK444", title: "4 — SPEECH301 · Public Speaking Skills", sub: "Practice quiz (live) + Quiz 1 past results" },
];

const rows = [];
for (const card of CARDS) {
  const url = `${baseUrl}/join/${card.code}`;
  const png = path.join(outDir, `join-${card.code}.png`);
  await QRCode.toFile(png, url, { width: 640, margin: 2 });
  console.log(`  + ${path.basename(png)} → ${url}`);
  rows.push({ ...card, url, png: path.basename(png) });
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InnoVision — Booth QR card</title>
<style>
  body { font-family: Arial, sans-serif; color: #111; max-width: 720px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 28px; } .hint { color: #444; }
  .card { border: 3px solid #111; border-radius: 16px; padding: 16px; margin: 20px 0; page-break-inside: avoid; text-align: center; }
  .card img { width: 300px; height: 300px; }
  .card h2 { margin: 8px 0 4px; font-size: 22px; }
  .card p { margin: 4px 0; } code { font-size: 18px; background: #eee; padding: 2px 8px; border-radius: 6px; }
  @media print { body { padding: 0; } }
</style></head><body>
<h1>Try InnoVision 📱</h1>
<p class="hint"><b>1.</b> Scan the first QR &nbsp; <b>2.</b> Tap <b>Join the demo</b> &nbsp; <b>3.</b> Answer — watch the big screen!</p>
${rows.map((r) => `<div class="card"><img src="${r.png}" alt="QR for ${r.code}"><h2>${r.title}</h2><p>${r.sub}</p><p>Code: <code>${r.code}</code></p><p class="hint">${r.url}</p></div>`).join("\n")}
<p class="hint">No camera needed for these quizzes. On the venue screen: lecturer live-session view during monitoring, quiz player during showcase.</p>
</body></html>`;
fs.writeFileSync(path.join(outDir, "booth-card.html"), html);
console.log(`\nDone → ${outDir}/booth-card.html (open + print; re-run when the tunnel link rotates)`);

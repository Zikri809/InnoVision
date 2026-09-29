/**
 * Export docs/MANUAL_TEST_GUIDE.md → docs/MANUAL_TEST_GUIDE.pdf (A4, print-ready).
 *
 *   npm run guide:pdf
 *
 * Single source of truth stays the .md file: this script does a lightweight
 * render (headings, tables, task lists, bullets, bold, inline code,
 * blockquotes) inside a styled print template, then prints via headless
 * Chromium (already a devDependency via @playwright/test — no new packages,
 * fully offline). Re-run whenever the guide changes.
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MD_PATH = join(ROOT, "docs", "MANUAL_TEST_GUIDE.md");
const PDF_PATH = join(ROOT, "docs", "MANUAL_TEST_GUIDE.pdf");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const esc = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const inline = (s) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

function renderTable(lines) {
  const rows = lines.map((l) =>
    l
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => inline(c.trim())),
  );
  const head = rows[0];
  const body = rows.slice(2); // row 1 is the --- separator
  return (
    `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` +
    `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  );
}

function renderMd(md) {
  const lines = md.split("\n");
  let html = "";
  let i = 0;
  const sections = []; // [id, title] for the TOC (## only)
  const slug = (t) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  const flushPara = (buf) => {
    if (!buf.length) return;
    // A standalone **Bold line** is a sub-heading in the tester guide.
    if (buf.length === 1 && /^\*\*.+\*\*$/.test(buf[0].trim())) {
      html += `<h3>${inline(buf[0].trim().replace(/^\*\*|\*\*$/g, ""))}</h3>`;
      return;
    }
    html += `<p>${buf.map(inline).join(" ")}</p>`;
  };

  let para = [];
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (/^#{1,3}\s/.test(t)) {
      flushPara(para);
      para = [];
      const level = t.match(/^#+/)[0].length;
      const text = t.replace(/^#+\s*/, "");
      if (level === 1) {
        // The cover page already carries the title — skip the MD's own H1
        // so it isn't duplicated mid-document.
      } else if (level === 2) {
        const id = slug(text.replace(/\(.*?\)/g, ""));
        sections.push([id, text]);
        // Glue the trailing ★ to the last word with a no-break space so a
        // long title (e.g. Phase 5) can't strand the star on its own line.
        const titled = text.replace(/ ★$/, " ★");
        const star = /★/.test(text) ? `<span class="core">Quick check</span>` : "";
        html += `<h2 id="${id}">${inline(titled)}${star}</h2>`;
      } else {
        html += `<h3>${inline(text)}</h3>`;
      }
      i++;
      continue;
    }
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:\-|]+\|$/.test(lines[i + 1].trim())) {
      flushPara(para);
      para = [];
      const tbl = [line];
      i += 1;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        tbl.push(lines[i]);
        i++;
      }
      html += renderTable(tbl);
      continue;
    }
    if (/^-\s\[ \]/.test(t)) {
      flushPara(para);
      para = [];
      html += "<ul class='check'>";
      while (i < lines.length && /^-\s\[ \]/.test(lines[i].trim())) {
        html += `<li><span class="box"></span><span>${inline(lines[i].trim().replace(/^-\s\[ \]\s*/, ""))}</span></li>`;
        i++;
      }
      html += "</ul>";
      continue;
    }
    if (/^-\s/.test(t)) {
      flushPara(para);
      para = [];
      html += "<ul>";
      while (i < lines.length && /^-\s/.test(lines[i].trim())) {
        html += `<li>${inline(lines[i].trim().replace(/^-\s*/, ""))}</li>`;
        i++;
      }
      html += "</ul>";
      continue;
    }
    if (/^>\s?/.test(t)) {
      flushPara(para);
      para = [];
      html += "<blockquote>";
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        html += `${inline(lines[i].replace(/^>\s?/, ""))}<br>`;
        i++;
      }
      html += "</blockquote>";
      continue;
    }
    if (t === "") {
      flushPara(para);
      para = [];
      i++;
      continue;
    }
    para.push(t);
    i++;
  }
  flushPara(para);
  return { html, sections };
}

const today = new Date().toISOString().slice(0, 10);
const { html: body, sections } = renderMd(readFileSync(MD_PATH, "utf8"));

const toc = sections
  .map(([id, title]) => `<li><a href="#${id}">${inline(title.replace(/ ★$/, " ★"))}</a></li>`)
  .join("");

const doc = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 18mm 15mm 20mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Verdana, Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #292524; margin: 0; }
  .cover { background: #431407; color: #fff7ed; border-radius: 18px; padding: 44px 40px; margin-bottom: 26px; }
  .cover .kicker { display: inline-block; font-size: 10pt; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: #fdba74; border: 2px solid #fdba74; border-radius: 999px; padding: 3px 14px; margin-bottom: 18px; }
  .cover h1 { font-size: 30pt; line-height: 1.15; margin: 0 0 10px; color: #fff; }
  .cover p.sub { font-size: 12pt; color: #fed7aa; margin: 0 0 22px; max-width: 60ch; }
  .cover .meta { display: table; border-collapse: collapse; font-size: 9.5pt; }
  .cover .meta div { display: table-row; }
  .cover .meta span { display: table-cell; padding: 3px 14px 3px 0; }
  .cover .meta span:first-child { color: #fdba74; font-weight: 700; }
  .toc { border: 3px solid #e7e5e4; border-radius: 14px; padding: 16px 22px; margin-bottom: 26px; background: #fafaf9; }
  .toc h2 { background: none; color: #431407; border: none; padding: 0; margin: 0 0 8px; font-size: 13pt; }
  .toc ul { columns: 2; margin: 0; padding-left: 20px; font-size: 9.5pt; }
  .toc li { margin: 2px 0; break-inside: avoid; }
  .toc a { color: #9a3412; text-decoration: none; }
  h1 { font-size: 20pt; color: #431407; border-bottom: 4px solid #f97316; padding-bottom: 6px; }
  h2 { font-size: 14pt; color: #fff; background: #9a3412; border-radius: 10px; padding: 7px 14px; margin-top: 28px; page-break-after: avoid; }
  h2 .core { float: right; font-size: 8pt; letter-spacing: 1.5px; background: #fbbf24; color: #431407; border-radius: 999px; padding: 2px 10px; margin-top: 3px; }
  h3 { font-size: 11.5pt; color: #9a3412; margin-bottom: 4px; page-break-after: avoid; }
  blockquote { border-left: 5px solid #f97316; background: #fff7ed; border-radius: 0 10px 10px 0; padding: 10px 14px; margin: 12px 0; font-size: 9.8pt; color: #57534e; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 16px; font-size: 9.6pt; }
  thead th { background: #fed7aa; color: #431407; text-align: left; }
  th, td { border: 2px solid #e7e5e4; padding: 6px 8px; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fafaf9; }
  tr, li, blockquote, table { page-break-inside: avoid; }
  ul { padding-left: 22px; }
  li { margin: 3px 0; }
  ul.check { list-style: none; padding-left: 4px; }
  ul.check li { display: flex; gap: 8px; align-items: flex-start; margin: 5px 0; }
  .box { flex: none; width: 13px; height: 13px; margin-top: 3px; border: 2.5px solid #9a3412; border-radius: 4px; }
  code { background: #f5f5f4; border: 1px solid #e7e5e4; border-radius: 5px; padding: 0 5px; font-size: 9.2pt; color: #9a3412; }
  strong { color: #431407; }
  p { margin: 6px 0; }
</style></head><body>
<div class="cover">
  <span class="kicker">Easy2U &middot; InnoVision</span>
  <h1>Manual Test Guide</h1>
  <p class="sub">No technical knowledge needed — one tester, one laptop, two browser windows. Just follow the steps in order and tick each box. The <strong style="color:#fde68a">Quick check</strong> (steps marked ★) takes about 45 minutes; the <strong style="color:#fde68a">Full check</strong> takes about 2 hours.</p>
  <div class="meta">
    <div><span>Date</span><span>${today} &middot; v${PKG.version}</span></div>
    <div><span>Which path?</span><span>Your lead will tell you: Quick check (★ steps) or Full check (everything)</span></div>
    <div><span>Stuck?</span><span>Note the step number, take a screenshot, keep going, report at sign-off</span></div>
  </div>
</div>
<div class="toc"><h2>Contents</h2><ul>${toc}</ul></div>
${body}
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(doc, { waitUntil: "load" });
  if (process.env.GUIDE_PREVIEW) {
    await page.setViewportSize({ width: 900, height: 1270 });
    await page.screenshot({ path: join(ROOT, "screenshots", "guide-preview.png") });
    console.log("wrote screenshots/guide-preview.png");
  }
  await page.pdf({
    path: PDF_PATH,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate:
      `<div style="width:100%;font-size:8pt;font-family:'Segoe UI',Arial,sans-serif;color:#a8a29e;padding:0 15mm;display:flex;justify-content:space-between;">` +
      `<span>Easy2U &middot; InnoVision Manual Test Guide</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    margin: { top: "18mm", bottom: "20mm", left: "15mm", right: "15mm" },
  });
  console.log(`wrote ${PDF_PATH}`);
} finally {
  await browser.close();
}

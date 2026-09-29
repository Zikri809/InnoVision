import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createElement as h } from "react";
import { ImageResponse } from "next/og.js";

// Pre-render the static brand card: no font or image downloads at runtime.
// Run from any directory: node scripts/generate-brand-share-image.mjs
const root = fileURLToPath(new URL("../", import.meta.url));
const mark = await readFile(path.join(root, "public/brand/easy2u-mark.png"));
const alt = "Easy2U — AI-powered gesture quizzes with face verification";
const image = new ImageResponse(
  h("div", {
    style: {
      width: "100%", height: "100%", display: "flex", alignItems: "center",
      justifyContent: "center", gap: 64, background: "#f97316",
    },
  },
  h("div", {
    style: {
      display: "flex", width: 230, height: 230, borderRadius: 52,
      background: "#3b1e10", alignItems: "center", justifyContent: "center",
      boxShadow: "16px 16px 0 #431407",
    },
  }, h("img", {
    src: `data:image/png;base64,${mark.toString("base64")}`,
    alt: "", width: 184, height: 100,
  })),
  h("div", { style: { display: "flex", flexDirection: "column", gap: 20 } },
    h("div", { style: { fontSize: 112, fontWeight: 700, color: "#431407" } }, "Easy2U"),
    h("div", { style: { fontSize: 36, color: "#7c2d12" } },
      "AI-powered gesture quizzes with face verification"),
  )),
  { width: 1200, height: 630 },
);
await writeFile(path.join(root, "src/app/opengraph-image.png"), Buffer.from(await image.arrayBuffer()));
await writeFile(path.join(root, "src/app/opengraph-image.alt.txt"), `${alt}\n`);
console.log("Generated Easy2U share image (1200 × 630).");

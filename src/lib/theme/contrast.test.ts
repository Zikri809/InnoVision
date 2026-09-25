import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AX-2 contrast gate — WCAG 2.1 relative-luminance ratio assertions over the
 * clay token literals in globals.css. Extends the labels.test.ts (U-M20)
 * AAA-pattern precedent: if someone re-lightens --primary-foreground, the
 * unit suite fails before the audit re-finds the regression.
 */

function srgbChannel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const m = hex.replace("#", "");
  const full =
    m.length === 3
      ? m
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : m;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// Tokens mirrored from src/app/globals.css :root (kept as literals so this
// test runs in a plain Node env with no CSS parsing).
const LIGHT = {
  primary: "#f97316",
  primaryDeep: "#c2410c",
  primaryForeground: "#431407",
  sidebarPrimary: "#f97316",
  sidebarPrimaryForeground: "#431407",
  background: "#fff7ed",
  foreground: "#7c2d12",
  card: "#ffffff",
  accent: "#2563eb",
  accentForeground: "#ffffff",
} as const;

const DARK = {
  primary: "#fb923c",
  primaryForeground: "#2a170c",
  background: "#1c0f08",
  foreground: "#ffedd5",
  card: "#2a170c",
  accent: "#60a5fa",
  accentForeground: "#1c0f08",
} as const;

describe("clay token contrast (AX-2, U-CX1..U-CX4)", () => {
  it("U-CX1 light --primary-foreground on --primary meets WCAG AA (≥4.5:1)", () => {
    const ratio = contrastRatio(LIGHT.primaryForeground, LIGHT.primary);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("U-CX2 light sidebar-primary pair meets WCAG AA (same failure class as primary)", () => {
    expect(
      contrastRatio(LIGHT.sidebarPrimaryForeground, LIGHT.sidebarPrimary),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("U-CX3 dark-mode primary pair still meets WCAG AA after the light-side fix", () => {
    expect(contrastRatio(DARK.primaryForeground, DARK.primary)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("U-CX4 regression tripwire: the old white-on-orange value would fail this gate", () => {
    // Pins the reason this test exists — if the token regresses to #ffffff
    // the *pattern* below (≈2.8:1) is what sneaks back in.
    expect(contrastRatio("#ffffff", LIGHT.primary)).toBeLessThan(4.5);
    // Body text pairs stay healthy in both themes.
    expect(contrastRatio(LIGHT.foreground, LIGHT.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(DARK.foreground, DARK.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("U-CX5 mirrored literals match the real globals.css source (drift tripwire)", () => {
    const css = readFileSync(
      resolve(__dirname, "..", "..", "app", "globals.css"),
      "utf8",
    );
    const pick = (name: string, from: number): string => {
      const idx = css.indexOf(`--${name}:`, from);
      const m = css.slice(idx).match(/--[\w-]+:\s*(#[0-9a-fA-F]{6})/);
      if (!m) throw new Error(`token --${name} not found`);
      return m[1].toLowerCase();
    };

    // First occurrence of each token after :root's opening = light block.
    const rootStart = css.indexOf(":root");
    expect(pick("primary", rootStart)).toBe(LIGHT.primary);
    expect(pick("primary-deep", rootStart)).toBe(LIGHT.primaryDeep);
    expect(pick("primary-foreground", rootStart)).toBe(LIGHT.primaryForeground);
    expect(pick("sidebar-primary-foreground", rootStart)).toBe(
      LIGHT.sidebarPrimaryForeground,
    );
    expect(pick("background", rootStart)).toBe(LIGHT.background);
    expect(pick("foreground", rootStart)).toBe(LIGHT.foreground);
    expect(pick("card", rootStart)).toBe(LIGHT.card);

    const darkStart = css.indexOf(".dark", rootStart);
    expect(pick("primary", darkStart)).toBe(DARK.primary);
    expect(pick("primary-foreground", darkStart)).toBe(DARK.primaryForeground);
    expect(pick("background", darkStart)).toBe(DARK.background);
    expect(pick("foreground", darkStart)).toBe(DARK.foreground);
    expect(pick("card", darkStart)).toBe(DARK.card);
  });
});

/**
 * The landing preview keeps a light quiz panel in both themes. Its text needs
 * fixed dark ink; theme-flipping foreground tokens disappear on that panel.
 * The surrounding blue stage and status card use theme tokens as pairs.
 *
 * Tailwind v4 palette literals below are the oklch() values from
 * node_modules/tailwindcss/theme.css converted to sRGB.
 */
const TW = {
  orange50: "#fff7ed",
  orange700: "#ca3500",
  orange950: "#441306",
  blue50: "#eff6ff",
  blue900: "#1c398e",
} as const;

describe("landing hero mock contrast (light panel, both themes)", () => {
  const AA = 4.5;

  it("U-CX6 question prompt meets AA on the fixed light panel", () => {
    expect(contrastRatio(DARK.foreground, TW.orange50)).toBeLessThan(AA);
    expect(contrastRatio(TW.orange950, TW.orange50)).toBeGreaterThanOrEqual(AA);
  });

  it("U-CX7 question eyebrow meets AA on the fixed light panel", () => {
    expect(contrastRatio(DARK.primary, TW.orange50)).toBeLessThan(AA);
    expect(contrastRatio(LIGHT.primary, TW.orange50)).toBeLessThan(AA);
    expect(contrastRatio(TW.orange700, TW.orange50)).toBeGreaterThanOrEqual(AA);
  });

  it("U-CX8 selected option text meets AA on the fixed bg-blue-50 row", () => {
    // Old value was text-accent, which flips to #60a5fa in dark mode.
    expect(contrastRatio("#60a5fa", TW.blue50)).toBeLessThan(AA);

    expect(contrastRatio(TW.blue900, TW.blue50)).toBeGreaterThanOrEqual(AA);
  });

  it("U-CX9 preview header and counter meet AA on the blue stage in both themes", () => {
    expect(contrastRatio(LIGHT.accentForeground, LIGHT.accent)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(DARK.accentForeground, DARK.accent)).toBeGreaterThanOrEqual(AA);
  });

  it("U-CX10 status sentence meets AA on the card in both themes", () => {
    expect(contrastRatio(LIGHT.foreground, LIGHT.card)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(DARK.foreground, DARK.card)).toBeGreaterThanOrEqual(AA);
  });

  it("U-CX11 drift tripwire: the hero mock's light-panel ink is not a theme token", () => {
    // The fixed light question panel must keep fixed dark ink in both themes.
    const src = readFileSync(
      resolve(__dirname, "..", "..", "components", "landing", "gesture-demo.tsx"),
      "utf8",
    );
    // Strip JSX/line comments first: the explanatory comments above the fix
    // mention the very class names being asserted against.
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");

    const panelStart = code.indexOf("bg-orange-50");
    expect(panelStart).toBeGreaterThan(-1);
    const optionsStart = code.indexOf("options.map(", panelStart);
    expect(optionsStart).toBeGreaterThan(panelStart);
    const header = code.slice(panelStart, optionsStart);

    // The light panel must not use theme-flipping ink.
    expect(header).not.toContain("text-primary");
    expect(header).not.toContain("text-foreground");
    expect(header).toContain("text-orange-700");
    expect(header).toContain("text-orange-950");

    // The selected option sits on fixed blue-50, so its ink cannot flip with
    // the theme. The unselected option is fixed white with fixed brown ink.
    const rows = code.slice(optionsStart, code.indexOf("</button>", optionsStart));
    expect(rows).toContain("bg-blue-50 text-blue-900");
    expect(rows).toContain("bg-white text-orange-950");
  });

  it("U-CX12 the selected-answer sentence stays in one live region", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "..", "components", "landing", "gesture-demo.tsx"),
      "utf8",
    );
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");
    const sentenceStart = code.indexOf("<span key={revision} aria-live=\"polite\"");
    expect(sentenceStart).toBeGreaterThan(-1);
    const sentence = code.slice(sentenceStart, code.indexOf("</span>", sentenceStart));
    expect(sentence).toContain('t("demoSelected"');
    expect(sentence).toContain("count: selected + 1");
  });

  it("U-CX13 landing orange text meets AA on light and dark surfaces", () => {
    expect(contrastRatio(LIGHT.primary, LIGHT.background)).toBeLessThan(AA);
    expect(contrastRatio(LIGHT.primaryDeep, LIGHT.background)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(LIGHT.primaryDeep, "#ffffff")).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(DARK.primary, DARK.background)).toBeGreaterThanOrEqual(AA);

    const page = readFileSync(resolve(__dirname, "..", "..", "app", "page.tsx"), "utf8");
    expect(page.replaceAll("dark:text-primary", "").replaceAll("dark:hover:text-primary", ""))
      .not.toMatch(/(?<![\w-])text-primary(?![\w-])/);
  });
});

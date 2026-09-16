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
  primaryForeground: "#431407",
  sidebarPrimary: "#f97316",
  sidebarPrimaryForeground: "#431407",
  background: "#fff7ed",
  foreground: "#7c2d12",
} as const;

const DARK = {
  primary: "#fb923c",
  primaryForeground: "#2a170c",
  background: "#1c0f08",
  foreground: "#ffedd5",
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
    expect(pick("primary-foreground", rootStart)).toBe(LIGHT.primaryForeground);
    expect(pick("sidebar-primary-foreground", rootStart)).toBe(
      LIGHT.sidebarPrimaryForeground,
    );
    expect(pick("background", rootStart)).toBe(LIGHT.background);
    expect(pick("foreground", rootStart)).toBe(LIGHT.foreground);

    const darkStart = css.indexOf(".dark", rootStart);
    expect(pick("primary", darkStart)).toBe(DARK.primary);
    expect(pick("primary-foreground", darkStart)).toBe(DARK.primaryForeground);
    expect(pick("background", darkStart)).toBe(DARK.background);
    expect(pick("foreground", darkStart)).toBe(DARK.foreground);
  });
});

/**
 * Landing hero mock — the gesture-quiz "live demo" card, now the client
 * component src/components/landing/gesture-demo.tsx (moved out of page.tsx
 * by the landing redesign; these gates moved with it).
 *
 * That mock renders a LIGHT quiz panel in BOTH themes (it reads as a picture of
 * the product), but its ink was written with theme-flipping tokens. In dark mode
 * --foreground is #ffedd5 and the panel's own gradient ends at orange-100
 * #ffedd4 — one hex digit apart, so the question prompt rendered at 1.00:1 and
 * was effectively invisible. Same class of bug on the "QUESTION 3" eyebrow
 * (--primary on cream, 2.1:1), the selected "Queue" option (--accent
 * #60a5fa on the fixed bg-blue-50, 2.34:1), and (redesign regression, caught
 * by U-CX11) the hovered option (--primary on the fixed bg-orange-50).
 *
 * Rule this pins: text sitting on a colour that does NOT flip with the theme
 * must use fixed palette values, never theme tokens.
 *
 * Tailwind v4 palette literals below are the oklch() values from
 * node_modules/tailwindcss/theme.css converted to sRGB.
 */
const TW = {
  orange50: "#fff7ed",
  orange100: "#ffedd4",
  orange700: "#ca3500",
  orange950: "#441306",
  blue50: "#eff6ff",
  blue600: "#155dfc",
  green200: "#b9f8cf",
  green700: "#008236",
} as const;

describe("landing hero mock contrast (light panel, both themes)", () => {
  const AA = 4.5;

  it("U-CX6 question prompt on the panel gradient meets AA at BOTH gradient stops", () => {
    // Pins the fix for the invisible-dark-mode-prompt bug: the old
    // DARK.foreground value must fail here, the new one must pass.
    expect(contrastRatio(DARK.foreground, TW.orange100)).toBeLessThan(AA);
    expect(contrastRatio(DARK.foreground, TW.orange50)).toBeLessThan(AA);

    expect(contrastRatio(TW.orange950, TW.orange50)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(TW.orange950, TW.orange100)).toBeGreaterThanOrEqual(AA);
  });

  it("U-CX7 QUESTION 3 eyebrow meets AA on both gradient stops", () => {
    // Old value was text-primary: #fb923c (dark) / #f97316 (light).
    expect(contrastRatio(DARK.primary, TW.orange50)).toBeLessThan(AA);
    expect(contrastRatio(LIGHT.primary, TW.orange50)).toBeLessThan(AA);

    expect(contrastRatio(TW.orange700, TW.orange50)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(TW.orange700, TW.orange100)).toBeGreaterThanOrEqual(AA);
  });

  it("U-CX8 selected option text meets AA on the fixed bg-blue-50 row", () => {
    // Old value was text-accent, which flips to #60a5fa in dark mode.
    expect(contrastRatio("#60a5fa", TW.blue50)).toBeLessThan(AA);

    expect(contrastRatio(TW.blue600, TW.blue50)).toBeGreaterThanOrEqual(AA);
  });

  it("U-CX9 'Q3 of 6' counter meets AA on the card in both themes", () => {
    // Old value was text-primary in both themes; light mode failed on white.
    expect(contrastRatio(LIGHT.primary, "#ffffff")).toBeLessThan(AA);

    expect(contrastRatio(TW.orange700, "#ffffff")).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(DARK.primary, DARK.primaryForeground)).toBeGreaterThanOrEqual(AA);
  });

  it("U-CX10 verified-row and check-badge pairs stay legible", () => {
    // The row sits on the dark clay card in dark mode; both runs must pass.
    expect(contrastRatio("#d6a37a", DARK.primaryForeground)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio("#60a5fa", DARK.primaryForeground)).toBeGreaterThanOrEqual(AA);
    // Check badge glyph on its green-200 disc.
    expect(contrastRatio(TW.green700, TW.green200)).toBeGreaterThanOrEqual(3);
  });

  it("U-CX11 drift tripwire: the hero mock's light-panel ink is not a theme token", () => {
    // The assertions above are only literals; this one fails if the mock is
    // edited back to a theme-flipping token on the light panel. Scoped to the
    // gradient-backed header, since the option rows below it sit on bg-card and
    // are SUPPOSED to flip with the theme.
    const src = readFileSync(
      resolve(__dirname, "..", "..", "components", "landing", "gesture-demo.tsx"),
      "utf8",
    );
    // Strip JSX/line comments first: the explanatory comments above the fix
    // mention the very class names being asserted against.
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");

    const panelStart = code.indexOf("bg-gradient-to-b from-orange-50");
    expect(panelStart).toBeGreaterThan(-1);
    // Header = eyebrow + prompt, i.e. everything before the options block.
    const optionsStart = code.indexOf("relative mt-5", panelStart);
    expect(optionsStart).toBeGreaterThan(panelStart);
    const header = code.slice(panelStart, optionsStart);

    // The light gradient panel must not use theme-flipping ink.
    expect(header).not.toContain("text-primary");
    expect(header).not.toContain("text-foreground");
    expect(header).toContain("text-orange-700");
    expect(header).toContain("text-orange-950");

    // The selected option sits on a fixed bg-blue-50, so its text must be a
    // fixed blue — not text-accent, which lightens to #60a5fa in dark mode.
    const selectedRow = code.slice(code.indexOf("bg-blue-50", optionsStart));
    expect(selectedRow.slice(0, 120)).not.toContain("text-accent");
    expect(selectedRow.slice(0, 120)).toContain("text-blue-600");

    // Redesign-era sibling of the bg-blue-50 bug: the HOVERED option sits on
    // a fixed bg-orange-50, so its ink must be fixed text-orange-700, not
    // text-primary (which is #fb923c in dark mode — ~2.2:1 on orange-50).
    const hoveredRow = code.slice(code.indexOf("bg-orange-50", optionsStart));
    expect(hoveredRow.slice(0, 160)).not.toContain("text-primary");
    expect(hoveredRow.slice(0, 160)).toContain("text-orange-700");
  });

  it("U-CX12 the verified row keeps its sentence in a single inline flow", () => {
    // Regression guard for the wrap scramble: as sibling flex children each
    // text run wrapped independently, stacking "Hold up" / "fingers" / "Queue!".
    const src = readFileSync(
      resolve(__dirname, "..", "..", "components", "landing", "gesture-demo.tsx"),
      "utf8",
    );
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");
    const rowStart = code.indexOf("{t(\"demoWave\")}");
    expect(rowStart).toBeGreaterThan(-1);
    // The sentence lives inside one wrapping <span> — the same lookback
    // window must contain that wrapper's opener (inline-flex + gap-2), so
    // the icon and sentence stay one flow instead of stacking as separate
    // flex items. (The last opener in the window is the inner green badge,
    // hence a window-level match rather than a "last opener" check.)
    const before = code.slice(Math.max(0, rowStart - 400), rowStart);
    expect(before).toMatch(/<span[^>]*inline-flex[^>]*gap-2[^>]*>/);
    // The demo's status strip is itself one wrapping flex row.
    expect(code).toContain("flex flex-wrap items-center gap-x-4");
  });
});

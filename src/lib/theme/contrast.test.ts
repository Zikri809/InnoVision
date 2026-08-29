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

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  THEME_STORAGE_KEY,
  THEME_PREFERENCES,
  THEME_INIT_SCRIPT,
  isThemePreference,
  resolveTheme,
  nextPreference,
  readStoredPreference,
  writeStoredPreference,
  applyTheme,
} from "./theme";

describe("theme helpers (AX-1)", () => {
  it("U-TH1 resolveTheme: explicit light/dark always wins over system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("U-TH2 resolveTheme: system follows the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("U-TH3 resolveTheme: missing/garbage storage falls back to system (defensive)", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(undefined, false)).toBe("light");
    expect(resolveTheme("", true)).toBe("dark");
    expect(resolveTheme("banana", false)).toBe("light");
    expect(resolveTheme("LIGHT", true)).toBe("dark"); // case-sensitive guard
    expect(resolveTheme('";alert(1);//', true)).toBe("dark");
  });

  it("U-TH4 nextPreference cycles light → dark → system → light", () => {
    expect(nextPreference("light")).toBe("dark");
    expect(nextPreference("dark")).toBe("system");
    expect(nextPreference("system")).toBe("light");
  });

  it("U-TH4b nextPreference: invalid input wraps back to the cycle start", () => {
    expect(nextPreference("banana" as never)).toBe("light");
  });

  it("U-TH5 isThemePreference narrows only the three valid values", () => {
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("System")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(42)).toBe(false);
  });

  it("U-TH6 storage key is namespaced and init script is a self-executing string", () => {
    expect(THEME_STORAGE_KEY).toBe("innovision.theme");
    expect(THEME_PREFERENCES).toEqual(["light", "dark", "system"]);
    expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_INIT_SCRIPT).toContain("prefers-color-scheme: dark");
    expect(THEME_INIT_SCRIPT).toContain('classList.add("dark")');
    // Wrapped in try/catch so storage failures never block render.
    expect(THEME_INIT_SCRIPT.startsWith("(function(){try{")).toBe(true);
  });

  describe("DOM-backed helpers (jsdom-free document stubs)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // The vitest env is "node"; these helpers guard on typeof document, so we
    // exercise the no-DOM branches here and the full behaviour via E2E.
    it("U-TH7 SSR/no-DOM safety: reads and writes are inert no-ops", () => {
      expect(readStoredPreference()).toBe("system");
      expect(() => writeStoredPreference("dark")).not.toThrow();
      expect(() => applyTheme("dark")).not.toThrow();
    });

    it("U-TH8 storage failures degrade to system, never throw (private mode/quota)", () => {
      vi.stubGlobal("window", {
        localStorage: {
          getItem: () => {
            throw new Error("quota exceeded");
          },
          setItem: () => {
            throw new Error("quota exceeded");
          },
        },
      });
      expect(readStoredPreference()).toBe("system");
      expect(() => writeStoredPreference("dark")).not.toThrow();
    });

    it("U-TH9 init script EXECUTES correctly: adds .dark only when warranted", () => {
      // The script ships raw inside <head> via dangerouslySetInnerHTML —
      // string-content assertions alone would let a syntax error ship.
      const run = (
        stored: string | null,
        systemDark: boolean,
      ): Set<string> => {
        const cls = new Set<string>();
        // The script references bare `localStorage` (globalThis scope) and
        // `window.matchMedia` — both surfaces must be stubbed.
        vi.stubGlobal("localStorage", { getItem: () => stored });
        vi.stubGlobal("window", {
          matchMedia: () => ({ matches: systemDark }),
        });
        vi.stubGlobal("document", {
          documentElement: {
            classList: {
              add: (c: string) => cls.add(c),
              remove: () => {},
              contains: () => false,
            },
          },
        });
        new Function(THEME_INIT_SCRIPT)();
        return cls;
      };

      expect(run("dark", false).has("dark")).toBe(true);
      expect(run("system", true).has("dark")).toBe(true);
      expect(run("light", true).has("dark")).toBe(false);
      expect(run("garbage", false).has("dark")).toBe(false);
      expect(run(null, false).has("dark")).toBe(false);
      // Empty storage + dark OS = dark (system default).
      expect(run("", true).has("dark")).toBe(true);
    });
  });
});

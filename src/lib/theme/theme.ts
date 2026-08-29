export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "innovision.theme";

export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "light",
  "dark",
  "system",
] as const;

export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    value === "light" || value === "dark" || value === "system"
  );
}

/**
 * Resolve a stored preference against the system preference. `system` follows
 * the OS; invalid/missing storage values fall back to `system` (never throw —
 * storage may hold arbitrary user-edited strings).
 */
export function resolveTheme(
  stored: string | null | undefined,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (stored === "light" || stored === "dark") return stored;
  return systemPrefersDark ? "dark" : "light";
}

/** Next step in the light → dark → system cycle. */
export function nextPreference(current: ThemePreference): ThemePreference {
  const idx = THEME_PREFERENCES.indexOf(current);
  return THEME_PREFERENCES[(idx + 1) % THEME_PREFERENCES.length] ?? "system";
}

/**
 * Apply a resolved theme to the document. Idempotent: only touches the class
 * list when it would change (avoids reflow churn on repeated calls).
 */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") {
    if (!root.classList.contains("dark")) root.classList.add("dark");
  } else if (root.classList.contains("dark")) {
    root.classList.remove("dark");
  }
}

/** Safe localStorage read — storage can be unavailable (private mode, SSR). */
export function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

/** Safe localStorage write — mirrors readStoredPreference's defenses. */
export function writeStoredPreference(preference: ThemePreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private mode / quota: theme still applies for this session.
  }
}

/**
 * Stringified pre-hydration script for the layout <head>. Runs before paint:
 * reads the stored preference (defaulting to system), resolves against
 * matchMedia, and toggles `.dark` on <html> so there is no flash-of-light.
 * Kept in one place so the CSP-hash story has a single source of truth.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k="${THEME_STORAGE_KEY}";var p=localStorage.getItem(k);if(p!=="light"&&p!=="dark"&&p!=="system")p="system";var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;if(d)r.classList.add("dark");}catch(e){}})();`;

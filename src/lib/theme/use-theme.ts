"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyTheme,
  nextPreference,
  readStoredPreference,
  resolveTheme,
  writeStoredPreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme";

/**
 * Client island state for the theme toggle. Mount-reads the stored preference
 * (hydration-safe: server and first client render agree on "system"), keeps the
 * `.dark` class in sync with preference + OS changes, and persists cycles.
 *
 * Cascading-render rule compliance: mount reads are deferred to a microtask
 * (app-user-menu.tsx precedent) and `resolved` is derived, never stored.
 */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  cycle: () => void;
} {
  // "system"/light are the hydration-stable initial values; real values are
  // read in a deferred mount effect so SSR markup matches first client render.
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => {
      if (!alive) return;
      const stored = readStoredPreference();
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      setSystemDark(mq.matches);
      setPreference(stored);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      setSystemDark(e.matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = useMemo(
    () => resolveTheme(preference, systemDark),
    [preference, systemDark],
  );

  // Class sync is a DOM write, not state — safe in an effect body.
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const cycle = useCallback(() => {
    const next = nextPreference(preference);
    writeStoredPreference(next);
    setPreference(next);
  }, [preference]);

  return { preference, resolved, cycle };
}

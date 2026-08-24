"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Minimal focus trap for full-screen blocking overlays (proctoring pause /
 * flagged screens). These overlays intentionally do NOT use the Dialog
 * primitive (they must not be Esc-dismissable and sit above the live camera
 * feed), but without help a keyboard/SR user could keep Tab-navigating the
 * quiz controls hidden behind the backdrop.
 *
 * On activation: moves focus to the overlay's first focusable element (or the
 * overlay itself). While active: cycles Tab/Shift+Tab within the overlay.
 * On deactivation: restores focus to the previously-focused element.
 */
export function useOverlayFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusFirst = () => {
      const items = el.querySelectorAll<HTMLElement>(FOCUSABLE);
      (items[0] ?? el).focus();
    };
    focusFirst();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      const inside = current instanceof Node && el.contains(current);
      if (e.shiftKey && (current === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Restore focus on teardown — a no-op when the trigger was removed.
      previous?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

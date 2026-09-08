"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** ssr=false snapshot of "is the client hydrated?" — portal-safe mount flag. */
const emptySubscribe = () => () => {};
const getHydratedSnapshot = () => true;
const getServerSnapshot = () => false;

function useHydrated() {
  return useSyncExternalStore(emptySubscribe, getHydratedSnapshot, getServerSnapshot);
}

/**
 * Dock FAB action sheet (plan: lecturer dock overhaul). A bottom-anchored
 * escape hatch for the dock FAB's quick actions — lecturer: New class /
 * New quiz; student: Join class.
 *
 * Design notes:
 *  - Deliberately NOT a vaul Drawer: the drawer bottom handle reads as "more
 *    content below", while this is a 1–2 item action menu. A custom clay card
 *    with entrance animation + scrim keeps the clay language (3px border, hard
 *    offset shadow, warm scrim) and stays dependency-free.
 *  - Portal to <body> so it layers above the fixed dock (z-40): scrim z-[60],
 *    sheet z-[70].
 *  - Hydration: portal target appears after mount (mounted flag) — the sheet
 *    only ever opens from a client interaction, so SSR never renders it.
 *  - Focus + a11y: role=dialog aria-modal, Escape closes, focus moves to the
 *    sheet on open and returns to the previously focused element on close.
 *  - The dock itself slides off-screen while `data-keyboard-open` is set
 *    (useKeyboardOcclusion); this sheet is NOT keyed to that flag so the
 *    inputs inside it stay put while typing.
 */
export function DockActionSheet({
  open,
  onOpenChange,
  children,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** Accessible name for the dialog. */
  label: string;
}) {
  const hydrated = useHydrated();
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // Escape to close + focus management while open.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    const frame = requestAnimationFrame(() => {
      sheetRef.current?.focus();
    });

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      cancelAnimationFrame(frame);
      previouslyFocused?.focus?.();
    };
  }, [open, onOpenChange]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!hydrated || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] sm:hidden">
      {/* Warm scrim (clay rule: never pure black). Tap to dismiss. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-pointer animate-in fade-in-0 duration-200 bg-orange-950/40 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        ref={sheetRef}
        className={cn(
          "absolute inset-x-3 bottom-[calc(8px+var(--safe-bottom))] rounded-[24px] border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay)] outline-none",
          "animate-in fade-in-0 slide-in-from-bottom-6 duration-200 ease-out",
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

"use client";

import * as React from "react";

/**
 * Keyboard occlusion (plan W1): with `interactiveWidget: resizes-content`,
 * focusing a text field shrinks the viewport and the fixed clay dock would
 * float up over forms. This hook watches focus at the document level and
 * toggles `data-keyboard-open` on <html>; the dock (and any other fixed
 * bottom UI) hides via `html[data-keyboard-open] &` styles.
 */
export function useKeyboardOcclusion() {
  React.useEffect(() => {
    const root = document.documentElement;
    const FOCUSABLE_INPUT = "input, textarea, select, [contenteditable]";

    const isOpen = (target: EventTarget | null) =>
      // focusin/focusout and activeElement are always the FOCUSED element
      // itself — never use querySelector here: BODY.querySelector("input")
      // matches the first input anywhere in the document and would pin the
      // flag open forever (m1 e2e finding).
      target instanceof HTMLElement && target.matches(FOCUSABLE_INPUT);

    const onFocusIn = (event: FocusEvent) => {
      if (isOpen(event.target)) root.setAttribute("data-keyboard-open", "");
    };
    const onFocusOut = (event: FocusEvent) => {
      // focusout fires before focusin on moves between inputs — check the
      // element gaining focus (relatedTarget) before clearing the flag.
      if (isOpen(event.relatedTarget)) return;
      if (isOpen(event.target) || root.hasAttribute("data-keyboard-open")) {
        root.removeAttribute("data-keyboard-open");
      }
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    // Safety net (m1 e2e finding): when the FOCUSED element unmounts (e.g.
    // the join form after router.refresh), no focusout fires — sync the
    // flag to document.activeElement periodically.
    const sync = () => {
      if (isOpen(document.activeElement)) {
        root.setAttribute("data-keyboard-open", "");
      } else {
        root.removeAttribute("data-keyboard-open");
      }
    };
    const iv = window.setInterval(sync, 500);

    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.clearInterval(iv);
      root.removeAttribute("data-keyboard-open");
    };
  }, []);
}

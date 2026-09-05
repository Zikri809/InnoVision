"use client";

import * as React from "react";

type WakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: string, listener: () => void) => void;
};

type WakeLockManager = {
  request: (type: "screen") => Promise<WakeLockSentinel>;
};

/**
 * Screen Wake Lock (plan W3/W4): keeps the screen awake during capture
 * flows — a screen auto-lock mid-assessment cascades into a focus_lost
 * pause. Re-acquires on visibilitychange (the sentinel is released by the
 * browser whenever the tab hides) and releases on unmount or when
 * `enabled` flips false. No-op where the API is unsupported (Safari <16.4,
 * Firefox).
 */
export function useWakeLock({ enabled }: { enabled: boolean }) {
  const sentinelRef = React.useRef<WakeLockSentinel | null>(null);

  const acquire = React.useCallback(async () => {
    if (typeof navigator === "undefined") return;
    const manager = (navigator as Navigator & { wakeLock?: WakeLockManager })
      .wakeLock;
    if (!manager || sentinelRef.current) return;
    try {
      sentinelRef.current = await manager.request("screen");
    } catch {
      // Denied or unsupported — screen lock stays the OS default. Not fatal.
    }
  }, []);

  const release = React.useCallback(async () => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    try {
      if (sentinel && !sentinel.released) await sentinel.release();
    } catch {
      // Already released by the browser — nothing to do.
    }
  }, []);

  React.useEffect(() => {
    if (!enabled) {
      void release();
      return;
    }
    void acquire();

    // The browser releases the sentinel whenever the page is hidden; the
    // visibilitychange handler re-arms it when we come back.
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void release();
    };
  }, [enabled, acquire, release]);
}

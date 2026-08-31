"use client";

import { useEffect, useRef } from "react";
import { BotAvatar } from "@/components/bot/bot-avatar";
import type { BotState } from "@/lib/bot/engine";

export function AuthBot({
  state,
  danger = false,
}: {
  state: BotState;
  danger?: boolean;
}) {
  const gazeRef = useRef<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const el = boxRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const clamp = (v: number) => Math.max(-1, Math.min(1, v));
      gazeRef.current = {
        x: -0.76 + clamp(nx) * 0.03,
        y: -0.05 + clamp(ny) * 0.08,
      };
    }
    function onLeave() {
      gazeRef.current = null;
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      className="pointer-events-none fixed top-1/2 -right-[16vmin] xl:-right-[12vmin] z-0 hidden -translate-y-1/2 lg:block opacity-90 transition-all duration-300"
    >
      <BotAvatar
        state={state}
        size={48}
        className="h-[75vmin] w-[75vmin] max-h-[640px] max-w-[640px]"
        bodyClassName={danger ? "fill-destructive" : undefined}
        gazeRef={gazeRef}
        eyeSepScale={0.35}
        eyeSizeScale={1.15}
        wobbleScale={0}
      />
    </div>
  );
}

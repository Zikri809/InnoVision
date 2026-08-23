"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  BOT_MORPH_SEC,
  sampleBot,
  settledMachine,
  type BotFrame,
  type BotState,
} from "@/lib/bot/engine";

const STATIC_T = 0.37;
const TERMINAL_SETTLE_SEC = BOT_MORPH_SEC + 1.3;

function fmt(n: number): string {
  return n.toFixed(3);
}

function bodyPath(points: BotFrame["points"]): string {
  let d = "";
  for (let i = 0; i < points.length; i++) {
    d += `${i === 0 ? "M" : "L"}${fmt(points[i].x)} ${fmt(points[i].y)}`;
  }
  return `${d}Z`;
}

function subscribePrefersReduced(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getPrefersReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function BotAvatar({
  state = "idle",
  size = 96,
  className,
  bodyClassName,
  gazeRef,
  eyeSepScale = 1,
  eyeSizeScale = 1,
  wobbleScale = 1,
}: {
  state?: BotState;
  size?: number;
  className?: string;
  bodyClassName?: string;
  gazeRef?: React.RefObject<{ x: number; y: number } | null>;
  eyeSepScale?: number;
  eyeSizeScale?: number;
  wobbleScale?: number;
}) {
  const reduced = useSyncExternalStore(
    subscribePrefersReduced,
    getPrefersReduced,
    () => false,
  );
  const [loopFrame, setLoopFrame] = useState<BotFrame>(() =>
    sampleBot(STATIC_T, settledMachine(state)),
  );
  const staticFrame = useMemo(
    () => sampleBot(STATIC_T, settledMachine(state), undefined, eyeSepScale, eyeSizeScale, wobbleScale),
    [state, eyeSepScale, eyeSizeScale, wobbleScale],
  );
  const frame = reduced ? staticFrame : loopFrame;

  const tRef = useRef(STATIC_T);
  const machineRef = useRef<{
    current: BotState;
    prev: BotState | null;
    switchAt: number;
  }>({ current: state, prev: null, switchAt: 0 });
  const ioVisibleRef = useRef(true);
  const docVisibleRef = useRef(true);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    machineRef.current = {
      current: state,
      prev:
        machineRef.current.current === state
          ? machineRef.current.prev
          : machineRef.current.current,
      switchAt: tRef.current,
    };
  }, [state]);

  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (ioVisibleRef.current && docVisibleRef.current) {
        tRef.current += dt;
        setLoopFrame(
          sampleBot(tRef.current, machineRef.current, gazeRef?.current ?? undefined, eyeSepScale, eyeSizeScale, wobbleScale),
        );
        const { current, switchAt } = machineRef.current;
        if (
          (current === "success" || current === "fail") &&
          tRef.current - switchAt > TERMINAL_SETTLE_SEC
        ) {
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, state, gazeRef, eyeSepScale, eyeSizeScale, wobbleScale]);

  useEffect(() => {
    const node = svgRef.current;
    const io =
      node && "IntersectionObserver" in window
        ? new IntersectionObserver((entries) => {
            ioVisibleRef.current = entries[0]?.isIntersecting ?? true;
          })
        : null;
    if (io && node) io.observe(node);
    const onVis = () => {
      docVisibleRef.current = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect();
    };
  }, []);

  const eyes = [frame.leftEye, frame.rightEye];

  return (
    <svg
      ref={svgRef}
      viewBox="-1.75 -1.75 3.5 3.5"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {frame.ring && (
        <circle
          cx="0"
          cy="0"
          r={fmt(frame.ring.r)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={0.05}
          opacity={fmt(frame.ring.alpha)}
        />
      )}
      <path
        d={bodyPath(frame.points)}
        fill="var(--primary)"
        stroke="var(--border)"
        strokeWidth={0.07}
        strokeLinejoin="round"
        className={`transition-colors duration-500 ${bodyClassName ?? ""}`}
      />
      {eyes.map((e, i) =>
        e.expr === "open" ? (
          <ellipse
            key={i}
            cx={fmt(e.cx)}
            cy={fmt(e.cy)}
            rx={fmt(e.rx)}
            ry={fmt(e.ry)}
            fill="var(--card)"
          />
        ) : (
          <path
            key={i}
            d={`M ${fmt(e.cx - e.rx)} ${fmt(e.cy)} Q ${fmt(e.cx)} ${fmt(e.cy - e.rx * 1.2)} ${fmt(e.cx + e.rx)} ${fmt(e.cy)}`}
            fill="none"
            stroke="var(--card)"
            strokeWidth={0.085}
            strokeLinecap="round"
          />
        ),
      )}
      {frame.dots.map((d, i) => (
        <circle
          key={i}
          cx={fmt(d.x)}
          cy={fmt(d.y)}
          r={fmt(d.r)}
          fill="var(--accent)"
          opacity={fmt(d.alpha)}
        />
      ))}
    </svg>
  );
}

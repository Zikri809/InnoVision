"use client";

import { useSyncExternalStore } from "react";
import type { BotState } from "@/lib/bot/engine";

/**
 * GenerationSphere — the generation mascot as a plain sphere (user brief:
 * the morphing blob reads wrong for this moment; the reference is
 * redesign-previews/generation-progress-redesign.html concept 2's bot
 * geometry re-drawn as a circle). Same geometry language as BotAvatar:
 * orange body, white eyes, accent ring/orbit dots — but a perfect circle
 * with a soft cream halo, and a viewBox that hugs the RING (not the body)
 * so the sphere's bottom edge lands exactly on the pedestal bar when the
 * bar is pulled up under it (the call site overlaps them with -mt-5).
 *
 * Faces per state: running = open eyes + live ring/dots (blink via SMIL,
 * gated on prefers-reduced-motion), success/celebrate = happy arcs + smile,
 * fail = frown, warn/paused = flat mouth.
 */

function subscribePrefersReduced(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getPrefersReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Ring + orbit dots only while the sphere is "working". */
function hasLiveDecor(state: BotState): boolean {
  return state === "thinking" || state === "scanning";
}

function Face({ state, reduced }: { state: BotState; reduced: boolean }) {
  if (state === "success" || state === "celebrate") {
    return (
      <>
        <path
          d="M -0.44 0.04 Q -0.3 -0.16 -0.16 0.04"
          fill="none"
          stroke="#ffffff"
          strokeWidth={0.09}
          strokeLinecap="round"
        />
        <path
          d="M 0.16 0.04 Q 0.3 -0.16 0.44 0.04"
          fill="none"
          stroke="#ffffff"
          strokeWidth={0.09}
          strokeLinecap="round"
        />
        <path
          d="M -0.22 0.32 Q 0 0.5 0.22 0.32"
          fill="none"
          stroke="#ffffff"
          strokeWidth={0.09}
          strokeLinecap="round"
        />
      </>
    );
  }
  if (state === "fail") {
    return (
      <>
        <ellipse cx={-0.3} cy={-0.08} rx={0.13} ry={0.1} fill="#ffffff" />
        <ellipse cx={0.3} cy={-0.08} rx={0.13} ry={0.1} fill="#ffffff" />
        <path
          d="M -0.22 0.42 Q 0 0.28 0.22 0.42"
          fill="none"
          stroke="#ffffff"
          strokeWidth={0.09}
          strokeLinecap="round"
        />
      </>
    );
  }
  if (state === "warn" || state === "paused") {
    return (
      <>
        <ellipse cx={-0.3} cy={-0.08} rx={0.13} ry={0.1} fill="#ffffff" />
        <ellipse cx={0.3} cy={-0.08} rx={0.13} ry={0.1} fill="#ffffff" />
        <path
          d="M -0.2 0.38 L 0.2 0.38"
          fill="none"
          stroke="#ffffff"
          strokeWidth={0.09}
          strokeLinecap="round"
        />
      </>
    );
  }
  // idle / thinking / scanning — open oval eyes; SMIL blink while live.
  const blink = (begin: string) =>
    reduced ? null : (
      <animate
        attributeName="ry"
        values="0.1;0.1;0.012;0.1"
        dur="3.4s"
        begin={begin}
        repeatCount="indefinite"
      />
    );
  return (
    <>
      <ellipse cx={-0.3} cy={-0.08} rx={0.13} ry={0.1} fill="#ffffff">
        {blink("0s")}
      </ellipse>
      <ellipse cx={0.3} cy={-0.08} rx={0.13} ry={0.1} fill="#ffffff">
        {blink("0.15s")}
      </ellipse>
    </>
  );
}

export function GenerationSphere({
  state = "idle",
  size = 96,
  className,
}: {
  state?: BotState;
  size?: number;
  className?: string;
}) {
  const reduced = useSyncExternalStore(
    subscribePrefersReduced,
    getPrefersReduced,
    () => false,
  );
  const live = hasLiveDecor(state) && !reduced;

  return (
    <svg
      viewBox="-1.45 -1.45 2.9 2.9"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {/* Orbit ring + sparkle dots — running only (the preview drops them
          at terminal states), breathing exactly like the preview's botSVG
          (r 1.15→1.4, opacity .55→.15, 2s) so the lower arc sweeps into
          the pedestal bar; the call site overlaps the bar 19px up. */}
      {live && (
        <circle
          cx={0}
          cy={0}
          r={1.3}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={0.06}
          opacity={0.5}
        >
          <animate
            attributeName="r"
            values="1.15;1.4;1.15"
            dur="2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.55;0.15;0.55"
            dur="2s"
            repeatCount="indefinite"
          />
        </circle>
      )}
      {/* Sparkle dots on the ring's upper-right arc — two bounce along the
          ring (cy animation) and two hold still, mirroring the preview. */}
      {live && (
        <>
          <circle cx={0.8} cy={-1} r={0.06} fill="var(--accent)">
            <animate
              attributeName="cy"
              values="-1;-1.25;-1"
              dur="2s"
              repeatCount="indefinite"
            />
          </circle>
          <circle cx={1.06} cy={-0.72} r={0.045} fill="var(--accent)" opacity={0.7}>
            <animate
              attributeName="cy"
              values="-0.72;-0.95;-0.72"
              dur="2s"
              begin="0.3s"
              repeatCount="indefinite"
            />
          </circle>
          <circle cx={0.86} cy={-0.9} r={0.06} fill="var(--accent)" />
          <circle cx={1.1} cy={-0.62} r={0.045} fill="var(--accent)" opacity={0.7} />
        </>
      )}
      {/* Soft cream halo, then the sphere itself. */}
      <circle
        cx={0}
        cy={0}
        r={1.1}
        className="fill-orange-100 dark:fill-orange-300/20"
      />
      <circle cx={0} cy={0} r={1} fill="var(--primary)" />
      <Face state={state} reduced={reduced} />
    </svg>
  );
}

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Scroll-into-view entrance wrapper. Adds .reveal-in once the element enters
 * the viewport (or immediately on older browsers) so CSS can run a staggered
 * pop-in. Under prefers-reduced-motion the global animation kill-switch in
 * globals.css renders the final state instantly, so this stays decorative.
 */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
      data-reveal={shown ? "in" : "out"}
    >
      {children}
    </div>
  );
}

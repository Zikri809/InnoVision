"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { isDevPlaygroundEnabled } from "@/lib/face/seam-gate";

/**
 * Dev-only trigger for the root error boundary (error.tsx). Exists so E2E can
 * exercise the boundary without a deliberate production crash surface.
 * 404 outside dev or the E2E harness — same guard as the /dev/bot playground.
 */
export default function DevErrorPage() {
  if (!isDevPlaygroundEnabled()) notFound();

  const [armed, setArmed] = useState(false);

  // Throw on a RENDER pass (not an event handler) so Next's error boundary
  // picks it up. Arming via state keeps the initial SSR/prerender clean.
  useEffect(() => {
    // Intentional: arming the error trigger IS the effect's job; there is no
    // external system to subscribe to on this dev-only page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArmed(true);
  }, []);

  if (armed) {
    throw new Error("Dev-only error boundary trigger (/dev/error).");
  }

  return (
    <main className="grid min-h-screen place-items-center">
      <p className="font-heading text-sm text-muted-foreground">Arming error trigger…</p>
    </main>
  );
}
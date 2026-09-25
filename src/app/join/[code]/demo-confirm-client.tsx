"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";

/**
 * Demo walk-up island (PLAN_DEMO_MODE.md D4).
 *
 * Renders only under NEXT_PUBLIC_DEMO_MODE=1 for the seeded demo class code.
 * The page (server component) has already re-derived the flag + code match and
 * resolved the auth branch; this island only performs the actions:
 *
 *  - anonymous            → "Join the demo" → POST /api/demo/guest → redirect
 *  - authenticated guest  → "Continue as Guest #N" OR "Start fresh"
 *                           (sign out client-side, then re-run provisioning)
 *
 * The POST is user-initiated on purpose: a link-preview bot scanning a shared
 * /join URL must not mint accounts. Do not "optimize" this into an auto-submit.
 */
export function DemoConfirmClient({
  code,
  guestName,
}: {
  code: string;
  /** When the visitor already holds a demo guest session, its display name. */
  guestName?: string | null;
}) {
  const router = useRouter();
  const t = useTranslations("demo");
  const tCommon = useTranslations("common");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-entry lock as a REF: two same-frame clicks both see busy=false before a
  // re-render, so a state-only guard can mint TWO guests. (student-quizzes-
  // client.tsx uses the same submitLock ref pattern.)
  const lockRef = useRef(false);

  async function provision() {
    if (lockRef.current) return;
    lockRef.current = true;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/demo/guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 429) setError(t("queueBusy"));
        else if (res.status === 503) setError(t("atCapacity"));
        else setError(tCommon("errorGeneric"));
        return;
      }
      router.replace(body?.redirect ?? "/student/quizzes");
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }

  async function startFresh() {
    if (lockRef.current) return;
    lockRef.current = true;
    setError(null);
    setBusy(true);
    try {
      // Clear the previous visitor's guest session so the next POST mints a
      // NEW guest (never silently continues as Guest #1 on a borrowed phone).
      const supabase = createClient();
      await supabase.auth.signOut();
    } catch {
      // Sign-out failure is non-fatal: provisioning still overwrites the cookie.
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
    await provision();
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">{t("title")}</CardTitle>
        <CardDescription>
          {guestName ? t("continueSubtitle", { name: guestName }) : t("subtitle")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <p
          data-testid="demo-code-display"
          className="text-center font-heading text-4xl font-bold tracking-[0.3em] text-primary"
        >
          {code}
        </p>
        <div aria-live="polite" className={!error ? "hidden" : undefined}>
          {error && (
            <p
              role="alert"
              className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
            >
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3">
          {guestName ? (
            <>
              <Button
                type="button"
                size="lg"
                className="w-full"
                onClick={() => void provision()}
                disabled={busy}
              >
                {busy ? t("starting") : t("continueCta", { name: guestName })}
              </Button>
              <Button
                type="button"
                size="lg"
                variant="outline"
                className="w-full"
                onClick={() => void startFresh()}
                disabled={busy}
              >
                {t("startFreshCta")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="lg"
              className="w-full"
              onClick={() => void provision()}
              disabled={busy}
            >
              {busy ? t("starting") : t("joinCta")}
            </Button>
          )}
          <p className="text-center text-xs font-semibold text-muted-foreground">
            {t("hint")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

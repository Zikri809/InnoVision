"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { joinErrorKey } from "./join-errors";

/**
 * /join/[code] confirm island — the scan target for the lecturer's QR code.
 * * The page (server component) resolved the auth branch; this island only
 * renders for logged-in students with a format-valid code. The POST is
 * user-initiated on purpose: link-preview bots and scanners hitting a shared
 * /join URL must not fire enrollment RPCs or burn DB lockout counters
 * (class_join_attempts). CSRF is unaffected either way (checkSameOrigin
 * passes for any same-origin fetch), so the deliberate-confirm UX is the
 * real reason — do not "optimize" this into an auto-submit.
 *
 * Error mapping: every typed API error gets a localized join.* key. (The
 * /student/classes drawer renders raw server English for most errors — a
 * known issue this surface deliberately does not replicate.)
 */
export function JoinConfirmClient({ code }: { code: string }) {
  const router = useRouter();
  const t = useTranslations("join");
  const tCommon = useTranslations("common");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleJoin() {
    if (joining) return;
    setError(null);
    setJoining(true);
    try {
      const res = await fetch("/api/classes/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json();
      if (!res.ok) {
        // audit-2 H-11: the RPC (authority) can still refuse a NULL-matric
        // student (e.g. the profile changed between page render and click) —
        // route them into the capture flow instead of showing an error.
        if (body?.error === "matric_required") {
          router.replace("/matric-capture");
          router.refresh();
          return;
        }
        const key = joinErrorKey(res.status, body?.error);
        setError(key === "generic" ? tCommon("errorGeneric") : t(key));
        return;
      }
      toast.success(t("joinedSuccess", { title: body.class?.title ?? "" }));
      // replace, not push: the join is consumed — Back from the classes
      // page should not re-offer it (QR scans are cold navigations anyway).
      router.replace("/student/classes");
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setJoining(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">{t("confirmTitle")}</CardTitle>
        <CardDescription>{t("confirmSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <p
          data-testid="join-code-display"
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
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={() => void handleJoin()}
            disabled={joining}
          >
            {joining ? t("joining") : t("confirmCta")}
          </Button>
          <Link
            href="/student/classes"
            className="inline-flex h-11 w-full items-center justify-center rounded-2xl text-sm font-bold text-muted-foreground hover:text-primary hover:underline"
          >
            {t("backToClasses")}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// Error mapping lives in ./join-errors (pure, unit-tested); this island only
// translates the resulting key names.

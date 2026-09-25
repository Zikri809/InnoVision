"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { WalkupResetSummary } from "@/lib/demo/walkup-reset";

/**
 * /demo reset island (PLAN_DEMO_MODE.md D9). Lists the blast radius before the
 * action and labels it "between shows only": a mid-show click recreates the
 * walk-up quiz under visitors who are mid-quiz.
 */
export function DemoResetButton() {
  const router = useRouter();
  const t = useTranslations("demo");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/demo/reset-walkup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? t("resetFailed"));
        return;
      }
      const s = body?.summary as WalkupResetSummary | undefined;
      setResult(
        s
          ? t("resetDone", {
              guests: s.guestsDeleted,
              enrollments: s.realEnrollmentsRemoved,
              recreated: s.quizRecreated ? "✓" : "✕",
              stale: s.staleQuizzesDeleted,
            })
          : t("doneCta"),
      );
      router.refresh();
    } catch {
      setError(t("resetFailed"));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-3">
      {!confirming ? (
        <Button type="button" variant="outline" onClick={() => setConfirming(true)} disabled={busy}>
          {t("resetCta")}
        </Button>
      ) : (
        <div className="space-y-2 rounded-2xl border-[3px] border-destructive/40 bg-destructive/10 p-4">
          <p className="text-sm font-bold text-destructive">{t("resetWarning")}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => void run()} disabled={busy}>
              {busy ? t("resetBusy") : t("resetConfirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              {t("resetCancel")}
            </Button>
          </div>
        </div>
      )}
      {result && (
        <p className="rounded-xl border-[3px] border-border bg-card px-4 py-3 text-sm font-semibold">
          {result}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-bold text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

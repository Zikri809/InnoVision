"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { WalkupResetSummary } from "@/lib/demo/walkup-reset";

/**
 * /demo reset island (PLAN_DEMO_MODE.md D9). Lists the blast radius before the
 * action and labels it "between shows only": a mid-show click recreates the
 * walk-up quiz under visitors who are mid-quiz.
 *
 * A5 (PLAN_DEMO_DAY_HARDENING): the age selector passes maxAgeHours through to
 * the route (clamped ≤24h server-side). 0h is the cap-hit escape hatch —
 * deletes ALL guests — and carries its own warning.
 */
export function DemoResetButton() {
  const router = useRouter();
  const t = useTranslations("demo");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [maxAgeHours, setMaxAgeHours] = useState(2);
  // R2 MINOR-3: same-frame re-entry lock (busy state doesn't cover two clicks
  // before re-render — the provision()/startFresh() lockRef pattern).
  const lockRef = useRef(false);

  async function run() {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/demo/reset-walkup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, maxAgeHours }),
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
              skipped: s.guestsSkippedActive ?? 0,
              enrollments: s.realEnrollmentsRemoved,
              preserved: s.realEnrollmentsPreserved ?? 0,
              recreated: s.quizRecreated ? "✓" : "✕",
              stale: s.staleQuizzesDeleted,
              cleared: s.curatedGuestSessionsCleared ?? 0,
            }) +
            (s.quizRecreateFailedReason === "deferred_active_sessions"
              ? ` ${t("resetDeferred")}`
              : "")
          : t("doneCta"),
      );
      router.refresh();
    } catch {
      setError(t("resetFailed"));
    } finally {
      lockRef.current = false;
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
          <label className="flex items-center gap-2 text-sm font-bold">
            <span>{t("resetAgeLabel")}</span>
            <select
              value={maxAgeHours}
              onChange={(e) => setMaxAgeHours(Number(e.target.value))}
              disabled={busy}
              className="rounded-xl border-[3px] border-border bg-card px-2 py-1 text-sm font-bold"
            >
              <option value={2}>{t("resetAge2h")}</option>
              <option value={1}>{t("resetAge1h")}</option>
              <option value={0}>{t("resetAge0h")}</option>
            </select>
          </label>
          {maxAgeHours === 0 && (
            <p role="alert" className="text-sm font-bold text-destructive">
              {t("resetAgeZeroWarning")}
            </p>
          )}
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
        <p
          role="status"
          className="rounded-xl border-[3px] border-border bg-card px-4 py-3 text-sm font-semibold"
        >
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

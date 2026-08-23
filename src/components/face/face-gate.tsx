"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { BotAvatar } from "@/components/bot/bot-avatar";
import type { BotState } from "@/lib/bot/engine";
import type { FaceStatus } from "@/lib/face/types";
import { ShieldCheck, UserRound, Timer } from "lucide-react";

const LIVENESS_AVATAR: Record<"idle" | "waiting" | "passed" | "failed", BotState> = {
  idle: "idle",
  waiting: "scanning",
  passed: "success",
  failed: "fail",
};

export function FaceGate({
  consentGiven,
  enrolled,
  remainingMs,
  livenessState,
  status,
  onBegin,
  onConsent,
}: {
  consentGiven: boolean;
  enrolled: boolean;
  remainingMs: number | null;
  livenessState: "idle" | "waiting" | "passed" | "failed";
  status: FaceStatus;
  onBegin: () => void;
  onConsent: () => void;
}) {
  const [consentChecked, setConsentChecked] = useState(consentGiven);
  const router = useRouter();
  const t = useTranslations("face");
  const tCommon = useTranslations("common");

  const readyToBegin = consentChecked && enrolled;

  return (
    <div className="relative mx-auto max-w-2xl px-4 py-10">
      {/* decorative blobs */}
      <div aria-hidden className="pointer-events-none absolute -left-6 top-8 h-24 w-24 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50" />
      <div aria-hidden className="pointer-events-none absolute -right-4 bottom-12 h-20 w-20 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50" />

      <div className="relative rounded-[28px] border-[3px] border-border bg-card p-7 shadow-[var(--shadow-clay)] md:p-9">
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-[18px] bg-blue-100 shadow-[0_4px_0_rgba(29,78,216,0.15)]">
          <BotAvatar state={LIVENESS_AVATAR[livenessState]} size={38} />
        </div>
        <h1 className="font-heading text-2xl font-semibold">{t("gateTitle")}</h1>
        <p className="mt-2 text-sm font-semibold text-muted-foreground">
          {t("gateSubtitle")}
        </p>

        {remainingMs !== null && (
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border-[3px] border-amber-300 bg-amber-50 px-3.5 py-1.5 text-sm font-extrabold text-amber-800" role="status">
            <Timer className="h-4 w-4" aria-hidden />
            {t("timeRemaining", { sec: Math.max(0, Math.ceil(remainingMs / 1000)) })}
          </p>
        )}

        {!consentGiven && (
          <div className="mt-5 rounded-2xl border-[3px] border-border bg-orange-50/60 p-5">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
              <p className="font-heading text-base font-semibold">{t("consentRequired")}</p>
            </div>
            <p className="mt-2 text-sm font-semibold text-muted-foreground">
              {t("consentCheckbox")}
            </p>
            <Button
              className="mt-4"
              onClick={() => {
                setConsentChecked(true);
                onConsent();
              }}
            >
              {tCommon("confirm")}
            </Button>
          </div>
        )}

        {!enrolled && consentGiven && (
          <div className="mt-5 rounded-2xl border-[3px] border-border bg-orange-50/60 p-5">
            <div className="flex items-center gap-2.5">
              <UserRound className="h-5 w-5 text-primary" aria-hidden />
              <p className="font-heading text-base font-semibold">{t("enrollRequired")}</p>
            </div>
            <p className="mt-2 text-sm font-semibold text-muted-foreground">
              {t("enrollRequiredBody")}
            </p>
            <Button
              className="mt-4"
              onClick={() => {
                router.push("/student/face/enroll");
              }}
            >
              {t("goToEnrollment")}
            </Button>
          </div>
        )}

        <div className="mt-5 rounded-2xl border-[3px] border-border bg-muted/50 p-5" role="status">
          <p className="font-heading text-base font-semibold">{t("livenessTitle")}</p>
          <p className="mt-1.5 text-sm font-semibold text-muted-foreground">
            {livenessState === "idle" && t("livenessIdle")}
            {livenessState === "waiting" && t("livenessWaiting")}
            {livenessState === "passed" && t("livenessPassed")}
            {livenessState === "failed" && t("livenessFailed")}
            {status === "paused" && t("livenessPaused")}
          </p>
        </div>

        <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-extrabold text-muted-foreground">
            {readyToBegin ? tCommon("ok") : t("enrollRequiredBody")}
          </p>
          <Button size="lg" onClick={onBegin} disabled={!readyToBegin}>
            {t("beginBtn")}
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, buttonVariants } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("common");

  useEffect(() => {
    console.error("App error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="rounded-[28px] border-[3px] border-destructive/40 bg-card p-8 shadow-[var(--shadow-clay)] max-w-md w-full">
        <span
          aria-hidden="true"
          className="inline-grid h-14 w-14 -rotate-4 place-items-center rounded-2xl bg-destructive font-heading text-2xl font-bold text-destructive-foreground shadow-[0_4px_0_var(--destructive-deep,#991b1b)] mb-4"
        >
          !
        </span>
        <h1 className="font-heading text-2xl font-semibold mb-2">{t("errorTitle")}</h1>
        <p className="text-sm font-semibold text-muted-foreground mb-6">{t("errorBody")}</p>
        <div className="flex flex-col gap-3">
          <Button onClick={() => reset()} size="lg" className="w-full">
            {t("retry")}
          </Button>
          <Link href="/" className={buttonVariants({ variant: "outline", size: "lg", className: "w-full" })}>
            {t("returnHome")}
          </Link>
        </div>
      </div>
    </div>
  );
}

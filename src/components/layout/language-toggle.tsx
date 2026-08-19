"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { setLocale } from "@/lib/i18n/locale";
import type { Locale } from "@/i18n/config";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export function LanguageToggle({ className }: { className?: string }) {
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const t = useTranslations("nav");

  function toggleLanguage() {
    const nextLocale: Locale = locale === "en" ? "ms" : "en";
    startTransition(async () => {
      await setLocale(nextLocale);
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={toggleLanguage}
      disabled={isPending}
      className={cn(
        "inline-flex h-11 cursor-pointer items-center gap-2 rounded-2xl border-[3px] border-border bg-card px-3.5 font-heading text-sm font-extrabold text-foreground shadow-[0_4px_0_var(--border)] transition-[transform,box-shadow] duration-[180ms] ease-out hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--border)] disabled:opacity-50",
        className,
      )}
      title={t("toggleLanguage")}
      aria-label={t("toggleLanguage")}
    >
      <Globe className="h-4 w-4 text-primary" aria-hidden />
      <span>{locale === "en" ? "EN" : "BM"}</span>
    </button>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme/use-theme";
import type { ThemePreference } from "@/lib/theme/theme";
import { cn } from "@/lib/utils";

const ICONS: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

/**
 * Theme cycle toggle (light → dark → system), visually paired with
 * LanguageToggle. Announces the new mode via aria-label; the icon + short
 * label reflect the CURRENT preference so the next click's outcome is
 * predictable.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, resolved, cycle } = useTheme();
  const t = useTranslations("nav");
  const Icon = ICONS[preference];

  return (
    <button
      type="button"
      onClick={cycle}
      className={cn(
        "inline-flex h-11 cursor-pointer items-center gap-2 rounded-2xl border-[3px] border-border bg-card px-3.5 font-heading text-sm font-extrabold text-foreground shadow-[0_4px_0_var(--border)] transition-[transform,box-shadow] duration-[180ms] ease-out hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--border)]",
        className,
      )}
      title={t("toggleTheme")}
      aria-label={t("themeAria", { mode: t(`theme_${preference}`) })}
      data-testid="theme-toggle"
      data-theme-preference={preference}
      data-theme-resolved={resolved}
    >
      <Icon className="h-4 w-4 text-primary" aria-hidden />
      <span>{t(`theme_${preference}`)}</span>
    </button>
  );
}

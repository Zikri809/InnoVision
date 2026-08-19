export const SUPPORTED_LOCALES = ["en", "ms"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE_NAME = "NEXT_LOCALE";

export const LOCALE_LABELS: Record<Locale, { label: string; flag: string; short: string }> = {
  en: { label: "English", flag: "🇬🇧", short: "EN" },
  ms: { label: "Bahasa Melayu", flag: "🇲🇾", short: "BM" },
};

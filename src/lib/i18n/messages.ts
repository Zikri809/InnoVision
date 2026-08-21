import en from "@/messages/en.json";
import ms from "@/messages/ms.json";
import type { SupportedLocale } from "@/lib/types/aliases";

type Messages = typeof en;

const CATALOG: Record<SupportedLocale, Messages> = { en, ms };

/**
 * Dotted-path message lookup for server code that already knows the user's
 * locale (server actions receive it as a parameter, so next-intl's
 * request-scoped `getTranslations` — which reads the cookie — is the wrong
 * tool there). Falls back to English, then to the key itself.
 */
export function tFor(locale: SupportedLocale): (key: string) => string {
  const msgs = CATALOG[locale] ?? CATALOG.en;
  return function t(key: string): string {
    const lookup = (obj: unknown, parts: string[]): string | undefined => {
      let cur: unknown = obj;
      for (const part of parts) {
        if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[part];
        } else {
          return undefined;
        }
      }
      return typeof cur === "string" ? cur : undefined;
    };
    const parts = key.split(".");
    return lookup(msgs, parts) ?? lookup(CATALOG.en, parts) ?? key;
  };
}

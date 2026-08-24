import { getTranslations } from "next-intl/server";

/**
 * Server-component panels for the two recurring page-load failure states
 * (profile not ready / query failed). Centralized so every route group gets
 * localized copy — these panels previously hardcoded English in ~11 async
 * server components, which Malay-locale users saw on every DB hiccup.
 */
export async function ProfilePendingPanel() {
  const t = await getTranslations("common");
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <p
        className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"
        role="alert"
      >
        {t("profileSettingUp")}
      </p>
    </div>
  );
}

export async function LoadErrorPanel() {
  const t = await getTranslations("common");
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <p
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        role="alert"
      >
        {t("loadFailed")}
      </p>
    </div>
  );
}

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";

export default async function NotFound() {
  const t = await getTranslations("common");
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="rounded-[28px] border-[3px] border-border bg-card p-8 shadow-[var(--shadow-clay)] max-w-md w-full">
        <span
          aria-hidden="true"
          className="inline-grid h-14 w-14 -rotate-4 place-items-center rounded-2xl bg-primary font-heading text-2xl font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)] mb-4"
        >
          404
        </span>
        <h1 className="font-heading text-2xl font-semibold mb-2">{t("notFoundTitle")}</h1>
        <p className="text-sm font-semibold text-muted-foreground mb-6">{t("notFoundBody")}</p>
        <Link href="/" className={buttonVariants({ size: "lg", className: "w-full" })}>
          {t("returnHome")}
        </Link>
      </div>
    </div>
  );
}

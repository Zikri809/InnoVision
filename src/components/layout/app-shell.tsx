import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { AppUserMenu } from "./app-user-menu";
import { AppNavLink } from "./app-nav-link";

/**
 * Shared clay app shell for the authenticated areas. Renders a sticky topbar
 * with the brand mark, role-aware nav, and the account menu; page content sits
 * in a centered, padded container. `/play` intentionally opts out (full-screen
 * focus mode).
 */
export async function AppShell({
  role,
  email,
  fullName,
  consentGiven,
  notificationBell,
  children,
}: {
  role: "lecturer" | "student";
  email: string;
  /** Profile display name (profiles.full_name) — shown in the account menu. */
  fullName?: string;
  consentGiven: boolean;
  /** Server-fetched <NotificationBell /> island (see role layouts). */
  notificationBell?: ReactNode;
  children: ReactNode;
}) {
  const t = await getTranslations("nav");

  const links =
    role === "lecturer"
      ? [{ href: "/lecturer/classes", label: t("myClasses") }]
      : [
          { href: "/student/classes", label: t("myClasses") },
          { href: "/student/quizzes", label: t("quizzes") },
          { href: "/student/my-quizzes", label: t("myQuizzes") },
          { href: "/student/face/enroll", label: t("faceSetup") },
        ];

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="skip-link">
        {t("skipToContent")}
      </a>

      <header className="sticky top-0 z-50 border-b-[3px] border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-[74px] w-full max-w-6xl items-center justify-between gap-3 px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-6 md:gap-8">
            <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5">
              <span className="grid h-10 w-10 -rotate-4 place-items-center rounded-[14px] bg-primary font-heading text-lg font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
                IV
              </span>
              <span className="hidden font-heading text-[21px] font-semibold sm:inline">
                InnoVision
              </span>
            </Link>

            <nav aria-label="Primary" className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-1">
              {links.map((l) => (
                <AppNavLink key={l.href} href={l.href} label={l.label} />
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-1.5">
            {notificationBell}
            <AppUserMenu email={email} fullName={fullName} consentGiven={consentGiven} />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-6 py-8 md:py-10">
        {children}
      </main>
    </div>
  );
}

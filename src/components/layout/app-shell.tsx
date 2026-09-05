"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AppUserMenu } from "./app-user-menu";
import { AppNavLink } from "./app-nav-link";
import { MobileBottomNav } from "./mobile-bottom-nav";
import { useKeyboardOcclusion } from "@/hooks/use-keyboard-occlusion";

/**
 * Shared clay app shell for the authenticated areas. Renders a sticky topbar
 * with the brand mark, role-aware nav, and the account menu; page content sits
 * in a centered, padded container. `/play` intentionally opts out (full-screen
 * focus mode).
 *
 * Mobile (plan W1): the topbar pads the notch (--safe-top) and compresses to
 * brand + bell + avatar below sm — the language/theme toggles live in the
 * account sheet on phones. The floating dock replaces the flat bottom bar and
 * hides while the keyboard is open (useKeyboardOcclusion).
 */
export function AppShell({
  role,
  email,
  fullName,
  matricNo,
  consentGiven,
  avatarPath,
  memberSince,
  faceEnrolled,
  notificationBell,
  children,
}: {
  role: "lecturer" | "student";
  email: string;
  /** Profile display name (profiles.full_name) — shown in the account menu. */
  fullName?: string;
  /** profiles.matric_no — students only; shown (and editable) in the account menu. */
  matricNo?: string | null;
  consentGiven: boolean;
  /** profiles.avatar_path — presence only; the URL is fetched client-side. */
  avatarPath?: string | null;
  /** profiles.created_at — "member since" line in the account menu. */
  memberSince?: string | null;
  /** Student face-enrollment state → status dot on the dock's Face tab. */
  faceEnrolled?: boolean;
  /** Server-fetched <NotificationBell /> island (see role layouts). */
  notificationBell?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("nav");
  useKeyboardOcclusion();

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

      <header className="sticky top-0 z-50 border-b-[3px] border-border bg-background/85 pt-[var(--safe-top)] backdrop-blur">
        <div className="mx-auto flex h-[74px] w-full max-w-6xl items-center justify-between gap-3 px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-6 md:gap-8">
            <Link href="/dashboard" aria-label={t("brand")} className="flex shrink-0 items-center gap-2.5">
              <span className="grid h-10 w-10 -rotate-4 place-items-center rounded-[14px] bg-primary font-heading text-lg font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
                IV
              </span>
              <span className="hidden font-heading text-[21px] font-semibold sm:inline">
                InnoVision
              </span>
            </Link>

            <nav aria-label={t("primaryNav")} className="hidden sm:flex items-center gap-1.5 overflow-x-auto scrollbar-none py-1">
              {links.map((l) => (
                <AppNavLink key={l.href} href={l.href} label={l.label} />
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-1.5">
            {notificationBell}
            <AppUserMenu
              email={email}
              fullName={fullName}
              matricNo={matricNo}
              isStudent={role === "student"}
              consentGiven={consentGiven}
              hasAvatar={Boolean(avatarPath)}
              memberSince={memberSince}
            />
          </div>
        </div>
      </header>

      <main
        id="main"
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8 md:py-10 pb-[calc(96px+var(--safe-bottom))] sm:pb-10"
      >
        {children}
      </main>

      <MobileBottomNav role={role} faceEnrolled={role === "student" ? faceEnrolled : undefined} />
    </div>
  );
}

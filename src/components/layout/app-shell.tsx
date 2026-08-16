import Link from "next/link";
import type { ReactNode } from "react";
import { AppUserMenu } from "./app-user-menu";
import { AppNavLink } from "./app-nav-link";

type NavLink = { href: string; label: string };

const NAV: Record<"lecturer" | "student", NavLink[]> = {
  lecturer: [{ href: "/lecturer/classes", label: "My Classes" }],
  student: [
    { href: "/student/classes", label: "My Classes" },
    { href: "/student/quizzes", label: "Quizzes" },
    { href: "/student/face/enroll", label: "Face Setup" },
  ],
};

/**
 * Shared clay app shell for the authenticated areas. Renders a sticky topbar
 * with the brand mark, role-aware nav, and the account menu; page content sits
 * in a centered, padded container. `/play` intentionally opts out (full-screen
 * focus mode).
 */
export function AppShell({
  role,
  email,
  consentGiven,
  children,
}: {
  role: "lecturer" | "student";
  email: string;
  consentGiven: boolean;
  children: ReactNode;
}) {
  const links = NAV[role];

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <header className="sticky top-0 z-50 border-b-[3px] border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-[74px] w-full max-w-6xl items-center justify-between gap-4 px-6">
          <div className="flex min-w-0 items-center gap-8">
            <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5">
              <span className="grid h-10 w-10 -rotate-4 place-items-center rounded-[14px] bg-primary font-heading text-lg font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
                IV
              </span>
              <span className="hidden font-heading text-[21px] font-semibold sm:inline">
                InnoVision
              </span>
            </Link>

            <nav aria-label="Primary" className="flex items-center gap-1.5">
              {links.map((l) => (
                <AppNavLink key={l.href} href={l.href} label={l.label} />
              ))}
            </nav>
          </div>

          <AppUserMenu email={email} consentGiven={consentGiven} />
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-6 py-8 md:py-10">
        {children}
      </main>
    </div>
  );
}

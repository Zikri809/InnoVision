"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  GraduationCap,
  ClipboardList,
  Zap,
  ScanFace,
  Archive,
} from "lucide-react";
import { cn } from "@/lib/utils";

type DockLink = {
  href: string;
  label: string;
  icon: typeof GraduationCap;
  /** Student Face tab only: "enrolled" | "pending" | null (hidden). */
  badge?: "enrolled" | "pending" | null;
};

/**
 * Floating clay dock (plan W1): solid card island with a 3px border and hard
 * offset shadow — the previous backdrop-blur bar violated clay rule 2.
 * Icons are 24px (--icon-nav). Labels render normal-case at 11px
 * (text-2xs): the full contract names ("Class Quizzes" / "Kuis Kelas") do
 * not fit ~80px slots at 12px uppercase, and truncating the primary
 * navigation is worse than one token step down (R2-B finding). Keep
 * `truncate` purely as a 320px guard. `data-keyboard-open` on <html>
 * (useKeyboardOcclusion) slides the dock off-screen while text inputs are
 * focused so it never floats over the keyboard.
 */
export function MobileBottomNav({
  role,
  faceEnrolled,
}: {
  role: "lecturer" | "student";
  /** Student only: profile face-enrollment state → status dot on the Face tab. */
  faceEnrolled?: boolean;
}) {
  const pathname = usePathname();
  const t = useTranslations("nav");

  const studentLinks: DockLink[] = [
    {
      href: "/student/classes",
      label: t("myClasses"),
      icon: GraduationCap,
    },
    {
      href: "/student/quizzes",
      label: t("quizzes"),
      icon: ClipboardList,
    },
    {
      href: "/student/my-quizzes",
      label: t("myQuizzes"),
      icon: Zap,
    },
    {
      href: "/student/face/enroll",
      label: t("faceSetup"),
      icon: ScanFace,
      // Badge semantics: emerald = enrolled, amber pulse = not yet. Hidden
      // entirely when the shell doesn't thread the state (undefined).
      badge:
        faceEnrolled === undefined ? null : faceEnrolled ? "enrolled" : "pending",
    },
  ];

  const lecturerLinks: DockLink[] = [
    {
      href: "/lecturer/classes",
      label: t("myClasses"),
      icon: GraduationCap,
    },
    {
      href: "/lecturer/classes/archived",
      label: t("archivedClassesLabel", { defaultValue: "Archived" }),
      icon: Archive,
    },
  ];

  const links = role === "lecturer" ? lecturerLinks : studentLinks;

  return (
    <nav
      aria-label={t("mobileNav")}
      className="fixed inset-x-3 bottom-[calc(8px+var(--safe-bottom))] z-40 flex items-stretch gap-1 rounded-[24px] border-[3px] border-border bg-card px-2 py-1.5 shadow-[var(--shadow-clay)] transition-transform duration-200 ease-out sm:hidden [[data-keyboard-open]_&]:translate-y-[120%]"
    >
      {links.map((link) => {
        const Icon = link.icon;
        const active =
          pathname === link.href ||
          (link.href !== "/lecturer/classes" &&
            link.href !== "/student/classes" &&
            pathname.startsWith(link.href + "/")) ||
          (link.href === "/lecturer/classes" &&
            pathname.startsWith("/lecturer/classes") &&
            !pathname.startsWith("/lecturer/classes/archived")) ||
          (link.href === "/student/classes" &&
            pathname === "/student/classes");

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-[18px] py-1.5 transition-[transform,colors] duration-150 active:translate-y-[2px] focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2",
              active
                ? "text-primary-deep dark:text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span
              className={cn(
                "relative grid h-8 min-w-12 place-items-center rounded-full transition-[background-color,box-shadow,border-color] duration-200",
                active
                  ? "border-2 border-primary/40 bg-primary/15 shadow-[0_2px_0_var(--border)]"
                  : "border-2 border-transparent bg-transparent"
              )}
            >
              <Icon
                className="size-[var(--icon-nav)] shrink-0"
                aria-hidden="true"
              />
              {link.badge === "enrolled" && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500"
                />
              )}
              {link.badge === "pending" && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full border-2 border-card bg-amber-500"
                />
              )}
            </span>
            <span className="w-full truncate px-1 text-center font-sans text-2xs font-extrabold">
              {link.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

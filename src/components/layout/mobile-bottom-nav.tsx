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

export function MobileBottomNav({
  role,
}: {
  role: "lecturer" | "student";
}) {
  const pathname = usePathname();
  const t = useTranslations("nav");

  const studentLinks = [
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
    },
  ];

  const lecturerLinks = [
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
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t-[3px] border-border bg-background/95 px-2 pt-2 pb-[max(0.6rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(194,65,12,0.12)] backdrop-blur-md sm:hidden"
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
              "flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-1.5 transition-[transform,colors] duration-150 active:scale-95",
              active
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span
              className={cn(
                "grid h-8 w-12 place-items-center rounded-full transition-[background-color,box-shadow,border-color]",
                active
                  ? "border-2 border-primary/40 bg-primary/15 shadow-[0_2px_0_var(--border)] dark:bg-primary/25"
                  : "bg-transparent"
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-[11px] font-extrabold tracking-tight truncate max-w-[72px]">
              {link.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

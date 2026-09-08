"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  GraduationCap,
  ClipboardList,
  Zap,
  ScanFace,
  LibraryBig,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DockActionSheet } from "./dock-action-sheet";
import {
  CreateClassAction,
  CreateQuizAction,
} from "./dock-fab-actions";

type DockLink = {
  href: string;
  label: string;
  icon: typeof GraduationCap;
  /** Student Face tab only: "enrolled" | "pending" | null (hidden). */
  badge?: "enrolled" | "pending" | null;
};

type LecturerClassOption = { id: string; title: string };

/**
 * Flat attached dock: full-width bar flush to the bottom edge with just a
 * top border (was a floating rounded island). Both roles share it — the
 * lecturer FAB keeps its raised center "+" posture on the flat bar. Tab
 * styling (incl. the tinted active pill) is unchanged.
 * Icons are 24px (--icon-nav). Labels render normal-case at 11px
 * (text-2xs): the full contract names ("Class Quizzes" / "Kuis Kelas") do
 * not fit ~80px slots at 12px uppercase, and truncating the primary
 * navigation is worse than one token step down (R2-B finding). Keep
 * `truncate` purely as a 320px guard. `data-keyboard-open` on <html>
 * (useKeyboardOcclusion) slides the dock off-screen while text inputs are
 * focused so it never floats over the keyboard.
 *
 * Dock FAB (lecturer dock overhaul): a raised center "+" anchors the
 * lecturer's #1 action — New class / New quiz (Archived was demoted to an
 * in-page destination; the Quizzes library takes the freed dock slot).
 * Lecturer-only by design: the student dock keeps its 4 tabs (join lives in
 * the classes page join drawer). The sheet is sm:hidden like the dock.
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
  const router = useRouter();
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
      href: "/lecturer/quizzes",
      label: t("lecturerQuizzes"),
      icon: LibraryBig,
    },
  ];

  const isLecturer = role === "lecturer";
  const links = isLecturer ? lecturerLinks : studentLinks;
  // FAB sits at the visual center of the lecturer's row: 1 tab | FAB | 1 tab.
  // Students have no FAB — their 4 tabs span the dock.
  const hasFab = isLecturer;
  const fabIndex = Math.ceil(links.length / 2);

  const [fabOpen, setFabOpen] = useState(false);
  // Sheet panel toggle: New class vs New quiz.
  const [panel, setPanel] = useState<"class" | "quiz">("class");
  // Active-class options for the quiz picker — fetched once per mount when
  // the sheet first opens (GET /api/classes is lecturer-scoped + cheap).
  const [classOptions, setClassOptions] = useState<LecturerClassOption[] | null>(
    null,
  );
  const [optionsError, setOptionsError] = useState(false);

  useEffect(() => {
    if (!hasFab || !fabOpen || classOptions || optionsError) return;
    let cancelled = false;
    fetch("/api/classes")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { classes?: (LecturerClassOption & { archived_at: string | null })[] }) => {
        if (cancelled) return;
        setClassOptions(
          (body.classes ?? [])
            .filter((c) => !c.archived_at)
            .map(({ id, title }) => ({ id, title })),
        );
      })
      .catch(() => {
        if (!cancelled) setOptionsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hasFab, fabOpen, classOptions, optionsError]);

  return (
    <>
      <nav
        aria-label={t("mobileNav")}
        className="fixed inset-x-0 bottom-0 z-40 flex items-stretch gap-1 border-t-[3px] border-border bg-card px-2 pb-[max(0.5rem,var(--safe-bottom))] pt-1.5 transition-transform duration-200 ease-out sm:hidden [[data-keyboard-open]_&]:translate-y-[120%]"
      >
        {links.slice(0, fabIndex).map((link) => (
          <DockTab key={link.href} link={link} pathname={pathname} />
        ))}

        {hasFab && (
          <button
            type="button"
            onClick={() => setFabOpen(true)}
            aria-label={t("createFabAria")}
            aria-expanded={fabOpen}
            className={cn(
              // Warm white icon (#fff7ed) — matches the default Button
              // variant's on-primary color, reads crisper at FAB size than
              // the brown --primary-foreground token.
              "relative -mt-4 flex size-14 shrink-0 cursor-pointer items-center justify-center self-start rounded-full border-[3px] border-border bg-primary text-[#fff7ed]",
              "shadow-[0_5px_0_var(--primary-deep)] transition-[transform,box-shadow] duration-150",
              "active:translate-y-[3px] active:shadow-[0_2px_0_var(--primary-deep)]",
              "focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2",
            )}
          >
            <Plus className="size-7" aria-hidden />
          </button>
        )}

        {links.slice(fabIndex).map((link) => (
          <DockTab key={link.href} link={link} pathname={pathname} />
        ))}
      </nav>

      <DockActionSheet
        open={fabOpen}
        onOpenChange={setFabOpen}
        label={t("createFab")}
      >
        <div className="space-y-3">
          {/* Segmented panel toggle (clay pressed-state pattern). */}
          <div className="grid grid-cols-2 gap-2" role="tablist" aria-label={t("createFab")}>
            {(
              [
                ["class", t("createNewClass")],
                ["quiz", t("createNewQuiz")],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={panel === key}
                onClick={() => setPanel(key)}
                className={cn(
                  "h-10 cursor-pointer rounded-xl border-[3px] px-2 text-sm font-extrabold transition-all duration-150",
                  panel === key
                    ? "border-primary bg-primary text-primary-foreground shadow-[0_2px_0_var(--primary-deep)]"
                    : "border-border bg-card text-muted-foreground shadow-[0_2px_0_var(--border)] hover:border-primary/40 hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {panel === "class" ? (
            <CreateClassAction onDone={() => setFabOpen(false)} />
          ) : optionsError ? (
            <p role="alert" className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive">
              {t("createNewQuizHint")}
            </p>
          ) : classOptions === null ? (
            <div className="space-y-1.5" aria-hidden="true">
              <div className="clay-skeleton h-11 rounded-xl border-[3px] border-border bg-muted" />
              <div className="clay-skeleton h-11 rounded-xl border-[3px] border-border bg-muted" />
            </div>
          ) : (
            <CreateQuizAction
              classes={classOptions}
              onPick={(url) => {
                setFabOpen(false);
                router.push(url);
              }}
            />
          )}
        </div>
      </DockActionSheet>
    </>
  );
}

/**
 * One dock tab. Extracted so the FAB can split the row without duplicating
 * the active-state logic. Active semantics per tab kind:
 *  - "/…/classes" roots stay active across their subtree EXCEPT the archived
 *    child route (lecturer), which is an in-page destination now.
 *  - leaf tabs ("/student/quizzes" etc.) match by prefix.
 */
function DockTab({
  link,
  pathname,
}: {
  link: DockLink;
  pathname: string;
}) {
  const Icon = link.icon;
  const active =
    pathname === link.href ||
    (link.href !== "/lecturer/classes" &&
      link.href !== "/student/classes" &&
      pathname.startsWith(link.href + "/")) ||
    (link.href === "/lecturer/classes" &&
      pathname.startsWith("/lecturer/classes") &&
      !pathname.startsWith("/lecturer/classes/archived")) ||
    (link.href === "/student/classes" && pathname === "/student/classes");

  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-[18px] py-1.5 transition-[transform,colors] duration-150 active:translate-y-[2px] focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2",
        active
          ? "text-primary-deep dark:text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="relative grid h-8 min-w-12 place-items-center">
        <Icon className="size-[var(--icon-nav)] shrink-0" aria-hidden="true" />
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
      <span className="w-full truncate px-1 text-center font-sans text-2xs font-extrabold" title={link.label}>
        {link.label}
      </span>
    </Link>
  );
}

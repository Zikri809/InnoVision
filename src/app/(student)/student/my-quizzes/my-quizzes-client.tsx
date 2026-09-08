"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { Input } from "@/components/ui/input";
import {
  CalendarDays,
  ClipboardList,
  ListChecks,
  MessageCircle,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  Share2,
  Trash2,
  EyeOff,
  Link2,
  Loader2,
  MoreVertical,
  TriangleAlert,
} from "lucide-react";

type MyQuiz = {
  id: string;
  title: string;
  description: string | null;
  share_code: string | null;
  created_at: string;
  updated_at: string;
  question_count: number;
};

function formatQuizDate(dateStr: string, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

/** Which surface of the mobile action drawer is showing. `null` = closed. */
type SheetState = "menu" | "share" | "delete" | null;

export function MyQuizzesClient({ quizzes }: { quizzes: MyQuiz[] }) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("myQuizzes");
  const tCommon = useTranslations("common");

  const lock = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<MyQuiz | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MyQuiz | null>(null);
  const [regenArmed, setRegenArmed] = useState(false);

  // ── Mobile-only surface state (desktop dialogs below stay untouched) ──
  const [isMobile, setIsMobile] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [sheetTarget, setSheetTarget] = useState<MyQuiz | null>(null);
  // FAB visibility: hides while scrolling down so it never covers a card.
  const [fabHidden, setFabHidden] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    // Direction-aware FAB: hide only while actively scrolling down past the
    // title zone; always show at the top or on any scroll-up. Refs keep the
    // handler stable without re-binding on every render.
    let lastY = window.scrollY;
    let hidden = false;
    let ticking = false;
    const handler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = window.scrollY;
        const down = y > lastY + 8;
        const up = y < lastY - 4;
        if (y <= 90 || up) hidden = false;
        else if (down) hidden = true;
        lastY = y;
        setFabHidden(hidden);
      });
    };
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, [isMobile]);

  async function mutate(
    quiz: MyQuiz,
    init: RequestInit,
  ): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    if (lock.current) return { ok: false, body: {} };
    setError(null);
    lock.current = true;
    setBusyId(quiz.id);
    try {
      const res = await fetch(`/api/student-quizzes/${quiz.id}`, init);
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const message = (body as { message?: string }).message;
        setError(message ?? tCommon("errorGeneric"));
        return { ok: false, body };
      }
      router.refresh();
      return { ok: true, body };
    } catch {
      setError(tCommon("errorGeneric"));
      return { ok: false, body: {} };
    } finally {
      lock.current = false;
      setBusyId(null);
    }
  }

  async function handleDelete() {
    const target = isMobile ? sheetTarget : deleteTarget;
    if (!target || lock.current) return;
    const { ok } = await mutate(target, { method: "DELETE" });
    if (ok) {
      setDeleteTarget(null);
      setSheet(null);
      setSheetTarget(null);
      toast.success(t("deletedNotice"));
    }
  }

  /**
   * Share actions merge the returned quiz row back into `shareTarget` — the
   * dialog reads from that state snapshot and would otherwise show stale
   * data until closed and reopened (router.refresh() does NOT update it).
   */
  async function shareAction(quiz: MyQuiz, action: "share" | "unshare" | "regenerate") {
    const { ok, body } = await mutate(quiz, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!ok) return;
    if (action === "unshare") {
      toast.success(t("unsharedNotice"));
      // Without a share_code the dialog would fall into its "minting link"
      // spinner branch — close it; the card flips to Private via refresh.
      setShareTarget(null);
      setSheet(null);
      setSheetTarget(null);
      setRegenArmed(false);
      return;
    }
    const updated = body.quiz as Partial<MyQuiz> | undefined;
    if (updated?.id) {
      setShareTarget((prev) =>
        prev && prev.id === updated.id ? { ...prev, ...updated } : prev,
      );
      // Keep the mobile sheet's snapshot fresh too (mirror of shareTarget).
      setSheetTarget((prev) =>
        prev && prev.id === updated.id ? { ...prev, ...updated } : prev,
      );
    }
  }

  /** Two-step regenerate: first click arms the confirm (plan §5.5). */
  function handleRegenerateClick() {
    if (!shareTarget) return;
    if (!regenArmed) {
      setRegenArmed(true);
      return;
    }
    setRegenArmed(false);
    void shareAction(shareTarget, "regenerate");
  }

  const shareHref = shareTarget?.share_code
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/s/${shareTarget.share_code}`
    : "";
  const whatsappHref = shareTarget?.share_code
    ? `https://wa.me/?text=${encodeURIComponent(
        `${shareTarget.title} — ${typeof window !== "undefined" ? window.location.origin : ""}/s/${shareTarget.share_code}`,
      )}`
    : "";

  const openSheet = useCallback((quiz: MyQuiz, state: SheetState = "menu") => {
    setSheetTarget(quiz);
    setShareTarget(quiz);
    setRegenArmed(false);
    setSheet(state);
  }, []);

  const sharedCount = quizzes.filter((q) => q.share_code).length;

  /* ════════════════ MOBILE (<640px) — card-as-play + action drawer + FAB ════════════════ */
  if (isMobile) {
    return (
      <div className="space-y-4">
        <div aria-live="polite">
          {error && (
            <p
              className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        {/* Large title + live count (replaces the hero band) */}
        <div className="px-1 pt-1">
          <h1 className="font-heading text-[28px] font-semibold leading-tight">
            {t("mobileLargeTitle")}
          </h1>
          <p className="mt-0.5 text-[13px] font-bold text-muted-foreground">
            {t("countLine", { count: quizzes.length, shared: sharedCount })}
          </p>
        </div>

        {quizzes.length === 0 ? (
          <div className="mt-2 rounded-[24px] border-[3px] border-dashed border-border bg-card/60 px-6 py-12 text-center">
            <span className="mx-auto grid h-16 w-16 -rotate-3 place-items-center rounded-[20px] border-[3px] border-emerald-500/30 bg-emerald-100 text-emerald-700 shadow-[0_4px_0_var(--border)] dark:bg-emerald-500/15 dark:text-emerald-300">
              <ClipboardList className="h-8 w-8" aria-hidden />
            </span>
            <p className="mt-4 font-heading text-lg font-semibold">{t("emptyTitle")}</p>
            <p className="mx-auto mt-1 max-w-[15rem] text-sm font-semibold text-muted-foreground">
              {t("emptySubtitle")}
            </p>
            <Link
              href="/student/my-quizzes/new"
              className={cn(buttonVariants({ size: "lg" }), "mt-5 shadow-[0_5px_0_var(--primary-deep)]")}
            >
              <Plus className="h-5 w-5" aria-hidden /> {t("createCta")}
            </Link>
          </div>
        ) : (
          <ul className="grid list-none gap-2.5">
            {quizzes.map((q) => {
              const playable = q.question_count > 0;
              return (
                <li key={q.id} className="relative">
                  <Link
                    href={playable ? `/play/student/${q.id}` : `/student/my-quizzes/${q.id}/edit`}
                    aria-label={
                      playable ? t("playQuizA11y", { title: q.title }) : t("editQuizA11y", { title: q.title })
                    }
                    className="block rounded-[20px] border-[3px] border-border bg-card px-3.5 pb-3 pt-3 shadow-[var(--shadow-clay-sm)] transition-[transform,box-shadow] duration-150 active:translate-y-[2px] active:shadow-[0_2px_0_rgba(194,65,12,0.12)]"
                  >
                    <h2 className="line-clamp-2 pr-8 text-[15px] font-extrabold leading-snug text-foreground">
                      {q.title}
                    </h2>
                    {q.description && (
                      <p className="mt-0.5 line-clamp-2 text-[12.5px] font-bold text-muted-foreground">
                        {q.description}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-bold text-muted-foreground">
                      {playable ? (
                        <>
                          <ListChecks className="h-3.5 w-3.5 text-primary-deep dark:text-primary" aria-hidden />
                          <span>{t("questionCount", { count: q.question_count })}</span>
                          <span aria-hidden className="opacity-50">·</span>
                          <CalendarDays className="h-3.5 w-3.5 text-primary-deep dark:text-primary" aria-hidden />
                          <time dateTime={q.created_at}>{formatQuizDate(q.created_at, locale)}</time>
                          {q.share_code && (
                            <span className="ml-1 inline-flex items-center gap-1 rounded-full border-2 border-emerald-300 bg-emerald-100 px-2 py-px text-[10.5px] font-extrabold uppercase tracking-wide text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-300">
                              <Share2 className="h-2.5 w-2.5" aria-hidden /> {t("shared")}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 font-extrabold text-amber-700 dark:text-amber-300">
                          <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                          {t("noQuestionsYet")}
                        </span>
                      )}
                    </div>
                  </Link>
                  <button
                    type="button"
                    aria-label={t("moreActionsA11y", { title: q.title })}
                    onClick={() => openSheet(q)}
                    className="absolute right-1.5 top-1.5 grid size-11 cursor-pointer place-items-center rounded-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground active:bg-muted"
                  >
                    <MoreVertical className="size-5" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Floating create — hides on scroll-down so it never covers a card */}
        {quizzes.length > 0 && (
          <Link
            href="/student/my-quizzes/new"
            aria-label={t("createFabA11y")}
            className={cn(
              "fixed bottom-[calc(104px+var(--safe-bottom))] right-3 z-30 grid size-14 cursor-pointer place-items-center rounded-[19px] border-[3px] border-transparent bg-primary text-[#fff7ed]",
              "shadow-[0_5px_0_var(--primary-deep)]",
              "transition-[transform,opacity,box-shadow] duration-200 ease-out",
              "active:translate-y-[3px] active:shadow-[0_2px_0_var(--primary-deep)]",
              "focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2",
              fabHidden ? "pointer-events-none translate-y-24 opacity-0" : "translate-y-0 opacity-100",
            )}
          >
            <Plus className="h-6 w-6" aria-hidden />
          </Link>
        )}

        {/* ── Mobile action drawer (menu → share/delete) ── */}
        <ResponsiveModal
          open={sheet !== null}
          onOpenChange={(o) => {
            if (!o) {
              setSheet(null);
              setSheetTarget(null);
              setRegenArmed(false);
            }
          }}
        >
          <ResponsiveModalContent className="sm:max-w-md">
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>
                {sheet === "menu"
                  ? t("actionsTitle")
                  : sheet === "share"
                    ? sheetTarget
                      ? t("shareTitle", { title: sheetTarget.title })
                      : ""
                    : t("deleteConfirmTitle")}
              </ResponsiveModalTitle>
              <ResponsiveModalDescription>
                {sheet === "share"
                  ? t("shareIntro")
                  : sheetTarget
                    ? sheetTarget.title
                    : t("shareIntro")}
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>

            {sheet === "menu" && sheetTarget && (
              <div className="divide-y-[2px] divide-border/60 rounded-2xl border-[2.5px] border-border bg-background pb-1 pt-1 shadow-[0_3px_0_var(--border)]">
                <button
                  type="button"
                  onClick={() => {
                    router.push(`/student/my-quizzes/${sheetTarget.id}/edit`);
                    setSheet(null);
                  }}
                  className="flex h-12 w-full cursor-pointer items-center gap-3 px-4 text-left transition-colors duration-150 active:bg-muted"
                >
                  <Pencil className="size-5 shrink-0 text-primary-deep dark:text-primary" aria-hidden />
                  <span className="text-[15px] font-extrabold text-foreground">{t("editBtn")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!sheetTarget.share_code) void shareAction(sheetTarget, "share");
                    setSheet("share");
                  }}
                  className="flex h-12 w-full cursor-pointer items-center gap-3 px-4 text-left transition-colors duration-150 active:bg-muted"
                >
                  <Share2 className="size-5 shrink-0 text-primary-deep dark:text-primary" aria-hidden />
                  <span className="text-[15px] font-extrabold text-foreground">{t("shareBtn")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSheet("delete")}
                  className="flex h-12 w-full cursor-pointer items-center gap-3 px-4 text-left transition-colors duration-150 active:bg-destructive/10"
                >
                  <Trash2 className="size-5 shrink-0 text-destructive" aria-hidden />
                  <span className="text-[15px] font-extrabold text-destructive">{t("deleteBtn")}</span>
                </button>
              </div>
            )}

            {sheet === "share" && (
              <div className="space-y-3">
                {sheetTarget?.share_code ? (
                  <>
                    <div className="flex items-center gap-2">
                      <Input readOnly value={shareHref} aria-label={t("copyBtn")} className="font-mono text-xs" />
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={t("copyBtn")}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(shareHref);
                            setError(null);
                            toast.success(tCommon("copied"));
                          } catch {}
                        }}
                      >
                        <Link2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a href={whatsappHref} target="_blank" rel="noopener noreferrer">
                        <Button variant="outline" size="sm">
                          <MessageCircle className="h-4 w-4" aria-hidden /> {t("whatsappBtn")}
                        </Button>
                      </a>
                      <Button
                        variant={regenArmed ? "destructive" : "outline"}
                        size="sm"
                        disabled={busyId !== null}
                        onClick={handleRegenerateClick}
                      >
                        <RefreshCcw className="h-4 w-4" aria-hidden />
                        {regenArmed ? tCommon("confirm") : t("regenerateBtn")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={busyId !== null}
                        onClick={() => sheetTarget && void shareAction(sheetTarget, "unshare")}
                      >
                        <EyeOff className="h-4 w-4" aria-hidden /> {t("unshareBtn")}
                      </Button>
                    </div>
                    <p className="text-xs font-semibold text-muted-foreground">{t("regenerateNote")}</p>
                  </>
                ) : (
                  <p
                    className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("mintingLink")}
                  </p>
                )}
              </div>
            )}

            {sheet === "delete" && sheetTarget && (
              <div className="space-y-4">
                <div className="flex items-start gap-2.5 rounded-2xl border-[2.5px] border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm font-bold text-destructive">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{t("deleteConfirmBody", { title: sheetTarget.title })}</span>
                </div>
                <div className="grid gap-2.5">
                  <Button variant="destructive" disabled={busyId === sheetTarget.id} onClick={() => void handleDelete()}>
                    <Trash2 className="h-4 w-4" aria-hidden /> {tCommon("delete")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSheet("menu");
                    }}
                  >
                    {tCommon("cancel")}
                  </Button>
                </div>
              </div>
            )}
          </ResponsiveModalContent>
        </ResponsiveModal>
      </div>
    );
  }

  /* ════════════════ DESKTOP (≥640px) — unchanged layout ════════════════ */
  return (
    <div className="space-y-6 sm:space-y-8">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-emerald-100 via-emerald-50 to-blue-50 dark:from-emerald-950/40 dark:via-card dark:to-blue-950/40 p-5 shadow-[var(--shadow-clay)] sm:p-7 md:p-9">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 max-sm:hidden rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 max-sm:hidden rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60 dark:bg-blue-500/5" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="inline-flex max-sm:hidden items-center gap-2 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-primary">
              <ClipboardList className="h-4 w-4" aria-hidden /> {t("heroTitle")}
            </span>
            <h1 className="mt-4 max-sm:mt-0 font-heading text-3xl max-sm:text-2xl font-semibold [text-wrap:balance] md:text-4xl">
              {t("heroTitle")}
            </h1>
            <p className="mt-2 max-w-xl text-sm font-semibold text-muted-foreground md:text-base">
              {t("heroSubtitle")}
            </p>
          </div>
          <Link
            href="/student/my-quizzes/new"
            className={cn(buttonVariants({ size: "lg" }), "shadow-[0_5px_0_var(--primary-deep)]")}
          >
            <Plus className="h-5 w-5" aria-hidden /> {t("createCta")}
          </Link>
        </div>
      </section>

      <div aria-live="polite">
        {error && (
          <p
            className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>

      {quizzes.length === 0 ? (
        <div className="grid place-items-center rounded-[28px] border-[3px] border-dashed border-border bg-card/60 px-8 py-16 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-emerald-100 text-primary">
            <ClipboardList className="h-7 w-7" aria-hidden />
          </span>
          <p className="mt-4 font-heading text-lg font-semibold">{t("emptyTitle")}</p>
          <p className="mt-1 max-w-xs text-sm font-semibold text-muted-foreground">
            {t("emptySubtitle")}
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
          {quizzes.map((q) => (
            <li key={q.id}>
              <Card className="group flex h-full flex-col transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)]">
                <CardHeader className="gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border-[3px] border-emerald-600/25 bg-emerald-100 text-emerald-700 shadow-[var(--shadow-clay-sm)] transition-transform duration-200 group-hover:-rotate-6 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300">
                      <ClipboardList className="h-6 w-6" aria-hidden />
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border-[3px] px-3 py-1 text-xs font-extrabold uppercase tracking-wide ${
                        q.share_code
                          ? "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-300"
                          : "border-border bg-muted text-muted-foreground dark:bg-muted/40"
                      }`}
                    >
                      {q.share_code ? (
                        <>
                          <Share2 className="h-3 w-3" aria-hidden /> {t("shared")}
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-3 w-3" aria-hidden /> {t("priv")}
                        </>
                      )}
                    </span>
                  </div>
                  <CardTitle className="text-lg leading-snug [text-wrap:balance]">
                    {q.title}
                  </CardTitle>
                  {q.description && (
                    <CardDescription className="line-clamp-2">{q.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="mt-auto space-y-3 pt-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border-[3px] border-border/70 bg-muted/50 px-3 py-2 text-xs font-bold text-muted-foreground dark:border-border/60 dark:bg-muted/20">
                    <span className="inline-flex items-center gap-1.5">
                      <ListChecks className="h-3.5 w-3.5 text-primary" aria-hidden />
                      {t("questionCount", { count: q.question_count })}
                    </span>
                    <span aria-hidden className="text-border">•</span>
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays className="h-3.5 w-3.5 text-primary" aria-hidden />
                      <time dateTime={q.created_at}>{formatQuizDate(q.created_at, locale)}</time>
                    </span>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      {q.question_count === 0 ? (
                        <Button size="sm" className="flex-[2]" disabled>
                          <Play className="h-4 w-4" aria-hidden /> {t("playBtn")}
                        </Button>
                      ) : (
                        <Link
                          href={`/play/student/${q.id}`}
                          className={cn(buttonVariants({ size: "sm" }), "flex-[2]")}
                        >
                          <Play className="h-4 w-4" aria-hidden /> {t("playBtn")}
                        </Link>
                      )}
                      <Link
                        href={`/student/my-quizzes/${q.id}/edit`}
                        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "flex-1")}
                      >
                        <Pencil className="h-4 w-4" aria-hidden /> {t("editBtn")}
                      </Link>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t-[3px] border-dashed border-border/70 pt-3 dark:border-border/50">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-2 text-muted-foreground hover:text-primary"
                        disabled={busyId === q.id}
                        onClick={() => {
                          setShareTarget(q);
                          void shareAction(q, "share");
                        }}
                      >
                        <Share2 className="h-4 w-4" aria-hidden /> {t("shareBtn")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-mr-2 text-muted-foreground hover:text-destructive"
                        disabled={busyId === q.id}
                        onClick={() => setDeleteTarget(q)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden /> {t("deleteBtn")}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {/* ── Share dialog ── */}
      <ResponsiveModal
        open={!!shareTarget && !isMobile}
        onOpenChange={(o) => {
          if (!o) {
            setShareTarget(null);
            setRegenArmed(false);
          }
        }}
      >
        <ResponsiveModalContent className="sm:max-w-md">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>
              {shareTarget ? t("shareTitle", { title: shareTarget.title }) : ""}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription>{t("shareIntro")}</ResponsiveModalDescription>
          </ResponsiveModalHeader>
          {shareTarget?.share_code ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input readOnly value={shareHref} aria-label={t("copyBtn")} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("copyBtn")}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(shareHref);
                      setError(null);
                      toast.success(tCommon("copied"));
                    } catch {}
                  }}
                >
                  <Link2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={whatsappHref} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm">
                    <MessageCircle className="h-4 w-4" aria-hidden /> {t("whatsappBtn")}
                  </Button>
                </a>
                <Button
                  variant={regenArmed ? "destructive" : "outline"}
                  size="sm"
                  disabled={busyId !== null}
                  onClick={handleRegenerateClick}
                >
                  <RefreshCcw className="h-4 w-4" aria-hidden />
                  {regenArmed ? tCommon("confirm") : t("regenerateBtn")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={busyId !== null}
                  onClick={() => shareTarget && void shareAction(shareTarget, "unshare")}
                >
                  <EyeOff className="h-4 w-4" aria-hidden /> {t("unshareBtn")}
                </Button>
              </div>
              <p className="text-xs font-semibold text-muted-foreground">{t("regenerateNote")}</p>
            </div>
          ) : (
            <p
              className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("mintingLink")}
            </p>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* ── Delete confirm dialog ── */}
      <ResponsiveModal open={!!deleteTarget && !isMobile} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <ResponsiveModalContent className="sm:max-w-md">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>{t("deleteConfirmTitle")}</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {deleteTarget ? t("deleteConfirmBody", { title: deleteTarget.title }) : ""}
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <ResponsiveModalFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {tCommon("cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()}>
              <Trash2 className="h-4 w-4" aria-hidden /> {tCommon("delete")}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}

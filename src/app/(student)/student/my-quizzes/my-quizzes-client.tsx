"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ClipboardList,
  Play,
  Pencil,
  Share2,
  Trash2,
  Plus,
  Link2,
  RefreshCcw,
  EyeOff,
  MessageCircle,
  Loader2,
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

export function MyQuizzesClient({ quizzes }: { quizzes: MyQuiz[] }) {
  const router = useRouter();
  const t = useTranslations("myQuizzes");
  const tCommon = useTranslations("common");

  const lock = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<MyQuiz | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MyQuiz | null>(null);
  const [regenArmed, setRegenArmed] = useState(false);

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
    if (!deleteTarget || lock.current) return;
    const { ok } = await mutate(deleteTarget, { method: "DELETE" });
    if (ok) {
      setDeleteTarget(null);
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
    if (action === "unshare") toast.success(t("unsharedNotice"));
    const updated = body.quiz as Partial<MyQuiz> | undefined;
    if (updated?.id) {
      setShareTarget((prev) =>
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
    ? `${window.location.origin}/s/${shareTarget.share_code}`
    : "";
  const whatsappHref = shareTarget?.share_code
    ? `https://wa.me/?text=${encodeURIComponent(
        `${shareTarget.title} — ${window.location.origin}/s/${shareTarget.share_code}`,
      )}`
    : "";

  return (
    <div className="space-y-8">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-emerald-100 via-emerald-50 to-blue-50 p-7 shadow-[var(--shadow-clay)] md:p-9">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-primary">
              <ClipboardList className="h-4 w-4" aria-hidden /> {t("heroTitle")}
            </span>
            <h1 className="mt-4 font-heading text-3xl font-semibold [text-wrap:balance] md:text-4xl">
              {t("heroSubtitle")}
            </h1>
            <p className="mt-2 max-w-xl text-sm font-semibold text-muted-foreground md:text-base">
              {t("heroSubtitle")}
            </p>
          </div>
          <Link href="/student/my-quizzes/new">
            <Button size="lg" className="shadow-[0_5px_0_var(--primary-deep)]">
              <Plus className="h-5 w-5" aria-hidden /> {t("createCta")}
            </Button>
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
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {quizzes.map((q) => (
            <li key={q.id}>
              <Card className="flex h-full flex-col transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)]">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-emerald-100 text-emerald-600">
                      <ClipboardList className="h-6 w-6" aria-hidden />
                    </span>
                    <span
                      className={`rounded-full border-[3px] px-3 py-1 text-xs font-extrabold ${
                        q.share_code
                          ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                          : "border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      {q.share_code ? t("shared") : t("priv")}
                    </span>
                  </div>
                  <CardTitle className="text-lg [text-wrap:balance]">{q.title}</CardTitle>
                  {q.description && (
                    <CardDescription className="line-clamp-2">{q.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="mt-auto space-y-3 pt-1">
                  <p className="text-sm font-semibold text-muted-foreground">
                    {t("questionCount", { count: q.question_count })}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/play/student/${q.id}`} aria-disabled={q.question_count === 0}>
                      <Button size="sm" disabled={q.question_count === 0}>
                        <Play className="h-4 w-4" aria-hidden /> {t("playBtn")}
                      </Button>
                    </Link>
                    <Link href={`/student/my-quizzes/${q.id}/edit`}>
                      <Button variant="outline" size="sm">
                        <Pencil className="h-4 w-4" aria-hidden /> {t("editBtn")}
                      </Button>
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
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
                      className="text-destructive hover:text-destructive"
                      disabled={busyId === q.id}
                      onClick={() => setDeleteTarget(q)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden /> {t("deleteBtn")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {/* ── Share dialog ── */}
      <Dialog
        open={!!shareTarget}
        onOpenChange={(o) => {
          if (!o) {
            setShareTarget(null);
            setRegenArmed(false); // never reopen into the armed-confirm state
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {shareTarget ? t("shareTitle", { title: shareTarget.title }) : ""}
            </DialogTitle>
            <DialogDescription>{t("shareIntro")}</DialogDescription>
          </DialogHeader>
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
                    } catch {
                      // Clipboard denied / insecure context — the link stays
                      // selected in the readonly input for manual copying.
                    }
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
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm dialog ── */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {deleteTarget ? t("deleteConfirmBody", { title: deleteTarget.title }) : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {tCommon("cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()}>
              <Trash2 className="h-4 w-4" aria-hidden /> {tCommon("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

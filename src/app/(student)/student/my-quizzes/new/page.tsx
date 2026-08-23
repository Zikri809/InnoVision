"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClipboardList, Loader2 } from "lucide-react";

/**
 * /student/my-quizzes/new — creates an EMPTY practice quiz (title/description)
 * then redirects into the builder. Question caps/limits live entirely in the
 * API + DB layers.
 */
export default function NewStudentQuizPage() {
  const router = useRouter();
  const t = useTranslations("quizEditor");
  const tMy = useTranslations("myQuizzes");
  const tCommon = useTranslations("common");

  const lock = useRef(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    if (!title.trim()) {
      setError(t("needTitle"));
      return;
    }
    setError(null);
    lock.current = true;
    setCreating(true);
    try {
      const res = await fetch("/api/student-quizzes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description: description.trim() ? description.trim() : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.quiz?.id) {
        router.push(`/student/my-quizzes/${body.quiz.id}/edit`);
        return;
      }
      setError(body.message ?? tCommon("errorGeneric"));
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      lock.current = false;
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-semibold">{tMy("heroTitle")}</h1>
        <p className="mt-1 text-sm font-semibold text-muted-foreground">
          {tMy("heroSubtitle")}
        </p>
      </div>

      <Card className="rounded-[28px] border-[3px] shadow-[var(--shadow-clay)]">
        <CardHeader>
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-100 text-emerald-600">
            <ClipboardList className="h-6 w-6" aria-hidden />
          </span>
          <CardTitle className="text-xl">{tMy("createCta")}</CardTitle>
          <CardDescription>{t("descriptionPlaceholder")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="title">{t("titleLabel")}</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("titlePlaceholder")}
                maxLength={200}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">{t("descriptionLabel")}</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
                maxLength={500}
              />
            </div>

            <div aria-live="polite" className={!error ? "hidden" : undefined}>
              {error && (
                <p
                  className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
                  role="alert"
                >
                  {error}
                </p>
              )}
            </div>

            <Button type="submit" size="lg" disabled={creating} className="w-full">
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  {tCommon("submitting")}
                </>
              ) : (
                t("createBtn")
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GraduationCap, Layers, ClipboardList, Plus, ArrowRight } from "lucide-react";

export type LecturerClassCard = {
  id: string;
  title: string;
  join_code: string;
  created_at: string;
  quizCount: number;
};

/**
 * Lecturer "My Classes" dashboard — hero band, quick stats, and chunky
 * interactive class cards (replaces the old flat single-column list).
 */
export function ClassesPageClient({ classes }: { classes: LecturerClassCard[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref lock guards against a fast double-click before React re-renders.
  const submitLock = useRef(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current) return;
    setError(null);
    submitLock.current = true;
    setCreating(true);
    try {
      const res = await fetch("/api/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Failed to create class.");
        return;
      }
      setTitle("");
      router.refresh();
    } catch {
      setError("Network error creating class.");
    } finally {
      submitLock.current = false;
      setCreating(false);
    }
  }

  const totalQuizzes = classes.reduce((n, c) => n + c.quizCount, 0);

  return (
    <div className="space-y-8">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 p-7 shadow-[var(--shadow-clay)] md:p-9">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-primary">
            <GraduationCap className="h-4 w-4" aria-hidden /> Lecturer dashboard
          </span>
          <h1 className="mt-4 font-heading text-3xl font-semibold [text-wrap:balance] md:text-4xl">
            Your classes, all in one place
          </h1>
          <p className="mt-2 max-w-xl text-sm font-semibold text-muted-foreground md:text-base">
            Create a class, share its join code, and build gesture-powered quizzes
            your students will actually enjoy.
          </p>

          {/* quick stats */}
          <div className="mt-6 grid max-w-md grid-cols-2 gap-4">
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-primary">
                <Layers className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold">{classes.length}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                {classes.length === 1 ? "Class" : "Classes"}
              </p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-accent">
                <ClipboardList className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold">{totalQuizzes}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                {totalQuizzes === 1 ? "Quiz" : "Quizzes"}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Create + list ── */}
      <section className="grid gap-6 lg:grid-cols-[340px_1fr]">
        {/* Create card */}
        <Card className="h-fit">
          <CardHeader>
            <div className="mb-1 grid h-11 w-11 place-items-center rounded-2xl bg-orange-100 text-primary">
              <Plus className="h-5 w-5" aria-hidden />
            </div>
            <CardTitle>Create a class</CardTitle>
            <CardDescription>
              A unique 6-character join code is generated for each class.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <Label htmlFor="class-title" className="sr-only">
                  Class title
                </Label>
                <Input
                  id="class-title"
                  placeholder="e.g. CS101 Algorithms"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={200}
                />
              </div>
              <Button type="submit" className="w-full" disabled={creating || !title.trim()}>
                {creating ? "Creating…" : "Create class"}
              </Button>
            </form>
            <div aria-live="polite">
              {error && (
                <p className="mt-3 rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Class cards */}
        <div>
          <h2 className="mb-4 font-heading text-xl font-semibold">My classes</h2>
          {classes.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-10 text-center text-sm font-semibold text-muted-foreground">
              You have no classes yet — create your first one to get started.
            </p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {classes.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/lecturer/classes/${c.id}`}
                    className="group block rounded-[22px] border-[3px] border-border bg-card p-5 shadow-[var(--shadow-clay)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-orange-100 font-heading text-lg font-bold text-primary">
                        {c.title.trim().charAt(0).toUpperCase()}
                      </span>
                      <span className="rounded-full border-[3px] border-border bg-muted px-2.5 py-0.5 font-mono text-xs font-bold tracking-wider text-muted-foreground">
                        {c.join_code}
                      </span>
                    </div>
                    <h3 className="mt-3.5 font-heading text-lg font-semibold leading-snug [text-wrap:balance]">
                      {c.title}
                    </h3>
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-xs font-extrabold text-muted-foreground">
                        {c.quizCount} {c.quizCount === 1 ? "quiz" : "quizzes"}
                      </span>
                      <span className="inline-flex items-center gap-1 text-sm font-extrabold text-primary transition-transform duration-200 group-hover:translate-x-0.5">
                        Open <ArrowRight className="h-4 w-4" aria-hidden />
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

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

type ClassRow = {
  id: string;
  title: string;
  join_code: string;
  created_at: string;
};

export function ClassesPageClient({ classes }: { classes: ClassRow[] }) {
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

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">My Classes</h1>
          <p className="text-sm text-muted-foreground">
            Create a class and share its join code with students.
          </p>
        </div>
      </div>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Create class</CardTitle>
          <CardDescription>
            A unique 6-character join code is generated for each class.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex gap-3">
            <div className="flex-1">
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
            <Button type="submit" disabled={creating || !title.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </form>
          {error && (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {classes.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          You have no classes yet. Create one above.
        </p>
      ) : (
        <ul className="space-y-3">
          {classes.map((c) => (
            <li key={c.id}>
              <Link
                href={`/lecturer/classes/${c.id}`}
                className="block rounded-lg border p-4 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{c.title}</span>
                  <span className="rounded bg-muted px-2 py-1 font-mono text-xs">
                    {c.join_code}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

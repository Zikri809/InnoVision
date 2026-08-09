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
  created_at: string;
};

export function StudentClassesClient({ classes }: { classes: ClassRow[] }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Ref lock guards against a fast double-click before React re-renders.
  const submitLock = useRef(false);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current) return;
    setError(null);
    setNotice(null);
    submitLock.current = true;
    setJoining(true);
    try {
      const res = await fetch("/api/classes/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json();
      if (!res.ok) {
        // already_enrolled is not an error worth surfacing harshly.
        if (res.status === 409) {
          setNotice("You are already enrolled in that class.");
        } else {
          setError(body.message ?? body.error ?? "Could not join the class.");
        }
        return;
      }
      setCode("");
      setNotice(`Joined ${body.class?.title ?? "class"}.`);
      router.refresh();
    } catch {
      setError("Network error joining class.");
    } finally {
      submitLock.current = false;
      setJoining(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">My Classes</h1>
          <p className="text-sm text-muted-foreground">
            Enter a join code provided by your lecturer.
          </p>
        </div>
        <Link
          href="/student/quizzes"
          className="text-sm font-medium text-primary hover:underline"
        >
          Available quizzes →
        </Link>
      </div>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Join a class</CardTitle>
          <CardDescription>
            Use the 6-character code your lecturer shared.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleJoin} className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="join-code" className="sr-only">
                Join code
              </Label>
              <Input
                id="join-code"
                placeholder="e.g. AB3X9K"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={12}
                className="font-mono uppercase"
              />
            </div>
            <Button type="submit" disabled={joining || !code.trim()}>
              {joining ? "Joining…" : "Join"}
            </Button>
          </form>
          {error && (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="mt-3 text-sm text-emerald-600" role="status">
              {notice}
            </p>
          )}
        </CardContent>
      </Card>

      {classes.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          You are not enrolled in any classes yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {classes.map((c) => (
            <li
              key={c.id}
              className="rounded-lg border p-4"
            >
              <span className="font-medium">{c.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold">My Classes</h1>
        <p className="mt-1 text-sm font-semibold text-muted-foreground">
          Enter a join code provided by your lecturer.
        </p>
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
          <div aria-live="polite">
            {error && (
              <p className="mt-3 rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="mt-3 rounded-xl border-[3px] border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-800" role="status">
                {notice}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {classes.length === 0 ? (
        <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-8 text-center text-sm font-semibold text-muted-foreground">
          You are not enrolled in any classes yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {classes.map((c) => (
            <li
              key={c.id}
              className="rounded-2xl border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay)]"
            >
              <span className="font-heading text-base font-semibold">{c.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

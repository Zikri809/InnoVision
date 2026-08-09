"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ClassInfo = {
  id: string;
  title: string;
  join_code: string;
  created_at: string;
};

type RosterEntry = {
  student_id: string;
  enrolled_at: string;
  full_name: string | null;
};

export function ClassDetailClient({
  cls,
  roster,
}: {
  cls: ClassInfo;
  roster: RosterEntry[];
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <Link
          href="/lecturer/classes"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to classes
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{cls.title}</h1>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Join code</CardTitle>
          <CardDescription>
            Share this code with students to enroll them in this class.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="rounded-lg bg-muted px-4 py-3 text-center font-mono text-2xl tracking-[0.4em]">
            {cls.join_code}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Roster</CardTitle>
            <CardDescription>
              {roster.length} enrolled student{roster.length === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" disabled title="Coming in Phase 3">
            Quizzes
          </Button>
        </CardHeader>
        <CardContent>
          {roster.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No students have joined yet.
            </p>
          ) : (
            <ul className="divide-y">
              {roster.map((s) => (
                <li key={s.student_id} className="flex items-center justify-between py-2">
                  <span className="font-medium">{s.full_name ?? "Unnamed student"}</span>
                  <span className="text-xs text-muted-foreground">
                    Joined {new Date(s.enrolled_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

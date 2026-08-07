"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Database } from "@/lib/types/database";

type Profile = Pick<
  Database["public"]["Tables"]["profiles"]["Row"],
  "role" | "full_name" | "consent_given_at"
>;

export function DashboardContent({
  email,
  profile,
}: {
  email: string;
  profile: Profile | null;
}) {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const hasConsented = Boolean(profile?.consent_given_at);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-2xl">InnoVision</CardTitle>
          <CardDescription>
            You are signed in
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="font-medium">{email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Role</dt>
              <dd className="font-medium capitalize">{profile?.role ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-medium">{profile?.full_name || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Biometric consent</dt>
              <dd className="font-medium">
                {hasConsented ? "Given ✓" : "Not given"}
              </dd>
            </div>
          </dl>
          {!hasConsented && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              You have not yet given biometric consent. Face enrollment will be
              blocked until you consent.
            </p>
          )}
          <Button onClick={handleLogout} variant="outline" className="w-full">
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

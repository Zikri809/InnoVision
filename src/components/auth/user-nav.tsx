"use client";

import { useRouter } from "next/navigation";
import { logout } from "@/lib/auth/logout";
import { Button } from "@/components/ui/button";

/**
 * Small auth header used on role landing pages: shows the signed-in email,
 * biometric-consent state, and a sign-out button.
 */
export function UserNav({
  email,
  consentGiven,
}: {
  email: string;
  consentGiven: boolean;
}) {
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <span className="hidden text-sm text-muted-foreground sm:inline">
        {email}
      </span>
      <span className="text-sm">
        {consentGiven ? "Given ✓" : "Consent missing"}
      </span>
      <Button onClick={handleLogout} variant="outline" size="sm">
        Sign out
      </Button>
    </div>
  );
}

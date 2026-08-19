"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/auth/logout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CircleCheck, CircleAlert, LogOut, UserRound } from "lucide-react";

function initialsFrom(email: string): string {
  const name = email.split("@")[0] ?? "";
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters = (parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
  return letters || "IV";
}

/**
 * Clay user menu for the app shell. Shows the signed-in email, biometric
 * consent state, and a sign-out action inside a chunky dialog.
 */
export function AppUserMenu({
  email,
  consentGiven,
}: {
  email: string;
  consentGiven: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    setSigningOut(true);
    await logout();
    router.push("/login");
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        aria-label="Open account menu"
        className="grid h-11 w-11 cursor-pointer place-items-center rounded-2xl border-[3px] border-border bg-card font-sans text-sm font-extrabold text-foreground shadow-[0_4px_0_var(--border)] transition-[transform,box-shadow] duration-[180ms] ease-out hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--border)]"
      >
        {initialsFrom(email)}
      </DialogTrigger>

      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <div className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-primary/15 text-primary">
            <UserRound className="h-6 w-6" aria-hidden />
          </div>
          <DialogTitle className="break-all text-base">{email}</DialogTitle>
          <DialogDescription>Your InnoVision account</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2.5 rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3 text-sm font-bold">
          {consentGiven ? (
            <>
              <CircleCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span className="text-emerald-700 dark:text-emerald-300">Biometric consent given</span>
            </>
          ) : (
            <>
              <CircleAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden />
              <span className="text-amber-700 dark:text-amber-300">Consent not given yet</span>
            </>
          )}
        </div>

        <Button
          onClick={handleLogout}
          variant="outline"
          className="w-full"
          disabled={signingOut}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

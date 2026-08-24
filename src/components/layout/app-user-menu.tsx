"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
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
import { LanguageToggle } from "./language-toggle";

function initialsFrom(source: string): string {
  // Names ("Nur Aisyah" → NA) and emails ("nur.aisyah@…" → NA) share one
  // splitter: whitespace for names, ./_/- for email local-parts.
  const local = source.includes("@") ? source.split("@")[0] : source;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  const letters = (
    parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] ?? "").slice(0, 2)
  ).toUpperCase();
  return letters || "IV";
}

/**
 * Clay user menu for the app shell. Shows the signed-in name (falling back to
 * email), biometric consent state, language switcher, and a sign-out action
 * inside a chunky dialog.
 */
export function AppUserMenu({
  email,
  consentGiven,
  fullName,
}: {
  email: string;
  consentGiven: boolean;
  /** Profile display name (profiles.full_name) — preferred over email. */
  fullName?: string;
}) {
  const router = useRouter();
  const t = useTranslations("nav");
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const displayName = fullName?.trim() || email;

  async function handleLogout() {
    setSigningOut(true);
    setSignOutError(false);
    try {
      await logout();
      router.push("/login");
      router.refresh();
    } catch (err) {
      console.error("Sign out failed:", err);
      setSignOutError(true);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <LanguageToggle />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          aria-label={t("accountMenu")}
          className="grid h-11 w-11 cursor-pointer place-items-center rounded-2xl border-[3px] border-border bg-card font-sans text-sm font-extrabold text-foreground shadow-[0_4px_0_var(--border)] transition-[transform,box-shadow] duration-[180ms] ease-out hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--border)]"
        >
          {initialsFrom(displayName)}
        </DialogTrigger>

        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <div className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-primary/15 text-primary">
              <UserRound className="h-6 w-6" aria-hidden />
            </div>
            <DialogTitle className="break-all text-base">{displayName}</DialogTitle>
            <DialogDescription className="flex flex-col gap-1">
              {fullName?.trim() ? <span className="break-all">{email}</span> : null}
              <span>{t("accountMenu")}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-center gap-2.5 rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3 text-sm font-bold">
              {consentGiven ? (
                <>
                  <CircleCheck className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                  <span className="text-emerald-700 dark:text-emerald-300">{t("consentGiven")}</span>
                </>
              ) : (
                <>
                  <CircleAlert className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                  <span className="text-amber-700 dark:text-amber-300">{t("consentMissing")}</span>
                </>
              )}
            </div>
            {signOutError && (
              <p role="alert" className="text-sm font-bold text-destructive">
                {t("signOutFailed")}
              </p>
            )}
          </div>

          <Button
            onClick={handleLogout}
            variant="outline"
            className="w-full"
            disabled={signingOut}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {signingOut ? t("signingOut") : t("signOut")}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

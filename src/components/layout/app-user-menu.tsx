"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { logout } from "@/lib/auth/logout";
import { updateMyMatric } from "@/lib/auth/update-matric";
import { isSystemAssignedMatric } from "@/lib/auth/matric";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CircleCheck, CircleAlert, Hash, LogOut, Pencil, UserRound } from "lucide-react";
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
 * email), the student's matric number (inline self-edit), biometric consent
 * state, language switcher, and a sign-out action inside a chunky dialog.
 */
export function AppUserMenu({
  email,
  consentGiven,
  fullName,
  matricNo,
  isStudent,
}: {
  email: string;
  consentGiven: boolean;
  /** Profile display name (profiles.full_name) — preferred over email. */
  fullName?: string;
  /** profiles.matric_no — shown (and editable) in the account menu. */
  matricNo?: string | null;
  /** Students see the matric block even before one is set (empty state). */
  isStudent?: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const displayName = fullName?.trim() || email;

  const [editingMatric, setEditingMatric] = useState(false);
  const [matricDraft, setMatricDraft] = useState(matricNo ?? "");
  const [savingMatric, setSavingMatric] = useState(false);
  const [matricError, setMatricError] = useState<string | null>(null);

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

  async function handleSaveMatric() {
    if (savingMatric) return;
    setSavingMatric(true);
    setMatricError(null);
    try {
      const res = await updateMyMatric(matricDraft);
      if (!res.ok) {
        setMatricError(res.error);
        return;
      }
      setEditingMatric(false);
      router.refresh();
    } catch {
      setMatricError(tCommon("errorGeneric"));
    } finally {
      setSavingMatric(false);
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
            {(matricNo != null || isStudent) && (
              <div className="rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3">
                {editingMatric ? (
                  <div className="space-y-2">
                    <label htmlFor="matric-edit" className="text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
                      {t("matricNumber")}
                    </label>
                    <Input
                      id="matric-edit"
                      type="text"
                      spellCheck={false}
                      autoComplete="off"
                      value={matricDraft}
                      onChange={(e) => {
                        setMatricDraft(e.target.value);
                        setMatricError(null);
                      }}
                      disabled={savingMatric}
                    />
                    {matricError && (
                      <p role="alert" className="text-sm font-bold text-destructive">
                        {matricError}
                      </p>
                    )}
                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingMatric(false);
                          setMatricDraft(matricNo ?? "");
                          setMatricError(null);
                        }}
                        disabled={savingMatric}
                      >
                        {tCommon("cancel")}
                      </Button>
                      <Button size="sm" onClick={handleSaveMatric} disabled={savingMatric}>
                        {savingMatric ? tCommon("saving") : tCommon("save")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <Hash className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
                          {t("matricNumber")}
                        </p>
                        <p className="break-all text-sm font-bold">{matricNo ?? "—"}</p>
                        <p className="text-xs font-semibold leading-relaxed text-muted-foreground">
                          {matricNo != null && isSystemAssignedMatric(matricNo)
                            ? t("matricSystemHint")
                            : t("matricHint")}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label={tCommon("edit")}
                      onClick={() => {
                        setMatricDraft(matricNo ?? "");
                        setMatricError(null);
                        setEditingMatric(true);
                      }}
                      className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-xl border-2 border-border bg-card text-muted-foreground shadow-[0_2px_0_var(--border)] transition-transform duration-150 ease-out hover:-translate-y-0.5 hover:text-primary active:translate-y-0"
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                )}
              </div>
            )}

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

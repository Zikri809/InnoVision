"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { logout } from "@/lib/auth/logout";
import { isSystemAssignedMatric } from "@/lib/auth/matric";
import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
import {
  Camera,
  CircleCheck,
  CircleAlert,
  LogOut,
  Presentation,
  Trash2,
  UserRound,
} from "lucide-react";
import { LanguageToggle } from "./language-toggle";
import { ThemeToggle } from "./theme-toggle";
import { clearQuestionImageCache } from "@/lib/media/use-question-image";

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

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
 * email), the student's matric number (READ-ONLY — corrections are dev/
 * service-role operations; the unique index still guards the value), biometric
 * consent state (students only), language switcher, and sign-out.
 *
 * Profile photo: a camera BADGE overlaid on the profile badge INSIDE this menu
 * opens the file picker DIRECTLY (upload/replace in one click, WhatsApp-style);
 * removal lives in the photo card below. Self-only surface — no other view
 * renders the photo.
 */
export function AppUserMenu({
  email,
  consentGiven,
  fullName,
  matricNo,
  isStudent,
  hasAvatar = false,
  memberSince = null,
}: {
  email: string;
  consentGiven: boolean;
  /** Profile display name (profiles.full_name) — preferred over email. */
  fullName?: string;
  /** profiles.matric_no — shown READ-ONLY in the account menu (policy: corrections are dev/service-role operations; registration remains the only self-service write, uniqueness-guarded). */
  matricNo?: string | null;
  /** Students see the matric block even before one is set (empty state). */
  isStudent?: boolean;
  /** profiles.avatar_path presence — URL is fetched from /api/profile/avatar. */
  hasAvatar?: boolean;
  /** profiles.created_at — rendered as a "member since" line in the header. */
  memberSince?: string | null;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("nav");
  const tMedia = useTranslations("media");
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const displayName = fullName?.trim() || email;
  // "Member since" label — same locale/tz conventions as class roster dates.
  let memberSinceLabel: string | null = null;
  if (memberSince) {
    const d = new Date(memberSince);
    if (!Number.isNaN(d.getTime())) {
      memberSinceLabel = new Intl.DateTimeFormat(
        locale === "ms" ? "ms-MY" : "en-US",
        { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Kuala_Lumpur" },
      ).format(d);
    }
  }

  // Avatar (self-only): signed URL fetch + upload/remove via /api/profile/avatar.
  const [avatarPresent, setAvatarPresent] = useState(hasAvatar);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  // Derived (never stale after removal): URL only counts while present.
  const shownAvatarUrl = avatarPresent ? avatarUrl : null;

  const loadAvatarUrl = useCallback(async () => {
    try {
      const res = await fetch("/api/profile/avatar");
      if (!res.ok) {
        setAvatarUrl(null);
        return;
      }
      const body = (await res.json()) as { url?: string };
      setAvatarUrl(body.url ?? null);
    } catch {
      setAvatarUrl(null);
    }
  }, []);

  useEffect(() => {
    if (!avatarPresent) return;
    // Microtask deferral keeps every setState out of the synchronous effect
    // body (cascading-render rule). avatarVersion forces a refetch after
    // same-presence changes (e.g. png→jpg replace swaps the stored path).
    let alive = true;
    void Promise.resolve().then(() => {
      if (alive) void loadAvatarUrl();
    });
    return () => {
      alive = false;
    };
  }, [avatarPresent, avatarVersion, loadAvatarUrl]);

  async function handleAvatarFile(file: File | undefined | null) {
    // Reset FIRST so re-selecting the same rejected file still fires onChange.
    if (avatarInputRef.current) avatarInputRef.current.value = "";
    if (!file || avatarBusy) return;
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError(tMedia("avatarTooLarge"));
      return;
    }
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const form = new FormData();
      form.append("image", file, file.name);
      const res = await fetch("/api/profile/avatar", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setAvatarError(body.message ?? tMedia("uploadFailed"));
        return;
      }
      setAvatarPresent(true);
      setAvatarVersion((v) => v + 1);
      router.refresh();
    } catch {
      setAvatarError(tMedia("uploadFailed"));
    } finally {
      setAvatarBusy(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  }

  async function handleAvatarRemove() {
    if (avatarBusy) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const res = await fetch("/api/profile/avatar", { method: "DELETE" });
      if (res.ok) {
        setAvatarPresent(false);
        setAvatarUrl(null);
        router.refresh();
      } else {
        setAvatarError(tMedia("removeFailed"));
      }
    } catch {
      setAvatarError(tMedia("removeFailed"));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleLogout() {
    setSigningOut(true);
    setSignOutError(false);
    try {
      // Drop signed-URL cache so a same-tab re-login as another user can't
      // render the predecessor's images until TTL decay.
      clearQuestionImageCache();
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
      <ThemeToggle />

      <ResponsiveModal open={open} onOpenChange={setOpen}>
        <ResponsiveModalTrigger
          aria-label={t("accountMenu")}
          className="relative grid h-11 w-11 cursor-pointer place-items-center overflow-hidden rounded-2xl border-[3px] border-border bg-card font-sans text-sm font-extrabold text-foreground shadow-[0_4px_0_var(--border)] transition-[transform,box-shadow] duration-[180ms] ease-out hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--border)]"
        >
          {shownAvatarUrl ? (
            <Image
              src={shownAvatarUrl}
              alt=""
              fill
              sizes="44px"
              className="object-cover"
              referrerPolicy="no-referrer"
              unoptimized
            />
          ) : (
            initialsFrom(displayName)
          )}
        </ResponsiveModalTrigger>

        {/* Hidden file input lives outside the modal so the picker can be
            opened from the badge rendered beside the profile badge in the
            modal header. */}
        <input
          ref={avatarInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => void handleAvatarFile(e.target.files?.[0])}
        />

        <ResponsiveModalContent className="sm:max-w-sm">
          <ResponsiveModalHeader>
            <div className="relative mb-1 h-12 w-12">
              <div className="relative grid h-full w-full place-items-center overflow-hidden rounded-2xl bg-primary/15 text-primary">
                {shownAvatarUrl ? (
                  <Image
                    src={shownAvatarUrl}
                    alt=""
                    fill
                    sizes="48px"
                    className="object-cover"
                    referrerPolicy="no-referrer"
                    unoptimized
                  />
                ) : (
                  <UserRound className="h-6 w-6" aria-hidden />
                )}
              </div>

              {/* Upload/replace badge — opens the file picker DIRECTLY (one
                  click, no menu detour). Overlaid on the profile badge. */}
              <button
                type="button"
                aria-label={tMedia("upload")}
                title={tMedia("upload")}
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarBusy}
                className="absolute -bottom-1.5 -right-1.5 z-10 grid size-6 cursor-pointer place-items-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-[0_2px_0_var(--primary-deep)] transition-transform duration-150 ease-out hover:scale-110 active:translate-y-0.5 disabled:opacity-50"
              >
                {avatarBusy ? (
                  <span className="size-3 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                ) : (
                  <Camera className="size-3" aria-hidden />
                )}
              </button>
            </div>
            <ResponsiveModalTitle className="break-all text-base">{displayName}</ResponsiveModalTitle>
            <ResponsiveModalDescription className="flex flex-col gap-1">
              {/* Role chip — lecturers only; students are identified by the
                  matric card below instead. */}
              {!isStudent && (
                <span className="inline-flex w-fit items-center gap-1.5 rounded-full border-2 border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wide text-primary">
                  <Presentation className="h-3 w-3" aria-hidden />
                  {t("roleLecturer")}
                </span>
              )}
              {fullName?.trim() ? <span className="break-all">{email}</span> : null}
              {memberSinceLabel && (
                <span className="text-muted-foreground">
                  {t("memberSince", { date: memberSinceLabel })}
                </span>
              )}
              <span>{t("accountMenu")}</span>
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>

          <div className="space-y-3">
            {/* Profile photo (self-only) — upload rides the badge beside the
                profile badge above; removal lives in here. */}
            {(avatarPresent || avatarError) && (
              <div className="rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
                      {tMedia("profilePhoto")}
                    </p>
                    <p className="text-xs font-semibold leading-relaxed text-muted-foreground">
                      {tMedia("photoHint")}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={tMedia("remove")}
                    onClick={() => void handleAvatarRemove()}
                    disabled={avatarBusy}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border-2 border-border bg-card text-muted-foreground shadow-[0_2px_0_var(--border)] transition-transform duration-150 ease-out hover:-translate-y-0.5 hover:text-destructive active:translate-y-0 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                {avatarError && (
                  <p role="alert" className="pt-2 text-sm font-bold text-destructive">
                    {avatarError}
                  </p>
                )}
              </div>
            )}

            {(matricNo != null || isStudent) && (
              <div className="rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
                    {t("matricNumber")}
                  </p>
                  {matricNo != null && isSystemAssignedMatric(matricNo) && (
                    <span className="shrink-0 rounded-full border-2 border-amber-300/60 bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-400">
                      {t("matricTemporary")}
                    </span>
                  )}
                </div>

                <p className="mt-2 break-all font-mono text-xl font-extrabold leading-tight tracking-[0.12em] text-foreground">
                  {matricNo ?? "—"}
                </p>

                <div className="mt-2 space-y-1 border-t-2 border-border/50 pt-2">
                  <p className="text-xs font-semibold leading-relaxed text-muted-foreground">
                    {t("matricHint")}
                  </p>
                  <p className="text-xs font-semibold leading-relaxed text-muted-foreground">
                    {t("matricChangeHint")}
                  </p>
                </div>
              </div>
            )}

            {/* Biometric consent (students only) — it gates face enrollment
                and quiz face checks; lecturers are auto-consented at signup
                and never hit those flows, so the card is hidden for them. */}
            {isStudent && (
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
            )}
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
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}

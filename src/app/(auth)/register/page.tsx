"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { register } from "@/lib/auth/register";
import { normalizeMatric } from "@/lib/auth/matric";
import type { UserRole, SupportedLocale } from "@/lib/types/aliases";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LanguageToggle } from "@/components/layout/language-toggle";
import { AuthBot } from "@/components/auth/auth-bot";
import type { BotState } from "@/lib/bot/engine";

export default function RegisterPage() {
  const router = useRouter();
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");

  const activeLocale = useLocale() as SupportedLocale;
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [matricNo, setMatricNo] = useState("");
  // Display-only for the picker; the server action always registers "student".
  const [role, setRole] = useState<UserRole>("student");
  const [inviteCode, setInviteCode] = useState("");
  const [locale, setLocaleState] = useState<SupportedLocale>(activeLocale || "en");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const botState: BotState = loading
    ? "scanning"
    : error
      ? "fail"
      : password.length >= 8
        ? "success"
        : fullName.length > 0 || email.length > 0 || password.length > 0
          ? "thinking"
          : "idle";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!consent) {
      setError(t("consentTitle") + ": " + t("consentText"));
      return;
    }

    if (password.length < 6) {
      setError(t("passwordMinLength"));
      return;
    }

    // Client mirror of the server-action matric rules (shared helper — the
    // same normalization the DB CHECK expects). Server re-validates.
    let normalizedMatric: string | undefined;
    if (role === "student") {
      const matric = normalizeMatric(matricNo);
      if (!matric.ok) {
        setError(
          matric.reason === "empty"
            ? t("matricRequired")
            : matric.reason === "reserved"
              ? t("matricReserved")
              : t("matricInvalid"),
        );
        return;
      }
      normalizedMatric = matric.value;
    }

    if (role === "lecturer" && !inviteCode.trim()) {
      setError(t("inviteCodeHelp"));
      return;
    }

    setLoading(true);

    try {
      const { session, error } = await register({
        email,
        password,
        fullName: fullName || undefined,
        matricNo: normalizedMatric,
        inviteCode: role === "lecturer" ? inviteCode : undefined,
        locale,
      });

      if (error) {
        setError(error);
        return;
      }

      if (session) {
        router.push("/dashboard");
        router.refresh();
      } else {
        // Email confirmation required — redirect to login with a message
        router.push("/login?message=check-email");
      }
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      {/* decorative blobs */}
      <div aria-hidden className="pointer-events-none absolute -left-10 top-20 h-32 w-32 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50" />
      <div aria-hidden className="pointer-events-none absolute -right-8 bottom-24 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50" />

      {/* Top right language switch */}
      <div className="absolute right-6 top-6 z-10">
        <LanguageToggle />
      </div>

      <AuthBot state={botState} danger={!!error && !loading} />

      <div className="w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <span className="grid h-11 w-11 -rotate-4 place-items-center rounded-2xl bg-primary font-heading text-xl font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
            IV
          </span>
          <span className="font-heading text-2xl font-semibold">InnoVision</span>
        </Link>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{t("createAccount")}</CardTitle>
            <CardDescription>{t("createSubtitle")}</CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="full-name">{t("fullName")}</Label>
                <Input
                  id="full-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  placeholder={t("fullNamePlaceholder")}
                  value={fullName}
                  onChange={(e) => {
                    setFullName(e.target.value);
                    setError(null);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">{t("email")}</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  spellCheck={false}
                  autoComplete="email"
                  placeholder={t("emailPlaceholder")}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">{t("password")}</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t("passwordPlaceholder")}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  required
                  minLength={6}
                />
              </div>

              <div className="space-y-2.5">
                <Label>{t("roleLabel")}</Label>
                <RadioGroup
                  aria-label={t("roleLabel")}
                  value={role}
                  onValueChange={(v) => setRole(v as UserRole)}
                  className="flex gap-6"
                >
                  <div className="flex items-center space-x-2.5">
                    <RadioGroupItem value="student" id="role-student" />
                    <Label htmlFor="role-student" className="cursor-pointer font-bold">
                      {t("studentRole")}
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2.5">
                    <RadioGroupItem value="lecturer" id="role-lecturer" />
                    <Label htmlFor="role-lecturer" className="cursor-pointer font-bold">
                      {t("lecturerRole")}
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              {role === "student" && (
                <div className="space-y-2">
                  <Label htmlFor="matric-no">{t("matricLabel")}</Label>
                  <Input
                    id="matric-no"
                    name="matricNo"
                    type="text"
                    inputMode="text"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t("matricPlaceholder")}
                    value={matricNo}
                    onChange={(e) => {
                      setMatricNo(e.target.value);
                      setError(null);
                    }}
                    required
                  />
                  <p className="text-xs font-semibold text-muted-foreground">
                    {t("matricHelp")}
                  </p>
                </div>
              )}

              {/* Preferred language selector during registration */}
              <div className="space-y-2.5">
                <Label>{t("languageLabel")}</Label>
                <RadioGroup
                  aria-label={t("languageLabel")}
                  value={locale}
                  onValueChange={(v) => setLocaleState(v as SupportedLocale)}
                  className="flex gap-6"
                >
                  <div className="flex items-center space-x-2.5">
                    <RadioGroupItem value="en" id="locale-en" />
                    <Label htmlFor="locale-en" className="cursor-pointer font-semibold">
                      {t("english")}
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2.5">
                    <RadioGroupItem value="ms" id="locale-ms" />
                    <Label htmlFor="locale-ms" className="cursor-pointer font-semibold">
                      {t("malay")}
                    </Label>
                  </div>


                </RadioGroup>
              </div>

              {role === "lecturer" && (
                <div className="space-y-2">
                  <Label htmlFor="invite-code">{t("inviteCode")}</Label>
                  <Input
                    id="invite-code"
                    type="text"
                    placeholder={t("inviteCodePlaceholder")}
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    autoComplete="off"
                  />
                  <p className="text-xs font-semibold text-muted-foreground">
                    {t("inviteCodeHelp")}
                  </p>
                </div>
              )}

              <div className="flex items-start space-x-3 rounded-2xl border-[3px] border-border bg-orange-50/60 p-4">
                <Checkbox
                  id="consent"
                  checked={consent}
                  onCheckedChange={(v) => setConsent(v === true)}
                  className="mt-0.5"
                />
                <div className="space-y-1.5 leading-none">
                  <Label
                    htmlFor="consent"
                    className="cursor-pointer text-sm font-extrabold"
                  >
                    {t("consentTitle")}
                  </Label>
                  <p className="text-xs font-semibold leading-relaxed text-muted-foreground">
                    {t("consentText")}
                  </p>
                </div>
              </div>

              <div aria-live="polite" className={!error ? "hidden" : undefined}>
                {error && (
                  <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-4">
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={loading || !consent}
              >
                {loading ? t("creatingAccount") : t("createAccountBtn")}
              </Button>
              <p className="text-sm font-semibold text-muted-foreground">
                {t("haveAccount")}{" "}
                <Link
                  href="/login"
                  className="font-extrabold text-primary hover:underline"
                >
                  {t("loginLink")}
                </Link>
              </p>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}

"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { login } from "@/lib/auth/login";
import { sanitizeRedirect } from "@/lib/auth/redirect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");

  const redirect = sanitizeRedirect(
    searchParams.get("redirect"),
    typeof window !== "undefined" ? window.location.origin : "http://localhost",
  );

  const message = searchParams.get("message");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const botState: BotState = loading
    ? "scanning"
    : error
      ? "fail"
      : password.length >= 8
        ? "success"
        : email.length > 0 || password.length > 0
          ? "thinking"
          : "idle";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { error } = await login({ email, password });

      if (error) {
        setError(error);
        return;
      }

      router.push(redirect);
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      {/* decorative blobs */}
      <div aria-hidden className="pointer-events-none absolute -left-10 top-16 h-32 w-32 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50" />
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
            <CardTitle className="text-2xl">{t("welcomeBack")}</CardTitle>
            <CardDescription>{t("signInSubtitle")}</CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-5">
              {message === "check-email" && (
                <div
                  role="status"
                  className="rounded-xl border-[3px] border-primary/30 bg-primary/10 px-4 py-3 text-sm font-bold text-primary"
                >
                  {t("checkEmailMessage")}
                </div>
              )}
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
                  autoComplete="current-password"
                  placeholder={t("passwordPlaceholder")}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  required
                />
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
              <Button type="submit" className="w-full" size="lg" disabled={loading}>
                {loading ? t("signingIn") : t("signInBtn")}
              </Button>
              <p className="text-sm font-semibold text-muted-foreground">
                {t("noAccount")}{" "}
                <Link href="/register" className="font-extrabold text-primary hover:underline">
                  {t("registerLink")}
                </Link>
              </p>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}

function LoginFallback() {
  const tCommon = useTranslations("common");
  return (
    <div className="flex min-h-screen items-center justify-center font-bold text-muted-foreground">
      {tCommon("loading")}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

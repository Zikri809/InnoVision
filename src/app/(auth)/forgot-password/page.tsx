"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { requestReset } from "@/lib/auth/reset";
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

export default function ForgotPasswordPage() {
  const router = useRouter();
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const botState: BotState = loading
    ? "scanning"
    : error
      ? "fail"
      : sent
        ? "success"
        : email.length > 0
          ? "thinking"
          : "idle";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { error } = await requestReset({ email });
      if (error) {
        setError(error);
        return;
      }
      // Generic confirmation regardless of account existence — never reveal
      // whether the address is registered (no enumeration oracle).
      setSent(true);
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 pt-[calc(var(--safe-top)+2.5rem)] pb-[max(2.5rem,var(--safe-bottom))]">
      {/* decorative blobs */}
      <div aria-hidden className="pointer-events-none absolute -left-10 top-16 h-32 w-32 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50" />
      <div aria-hidden className="pointer-events-none absolute -right-8 bottom-24 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50" />

      {/* Top right language switch */}
      <div className="absolute right-6 top-[calc(var(--safe-top)+1.5rem)] z-10">
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
            <CardTitle className="text-2xl">{t("forgotTitle")}</CardTitle>
            <CardDescription>{t("forgotSubtitle")}</CardDescription>
          </CardHeader>
          {sent ? (
            <CardContent className="space-y-5">
              <div
                role="status"
                className="rounded-xl border-[3px] border-primary/30 bg-primary/10 px-4 py-3 text-sm font-bold text-primary"
              >
                {t("forgotEmailSent")}
              </div>
              <Button variant="outline" className="w-full" onClick={() => router.push("/login")}>
                {t("backToLogin")}
              </Button>
            </CardContent>
          ) : (
            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-5">
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
                  {loading ? t("forgotSending") : t("forgotSubmit")}
                </Button>
                <p className="text-sm font-semibold text-muted-foreground">
                  <Link href="/login" className="font-extrabold text-primary hover:underline">
                    {t("backToLogin")}
                  </Link>
                </p>
              </CardFooter>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}

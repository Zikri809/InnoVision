"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { captureOwnMatric } from "@/lib/auth/matric-capture";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * AU-2 matric capture form. Validation mirrors the register UI's client-side
 * guards (maxLength 6, digits) with the server action as the authoritative
 * gate; success re-navigates — the layout's gate then passes.
 */
export function MatricCaptureForm() {
  const router = useRouter();
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");

  const [matricNo, setMatricNo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const result = await captureOwnMatric({ matricNo });
      if (result.error) {
        setError(result.error);
        return;
      }
      // Captured — the student layout's gate passes now.
      router.push("/student/classes");
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-4">
      <div className="space-y-2">
        <Label htmlFor="matric-no">{t("matricLabel")}</Label>
        <Input
          id="matric-no"
          name="matricNo"
          inputMode="numeric"
          autoComplete="off"
          placeholder="123456"
          value={matricNo}
          onChange={(e) => {
            setMatricNo(e.target.value);
            setError(null);
          }}
          maxLength={6}
          className="font-mono tracking-widest"
          required
        />
        <p className="text-xs font-semibold text-muted-foreground">
          {t("matricGateHint")}
        </p>
      </div>
      <div aria-live="polite">
        {error && (
          <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" className="w-full" size="lg" disabled={saving || matricNo.trim().length !== 6}>
        {saving ? tCommon("saving") : t("matricGateSubmit")}
      </Button>
    </form>
  );
}

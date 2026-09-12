"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { Copy } from "lucide-react";

/**
 * QR join dialog (lecturer class page) — renders `react-qr-code` as pure
 * React SVG (no innerHTML, no remote fetch, no canvas) encoding the universal
 * join URL {origin}/join/{code}.
 *
 * The origin is read from the browser at dialog-open, so dev/staging/prod QRs
 * are always self-correct with no site-URL config. The resolved URL is also
 * shown as text so a dev/LAN deployment (unresolvable hostname from student
 * phones) is immediately obvious to the lecturer.
 *
 * Mounted only for UNARCHIVED classes: joining an archived class always 409s
 * (class_archived), so the affordance would be a broken promise.
 */
export function JoinQrDialog({
  code,
  open,
  onOpenChange,
}: {
  code: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("join");
  // Render the QR only once mounted-open so window.location is always defined
  // (this component is client-only, but the guard keeps SSR/hydration honest).
  const [joinUrl, setJoinUrl] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read-once external init: window.location.origin is unreadable during SSR (class-detail deep-link precedent)
      setJoinUrl(`${window.location.origin}/join/${encodeURIComponent(code)}`);
    }
  }, [open, code]);

  async function copyLink() {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast.success(t("linkCopied"));
    } catch {
      toast.error(t("copyLinkError"));
    }
  }

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent>
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>{t("qrTitle")}</ResponsiveModalTitle>
          <ResponsiveModalDescription>{t("qrHint")}</ResponsiveModalDescription>
        </ResponsiveModalHeader>
        <div className="flex flex-col items-center gap-4 py-2">
          {joinUrl && (
            <div
              data-testid="join-qr-canvas"
              className="rounded-2xl border-[3px] border-border bg-white p-4 shadow-[var(--shadow-clay-sm)]"
            >
              <QRCode value={joinUrl} size={192} bgColor="#ffffff" fgColor="#1c1917" />
            </div>
          )}
          <p className="font-heading text-2xl font-bold tracking-[0.3em] text-primary">
            {code}
          </p>
          <p
            data-testid="join-qr-url"
            className="max-w-full truncate rounded-xl border-[2.5px] border-border bg-muted/50 px-3 py-1.5 font-mono text-xs font-semibold text-muted-foreground"
          >
            {joinUrl ?? "…"}
          </p>
        </div>
        <ResponsiveModalFooter>
          <Button type="button" variant="outline" onClick={() => void copyLink()}>
            <Copy className="mr-1.5 size-4" aria-hidden />
            {t("copyLink")}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("qrDone")}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

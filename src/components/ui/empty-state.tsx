import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  illustration: Illustration,
  title,
  subtitle,
  action,
  className,
  iconClassName,
}: {
  illustration?: ComponentType<{ className?: string }>;
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <div
      className={cn(
        "grid place-items-center gap-1 rounded-[16px] border-2 border-dashed border-border px-6 py-10 text-center",
        className,
      )}
    >
      {Illustration && (
        <Illustration
          className={cn(
            "mb-2 h-16 w-auto text-muted-foreground/60",
            iconClassName,
          )}
        />
      )}
      <p className="font-heading text-lg font-semibold">{title}</p>
      {subtitle != null && (
        <p className="max-w-sm text-sm text-muted-foreground">{subtitle}</p>
      )}
      {action ?? null}
    </div>
  );
}

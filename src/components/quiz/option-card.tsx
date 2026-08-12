import { cn } from "@/lib/utils";

/**
 * Glassmorphic click-first option card. `role="button"`, keyboard-focusable,
 * with selected / disabled / feedback (correct / incorrect) states. The
 * finger badge is a placeholder for the P6 gesture layer (1–5 fingers).
 */
export function OptionCard({
  letter,
  finger,
  text,
  selected,
  correct,
  incorrect,
  disabled,
  onClick,
}: {
  letter: string;
  finger: number;
  text: string;
  selected?: boolean;
  correct?: boolean;
  incorrect?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="button"
      tabIndex={disabled ? -1 : 0}
      disabled={disabled}
      onClick={onClick}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled && onClick) {
          e.preventDefault();
          onClick();
        }
      }}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border bg-card/60 px-4 py-3 text-left shadow-sm backdrop-blur transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        !disabled && !selected && !correct && !incorrect && "hover:bg-muted/60 cursor-pointer",
        selected && !correct && !incorrect && "border-primary bg-primary/10",
        correct && "border-emerald-400 bg-emerald-50",
        incorrect && "border-destructive bg-destructive/10",
        disabled && "opacity-70 cursor-default",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium",
          correct
            ? "border-emerald-400 bg-emerald-100 text-emerald-800"
            : incorrect
              ? "border-destructive bg-destructive/10 text-destructive"
              : selected
                ? "border-primary bg-primary/10 text-primary"
                : "border-muted bg-muted/50 text-muted-foreground",
        )}
      >
        {letter}
      </span>
      <span className="min-w-0 flex-1 text-sm">{text}</span>
      <span className="shrink-0 text-xs text-muted-foreground" aria-hidden>
        {finger}
      </span>
    </button>
  );
}

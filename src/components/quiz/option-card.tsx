import { cn } from "@/lib/utils";

/**
 * Finger glyphs for the 1–5 finger badge (Phase 6). The 4/5 duplication is
 * deliberate: four fingers (no thumb) and the open palm (five) share the
 * raised-hand glyph because the palm-next hint ("hold ✋ to continue") gives
 * the five-finger case its distinct contextual affordance.
 */
const FINGER_GLYPHS = ["☝️", "✌️", "🤟", "🖐", "🖐"];

/**
 * Glassmorphic click-first option card. `role="button"`, keyboard-focusable,
 * with selected / disabled / feedback (correct / incorrect) states. The finger
 * badge is the P6 gesture glyph; `holdProgress` (0..1) drives an accent
 * progress bar when the student holds the matching finger to confirm.
 */
export function OptionCard({
  letter,
  finger,
  text,
  selected,
  correct,
  incorrect,
  disabled,
  holdProgress,
  onClick,
}: {
  letter: string;
  finger: number;
  text: string;
  selected?: boolean;
  correct?: boolean;
  incorrect?: boolean;
  disabled?: boolean;
  /** 0..1 hold completion for this option's finger (P6). */
  holdProgress?: number;
  onClick?: () => void;
}) {
  const progress = Math.max(0, Math.min(1, holdProgress ?? 0));
  const glyph = FINGER_GLYPHS[finger - 1] ?? String(finger);

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
        "relative flex w-full items-center gap-3 overflow-hidden rounded-xl border bg-card/60 px-4 py-3 text-left shadow-sm backdrop-blur transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        !disabled && !selected && !correct && !incorrect && "hover:bg-muted/60 cursor-pointer",
        selected && !correct && !incorrect && "border-primary bg-primary/10",
        correct && "border-emerald-400 bg-emerald-50",
        incorrect && "border-destructive bg-destructive/10",
        disabled && "opacity-70 cursor-default",
      )}
    >
      {/* Hold-progress accent bar (aria-hidden — decorative). */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-primary/15 transition-[width] duration-100"
        style={{ width: `${progress * 100}%` }}
      />
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
      <span className="relative min-w-0 flex-1 text-sm">{text}</span>
      <span className="relative shrink-0 text-xs text-muted-foreground" aria-hidden>
        {glyph}
      </span>
    </button>
  );
}

import { cn } from "@/lib/utils";

/**
 * Finger glyphs for the 1–5 finger badge (Phase 6). The 4/5 duplication is
 * deliberate: four fingers (no thumb) and the open palm (five) share the
 * raised-hand glyph because the palm-next hint ("hold ✋ to continue") gives
 * the five-finger case its distinct contextual affordance.
 */
const FINGER_GLYPHS = ["☝️", "✌️", "🤟", "🖐", "🖐"];

/**
 * Clay click-first option card. `role="button"`, keyboard-focusable, with
 * selected / disabled / feedback (correct / incorrect) states. The finger badge
 * is the P6 gesture glyph; `holdProgress` (0..1) drives an accent progress fill
 * when the student holds the matching finger to confirm.
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
        "relative flex w-full items-center gap-3.5 overflow-hidden rounded-2xl border-[3px] px-4 py-4 text-left transition-[transform,box-shadow,background-color,border-color] duration-[180ms] ease-out",
        "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40",
        // Base clay option
        !selected && !correct && !incorrect && "border-border bg-card shadow-[0_4px_0_var(--border)]",
        !disabled && !selected && !correct && !incorrect && "cursor-pointer hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--border)]",
        // Selected (gesture/click locked)
        selected && !correct && !incorrect && "border-accent bg-blue-50 shadow-[0_4px_0_#bfdbfe]",
        // Feedback
        correct && "border-emerald-400 bg-emerald-50 shadow-[0_4px_0_#a7f3d0]",
        incorrect && "border-destructive bg-destructive/10 shadow-[0_4px_0_rgba(220,38,38,0.25)]",
        disabled && "cursor-default opacity-70",
      )}
    >
      {/* Hold-progress accent fill (aria-hidden — decorative). */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-primary/15 transition-[width] duration-100"
        style={{ width: `${progress * 100}%` }}
      />
      <span
        className={cn(
          "relative flex size-10 shrink-0 items-center justify-center rounded-xl border-[3px] font-heading text-base font-semibold",
          correct
            ? "border-emerald-400 bg-emerald-100 text-emerald-800"
            : incorrect
              ? "border-destructive bg-destructive/10 text-destructive"
              : selected
                ? "border-accent bg-accent text-accent-foreground"
                : "border-border bg-muted text-foreground",
        )}
      >
        {letter}
      </span>
      <span className="relative min-w-0 flex-1 text-base font-bold text-foreground">{text}</span>
      <span className="relative shrink-0 text-lg" aria-hidden>
        {glyph}
      </span>
    </button>
  );
}

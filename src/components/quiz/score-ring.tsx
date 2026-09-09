/**
 * ScoreRing — the clay score ring shared by the quiz end screen
 * (`end-screen.tsx`) and the self-play results (`student-quiz/player-client`).
 * SVG ring around a baseline-aligned "3 / 4" score line.
 */
export function ScoreRing({
  ratio,
  label,
  sub,
}: {
  ratio: number;
  label: string;
  sub: string;
}) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const filled = Math.max(0, Math.min(1, ratio)) * C;
  return (
    <div className="relative grid size-[152px] place-items-center">
      <svg viewBox="0 0 120 120" className="absolute inset-0 size-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={R} fill="none" stroke="var(--muted)" strokeWidth="11" />
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="11"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${C - filled}`}
        />
      </svg>
      <div className="flex items-baseline justify-center gap-1 whitespace-nowrap leading-none">
        <span className="font-heading text-4xl font-bold text-foreground">{label}</span>
        <span className="font-heading text-lg font-bold text-muted-foreground">{sub}</span>
      </div>
    </div>
  );
}

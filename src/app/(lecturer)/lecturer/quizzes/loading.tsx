/**
 * Route-level loading shell (plan W2): hero strip + clay skeleton cards with
 * the warm opacity pulse (globals.css .clay-skeleton — no gradient shimmer).
 * Pure markup, no text.
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="clay-skeleton h-40 rounded-[28px] border-[3px] border-border bg-muted" />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
        <div className="clay-skeleton h-40 rounded-[22px] border-[3px] border-border bg-muted" />
        <div className="clay-skeleton h-40 rounded-[22px] border-[3px] border-border bg-muted" />
        <div className="clay-skeleton h-40 rounded-[22px] border-[3px] border-border bg-muted" />
      </div>
    </div>
  );
}

/**
 * Format a duration (seconds) as a compact human string: hours + minutes first,
 * falling back to minutes + seconds for sub-hour values. Used for STATIC time
 * limits (quiz cards, headers) — never for live countdowns.
 */
export function formatDuration(sec: number, locale: string = "en"): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const isMs = locale === "ms";
  const hUnit = isMs ? "j" : "h";
  const mUnit = "m";
  const sUnit = "s";

  if (h > 0) return m > 0 ? `${h}${hUnit} ${m}${mUnit}` : `${h}${hUnit}`;
  if (m > 0) return s > 0 ? `${m}${mUnit} ${s}${sUnit}` : `${m}${mUnit}`;
  return `${s}${sUnit}`;
}
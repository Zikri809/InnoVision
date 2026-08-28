/**
 * Availability-window helpers (PLAN_R_QUIZ_LIFECYCLE QC-3).
 *
 * The wire/storage format is a UTC instant (ISO 8601); the EDITOR surface is
 * `datetime-local` (a wall-clock string with NO timezone marker) which the
 * browser interprets in the LECTURER'S local timezone. Converting once at the
 * client boundary — here — keeps the DB side pure timestamptz comparisons and
 * makes the conversion unit-testable in the Node vitest env (the dialog
 * component itself is browser-only and E2E-covered).
 *
 * Display formatting follows the house convention: fixed
 * `Asia/Kuala_Lumpur` wall-clock rendering, locale-tagged (en-US | ms-MY).
 */

export const DISPLAY_TIME_ZONE = "Asia/Kuala_Lumpur";

/**
 * Parse a `datetime-local` input value ("2026-09-01T14:00" or with seconds)
 * as a UTC ISO instant. `datetime-local` has no offset, so we interpret it
 * as UTC server-side canonical time — the lecturer schedules in "quiz time".
 * Empty/null → null (unbounded endpoint).
 */
export function windowLocalInputToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!m) return null;
  const [ , y, mo, d, h, mi, s ] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}.000Z`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return iso;
}

/**
 * Format a UTC ISO instant as a `datetime-local` input value (UTC
 * wall-clock components, since the parse side interprets inputs as UTC).
 * Null/unparseable → "" (empty input = unbounded).
 */
export function windowIsoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/** Shared formatter: localized date+time in the display timezone. */
function formatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  });
}

/**
 * Human window line for cards/dialogs: "Opens 1 Sep, 2:00 PM" /
 * "Due 1 Sep, 4:00 PM" / "1 Sep, 2:00 PM – 4:00 PM".
 * Returns "" when both endpoints are absent (nothing to render).
 */
export function formatWindow(
  opensAt: string | null | undefined,
  closesAt: string | null | undefined,
  locale: string = "en",
): string {
  const fmt = formatter(locale);
  const parts: string[] = [];
  const opens = parseable(opensAt);
  const closes = parseable(closesAt);
  if (opens) parts.push(fmt.format(new Date(opens)));
  if (closes) parts.push(fmt.format(new Date(closes)));
  return parts.join(" – ");
}

function parseable(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : iso;
}
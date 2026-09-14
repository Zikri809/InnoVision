/**
 * Availability-window helpers (PLAN_R_QUIZ_LIFECYCLE QC-3).
 *
 * The wire/storage format is a UTC instant (ISO 8601); the EDITOR surface is
 * `datetime-local` (a wall-clock string with NO timezone marker).
 *
 * audit-3 C-F3: the parse side used to interpret that wall-clock as UTC while
 * every display surface renders fixed `Asia/Kuala_Lumpur` (UTC+8) — the same
 * instant therefore showed two different wall-clocks, and a UTC+8 lecturer
 * picking "2:00 PM" got a quiz opening at 10:00 PM local. The two sides now
 * agree on ONE zone: the institution's display zone (`DISPLAY_TIME_ZONE`).
 * A `datetime-local` value is read as a wall-clock in that zone, and every
 * human-facing render uses the same zone, so what the lecturer types is what
 * the lecturer (and the student) sees.
 *
 * The `datetime-local` STRING CONTRACT (`"YYYY-MM-DDTHH:mm"` / `""`) is
 * unchanged — only the zone the components are interpreted in. Server payloads
 * stay ISO UTC instants, and the DB side stays pure timestamptz comparisons.
 * Unit-testable in the Node vitest env (the dialog itself is browser-only and
 * E2E-covered); conversion needs no browser APIs.
 */

export const DISPLAY_TIME_ZONE = "Asia/Kuala_Lumpur";

/**
 * Parse a `datetime-local` input value ("2026-09-01T14:00" or with seconds)
 * as a UTC ISO instant, interpreting the wall-clock in `DISPLAY_TIME_ZONE`
 * (the same zone every display surface uses — audit-3 C-F3).
 * Empty/null/garbage → null (unbounded endpoint).
 */
export function windowLocalInputToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!m) return null;
  const [ , y, mo, d, h, mi, s ] = m;
  const wallMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? "00"),
  );
  if (Number.isNaN(wallMs)) return null;
  // Reject calendar overflow (e.g. month 13 / day 32) — Date.UTC rolls those
  // over silently, which would turn garbage into a valid-looking instant.
  const wall = new Date(wallMs);
  if (
    wall.getUTCFullYear() !== Number(y) ||
    wall.getUTCMonth() !== Number(mo) - 1 ||
    wall.getUTCDate() !== Number(d) ||
    wall.getUTCHours() !== Number(h) ||
    wall.getUTCMinutes() !== Number(mi)
  ) {
    return null;
  }
  const instant = zonedWallClockToInstant(wallMs);
  if (instant === null) return null;
  return new Date(instant).toISOString();
}

/**
 * Format a UTC ISO instant as a `datetime-local` input value (wall-clock
 * components in `DISPLAY_TIME_ZONE` — the inverse of the parse side).
 * Null/unparseable → "" (empty input = unbounded).
 */
export function windowIsoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const wall = instantToZonedWallClock(d.getTime());
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${wall.year}-${pad(wall.month)}-${pad(wall.day)}` +
    `T${pad(wall.hour)}:${pad(wall.minute)}`
  );
}

// ─── Timezone arithmetic (no browser APIs; works in Node + browser) ───────

/** Zone offset (ms) at a given UTC instant, via the Intl format-to-parts trick. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Some engines render midnight as hour 24 with hour12:false.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - instantMs;
}

/**
 * Interpret `wallMs` (UTC-encoded wall-clock components) as a wall-clock in
 * `DISPLAY_TIME_ZONE` and return the true UTC instant. Uses the zone offset
 * at a first approximation, then re-checks once so a DST boundary (not a
 * concern for Asia/Kuala_Lumpur, but kept correct for any configured zone)
 * still resolves.
 */
function zonedWallClockToInstant(wallMs: number, timeZone = DISPLAY_TIME_ZONE): number | null {
  const offset1 = zoneOffsetMs(wallMs, timeZone);
  const candidate1 = wallMs - offset1;
  const offset2 = zoneOffsetMs(candidate1, timeZone);
  const candidate2 = wallMs - offset2;
  // Prefer the candidate whose zone offset round-trips.
  if (zoneOffsetMs(candidate1, timeZone) === offset1) return candidate1;
  if (zoneOffsetMs(candidate2, timeZone) === offset2) return candidate2;
  return candidate1;
}

/** Inverse: true UTC instant → wall-clock components in `DISPLAY_TIME_ZONE`. */
function instantToZonedWallClock(
  instantMs: number,
  timeZone = DISPLAY_TIME_ZONE,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const shifted = new Date(instantMs + zoneOffsetMs(instantMs, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
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

/** Shared formatter with weekday, for due-date chips (SQ-1). */
function dueFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
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

/**
 * Due-date chip line (SQ-1): "Due Fri 12 Sep, 4:00 PM" style localized string
 * for a closes_at instant. Null/unparseable → null (no chip to render).
 */
export function formatDue(
  closesAt: string | null | undefined,
  locale: string = "en",
): string | null {
  const closes = parseable(closesAt);
  if (!closes) return null;
  return dueFormatter(locale).format(new Date(closes));
}

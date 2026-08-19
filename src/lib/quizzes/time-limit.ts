import { TIME_LIMIT_MAX_SEC } from "./validation";

export const HOURS_MAX = 2; // TIME_LIMIT_MAX_SEC / 3600
export const MINUTES_MAX = 59;

/** [hours, minutes] pair from stored seconds (clamped to [0, TIME_LIMIT_MAX_SEC] for display). */
export function secondsToHm(sec: number | null): { hours: number; minutes: number } {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return { hours: 0, minutes: 0 };
  if (sec > TIME_LIMIT_MAX_SEC) {
    console.warn(`time_limit_sec ${sec} exceeds ${TIME_LIMIT_MAX_SEC}; clamping for display.`);
  }
  const capped = Math.min(Math.max(0, sec), TIME_LIMIT_MAX_SEC);
  return { hours: Math.floor(capped / 3600), minutes: Math.floor((capped % 3600) / 60) };
}

/**
 * Lossless serialization of hours/minutes pair to seconds.
 * Schema (Zod .max) is the single validation boundary. Returns null for blank/0h0m.
 */
export function hmToSeconds(hours: number, minutes: number): number | null {
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const h = Math.max(0, Math.trunc(hours));
  const m = Math.max(0, Math.trunc(minutes));
  if (h === 0 && m === 0) return null;
  return h * 3600 + m * 60;
}

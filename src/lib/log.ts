/**
 * Minimal structured error logging (audit-5 O3).
 *
 * The audit found that verify-503 → cron-flag → answer-409 surfaced across
 * three independent `console.error` sinks with no shared shape, so a single
 * incident could not be correlated. This module emits ONE JSON line on stderr
 * carrying the fields an operator needs to join the subsystems:
 *
 *   { level, msg, ts, ...context }
 *
 * There is deliberately NO metrics/pino/OTel dependency — the repo has none,
 * and adding one is out of scope. This is the smallest change that makes the
 * three subsystems log a correlate-able `{ sessionId, subsystem, errorCode }`.
 *
 * Usage:
 *   logError("verify.frame_fanout", err, { subsystem: "verification",
 *     errorCode: "insightface_unavailable", sessionId, trigger });
 *
 * The `err` argument accepts an Error, a PostgREST-shaped `{ message, code }`
 * object, or a string; it is normalized to a short `error`/`errorCode` pair so
 * a raw stack never dwarfs the structured fields (and no secret leaks).
 */

export type LogContext = Record<string, unknown> & {
  /** Cross-subsystem correlator: which subsystem emitted this. */
  subsystem?: "quiz-play" | "integrity" | "verification" | "seam";
  /** The typed error the route maps to an HTTP status (when known). */
  errorCode?: string;
  /** The session this concerns, when applicable. */
  sessionId?: string;
};

type ErrorLike = { message?: unknown; code?: unknown };

/** Normalize an unknown error to a short, non-leaking message string. */
function describeError(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "object") {
    const { message, code } = err as ErrorLike;
    if (typeof message === "string" && message.length > 0) {
      return typeof code === "string" && code.length > 0 ? `${message} (${code})` : message;
    }
  }
  return String(err);
}

/**
 * Emit a structured error line. Never throws: a logging failure must not sink
 * a request (the call sites are error paths already).
 */
export function logError(
  msg: string,
  err?: unknown,
  context: LogContext = {},
): void {
  try {
    const errorText = describeError(err);
    const line = JSON.stringify({
      level: "error",
      msg,
      ts: new Date().toISOString(),
      ...(errorText !== undefined ? { error: errorText } : {}),
      ...context,
    });
    console.error(line);
  } catch {
    // A circular context object or a hostile getter must not break the route.
    try {
      console.error(msg);
    } catch {
      /* nothing left to do */
    }
  }
}

/**
 * Sanitize a post-login redirect target to prevent open-redirect attacks.
 *
 * Only local (same-origin) paths are allowed. Rejects:
 *   - protocol-relative URLs (`//host`) and absolute URLs (`http://host`)
 *   - backslash variants (`/\evil.com`) that URL parsers may normalize to
 *     `https://evil.com/`
 *   - any value that doesn't start with a single `/`
 *
 * `baseOrigin` is the trusted origin (e.g. `window.location.origin` in the
 * browser, or the request origin server-side). Pass it explicitly so this
 * helper is testable in both environments.
 */
export function sanitizeRedirect(
  raw: string | null | undefined,
  baseOrigin: string,
): string {
  if (typeof raw !== "string" || raw.length === 0) return "/dashboard";
  if (raw.startsWith("//")) return "/dashboard";
  if (!raw.startsWith("/")) return "/dashboard";
  // Backslash is not a valid local-path separator; reject outright — including
  // percent-encoded forms (%5c / %5C) that a browser's URL parser may decode
  // into a backslash and then normalize into an external host.
  if (raw.includes("\\") || /%5c/i.test(raw)) return "/dashboard";
  // CR/LF (raw or percent-encoded) must never reach a Location header — they
  // enable response/header injection in the auth-callback redirect.
  if (/[\r\n]/.test(raw) || /%0d|%0a/i.test(raw)) return "/dashboard";

  try {
    const resolved = new URL(raw, baseOrigin);
    if (resolved.origin !== baseOrigin) return "/dashboard";
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return "/dashboard";
  }
}

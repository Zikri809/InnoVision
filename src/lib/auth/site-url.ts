/**
 * Authoritative origin for links the SERVER hands to GoTrue
 * (`redirectTo` / `emailRedirectTo` on reset/register/SSO).
 *
 * audit-2 H-02: those origins used to be assembled from the request's
 * `x-forwarded-host`/`host` headers. `requestReset({email: victim})` with a
 * forged Host header poisoned the recovery link's origin (account-takeover
 * phishing if GoTrue's redirect allowlist is permissive). Request headers are
 * attacker-writable on every unauthenticated route, so they must never decide
 * where an email link lands.
 *
 * Resolution order:
 *  1. `SITE_URL` (or `NEXT_PUBLIC_SITE_URL`) — authoritative when set.
 *  2. In NON-production only: request headers (localhost convenience —
 *     dev runs on arbitrary ports and rarely sets SITE_URL).
 *  3. Otherwise `null` → callers degrade to a RELATIVE redirect path, which
 *     GoTrue resolves against ITS OWN configured Site URL. That is the safe
 *     failure mode: a forged Host header can no longer steer the link.
 */
export function resolveSiteOrigin(
  headers?: { get(name: string): string | null },
): string | null {
  const raw = (
    process.env.SITE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    ""
  ).trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.origin;
      }
      console.error(
        "SITE_URL must be an absolute http(s) origin; ignoring value.",
      );
    } catch {
      console.error("SITE_URL is not a valid URL; ignoring value.");
    }
  }

  if (process.env.NODE_ENV !== "production" && headers) {
    try {
      const host = headers.get("x-forwarded-host") ?? headers.get("host");
      const proto = headers.get("x-forwarded-proto") ?? "http";
      if (host) return `${proto}://${host}`;
    } catch {
      // headers() throwing / unreadable outside a request scope — fall
      // through to the relative-path degradation (pre-audit-2 behavior).
    }
  }

  if (process.env.NODE_ENV === "production" && !raw) {
    // One-time-visible hint (per process) — link flows still work through
    // GoTrue's Site-URL resolution, but the operator should pin SITE_URL.
    console.warn(
      "SITE_URL is not set: password-reset/confirmation links fall back to " +
        "GoTrue's configured Site URL. Set SITE_URL to pin the origin.",
    );
  }
  return null;
}

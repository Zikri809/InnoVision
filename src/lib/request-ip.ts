/**
 * Best-effort client-IP derivation for rate-limit keys.
 *
 * audit-2 M-02: every unauthenticated budget used to key on the LEFTMOST
 * `x-forwarded-for` entry — the one the CLIENT writes. Rotating that header
 * per request silently defeated the signup/reset/SSO/matric throttles.
 *
 * The RIGHTMOST entry is the one appended by the trusted edge proxy (a client
 * can only prepend). Direct access (no proxy) yields no XFF at all, so
 * `x-real-ip` / "unknown" take over. This is spoof-resistant against header
 * rotation for the single-proxy topology this app documents (the check-env
 * parity sheet lists it); multi-proxy chains would need a
 * TRUSTED_PROXY_COUNT knob — noted in audit-2 §2.3 M-02 as follow-up ops
 * config, not needed for the classroom deployment shape.
 */
export function clientIpFromHeaders(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

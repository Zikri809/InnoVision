/**
 * Best-effort client-IP derivation for rate-limit keys.
 *
 * audit-2 M-02: every unauthenticated budget used to key on the LEFTMOST
 * `x-forwarded-for` entry — the one the CLIENT writes. Rotating that header
 * per request silently defeated the signup/reset/SSO/matric throttles.
 *
 * The RIGHTMOST entry is the one appended by the trusted edge proxy (a client
 * can only prepend). Direct access (no proxy) yields no XFF at all, so
 * `x-real-ip` / "unknown" take over.
 *
 * audit-3 A-F1/H-F4/H-F5: the topology decides whether that premise holds, and
 * the two documented postures disagree —
 *   P2 cloudflare tunnel (the deployed posture): the edge appends the client
 *      IP to XFF, so the rightmost entry is genuinely proxy-written and the
 *      attribution is correct. This is why the default is ONE trusted hop.
 *   P1 direct LAN/host (no proxy): every forwarding header is CLIENT-WRITTEN.
 *      `x-forwarded-for: <random>` then mints a fresh bucket per request
 *      (H-F5), while an honest browser sends no forwarding header at all, so
 *      every honest student collapses into ONE bucket (A-F1). Neither half is
 *      fixable from inside this function.
 *
 * `TRUSTED_PROXY_COUNT` makes the assumption explicit instead of implied:
 *   unset / 1 → one trusted hop (the tunnel default): the client IP is the
 *               rightmost XFF entry, stable against a client prepending junk.
 *   N > 1     → a multi-hop chain; take the entry N from the right.
 *   0         → no proxy is trusted: the key degrades to a single shared
 *               bucket. This DEFEATS header rotation entirely — the honest
 *               hardening for a direct-access deployment — at the cost of
 *               turning every per-IP budget into a global cap.
 *
 * The direct-access symptom (no forwarding headers at all) logs a one-time
 * warning naming the knob, because that is exactly the misconfiguration audit-3
 * A-F1 found silent: without it an operator's only evidence is students
 * reporting 429s from a budget that collapsed into a global cap.
 */

let badProxyCountWarned = false;

/**
 * Count of trusted proxy hops in front of this process (see the header).
 *
 * An UNPARSEABLE value falls back to 0 (the conservative posture), not 1: a
 * typo like `TRUSTED_PROXY_COUNT=0,` or `=zero` must not silently select the
 * PERMISSIVE setting while the operator believes rotation is defeated
 * (adversarial review). The bad value is warned once so the typo is visible.
 */
function trustedProxyCount(): number {
  const raw = process.env.TRUSTED_PROXY_COUNT;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    if (!badProxyCountWarned) {
      badProxyCountWarned = true;
      console.warn(
        `[request-ip] TRUSTED_PROXY_COUNT=${JSON.stringify(raw)} is not a non-negative integer; ` +
          "treating it as 0 (no trusted proxy). Per-IP budgets will share one bucket.",
      );
    }
    return 0;
  }
  return parsed;
}

let directAccessWarned = false;

/**
 * Warn once per process when NO forwarding headers are present, which means
 * this process is being reached directly rather than through a proxy. The
 * per-IP budgets are then degenerate (one shared bucket) and, worse, a client
 * that DOES send a forged header gets a bucket of its own choosing.
 */
function warnIfDirectAccess(h: Headers): void {
  if (directAccessWarned) return;
  if (h.get("x-forwarded-for") || h.get("x-real-ip")) return;
  directAccessWarned = true;
  console.warn(
    "[request-ip] No x-forwarded-for / x-real-ip on this request: this process looks like it " +
      "is being reached DIRECTLY (no proxy). Per-IP rate-limit budgets then share one bucket, " +
      "and a client that forges a forwarding header can mint its own. Set TRUSTED_PROXY_COUNT=0 " +
      "to make that explicit (shared bucket, rotation defeated) or place the app behind the " +
      "documented proxy and set it to the hop count (audit-3 A-F1/H-F4/H-F5).",
  );
}

export function clientIpFromHeaders(h: Headers): string {
  const trusted = trustedProxyCount();

  if (trusted === 0) {
    // Deliberately untrusted (or a direct-access deployment): a single shared
    // bucket is the honest key — it cannot be rotated away by a lying client,
    // which is the property the budgets actually need.
    return "direct";
  }

  const xff = h.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // The client IP is `trusted` hops from the right: the last entry was
    // appended by our immediately-facing proxy, the one before it by the hop
    // behind that, and so on.
    const candidate = parts[parts.length - trusted];
    if (candidate) return candidate;
  } else {
    warnIfDirectAccess(h);
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

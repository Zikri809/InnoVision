/**
 * AU-2 — Microsoft institutional SSO trust boundary (pure, Node-testable).
 *
 * Two-layer trust: the Supabase Azure provider is configured tenant-specific
 * (dashboard-side) so personal accounts never reach the consent screen; this
 * module is the SECOND layer — a post-callback email-domain allowlist that
 * must reject personal Microsoft addresses (@outlook.com, @hotmail.com, …)
 * even though they authenticate fine against the same flow.
 *
 * Domain semantics (pinned at pre-flight): CASE-INSENSITIVE EXACT match on
 * the email's domain — no wildcard subdomains (a university lists every real
 * domain it owns; student subdomain addresses are not admitted by accident).
 * Missing/unparseable email → reject (never admit an unknown identity).
 */

const INSTITUTIONAL_DOMAINS_ENV = "INSTITUTIONAL_EMAIL_DOMAINS";

/**
 * Read the allowlist from the environment (comma-separated). Empty/missing →
 * [] — SSO is DISABLED when no domains are configured (the login button only
 * renders when the list is non-empty; the callback rejects everything).
 * Pure over its input; env read at call time for testability.
 */
export function institutionalDomains(envValue?: string): string[] {
  const raw = envValue ?? process.env[INSTITUTIONAL_DOMAINS_ENV] ?? "";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

/**
 * True when the app has SSO configured at all (drives the login button's
 * visibility server-side via a layout prop).
 */
export function isSsoConfigured(): boolean {
  return institutionalDomains().length > 0;
}

export type InstitutionalEmailVerdict =
  | { ok: true; domain: string }
  | { ok: false; reason: "no_email" | "not_allowed" };

/**
 * Allowlist verdict for a callback identity's email. Case-insensitive exact
 * suffix after the LAST @ (the local part may contain @ only in quoted local
 * parts — practically unreachable here; last-@ is the safe split).
 */
export function isAllowedInstitutionalEmail(
  email: string | null | undefined,
  allowedDomains: string[],
): InstitutionalEmailVerdict {
  if (!email || !email.includes("@") || allowedDomains.length === 0) {
    return { ok: false, reason: "no_email" };
  }
  const domain = email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase();
  if (domain.length === 0) return { ok: false, reason: "no_email" };
  if (allowedDomains.includes(domain)) return { ok: true, domain };
  return { ok: false, reason: "not_allowed" };
}

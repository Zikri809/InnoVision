import { Suspense } from "react";
import { isSsoConfigured } from "@/lib/auth/institutional";
import { LoginForm, LoginFallback } from "./login-form";

/**
 * Login entry (server component).
 *
 * AU-2: the SSO button renders ONLY when the institutional domain allowlist
 * is configured — absent env = absent affordance (and a clean E2E seam). The
 * flag is read HERE, server-side, and passed down as a boolean so the
 * allowlist value itself is never inlined into the client bundle.
 *
 * force-dynamic: the flag is RUNTIME server env (read per request), so a
 * statically prerendered page would bake the build-time answer — the e2e
 * harness's second app instance (chromium-sso project) sets
 * INSTITUTIONAL_EMAIL_DOMAINS at runtime and must see the button.
 */
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const ssoConfigured = isSsoConfigured();
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm ssoConfigured={ssoConfigured} />
    </Suspense>
  );
}

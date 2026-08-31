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
 */
export default function LoginPage() {
  const ssoConfigured = isSsoConfigured();
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm ssoConfigured={ssoConfigured} />
    </Suspense>
  );
}

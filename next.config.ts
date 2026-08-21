import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Security headers applied to every response.
 *
 * CSP ships in Report-Only mode first: the app loads WASM/WASM-workers
 * (MediaPipe), blob: media streams (camera), and calls user-configured AI/OCR
 * endpoints (AI_BASE_URL / GLM_BASE_URL) whose origins are not known at build
 * time, so a wrong policy would silently break the exam-critical vision stack.
 * Watch the console for violation reports in staging; once clean, rename the
 * header to `Content-Security-Policy` to enforce. The connect-src list below
 * covers Supabase + localhost dev servers; add your production origins there.
 * The enforced headers close clickjacking, MIME-sniffing, and referrer leaks.
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  // AI/OCR endpoints are user-configured at runtime — keep https: open until
  // the deployment target is fixed, then pin exact origins.
  "connect-src 'self' blob: data: https://*.supabase.co wss://*.supabase.co http://localhost:* ws://localhost:* https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy-Report-Only",
    value: CSP_REPORT_ONLY,
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), payment=()",
  },
  // Only meaningful over HTTPS; harmless on localhost.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default withNextIntl(nextConfig);

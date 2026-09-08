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
  // exceljs is a heavy CJS Node module used only inside the export route —
  // keep it out of the bundler (runtime require, no client impact).
  serverExternalPackages: ["exceljs"],
  // Same-origin proxy to the local Supabase Kong gateway. The client bundle
  // bakes NEXT_PUBLIC_SUPABASE_URL (127.0.0.1:58021 here), which a REMOTE
  // browser would resolve to its own machine — so supabase/client.ts re-points
  // loopback URLs at this /sb prefix instead. Same-origin also means cookies
  // flow and CORS never applies. Note: HTTP routes proxy fine; the realtime
  // WebSocket does NOT upgrade through Next — use-notifications treats
  // postgres_changes as a latency accelerator (polling is the backbone), so
  // remote clients just fall back to the 20s poll cadence.
  async rewrites() {
    const LOCAL_SUPABASE = "http://127.0.0.1:58021";
    return [
      { source: "/sb/rest/v1/:path*", destination: `${LOCAL_SUPABASE}/rest/v1/:path*` },
      { source: "/sb/auth/v1/:path*", destination: `${LOCAL_SUPABASE}/auth/v1/:path*` },
      { source: "/sb/realtime/v1/:path*", destination: `${LOCAL_SUPABASE}/realtime/v1/:path*` },
      { source: "/sb/storage/v1/:path*", destination: `${LOCAL_SUPABASE}/storage/v1/:path*` },
    ];
  },
  // Cloudflare tunnel (innovision.zikr-i.uk): Next's server-action CSRF check
  // compares the browser Origin against Host/X-Forwarded-Host — behind the
  // tunnel they differ, and a mismatched action is silently aborted (the login
  // form appears to just reset). Allowlist the tunnel host for actions; dev
  // also needs allowedDevOrigins so /_next/* assets + HMR socket aren't 403'd.
  allowedDevOrigins: ["innovision.zikr-i.uk"],
  experimental: {
    serverActions: {
      allowedOrigins: ["innovision.zikr-i.uk"],
    },
    optimizePackageImports: [
      "lucide-react",
      "@remixicon/react",
      "sonner",
      "clsx",
      "tailwind-merge",
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default withNextIntl(nextConfig);

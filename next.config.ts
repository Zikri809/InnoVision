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
  // audit-3 R3-INT-F2: `cdn.jsdelivr.net` is REQUIRED here by the DEFAULT OCR
  // engine. `src/lib/extract/tesseract.ts` calls `Tesseract.createWorker()`
  // without workerPath/corePath, so tesseract.js v7 falls back to its CDN
  // defaults: the worker is `importScripts`-ed from jsdelivr and the WASM core
  // is dynamically imported from it. Both are governed by `script-src` (a blob
  // worker is allowed by worker-src, but the script it loads is not), so
  // enforcing the previous policy would have blocked OCR for every page in
  // every deployment. The traineddata FETCH is unaffected — `connect-src`
  // below already ends in a blanket `https:`.
  //
  // This is the deliberate trade-off between the two available remedies:
  // allowing the origin the code ALREADY loads (no security change from
  // today's no-CSP behaviour, and it unblocks enforcement) versus vendoring
  // the worker/core/traineddata under /public like the MediaPipe assets, which
  // would let this origin be removed. Vendoring is the stronger fix and the
  // documented follow-up; it was not taken here because it adds ~18 MB of WASM
  // variants plus a vendor script and a CI hash step. If you vendor them, DROP
  // this origin and re-point tesseract.ts at the local paths.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
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
    // audit-3 R3-INT-F1: `microphone=()` is an EMPTY allowlist — it blocks
    // same-origin too, so the integrity suite's own `getUserMedia({audio:true})`
    // (src/components/face/use-integrity-advisories.ts) always failed with
    // NotAllowedError, killing the voice_activity + headset_active advisories
    // and the incident-clip audio track in every deployment. The only mic
    // consumers are same-origin, so `(self)` is the correct allowlist.
    value: "camera=(self), microphone=(self), geolocation=(), payment=()",
  },
  // Only meaningful over HTTPS; harmless on localhost.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

/**
 * Hostnames allowed to differ from the request Host for server actions and
 * dev-only /_next/* + HMR fetches.
 *
 * audit-3 H-F8 / R2-TOP-F1: these used to be the hardcoded tunnel host
 * `innovision.zikr-i.uk`, so a staging or second-institution deploy silently
 * aborted every server action (the login form appears to just reset) with no
 * env remedy. They are now DERIVED from deployment env:
 *   - `TRUSTED_ORIGINS`      — comma-separated, scheme-included origins (the
 *                              same var `checkSameOrigin` in src/lib/http.ts
 *                              reads, so actions and route handlers agree).
 *   - `NEXT_PUBLIC_SITE_URL` / `SITE_URL` — the deployment's public origin.
 *   - `ALLOWED_HOSTS`        — the name the VPS operator docs use
 *                              (docs/DEPLOY_VPS.md, .env.local.example) and the
 *                              name the app Dockerfile/compose expose as a build
 *                              arg. It is an ALIAS for `ALLOWED_ORIGINS`; both
 *                              are read below. Before this alias existed the
 *                              documented arg was a silent no-op — an operator
 *                              following the runbook set ALLOWED_HOSTS, nothing
 *                              read it, and the origin only worked because the
 *                              same block also set NEXT_PUBLIC_SITE_URL/SITE_URL.
 *   - `ALLOWED_ORIGINS`      — extra comma-separated hostnames (wildcards OK,
 *                              e.g. `*.example.edu`). The pre-existing name.
 * The tunnel host stays as the DEFAULT so the current deployment keeps
 * working with zero config. Set the env vars above for any other deployment.
 */
const DEFAULT_ALLOWED_HOSTS = ["innovision.zikr-i.uk"];

function hostnamesFrom(...values: (string | undefined)[]): string[] {
  const hosts: string[] = [];
  for (const value of values) {
    for (const entry of (value ?? "").split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      try {
        // Entries are scheme-included origins; bare hostnames (incl. the
        // `*.example.edu` wildcard form Next accepts) pass through as-is.
        const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
        hosts.push(url.host.toLowerCase());
      } catch {
        // Malformed entry — skip rather than break the build.
      }
    }
  }
  return hosts;
}

const ALLOWED_HOSTS = [
  ...new Set([
    ...DEFAULT_ALLOWED_HOSTS,
    ...hostnamesFrom(
      // ALLOWED_HOSTS is the operator-facing name (docs + Dockerfile build
      // arg); ALLOWED_ORIGINS is the original one. Both are honoured so a
      // runbook that sets either is not a silent no-op.
      process.env.ALLOWED_HOSTS,
      process.env.ALLOWED_ORIGINS,
      process.env.TRUSTED_ORIGINS,
      process.env.NEXT_PUBLIC_SITE_URL,
      process.env.SITE_URL,
    ),
  ]),
];

/**
 * BUILD-time Supabase target — is the baked public URL a HOSTED project?
 *
 * Read at module scope, exactly like `ALLOWED_HOSTS` above: this is build-time
 * input, not runtime config (see the `/sb` gate in `rewrites()` below).
 *
 * Fail-closed by DIRECTION: an absent, malformed, or unrecognised value is
 * treated as NOT hosted, which keeps the four local-Kong rules. That is the
 * safe branch — a LOCAL build that lost its rules breaks every browser-direct
 * Supabase call (`src/lib/supabase/client.ts` re-points loopback URLs at `/sb`),
 * whereas a HOSTED build that keeps them merely carries dead routes the hosted
 * browser never requests (`client.ts` passes a hosted URL through unchanged).
 * Only a positive match on a real hosted project hostname returns `[]`.
 */
const SUPABASE_IS_HOSTED = (() => {
  const raw = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    // Hosted projects live on `<project-ref>.supabase.co`; Supabase's India
    // region mirrors that on `.supabase.in`. A self-hosted / dedicated
    // deployment on its own domain does NOT match and keeps the local rules.
    return /^[a-z0-9-]+\.supabase\.(co|in)$/i.test(url.hostname);
  } catch {
    return false;
  }
})();

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Self-contained server bundle for the app container (plan B3.1 / gate O1):
  // `.next/standalone` carries the traced node_modules + server.js. It does
  // NOT copy `public/` or `.next/static` — the Dockerfile copies both
  // explicitly (standalone does not auto-copy either).
  output: "standalone",
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
  //
  // ── GATED ON THE BUILD-TIME NEXT_PUBLIC_SUPABASE_URL (plan B1.7) ──
  // The rules below hardcode the LOCAL Kong gateway (127.0.0.1:58021) and are
  // WRONG for a hosted project. They are gated, not deleted, because they are
  // still the correct rules for every local/self-hosted build.
  //
  // MENTAL-MODEL CORRECTION — the plan insists on this:
  //   `rewrites()` is evaluated ONCE, at BUILD time, by Next's
  //   `loadCustomRoutes`; the result is frozen into `.next/routes-manifest.json`
  //   and served verbatim by `next start`. `next start` NEVER re-invokes this
  //   function, and neither does a runtime env change. So the hosted flip is a
  //   **BUILD-ARG flip, not an env flip**: setting NEXT_PUBLIC_SUPABASE_URL in
  //   the container's runtime environment changes nothing about these routes —
  //   the image must be REBUILT with the value as a build arg. (Contrast
  //   `next dev`, which re-evaluates per request — a green `next dev` dry run
  //   against hosted Supabase therefore does NOT prove the prod image.)
  //   This is the same build-time family as ALLOWED_HOSTS above.
  //
  // Why gate at all, when hosted browsers never hit /sb (`client.ts` returns a
  // hosted URL unchanged)? Because the stale 127.0.0.1:58021 destination would
  // otherwise stay live dead code in the shipped image — an unauthenticated
  // same-origin proxy surface pointing at a host that does not exist on the
  // VPS. Gate it explicitly; do not rely on disuse.
  async rewrites() {
    if (SUPABASE_IS_HOSTED) {
      // Hosted Supabase: browser-direct HTTPS to <ref>.supabase.co, no proxy.
      return [];
    }
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
  // audit-3 H-F8: derived from env (see ALLOWED_HOSTS above) — the tunnel host
  // is only the default, never the sole hardcoded deployment.
  allowedDevOrigins: ALLOWED_HOSTS,
  experimental: {
    serverActions: {
      allowedOrigins: ALLOWED_HOSTS,
    },
    // The same-origin /sb proxy carries browser uploads (quiz source PDFs —
    // 25 MB per file, 50 MB total per the client-side caps). Next's dev proxy
    // clones request bodies with a 10 MiB default cap and TRUNCATES anything
    // larger; the truncated stream then stalls until the dev proxy's 30s
    // proxyTimeout aborts it as a 500. Raise both above the app's upload
    // ceiling (production next start does not apply the clone path).
    proxyClientMaxBodySize: 55 * 1024 * 1024,
    proxyTimeout: 120_000,
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

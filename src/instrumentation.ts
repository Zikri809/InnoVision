/**
 * Next.js instrumentation (H3-INFRA-F8, R2-FACE-F2 companion).
 *
 * `onRequestError` fires for every UNHANDLED server-side error in the App
 * Router (route handlers, server components, server actions). Without it a
 * 500 is invisible unless the platform captures stderr — this repo has no
 * error-tracking vendor, so a structured stderr line is the only signal.
 *
 * Deliberately dependency-free: `console.error` with a JSON payload so a
 * log-shipper (or `docker logs | jq`) can parse it without a vendor SDK.
 * No request headers or bodies are logged — the digest + path + method are
 * enough to correlate, and headers can carry cookies/tokens.
 *
 * Next 16 loads this file automatically from the project root (stable since
 * Next 15; no `experimental.instrumentationHook` flag needed).
 *
 * `register()` (S1/S5 — plan §10.2) is Next's once-per-server-start hook. It
 * runs the production env gate, which THROWS under `NODE_ENV=production` +
 * `PROD_ENV_STRICT=1` when a kill switch is armed or a gated token is empty.
 * Outside strict mode the gate only warns (once). The e2e harness runs a
 * production build with the kill switches deliberately ON and does not set
 * `PROD_ENV_STRICT`, so it is unaffected — see the prod-guards header.
 */

import { assertProdEnvSafe } from "@/lib/prod-guards";

type RequestErrorContext = {
  routerKind: "Pages Router" | "App Router";
  routePath: string;
  routeType: "render" | "route" | "action" | "proxy";
  renderSource?: "react-server-components" | "react-server-components-payload" | "server-rendering";
  revalidateReason: "on-demand" | "stale" | undefined;
};

/**
 * Runs once per server start (both `next dev` and `next start`; skipped during
 * `next build` by Next itself).
 *
 * **Why this EXITS the process and not just re-throws (measured, not assumed).**
 * Next awaits `register()` from `prepare()`, so the contract's "try/catch that
 * re-throws" was assumed to abort `next start`. It does not: Next catches the
 * rejection, logs `Failed to prepare server`, and **keeps the HTTP listener
 * bound** — a `next start` with the strict gate armed and
 * `E2E_RATE_LIMIT_DISABLED=1` stays alive and answers `500 Internal Server
 * Error` to EVERY request (verified against this build). That is not a hard
 * fail; it is a zombie that looks up to a naive liveness check while serving
 * nothing, and it is strictly worse than the warn it replaced. So the catch
 * logs, then `process.exit(1)` — the process dies, the orchestrator restarts
 * or gives up, and no request is ever served from a misconfigured stack. This
 * is the S5 "hard-fail `next start`" requirement actually met.
 *
 * The rethrow after the exit is unreachable at runtime (and the process is
 * gone), but it is kept deliberately: it preserves the contract's shape, and it
 * is the only protection if `process.exit` is ever stubbed (tests) or
 * intercepted. `process.exit` runs ONLY on the strict path — a non-strict start
 * (the e2e harness) never reaches this catch.
 */
export async function register(): Promise<void> {
  try {
    assertProdEnvSafe();
  } catch (err) {
    console.error(
      "[instrumentation] production env gate REFUSED to start this server (S1/S5). " +
        "Exiting instead of serving requests from a misconfigured stack.",
    );
    // A startup gate is the one place an immediate exit is correct: nothing is
    // in flight, and the alternative (see the doc comment) is a process that
    // answers 500 to every request.
    process.exit(1);
    throw err;
  }
}

export async function onRequestError(
  error: unknown,
  request: Readonly<{ path: string; method: string; headers: Record<string, string | string[] | undefined> }>,
  context: Readonly<RequestErrorContext>,
): Promise<void> {
  const err = error as { message?: unknown; digest?: unknown; stack?: unknown };
  console.error(
    JSON.stringify({
      level: "error",
      scope: "onRequestError",
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind,
      // `digest` is Next's stable per-error id (also surfaced to the client in
      // production, where the message is redacted) — the correlation key.
      digest: typeof err?.digest === "string" ? err.digest : undefined,
      message: typeof err?.message === "string" ? err.message : String(error),
      stack: typeof err?.stack === "string" ? err.stack : undefined,
    }),
  );
}

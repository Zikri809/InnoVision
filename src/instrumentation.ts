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
 */

type RequestErrorContext = {
  routerKind: "Pages Router" | "App Router";
  routePath: string;
  routeType: "render" | "route" | "action" | "proxy";
  renderSource?: "react-server-components" | "react-server-components-payload" | "server-rendering";
  revalidateReason: "on-demand" | "stale" | undefined;
};

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

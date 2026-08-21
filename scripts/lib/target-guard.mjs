/**
 * Safety guard for scripts holding the service-role key: they mutate whatever
 * project `.env.local` points at, so refuse remote/production URLs unless
 * explicitly overridden with ALLOW_PROD_SEED=1.
 */
export function assertLocalTarget(url, scriptName) {
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  if (isLocal || process.env.ALLOW_PROD_SEED === "1") return;
  console.error(
    `\n⚠️ SAFETY GUARD: Target Supabase URL (${url}) appears to be a remote/production environment.` +
      `\nThis script runs with the SERVICE ROLE key — targeting prod is blocked by default.` +
      `\nIf you really meant this project, re-run with: ALLOW_PROD_SEED=1 node scripts/${scriptName}\n`,
  );
  process.exit(1);
}

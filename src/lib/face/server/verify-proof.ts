import { createHash, createHmac } from "node:crypto";

/**
 * Route-minted verify proof (audit-1 P0-1 — see migration 0045 §2/§9c).
 *
 * The verify route computes
 *
 *   HMAC-SHA256(secret, sessionId || ':' || nonce || ':' || frameConcat)
 *
 * over the EXACT frame byte strings it forwards to `record_face_check`
 * (frameConcat = frames joined with '|', byte-identical to the SQL
 * `v_concat` the RPC rebuilds). Direct PostgREST callers cannot obtain a
 * proof — the secret lives in the non-exposed `app_private` schema and is
 * only readable by `service_role` through `get_verify_proof_secret()` — so
 * a forged `p_similarities` array dies at the RPC's proof gate no matter
 * what values it carries.
 *
 * The similarities themselves are deliberately NOT bound into the proof:
 * a valid proof for (session, nonce, frames) can only originate from this
 * route process, which computed them from the sidecar compare. Binding the
 * float values would require a TS↔Postgres float4 text-format contract for
 * no additional property.
 *
 * SERVER-ONLY (node:crypto). The digest comparison inside the RPC is
 * double-HMAC masked, so this module only needs to produce the hex string.
 */

export const VERIFY_PROOF_UNAVAILABLE = "proof_secret_unavailable";

/** Byte-identical rebuild of the SQL `v_concat` in record_face_check. */
export function frameConcat(frames: string[]): string {
  return frames.map((f) => f ?? "").reduce((acc, f) => `${acc}|${f}`, "");
}

/** SHA-256 hex of the frame concat — the RPC's `v_frame_hash` twin. */
export function frameHash(frames: string[]): string {
  return createHash("sha256").update(frameConcat(frames), "utf8").digest("hex");
}

/** The exact message the RPC HMACs. Exposed for tests. */
export function proofMessage(sessionId: string, nonce: string, frames: string[]): string {
  return `${sessionId}:${nonce}:${frameConcat(frames)}`;
}

/** Mint the p_proof value for record_face_check. */
export function mintVerifyProof(
  secret: string,
  sessionId: string,
  nonce: string,
  frames: string[],
): string {
  return createHmac("sha256", secret)
    .update(proofMessage(sessionId, nonce, frames), "utf8")
    .digest("hex");
}

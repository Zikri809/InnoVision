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
  return `${sessionId.toLowerCase()}:${nonce.toLowerCase()}:${frameConcat(frames)}`;
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

/** Canonical, length-prefixed answer encoding shared with the SQL RPC. */
export function canonicalAnswer(
  answer: {
    questionId: string;
    selectedIndex?: number;
    selectedIndices?: number[];
    answerText?: string;
    skipped?: boolean;
  },
): string {
  const part = (value: string | null) =>
    value === null ? "-:" : `${Buffer.byteLength(value, "utf8")}:${value}`;
  return [
    part(answer.questionId.toLowerCase()),
    part(answer.selectedIndex === undefined ? null : String(answer.selectedIndex)),
    part(answer.selectedIndices === undefined ? null : [...new Set(answer.selectedIndices)].sort((a, b) => a - b).join(",")),
    part(answer.answerText ?? null),
    // The RPC contract defaults omitted p_skipped to false; bind that same
    // value whether the browser omitted it or sent false explicitly.
    part(String(answer.skipped ?? false)),
  ].join("");
}

/** Proof binding the fresh frame set to this exact question and answer. */
export function mintAnswerProof(
  secret: string,
  sessionId: string,
  nonce: string,
  frames: string[],
  answer: Parameters<typeof canonicalAnswer>[0],
): string {
  const frameDigest = frameHash(frames);
  return createHmac("sha256", secret)
    .update(`answer:${sessionId.toLowerCase()}:${nonce.toLowerCase()}:${frameDigest}:${canonicalAnswer(answer)}`, "utf8")
    .digest("hex");
}

import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { frameConcat, frameHash, mintVerifyProof, proofMessage } from "./verify-proof";

// The byte contract these tests pin is migration 0045 §9c: the RPC rebuilds
// v_concat = '' || '|f1' || '|f2' … (coalescing NULLs to '') and verifies
// HMAC-SHA256(secret, session:nonce:v_concat). A drift on either side fails
// every honest verify, so the concat shape is pinned exactly.

describe("frameConcat (SQL v_concat twin)", () => {
  it("prefixes each frame with '|' exactly like the SQL accumulator", () => {
    expect(frameConcat(["a", "b", "c"])).toBe("|a|b|c");
    expect(frameConcat(["a"])).toBe("|a");
  });

  it("coalesces null/undefined frames to the empty string (SQL coalesce)", () => {
    expect(frameConcat(["a", null as unknown as string, "c"])).toBe("|a||c");
    expect(frameConcat([])).toBe("");
  });
});

describe("frameHash (SQL v_frame_hash twin)", () => {
  it("is the sha256 hex of the concat", () => {
    expect(frameHash(["x", "y"])).toBe(createHash("sha256").update("|x|y", "utf8").digest("hex"));
  });
});

describe("mintVerifyProof", () => {
  const secret = "unit-secret";
  const session = "00000000-0000-4000-8000-0000000000aa";
  const nonce = "11111111-1111-4111-8111-111111111111";

  it("is deterministic for identical inputs", () => {
    expect(mintVerifyProof(secret, session, nonce, ["f1", "f2"]))
      .toBe(mintVerifyProof(secret, session, nonce, ["f1", "f2"]));
  });

  it("binds the session, the nonce AND the frame bytes", () => {
    const base = mintVerifyProof(secret, session, nonce, ["f1"]);
    expect(mintVerifyProof(secret, session, nonce, ["f2"])).not.toBe(base);
    expect(mintVerifyProof(secret, session, "22222222-2222-4222-8222-222222222222", ["f1"])).not.toBe(base);
    expect(mintVerifyProof(secret, "00000000-0000-4000-8000-0000000000bb", nonce, ["f1"])).not.toBe(base);
    expect(mintVerifyProof("other-secret", session, nonce, ["f1"])).not.toBe(base);
  });

  it("HMACs exactly the session:nonce:concat message", () => {
    const expected = createHmac("sha256", secret)
      .update(proofMessage(session, nonce, ["f1", "f2"]), "utf8")
      .digest("hex");
    expect(mintVerifyProof(secret, session, nonce, ["f1", "f2"])).toBe(expected);
    expect(proofMessage(session, nonce, ["f1", "f2"])).toBe(`${session}:${nonce}:|f1|f2`);
  });
});

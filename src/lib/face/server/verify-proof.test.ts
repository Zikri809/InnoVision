import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { canonicalAnswer, frameConcat, frameHash, mintAnswerProof, mintVerifyProof, proofMessage } from "./verify-proof";

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
    expect(mintVerifyProof(secret, session.toUpperCase(), nonce.toUpperCase(), ["f1", "f2"]))
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

describe("answer-bound face proof", () => {
  const secret = "answer-secret";
  const session = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const nonce = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
  const frames = ["front-🙂", "left-frame", "right-frame"];
  const answer = { questionId: "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC", selectedIndices: [2, 1, 2] };

  it("uses stable UTF-8 length prefixes and canonical sorted unique multi-selection", () => {
    expect(canonicalAnswer(answer)).toBe("36:cccccccc-cccc-4ccc-8ccc-cccccccccccc-:3:1,2-:5:false");
    expect(canonicalAnswer({ questionId: answer.questionId, answerText: "café🙂" }))
      .toBe("36:cccccccc-cccc-4ccc-8ccc-cccccccccccc-:-:9:café🙂5:false");
    expect(canonicalAnswer({ questionId: answer.questionId }))
      .toBe(canonicalAnswer({ questionId: answer.questionId, skipped: false }));
  });

  it("normalizes UUID case and binds the frames, question, and answer shape", () => {
    const proof = mintAnswerProof(secret, session, nonce, frames, answer);
    expect(mintAnswerProof(secret.toUpperCase(), session.toLowerCase(), nonce.toLowerCase(), frames, answer)).not.toBe(proof);
    expect(mintAnswerProof(secret, session.toLowerCase(), nonce.toLowerCase(), frames, answer)).toBe(proof);
    expect(mintAnswerProof(secret, session, nonce, ["changed", ...frames.slice(1)], answer)).not.toBe(proof);
    expect(mintAnswerProof(secret, session, nonce, frames, { ...answer, questionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })).not.toBe(proof);
    expect(mintAnswerProof(secret, session, nonce, frames, { ...answer, selectedIndices: [1, 2] })).toBe(proof);
  });
});

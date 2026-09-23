import { describe, it, expect, vi, afterEach } from "vitest";
import { logError } from "@/lib/log";

/** Capture the single console.error line logError emits. */
function capture(fn: () => void): { calls: unknown[][]; parsed: Record<string, unknown> } {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  fn();
  const calls = spy.mock.calls as unknown[][];
  spy.mockRestore();
  const first = calls[0]?.[0];
  let parsed: Record<string, unknown> = {};
  if (typeof first === "string") {
    try {
      parsed = JSON.parse(first);
    } catch {
      parsed = { raw: first };
    }
  }
  return { calls, parsed };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logError (audit-5 O3)", () => {
  it("emits ONE JSON line carrying level/msg/ts and the correlation fields", () => {
    const { calls, parsed } = capture(() =>
      logError("verify.frame_fanout", new Error("sidecar down"), {
        subsystem: "verification",
        errorCode: "insightface_unavailable",
        sessionId: "s-1",
      }),
    );
    expect(calls).toHaveLength(1);
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("verify.frame_fanout");
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.error).toBe("sidecar down");
    expect(parsed.subsystem).toBe("verification");
    expect(parsed.errorCode).toBe("insightface_unavailable");
    expect(parsed.sessionId).toBe("s-1");
  });

  it("normalizes a PostgREST-shaped { message, code } error", () => {
    const { parsed } = capture(() =>
      logError("answer.error", { message: "duplicate key", code: "23505" }, {
        subsystem: "quiz-play",
      }),
    );
    expect(parsed.error).toBe("duplicate key (23505)");
  });

  it("accepts a plain string error", () => {
    const { parsed } = capture(() => logError("x.y", "boom"));
    expect(parsed.error).toBe("boom");
  });

  it("omits `error` when none was supplied", () => {
    const { parsed } = capture(() => logError("x.y", undefined, { subsystem: "seam" }));
    expect("error" in parsed).toBe(false);
    expect(parsed.subsystem).toBe("seam");
  });

  it("never throws on a circular context (falls back to the bare message)", () => {
    const circ: Record<string, unknown> = { subsystem: "integrity" };
    circ.self = circ;
    const { calls } = capture(() => logError("cyclic", new Error("e"), circ));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("cyclic");
  });

  it("handles a non-Error object with no message", () => {
    const { parsed } = capture(() => logError("x.y", { code: 42 }));
    expect(parsed.error).toBe("[object Object]");
  });
});

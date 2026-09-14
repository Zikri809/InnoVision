import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  extractFace,
  health,
  uidMockEmbedding,
  isMockModeEnabled,
  isMockMatchFrame,
  isMockMismatchFrame,
  MOCK_MATCH_MARKER,
  MOCK_MISMATCH_MARKER,
} from "./insightface-client";
import { EMBEDDING_DIMS } from "@/lib/face/embedding";

/**
 * audit-1 §5.4: the ONLY unmocked boundary test for the InsightFace client.
 *
 * The route tests vi.mock this module (they'd otherwise need Docker), which
 * means the real client's I/O contract — URL wiring, the token header, the
 * typed error mapping, the per-face validation/normalization — was
 * unmeasured anywhere in CI. This test stands up a local HTTP server as the
 * sidecar and exercises the REAL module against it. No Docker, no network.
 */

let server: http.Server;
let baseUrl = "";
let lastHeaders: Record<string, string | string[] | undefined> = {};
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

function makeFace(overrides: Record<string, unknown> = {}) {
  return {
    embedding: Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i % 7) / 7),
    yaw: 3,
    pitch: 1,
    roll: 0,
    det_score: 0.97,
    bbox: [10, 20, 300, 400],
    ...overrides,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  process.env.INSIGHTFACE_BASE_URL = baseUrl;
  delete process.env.FACE_SIDECAR_TOKEN;
  // Mock mode must be OFF for this boundary test (both flags unset).
  delete process.env.FACE_MOCK_ENABLED;
  delete process.env.NEXT_PUBLIC_E2E_FAKE_SEAM;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.INSIGHTFACE_BASE_URL;
});

describe("insightface-client — real boundary (audit-1 §5.4)", () => {
  it("extractFace posts the frame to ${BASE_URL}/extract and parses a valid face", async () => {
    handler = (req, res) => {
      expect(req.url).toBe("/extract");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ faces: [makeFace()] }));
    };
    const r = await extractFace("data:image/jpeg;base64,AAAA", "uid-1");
    if ("error" in r) throw new Error(`expected a parsed result, got ${JSON.stringify(r)}`);
    expect(r.faces).toHaveLength(1);
    expect(r.faces[0].embedding).toHaveLength(EMBEDDING_DIMS);
    expect(r.faces[0].det_score).toBeCloseTo(0.97);
    expect(r.faces[0].bbox).toEqual([10, 20, 300, 400]);
  });

  it("carries FACE_SIDECAR_TOKEN as x-sidecar-token when set", async () => {
    process.env.FACE_SIDECAR_TOKEN = "boundary-token";
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ faces: [] }));
    };
    await extractFace("frame", "uid-1");
    expect(lastHeaders["x-sidecar-token"]).toBe("boundary-token");
    delete process.env.FACE_SIDECAR_TOKEN;
  });

  it("drops faces with a wrong-dimension embedding or malformed bbox", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          faces: [
            makeFace({ embedding: [1, 2, 3] }), // wrong dims → dropped
            makeFace({ bbox: [1, 2] }), // malformed bbox → dropped
            makeFace(), // valid → kept
          ],
        }),
      );
    };
    const r = await extractFace("frame", "uid-1");
    if ("error" in r) throw new Error("expected a parsed result");
    expect(r.faces).toHaveLength(1);
  });

  it("422/400 → typed invalid_frame (client-side frame problem)", async () => {
    handler = (_req, res) => {
      res.statusCode = 422;
      res.end("no");
    };
    expect(await extractFace("frame", "uid-1")).toEqual({ error: "invalid_frame" });
  });

  it("non-2xx → typed insightface_error (never the upstream body)", async () => {
    handler = (_req, res) => {
      res.statusCode = 500;
      res.end("stack trace with secrets");
    };
    expect(await extractFace("frame", "uid-1")).toEqual({ error: "insightface_error" });
  });

  it("connection refused → typed insightface_unavailable", async () => {
    // Point at a port with no listener (still inside this process' env).
    process.env.INSIGHTFACE_BASE_URL = "http://127.0.0.1:1";
    try {
      expect(await extractFace("frame", "uid-1")).toEqual({ error: "insightface_unavailable" });
    } finally {
      process.env.INSIGHTFACE_BASE_URL = baseUrl;
    }
  });

  it("a hung sidecar hits the 5s abort → insightface_unavailable (never a hang)", { timeout: 10_000 }, async () => {
    handler = (_req, res) => {
      // Never respond and never end — the client's AbortSignal.timeout(5000)
      // must convert the hang into a typed unavailable (503 upstream).
      void _req;
    };
    const started = Date.now();
    const r = await extractFace("frame", "uid-1");
    expect(r).toEqual({ error: "insightface_unavailable" });
    expect(Date.now() - started).toBeLessThan(7000);
  });

  it("health(): {status:'ok'} → true; anything else → false", async () => {
    handler = (_req, res) => {
      expect(_req.url).toBe("/health");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
    };
    expect(await health()).toBe(true);

    handler = (_req, healthRes) => {
      healthRes.statusCode = 503;
      healthRes.end("down");
    };
    expect(await health()).toBe(false);
  });

  it("mock embedding contract (LOAD-BEARING): deterministic per uid, near-orthogonal across uids", () => {
    process.env.NEXT_PUBLIC_E2E_FAKE_SEAM = "1";
    process.env.FACE_MOCK_ENABLED = "1";
    try {
      const a1 = uidMockEmbedding("student-a");
      const a2 = uidMockEmbedding("student-a");
      const b = uidMockEmbedding("student-b");
      // (a) identical for the same uid across enroll + verify.
      expect(a1).toEqual(a2);
      // (b) near-orthogonal across students: |cos| stays far below the 0.45
      // duplicate-detection floor (measured ~0.04-0.08 across uid pairs).
      const dot = a1.reduce((acc, x, i) => acc + x * b[i], 0);
      expect(Math.abs(dot)).toBeLessThan(0.1);
      // The MATCH marker detection is mock-gated AND marker-gated.
      expect(MOCK_MATCH_MARKER).toContain("FAKE_FRAME_MATCH");
    } finally {
      delete process.env.NEXT_PUBLIC_E2E_FAKE_SEAM;
      delete process.env.FACE_MOCK_ENABLED;
    }
  });
});

// ─── audit-3 E-F6: mock-mode surface + memoized production warning ────────
//
// The warning is memoized at MODULE level, so each warn assertion re-imports a
// fresh instance (vi.resetModules + dynamic import — the hardening-gate.test.ts
// precedent). The env is read at CALL time, so the mock-mode behavior tests
// can drive the statically-imported instance directly.
describe("audit-3 E-F6 — mock mode + production warning", () => {
  const SEAM = "NEXT_PUBLIC_E2E_FAKE_SEAM";
  const MOCK = "FACE_MOCK_ENABLED";

  async function withMockFlags(run: () => Promise<void>): Promise<void> {
    const prevSeam = process.env[SEAM];
    const prevMock = process.env[MOCK];
    process.env[SEAM] = "1";
    process.env[MOCK] = "1";
    try {
      await run();
    } finally {
      if (prevSeam === undefined) delete process.env[SEAM];
      else process.env[SEAM] = prevSeam;
      if (prevMock === undefined) delete process.env[MOCK];
      else process.env[MOCK] = prevMock;
    }
  }

  it("mock mode + marker predicates require BOTH flags", () => {
    expect(isMockModeEnabled()).toBe(false);
    process.env[SEAM] = "1";
    try {
      // Only one of the two flags set → still OFF (strict opt-in).
      delete process.env[MOCK];
      expect(isMockModeEnabled()).toBe(false);
    } finally {
      delete process.env[SEAM];
    }
  });

  it("marker predicates and canned extraction only fire with both flags", async () => {
    await withMockFlags(async () => {
      expect(isMockModeEnabled()).toBe(true);
      expect(isMockMatchFrame(MOCK_MATCH_MARKER)).toBe(true);
      expect(isMockMatchFrame(MOCK_MISMATCH_MARKER)).toBe(false);
      expect(isMockMismatchFrame(MOCK_MISMATCH_MARKER)).toBe(true);
      expect(isMockMismatchFrame(MOCK_MATCH_MARKER)).toBe(false);

      // MATCH marker → one canned centered face with a real spoof verdict.
      const match = await extractFace(MOCK_MATCH_MARKER, "uid-mock");
      if ("error" in match) throw new Error("expected a canned match result");
      expect(match.faces).toHaveLength(1);
      expect(match.faces[0].yaw).toBe(0);
      expect(match.spoof).toEqual({ real: true, score: 0.99 });

      // MISMATCH marker → the no-face sentinel (a 0-vote, never an error).
      expect(await extractFace(MOCK_MISMATCH_MARKER, "uid-mock")).toEqual({ faces: [] });
      // A REAL frame while the flag is on → deterministic no-face, never a 503.
      expect(await extractFace("a-real-webcam-frame", "uid-mock")).toEqual({ faces: [] });
      // Health short-circuits to true in mock mode (no sidecar round trip).
      expect(await health()).toBe(true);
    });
  });

  describe("warnIfMockSeamInProduction", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    let prevNode: string | undefined;

    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      prevNode = process.env.NODE_ENV;
    });

    afterEach(() => {
      warn.mockRestore();
      (process.env as { NODE_ENV?: string }).NODE_ENV = prevNode;
      delete process.env[SEAM];
      delete process.env[MOCK];
    });

    async function freshClient() {
      vi.resetModules();
      return await import("./insightface-client");
    }

    it("warns ONCE when NODE_ENV=production and both seam flags are set", async () => {
      const mod = await freshClient();
      (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
      process.env[SEAM] = "1";
      process.env[MOCK] = "1";
      expect(mod.isMockModeEnabled()).toBe(true);
      // Memoization: a second call must not warn again.
      expect(mod.isMockModeEnabled()).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("[insightface]");
    });

    it("does NOT warn in a development build", async () => {
      const mod = await freshClient();
      (process.env as { NODE_ENV?: string }).NODE_ENV = "development";
      process.env[SEAM] = "1";
      process.env[MOCK] = "1";
      expect(mod.isMockModeEnabled()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does NOT warn when the flags are absent (mock mode off)", async () => {
      const mod = await freshClient();
      (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
      delete process.env[SEAM];
      delete process.env[MOCK];
      expect(mod.isMockModeEnabled()).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  extractFace,
  health,
  uidMockEmbedding,
  MOCK_MATCH_MARKER,
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

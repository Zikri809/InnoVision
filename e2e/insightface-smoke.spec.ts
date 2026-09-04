import { readFileSync } from "fs";
import path from "path";
import { test, expect } from "@playwright/test";

/**
 * Opt-in InsightFace sidecar smoke (REAL Docker service — no mocks).
 *
 * The regular E2E suite runs with FACE_MOCK_ENABLED=1 so CI never needs
 * Docker. That leaves the server-side HTTP glue (JSON encoding, response
 * parsing, real-model behavior) and the real similarity distribution
 * unexercised — this spec closes that gap.
 *
 * Runs ONLY when the sidecar answers on INSIGHTFACE_BASE_URL; otherwise every
 * test skips with a pointer to `npm run face:start`.
 * Pre-demo: `docker compose up -d insightface-service` then
 * `npm run test:face-smoke`.
 *
 * Uses AI-generated synthetic faces (thispersondoesnotexist.com — no real
 * person depicted) so biometric-looking data never references a human.
 */

const BASE_URL = (
  process.env.INSIGHTFACE_BASE_URL || "http://localhost:8000"
).replace(/\/$/, "");
const TOKEN = process.env.FACE_SIDECAR_TOKEN || "";
const MATCH_THRESHOLD = 0.5; // mirrors FACE_SIMILARITY_MIN (app match gate)

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return TOKEN ? { "x-sidecar-token": TOKEN, ...extra } : extra;
}

async function extract(name: "person-a.jpg" | "person-b.jpg"): Promise<{
  faces: { embedding: number[]; det_score: number }[];
}> {
  const bytes = readFileSync(path.join(__dirname, "fixtures", "faces", name));
  const dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  const res = await fetch(`${BASE_URL}/extract`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ frame: dataUrl }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(res.ok, `extract ${name} → HTTP ${res.status}`).toBe(true);
  return (await res.json()) as { faces: { embedding: number[]; det_score: number }[] };
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

let serviceUp = false;

test.describe.serial("InsightFace smoke (real sidecar)", () => {
  test.beforeAll(async () => {
    try {
      const res = await fetch(`${BASE_URL}/health`, {
        headers: headers(),
        signal: AbortSignal.timeout(5_000),
      });
      serviceUp = res.ok && (await res.json()).status === "ok";
    } catch {
      serviceUp = false;
    }
    test.skip(
      !serviceUp,
      "InsightFace sidecar not reachable — start it with `npm run face:start`",
    );
  });

  test("health reports buffalo_l on CPU", async () => {
    const res = await fetch(`${BASE_URL}/health`, { headers: headers() });
    const json = (await res.json()) as { model?: string; providers?: string[] };
    expect(json.model).toBe("buffalo_l");
    expect(json.providers).toContain("CPUExecutionProvider");
  });

  test("extract returns a 512-d L2-normalized embedding", async () => {
    const { faces } = await extract("person-a.jpg");
    // NOTE: the fixtures are tiny (256px) synthetic faces — weak SCRFD
    // detections (det_score ~0.13-0.44). The sidecar's detector threshold is
    // intentionally permissive (candidate generation); the route-side
    // DETECTION_SCORE_MIN floor is the quality gate for REAL webcam frames.
    // This smoke asserts the pipeline (decode → detect → embed), not fixture
    // photographic quality.
    expect(faces.length).toBeGreaterThanOrEqual(1);
    const face = faces[0];
    expect(face.embedding).toHaveLength(512);
    const norm = Math.sqrt(dot(face.embedding, face.embedding));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
    expect(face.det_score).toBeGreaterThan(0.05); // any real detection at all
  });

  test("same image → cosine ≈ 1.0; different face → cosine < 0.45", async () => {
    const a1 = (await extract("person-a.jpg")).faces[0].embedding;
    const a2 = (await extract("person-a.jpg")).faces[0].embedding;
    const b = (await extract("person-b.jpg")).faces[0].embedding;
    expect(dot(a1, a2)).toBeGreaterThan(0.9); // deterministic re-extract
    expect(dot(a1, b)).toBeLessThan(0.45); // impostor pair (< DUP gate 0.45)
  });
});

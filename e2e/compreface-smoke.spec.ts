import { readFileSync } from "fs";
import path from "path";
import { test, expect, type TestInfo } from "@playwright/test";

/**
 * Opt-in CompreFace integration smoke (REAL Docker service — no mocks).
 *
 * The regular E2E suite runs with COMPREFACE_MOCK_ENABLED=1 so CI never needs
 * Docker. That leaves the server-side HTTP glue (auth header, multipart
 * encoding, response-shape parsing, error mapping) and the real model's
 * similarity distribution unexercised — this spec closes that gap.
 *
 * Runs ONLY when the CompreFace container answers on COMPREFACE_BASE_URL;
 * otherwise every test skips with a pointer to `npm run compreface:start`.
 * Pre-demo: `docker compose up -d` then `npm run test:face-smoke`.
 *
 * Uses AI-generated synthetic faces (thispersondoesnotexist.com — no real
 * person depicted) so biometric-looking data never references a human.
 * The spec creates its own namespaced subject and cleans ONLY that subject —
 * never touches other gallery entries.
 */

const BASE_URL = (
  process.env.COMPREFACE_BASE_URL || "http://localhost:8000"
).replace(/\/$/, "");
const API_KEY = process.env.COMPREFACE_API_KEY || "";
const SUBJECT = `smoke-${Date.now()}`;
const MATCH_THRESHOLD = 0.5; // mirrors FACE_SIMILARITY_MIN (app match gate)

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-api-key": API_KEY, ...extra };
}

function faceBlob(name: "person-a.jpg" | "person-b.jpg"): Blob {
  const bytes = readFileSync(path.join(__dirname, "fixtures", "faces", name));
  return new Blob([bytes], { type: "image/jpeg" });
}

async function recognizeForm(
  form: FormData,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE_URL}/api/v1/recognition/recognize`, {
    method: "POST",
    headers: headers(),
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body — keep null, status carries the signal
  }
  return { status: res.status, json };
}

/** Every (subject, similarity) reading across all faces in a recognize response.
 * API similarity is already a 0..1 FRACTION (verified against 1.2.0) — the
 * same scale the app client consumes, no rescaling. */
function readings(json: unknown): { subject: string; similarity: number }[] {
  const out: { subject: string; similarity: number }[] = [];
  const faces =
    (json as { result?: { subjects?: { subject: string; similarity: number }[] }[] })
      ?.result ?? [];
  for (const face of faces) {
    for (const s of face.subjects ?? []) {
      out.push({ subject: s.subject, similarity: s.similarity });
    }
  }
  return out;
}

let serviceUp = false;

test.describe.serial("CompreFace smoke (real service)", () => {
  test.beforeAll(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/consistence/status`, {
        method: "GET",
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json()) as {
        status?: string;
        dbIsInconsistent?: boolean;
      };
      serviceUp =
        res.ok && json.status === "OK" && json.dbIsInconsistent !== true;
    } catch {
      serviceUp = false;
    }
  });

  test.afterAll(async () => {
    // Clean ONLY our namespaced subject; 404 = already gone is fine.
    try {
      await fetch(`${BASE_URL}/api/v1/recognition/subjects/${SUBJECT}`, {
        method: "DELETE",
        headers: headers(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // best-effort teardown
    }
  });

  const guard = (t: TestInfo) => {
    if (!API_KEY) t.skip(true, "COMPREFACE_API_KEY unset");
    if (!serviceUp)
      t.skip(
        true,
        `CompreFace not healthy at ${BASE_URL} — run \`npm run compreface:start\``,
      );
  };

  test("health endpoint reports an consistent DB", async ({}, testInfo) => {
    guard(testInfo);
    expect(serviceUp).toBe(true);
  });

  test("enrolls a synthetic face and returns an image_id", async ({}, testInfo) => {
    guard(testInfo);
    const form = new FormData();
    form.append("file", faceBlob("person-a.jpg"), "frame.jpg");
    const res = await fetch(
      `${BASE_URL}/api/v1/recognition/faces?subject=${encodeURIComponent(SUBJECT)}`,
      { method: "POST", headers: headers(), body: form, signal: AbortSignal.timeout(30_000) },
    );
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { image_id?: string };
    expect(json.image_id).toBeTruthy();
  });

  test("re-recognizes the enrolled face above the match gate", async ({}, testInfo) => {
    guard(testInfo);
    const form = new FormData();
    form.append("file", faceBlob("person-a.jpg"), "frame.jpg");
    form.append("limit", "0");
    form.append("prediction_count", "3");
    const { status, json } = await recognizeForm(form);
    expect(status).toBe(200);
    const mine = readings(json).filter((r) => r.subject === SUBJECT);
    expect(mine.length).toBeGreaterThan(0);
    // Same-image re-read must clear the app's match gate comfortably.
    expect(Math.max(...mine.map((r) => r.similarity))).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  test("a different synthetic face stays below the match gate", async ({}, testInfo) => {
    guard(testInfo);
    const form = new FormData();
    form.append("file", faceBlob("person-b.jpg"), "frame.jpg");
    form.append("limit", "0");
    form.append("prediction_count", "3");
    const { status, json } = await recognizeForm(form);
    expect(status).toBe(200);
    const mine = readings(json).filter((r) => r.subject === SUBJECT);
    // Either not found at all, or found below the gate — never a false accept.
    for (const r of mine) {
      expect(r.similarity).toBeLessThan(MATCH_THRESHOLD);
    }
  });

  test("a non-face image yields zero faces (400 → empty mapping)", async ({}, testInfo) => {
    guard(testInfo);
    const bytes = readFileSync(path.join(__dirname, "fixtures", "scanned-chapter.png"));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/png" }), "frame.jpg");
    form.append("limit", "0");
    form.append("prediction_count", "3");
    const { status, json } = await recognizeForm(form);
    // CompreFace maps no-face images to 400; the client treats that as [].
    if (status === 400) {
      expect(status).toBe(400);
    } else {
      expect(status).toBe(200);
      expect(readings(json)).toHaveLength(0);
    }
  });

  test("subject delete is authoritative (gone from subsequent reads)", async ({}, testInfo) => {
    guard(testInfo);
    const del = await fetch(
      `${BASE_URL}/api/v1/recognition/subjects/${encodeURIComponent(SUBJECT)}`,
      { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(30_000) },
    );
    expect(del.ok || del.status === 404).toBe(true);

    const get = await fetch(
      `${BASE_URL}/api/v1/recognition/subjects/${encodeURIComponent(SUBJECT)}`,
      { method: "GET", headers: headers(), signal: AbortSignal.timeout(30_000) },
    );
    expect(get.status).toBe(404);
  });
});

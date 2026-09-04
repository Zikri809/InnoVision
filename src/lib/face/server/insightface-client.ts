import "server-only";

import { createHash } from "node:crypto";
import {
  EMBEDDING_DIMS,
  InsightFaceFace,
  l2Normalize,
} from "@/lib/face/embedding";

/**
 * InsightFace sidecar REST client (server-only) — replaces compreface-client.
 *
 * This module is the SINGLE integration boundary with the self-hosted
 * InsightFace sidecar (FastAPI + ONNX Runtime, docker/insightface). It lives
 * OUTSIDE the pure-logic `lib/face/*.ts` modules (which stay
 * `process.env`-free): `import "server-only"` throws if a client component
 * ever imports it, and `INSIGHTFACE_BASE_URL` / `FACE_SIDECAR_TOKEN` are read
 * here (server-only env, never shipped to the browser).
 *
 * Mock mode: when `NEXT_PUBLIC_E2E_FAKE_SEAM === '1'` (the Playwright-harness
 * seam flag — see src/lib/face/seam-gate.ts) AND `FACE_MOCK_ENABLED === '1'`,
 * the client returns canned responses WITHOUT calling the sidecar. Mock mode
 * is STRICT OPT-IN via BOTH flags: without them the client always talks to
 * the sidecar, so a staging / dev deployment reachable by students can never
 * be silently bypassed via a marker frame.
 *
 * Mock embedding contract (LOAD-BEARING): the FAKE_FRAME_MATCH marker maps to
 * a deterministic embedding derived from the CALLER's uid (see uidHashVector).
 * Mock enrollments insert REAL rows into `profile_face_samples` through the
 * real `enroll_face` RPC, so the mock vector must be (a) identical for the
 * same student across enroll + verify (dot ≈ 1.0 → pass) and (b) near-
 * orthogonal across students (|cos| ≈ 0.04 « 0.45 → the internal duplicate
 * check never flags the second E2E student). A MISMATCH marker yields NO face
 * (a 0-vote — the no-face sentinel, matching the old `subjects: []`).
 *
 * All methods return typed objects; network/HTTP errors map to
 * `{ error: 'insightface_unavailable' }` so routes can 503 without leaking
 * internals.
 */

export type InsightFaceExtractResult = { faces: InsightFaceFace[] };

export type InsightFaceError = {
  error: "insightface_unavailable" | "insightface_error" | "invalid_frame";
};

/**
 * Fetch timeout toward the sidecar (ms). A hung/half-dead container must NOT
 * hold the Next.js route open until the platform kills it (504) — a platform
 * timeout on a verify would otherwise look like a silent PASS to the client.
 * A timeout here aborts the fetch → `insightface_unavailable` → 503 → the
 * pipeline fails open to `unavailable` (lecturer-visible), never `ready`.
 */
const INSIGHTFACE_TIMEOUT_MS = 5000;

/** Marker frame size in bytes is meaningless (it's ASCII); sent as-is. */

function isMockMode(): boolean {
  // Since 5f6b1da the E2E suite runs the PRODUCTION build (`npm run build &&
  // npm run start`), where NODE_ENV is "production" and the old gate was
  // dead — every mock-branching path silently fell through to the live
  // client. The harness opt-in (playwright.config.ts webServer env →
  // seam-gate.ts) now carries the E2E-only privilege; production deployments
  // never set it, so the default-off posture is unchanged.
  return (
    process.env.NEXT_PUBLIC_E2E_FAKE_SEAM === "1" &&
    process.env.FACE_MOCK_ENABLED === "1"
  );
}

/** E2E frame markers produced by the fake tracker (`e2e/fake-face-tracker.ts`). */
export const MOCK_MATCH_MARKER = "FAKE_FRAME_MATCH";
export const MOCK_MISMATCH_MARKER = "FAKE_FRAME_MISMATCH";

/**
 * True when the E2E mock is enabled AND this frame is a fake "match".
 * Both conditions are required: outside an explicitly opted-in mock run the
 * marker string must reach the sidecar like any other frame (a marker in the
 * wild is just garbage pixels that fail extraction).
 */
export function isMockMatchFrame(frame: string): boolean {
  return isMockMode() && frame.includes(MOCK_MATCH_MARKER);
}

/** True when the E2E mock is enabled AND this frame is a fake "mismatch". */
export function isMockMismatchFrame(frame: string): boolean {
  return isMockMode() && frame.includes(MOCK_MISMATCH_MARKER);
}

/**
 * True when mock mode is enabled (dev/E2E only — production never qualifies).
 * Routes branch on this to skip live-service validation (e.g. enroll pose
 * checks) that would otherwise be fed canned responses. A developer testing
 * the UI with a REAL webcam while the flag is on is not an error case: their
 * frames simply bypass the mocked-out stages.
 */
export function isMockModeEnabled(): boolean {
  return isMockMode();
}

/**
 * Deterministic mock embedding derived from the caller's uid (see the module
 * header for why it must be uid-specific). Same derivation for a uid always
 * yields the same unit vector.
 */
export function uidMockEmbedding(uid: string): number[] {
  const dims: number[] = [];
  let counter = 0;
  while (dims.length < EMBEDDING_DIMS) {
    const digest = createHash("sha256").update(`${uid}:${counter}`).digest();
    for (const byte of digest) {
      if (dims.length >= EMBEDDING_DIMS) break;
      dims.push(byte / 127.5 - 1);
    }
    counter += 1;
  }
  return l2Normalize(dims);
}

/**
 * The canned `/extract` response for a MATCH marker: exactly one centered
 * face, det_score above the selection floor, yaw 0 (the route skips pose
 * validation in mock mode — the E2E side angles carry the same marker and
 * would otherwise fail the 10–75° side gate).
 */
function mockExtractMatch(uid: string): InsightFaceExtractResult {
  const w = 640;
  const h = 480;
  return {
    faces: [
      {
        embedding: uidMockEmbedding(uid),
        yaw: 0,
        pitch: 0,
        roll: 0,
        det_score: 0.99,
        bbox: [w * 0.25, h * 0.2, w * 0.75, h * 0.9],
      },
    ],
  };
}

/**
 * Extract every face in a frame (detection + pose + embedding in ONE call —
 * the CompreFace detect→recognize→add sequence collapses to this).
 *
 * The ROUTE derives the caller's uid — the mock path needs it to build the
 * deterministic per-student embedding — so it is an explicit argument here
 * even though real mode ignores it.
 */
export async function extractFace(
  frame: string,
  uid: string,
): Promise<InsightFaceExtractResult | InsightFaceError> {
  if (isMockMode()) {
    if (frame.includes(MOCK_MISMATCH_MARKER)) return { faces: [] };
    if (frame.includes(MOCK_MATCH_MARKER)) return mockExtractMatch(uid);
    // A REAL frame while the mock flag is on (operator error in dev): return
    // a deterministic NO-face instead of an error — a real webcam frame in
    // mock mode must never 503 into `unavailable`, it must fail as a 0-vote.
    return { faces: [] };
  }

  try {
    const baseUrl = process.env.INSIGHTFACE_BASE_URL || "http://localhost:8000";
    const token = process.env.FACE_SIDECAR_TOKEN || "";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-sidecar-token"] = token;
    const res = await fetch(`${baseUrl}/extract`, {
      method: "POST",
      headers,
      body: JSON.stringify({ frame }),
      cache: "no-store",
      signal: AbortSignal.timeout(INSIGHTFACE_TIMEOUT_MS),
    });
    if (res.status === 422 || res.status === 400) {
      // Sidecar-level frame rejection (undecodable body etc.) — a client-side
      // frame problem, not an outage.
      return { error: "invalid_frame" };
    }
    if (!res.ok) return { error: "insightface_error" };
    const json = (await res.json()) as { faces?: unknown };
    const faces: InsightFaceFace[] = [];
    for (const raw of Array.isArray(json.faces) ? json.faces : []) {
      const f = raw as Record<string, unknown>;
      const embedding = Array.isArray(f.embedding)
        ? (f.embedding as unknown[]).map((x) => Number(x))
        : [];
      const bbox = Array.isArray(f.bbox) ? (f.bbox as unknown[]).map((x) => Number(x)) : [];
      if (embedding.length !== EMBEDDING_DIMS || bbox.length !== 4) continue;
      faces.push({
        embedding,
        yaw: Number(f.yaw ?? 0),
        pitch: Number(f.pitch ?? 0),
        roll: Number(f.roll ?? 0),
        det_score: Number(f.det_score ?? 0),
        bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
      });
    }
    return { faces };
  } catch {
    return { error: "insightface_unavailable" };
  }
}

/** Sidecar health probe (used by `/api/face/health` + the boot race). */
export async function health(): Promise<boolean> {
  if (isMockMode()) return true;
  try {
    const baseUrl = process.env.INSIGHTFACE_BASE_URL || "http://localhost:8000";
    const token = process.env.FACE_SIDECAR_TOKEN || "";
    const headers: Record<string, string> = {};
    if (token) headers["x-sidecar-token"] = token;
    const res = await fetch(`${baseUrl}/health`, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(INSIGHTFACE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { status?: string };
    return json.status === "ok";
  } catch {
    return false;
  }
}

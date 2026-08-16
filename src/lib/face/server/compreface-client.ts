import "server-only";

/**
 * CompreFace REST client (server-only) — Phase 7 CompreFace migration (L20).
 *
 * This module is the SINGLE integration boundary with the self-hosted
 * CompreFace Docker service. It lives OUTSIDE the pure-logic `lib/face/*.ts`
 * modules (which stay `process.env`-free): `import "server-only"` throws if a
 * client component ever imports it, and `COMPREFACE_BASE_URL` /
 * `COMPREFACE_API_KEY` are read here (server-only env, never shipped to the
 * browser).
 *
 * Mock mode (L15): when `NODE_ENV !== 'production'` AND
 * `COMPREFACE_MOCK_ENABLED === '1'`, the client inspects the frame string for
 * the E2E marker substrings (`FAKE_FRAME_MATCH` / `FAKE_FRAME_MISMATCH`) and
 * returns canned responses WITHOUT calling Docker. The two-flag guard means a
 * misconfigured production deployment cannot activate the mock.
 *
 * All methods return typed objects; network/HTTP errors map to
 * `{ error: 'compreface_unavailable' }` so routes can 503 without leaking
 * internals.
 */

export type CompreFaceRecognizeResult = {
  subject: string | null;
  similarity: number;
  subjects: { subject: string; similarity: number }[];
};

export type CompreFaceError = { error: "compreface_unavailable" | "compreface_error" };

/**
 * Fetch timeout toward CompreFace (ms). A hung/half-dead container must NOT
 * hold the Next.js route open until the platform kills it (504) — a platform
 * timeout on a verify would otherwise look like a silent PASS to the client.
 * A timeout here aborts the fetch → `compreface_unavailable` → 503 → the
 * pipeline fails open to `unavailable` (lecturer-visible), never `ready`.
 */
const COMPREFACE_TIMEOUT_MS = 5000;

function isMockMode(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.COMPREFACE_MOCK_ENABLED === "1"
  );
}

/** E2E frame markers produced by the fake tracker (`e2e/fake-face-tracker.ts`). */
export const MOCK_MATCH_MARKER = "FAKE_FRAME_MATCH";
export const MOCK_MISMATCH_MARKER = "FAKE_FRAME_MISMATCH";

/** True when the E2E mock is enabled AND this frame is a fake "match". */
export function isMockMatchFrame(frame: string): boolean {
  return isMockMode() && frame.includes(MOCK_MATCH_MARKER);
}

/** True when the E2E mock is enabled AND this frame is a fake "mismatch". */
export function isMockMismatchFrame(frame: string): boolean {
  return isMockMode() && frame.includes(MOCK_MISMATCH_MARKER);
}

let warnedMissingKey = false;

async function comprefaceFetch(
  path: string,
  init: { method: string; body?: string | FormData; contentType?: string },
): Promise<Response> {
  // `||` (not `??`): an EMPTY-string env value (`COMPREFACE_BASE_URL=`) would
  // otherwise yield a relative-URL fetch that throws — misconfiguration
  // masquerading as an outage. Fall back to the local defaults.
  const baseUrl = process.env.COMPREFACE_BASE_URL || "http://localhost:8000";
  const apiKey = process.env.COMPREFACE_API_KEY || "";
  if (!apiKey && !isMockMode() && !warnedMissingKey) {
    warnedMissingKey = true;
    console.warn("compreface-client: COMPREFACE_API_KEY is unset — CompreFace calls will fail authentication.");
  }
  const headers: Record<string, string> = { "x-api-key": apiKey };
  if (init.contentType) headers["content-type"] = init.contentType;
  return fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers,
    body: init.body,
    cache: "no-store",
    signal: AbortSignal.timeout(COMPREFACE_TIMEOUT_MS),
  });
}

function mockRecognize(frame: string): CompreFaceRecognizeResult {
  if (frame.includes(MOCK_MATCH_MARKER)) {
    return { subject: "mock-subject", similarity: 0.95, subjects: [{ subject: "mock-subject", similarity: 0.95 }] };
  }
  if (frame.includes(MOCK_MISMATCH_MARKER)) {
    return { subject: null, similarity: 0.1, subjects: [] };
  }
  // A REAL frame while the mock flag is on (operator error in dev): return a
  // deterministic NO-match instead of an error — a real webcam frame in mock
  // mode must never 503 into `unavailable`, it must fail as a mismatch.
  return { subject: null, similarity: 0, subjects: [] };
}

/**
 * Recognize a frame against ALL enrolled subjects (1:N). Returns the top
 * match + the full ranked list (the route extracts top-2 for the margin rule).
 */
export async function recognize(frame: string): Promise<CompreFaceRecognizeResult | CompreFaceError> {
  if (isMockMode()) {
    return mockRecognize(frame);
  }

  try {
    const form = new FormData();
    form.append("file", new Blob([frame], { type: "image/jpeg" }), "frame.jpg");
    form.append("limit", "0");
    const res = await comprefaceFetch("/api/v1/recognition/recognize", {
      method: "POST",
      body: form,
    });
    if (!res.ok) return { error: "compreface_error" };
    const json = (await res.json()) as {
      result?: { subjects?: { subject: string; similarity: number }[] };
    };
    const subjects = (json.result?.subjects ?? []).slice(0, 3);
    const top = subjects[0] ?? null;
    return {
      subject: top?.subject ?? null,
      similarity: top?.similarity ?? 0,
      subjects,
    };
  } catch {
    return { error: "compreface_unavailable" };
  }
}

/** Detect faces + pose (used for enrollment pose validation). */
export async function detect(
  frame: string,
): Promise<{ faces: { yaw: number }[] } | CompreFaceError> {
  if (isMockMode()) {
    // Mock pose: the fake tracker's frames carry no real yaw — yaw 0 passes
    // the front range; left/right enrollment in E2E uses the MATCH marker
    // which skips pose validation route-side.
    return { faces: [{ yaw: 0 }] };
  }
  try {
    const form = new FormData();
    form.append("file", new Blob([frame], { type: "image/jpeg" }), "frame.jpg");
    form.append("det_prob_threshold", "0.8");
    const res = await comprefaceFetch("/api/v1/detection/detect", {
      method: "POST",
      body: form,
    });
    if (!res.ok) return { error: "compreface_error" };
    const json = (await res.json()) as {
      result?: { faces?: { attributes?: { pose?: { yaw?: number } } }[] };
    };
    const faces = (json.result?.faces ?? []).map((f) => ({ yaw: f.attributes?.pose?.yaw ?? 0 }));
    return { faces };
  } catch {
    return { error: "compreface_unavailable" };
  }
}

/** Add an example (frame) to a subject (multi-sample enrollment). */
export async function addSubjectExample(
  subject: string,
  frame: string,
): Promise<{ imageId?: string } | CompreFaceError> {
  if (isMockMode()) return { imageId: "mock-image-id" };
  try {
    const form = new FormData();
    form.append("file", new Blob([frame], { type: "image/jpeg" }), "frame.jpg");
    const res = await comprefaceFetch(`/api/v1/recognition/subjects/${encodeURIComponent(subject)}/examples`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) return { error: "compreface_error" };
    const json = (await res.json()) as { image_id?: string };
    return { imageId: json.image_id };
  } catch {
    return { error: "compreface_unavailable" };
  }
}

/** Delete a subject + all its examples. */
export async function deleteSubject(subject: string): Promise<{ ok: true } | CompreFaceError> {
  if (isMockMode()) return { ok: true };
  try {
    const res = await comprefaceFetch(`/api/v1/recognition/subjects/${encodeURIComponent(subject)}`, {
      method: "DELETE",
    });
    // 404 = already gone → treat as success (idempotent cleanup).
    if (res.ok || res.status === 404) return { ok: true };
    return { error: "compreface_error" };
  } catch {
    return { error: "compreface_unavailable" };
  }
}

/** Check whether a subject exists (re-enroll detection). */
export async function subjectExists(subject: string): Promise<boolean | CompreFaceError> {
  if (isMockMode()) return true;
  try {
    const res = await comprefaceFetch(`/api/v1/recognition/subjects/${encodeURIComponent(subject)}`, {
      method: "GET",
    });
    return res.ok;
  } catch {
    return { error: "compreface_unavailable" };
  }
}

/** CompreFace health probe (used by `/api/face/health` + the boot race). */
export async function health(): Promise<boolean> {
  if (isMockMode()) return true;
  try {
    const res = await fetch(
      `${process.env.COMPREFACE_BASE_URL || "http://localhost:8000"}/api/v1/health`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(COMPREFACE_TIMEOUT_MS),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

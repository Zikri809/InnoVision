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
 * Mock mode: when `NEXT_PUBLIC_E2E_FAKE_SEAM === '1'` (the Playwright-harness
 * seam flag — see src/lib/face/seam-gate.ts) AND
 * `COMPREFACE_MOCK_ENABLED === '1'`, the client inspects the frame string for
 * the E2E marker substrings (`FAKE_FRAME_MATCH` / `FAKE_FRAME_MISMATCH`) and
 * returns canned responses WITHOUT calling Docker. Mock mode is STRICT OPT-IN
 * via BOTH flags: without them the client always talks to Docker, so a
 * staging / dev deployment reachable by students can never be silently
 * bypassed via a marker frame.
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
 * Full multi-face recognize payload: every detected face with its ranked
 * subject list. Powers the 1:1-by-lookup verify path — the route extracts
 * the CALLER's own similarity instead of requiring a top-1 gallery rank
 * (which made lookalike classmates an escalating false-positive surface).
 */
export type CompreFaceFace = { subjects: { subject: string; similarity: number }[] };

/**
 * The caller's own best similarity across ALL faces in the frame (1:1 by
 * lookup). A frame containing both the student and a passer-by still yields
 * the STUDENT's reading — a second person never drags the score down or up.
 */
export function selfSimilarity(
  faces: CompreFaceFace[],
  uid: string,
): number {
  let best = 0;
  for (const face of faces) {
    for (const s of face.subjects) {
      if (s.subject === uid && s.similarity > best) best = s.similarity;
    }
  }
  return best;
}

/**
 * Fetch timeout toward CompreFace (ms). A hung/half-dead container must NOT
 * hold the Next.js route open until the platform kills it (504) — a platform
 * timeout on a verify would otherwise look like a silent PASS to the client.
 * A timeout here aborts the fetch → `compreface_unavailable` → 503 → the
 * pipeline fails open to `unavailable` (lecturer-visible), never `ready`.
 */
const COMPREFACE_TIMEOUT_MS = 5000;

function isMockMode(): boolean {
  // Since 5f6b1da the E2E suite runs the PRODUCTION build (`npm run build &&
  // npm run start`), where NODE_ENV is "production" and the old gate was
  // dead — every mock-branching path silently fell through to the live
  // CompreFace client. The harness opt-in (playwright.config.ts webServer
  // env → seam-gate.ts) now carries the E2E-only privilege; production
  // deployments never set it, so the default-off posture is unchanged.
  return (
    process.env.NEXT_PUBLIC_E2E_FAKE_SEAM === "1" &&
    process.env.COMPREFACE_MOCK_ENABLED === "1"
  );
}

/** E2E frame markers produced by the fake tracker (`e2e/fake-face-tracker.ts`). */
export const MOCK_MATCH_MARKER = "FAKE_FRAME_MATCH";
export const MOCK_MISMATCH_MARKER = "FAKE_FRAME_MISMATCH";

/**
 * True when the E2E mock is enabled AND this frame is a fake "match".
 * Both conditions are required: outside an explicitly opted-in mock run the
 * marker string must reach CompreFace like any other frame (a marker in the
 * wild is just garbage pixels that fail recognition).
 */
export function isMockMatchFrame(frame: string): boolean {
  return isMockMode() && frame.includes(MOCK_MATCH_MARKER);
}

/** True when the E2E mock is enabled AND this frame is a fake "mismatch". */
export function isMockMismatchFrame(frame: string): boolean {
  return isMockMode() && frame.includes(MOCK_MISMATCH_MARKER);
}

/**
 * True when CompreFace mock mode is enabled (dev/E2E only — production
 * never qualifies). Routes branch on this to skip live-service validation
 * (e.g. enroll pose checks) that would otherwise be fed canned responses.
 * A developer testing the UI with a REAL webcam while the flag is on is not
 * an error case anymore: their frames simply bypass the mocked-out stages.
 */
export function isMockModeEnabled(): boolean {
  return isMockMode();
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

function mockRecognizeFaces(frame: string): CompreFaceFace[] {
  if (frame.includes(MOCK_MATCH_MARKER)) {
    return [{ subjects: [{ subject: "mock-subject", similarity: 0.95 }] }];
  }
  if (frame.includes(MOCK_MISMATCH_MARKER)) {
    return [{ subjects: [] }];
  }
  // A REAL frame while the mock flag is on (operator error in dev): return a
  // deterministic NO-match instead of an error — a real webcam frame in mock
  // mode must never 503 into `unavailable`, it must fail as a mismatch.
  return [{ subjects: [] }];
}

function frameToBlob(frame: string): Blob {
  const base64 = frame.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64, "base64");
  return new Blob([buffer], { type: "image/jpeg" });
}

/**
 * Recognize a frame against ALL enrolled subjects (1:N), returning every
 * detected face with its full ranked subject list. The verify route extracts
 * the caller's own similarity (`selfSimilarity`); the enroll route's
 * duplicate check reads the top-ranked entry.
 */
export async function recognize(frame: string): Promise<CompreFaceRecognizeResult | CompreFaceError> {
  const faces = await recognizeFaces(frame);
  if ("error" in faces) return faces;
  const ranked = faces[0]?.subjects ?? [];
  const top = ranked[0] ?? null;
  return { subject: top?.subject ?? null, similarity: top?.similarity ?? 0, subjects: ranked };
}

export async function recognizeFaces(
  frame: string,
): Promise<CompreFaceFace[] | CompreFaceError> {
  if (isMockMode()) {
    return mockRecognizeFaces(frame);
  }

  try {
    const form = new FormData();
    form.append("file", frameToBlob(frame), "frame.jpg");
    form.append("limit", "0");
    form.append("prediction_count", "3");
    const res = await comprefaceFetch("/api/v1/recognition/recognize", {
      method: "POST",
      body: form,
    });
    if (res.status === 400) {
      // No face found in image -> zero faces
      return [];
    }
    if (!res.ok) return { error: "compreface_error" };
    const json = (await res.json()) as {
      result?: { subjects?: { subject: string; similarity: number }[] }[];
    };
    return (json.result ?? []).map((f) => ({
      subjects: (f.subjects ?? []).slice(0, 3),
    }));
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
    form.append("file", frameToBlob(frame), "frame.jpg");
    const res = await comprefaceFetch("/api/v1/recognition/recognize?face_plugins=pose", {
      method: "POST",
      body: form,
    });
    if (res.status === 400) {
      // No face found in image
      return { faces: [] };
    }
    if (!res.ok) return { error: "compreface_error" };
    const json = (await res.json()) as {
      result?: { pose?: { yaw?: number } }[];
    };
    const faces = (json.result ?? []).map((f) => ({ yaw: f.pose?.yaw ?? 0 }));
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
    form.append("file", frameToBlob(frame), "frame.jpg");
    const res = await comprefaceFetch(`/api/v1/recognition/faces?subject=${encodeURIComponent(subject)}`, {
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
/**
 * CompreFace availability probe (used by `/api/face/health` + the boot race).
 *
 * 1.2.0 dropped the old public `/api/v1/health` (the inference API now parses
 * unknown `/api/v1/<path>` segments as recognition model types and 500s on
 * `/health`). The real health signal is `/api/v1/consistence/status`, which
 * reports DB + face-collection consistency and is keyed on `x-api-key`.
 */
export async function health(): Promise<boolean> {
  if (isMockMode()) return true;
  try {
    const res = await comprefaceFetch("/api/v1/consistence/status", { method: "GET" });
    if (!res.ok) return false;
    const json = (await res.json()) as { status?: string; dbIsInconsistent?: boolean };
    return json.status === "OK" && json.dbIsInconsistent !== true;
  } catch {
    return false;
  }
}

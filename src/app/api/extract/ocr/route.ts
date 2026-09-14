import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { httpChatCompletions, probeGlmModel } from "@/lib/ai/http-compat";
import { checkSameOrigin, invalidJson, payloadTooLarge, readCappedJson } from "@/lib/http";
import { sniffImageType } from "@/lib/media/validation";

export const dynamic = "force-dynamic";

/**
 * POST/GET /api/extract/ocr — server-side proxy to the local GLM-OCR
 * container (vLLM, [OI]-compatible).
 *
 * WHY SERVER-SIDE NOW: the GLM-OCR container is loopback-bound
 * (127.0.0.1:11434), so a browser on ANOTHER machine (e.g. a teammate via a
 * tunnel) cannot reach it. Proxying through this route keeps the feature
 * usable remotely while the container itself never leaves loopback.
 *
 * SSRF guard (S8, unchanged): the target URL comes ONLY from server env
 * (`GLM_BASE_URL` / `OCR_GLM_MODEL`) — never from the request body. The
 * client cannot aim this proxy at arbitrary hosts.
 *
 * audit-2 H-12 hardening:
 *  - per-user rate limit (every sibling media route is budgeted; this one
 *    held N concurrent 90s GPU inferences on one lecturer account);
 *  - streaming-capped body read (the header-only check let a chunked POST
 *    fully materialize before any cap ran);
 *  - the `data:image/` prefix check is now a REAL allowlist: must carry
 *    `;base64,`, must be png/jpeg/webp, and the DECODED bytes must sniff to
 *    the declared type (magic-byte check — `data:image/svg+xml` payloads and
 *    mislabeled junk are rejected before the GPU hold).
 *
 * audit-3 F-F4 correction: H-12 landed the LIMITER only — the route had no
 * in-flight guard, so the sliding window admitted a second batch of 20 at
 * t≈60s while the first batch (90s timeout each) was still running → up to 40
 * concurrent GPU holds per user. The per-user in-flight guard below is the
 * real concurrency bound; the limiter is a budget, not a concurrency control.
 *
 * Contract (mirrors the previous direct-from-browser behavior):
 *  - GET  → `{ available }` (model probe; drives the engine picker)
 *  - POST `{ image: dataUrl }` (ONE rasterized page) → `{ text }`
 *    Typed failures: `glm_model_unavailable` / `glm_timeout` / `glm_error` /
 *    `glm_rate_limited` (audit-3 F-F10: our per-user budget or an upstream
 *    429 is distinct from "the model could not read this page", so the client
 *    says "rate limited, retry" instead of provoking blind retries) /
 *    `glm_busy` (F-F4: too many concurrent page inferences for this user).
 */

// A single canvas-rasterized page as base64 — generous ceiling, but bounded.
const MAX_IMAGE_DATAURL_CHARS = 32_000_000;
// {image:"data:image/png;base64,<32M>"} JSON slack on top of the data URL.
const OCR_BODY_LIMIT_BYTES = MAX_IMAGE_DATAURL_CHARS + 4096;
const PAGE_TIMEOUT_MS = 90_000;

// Classroom scale, not DoS scale: one page per click, a 60-page deck at a
// sane pace stays far below this; a scripted 32MB×N loop does not.
//
// audit-3 F-F2/F-F4 budget note: a single-user 40-page deck at the documented
// GLM throughput (~0.46 s/page, docs/GLM_OCR_SETUP.md) burns 20 pages in ~9 s
// and 40 in ~18 s — i.e. an honest long deck TRIPS this window mid-run. The
// limiter is therefore a burst guard, NOT the long-deck budget: the in-flight
// guard below caps actual concurrent GPU holds, and the client classifies a
// 429 as `glm_rate_limited` (retryable) rather than a read failure. Kept at
// 20/min deliberately — raising it widens the GPU-hold surface without fixing
// the client's ability to see and retry the loss.
const OCR_RATE = { limit: 20, windowMs: 60 * 1000 };

// audit-3 F-F4: per-user in-flight counter. The sliding window above admits a
// second batch of 20 at t≈60s while the first batch may still be running
// (90s page timeout) → up to 40 concurrent 90s GPU holds per user. Two
// overlapping pages per user is the honest ceiling (one dialog extracts one
// page at a time); a third gets a typed retryable code instead of queueing
// another 90s inference. In-process only (same single-instance caveat as
// generate-quiz/regenerate-question).
const MAX_IN_FLIGHT_PER_USER = 2;
const inFlight = new Map<string, number>();

const GLM_TRANSCRIBE_PROMPT =
  "You are an OCR engine. Transcribe ALL visible text from this page image " +
  "faithfully, preserving structure (headings, bullets, tables as text). " +
  "Output ONLY the transcribed text, no commentary.";

const ALLOWED_MIME_PREFIXES = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"] as const;

function glmEnv(): { baseUrl: string; model: string; apiKey: string | undefined } {
  return {
    baseUrl: process.env.GLM_BASE_URL || "http://localhost:11434",
    model: process.env.OCR_GLM_MODEL || "glm-ocr",
    // audit-3 R3-DEP-F2: the compose service can run vLLM with `--api-key`
    // (the sidecar-token pattern, guarding bind drift). When it does, the
    // proxy must present the same key or every OCR call 401s. Unset is the
    // existing keyless loopback posture. Read here, never echoed.
    apiKey: process.env.VLLM_API_KEY || undefined,
  };
}

export async function GET() {
  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  // audit-3 H3-AUTHZ-F3: this GET ran an unbudgeted real fetch (probeGlmModel
  // hits the container's /v1/models with a 2 s bound), while its POST sibling
  // was budgeted and the analogous face/health GET is budgeted too. Same
  // limiter as POST — an availability probe is a user click, not a hot path.
  if (!rateLimit(`ocr-health:${auth.userId}`, OCR_RATE)) {
    return NextResponse.json({ error: "glm_rate_limited" }, { status: 429 });
  }

  const { baseUrl, model, apiKey } = glmEnv();
  const available = await probeGlmModel({ baseUrl, model, apiKey });
  return NextResponse.json({ available });
}

export async function POST(request: Request) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  // audit-2 H-12: authenticated cost guard (sign 60/min, IMAGE_RATE 20/h
  // precedents). A page OCR is one user click; 20/min is generous.
  if (!rateLimit(`ocr:${auth.userId}`, OCR_RATE)) {
    // audit-3 F-F10: a spent per-user budget is NOT a read failure. The
    // distinct code keeps the dialog from telling the user the scanner
    // "could not read this file" (which invites retries into the same window).
    return NextResponse.json({ error: "glm_rate_limited" }, { status: 429 });
  }

  // audit-3 F-F4: concurrency bound — the limiter is a budget, not a cap on
  // simultaneous GPU holds.
  const inFlightKey = `ocr:${auth.userId}`;
  if ((inFlight.get(inFlightKey) ?? 0) >= MAX_IN_FLIGHT_PER_USER) {
    return NextResponse.json({ error: "glm_busy" }, { status: 429 });
  }
  inFlight.set(inFlightKey, (inFlight.get(inFlightKey) ?? 0) + 1);
  try {
    return await handleOcrPage(request);
  } finally {
    const next = (inFlight.get(inFlightKey) ?? 0) - 1;
    if (next <= 0) inFlight.delete(inFlightKey);
    else inFlight.set(inFlightKey, next);
  }
}

/** The single-page transcription work, run under the in-flight guard. */
async function handleOcrPage(request: Request): Promise<NextResponse> {
  // Streaming-capped read: rejects over-cap bodies (header OR stream) before
  // they materialize. The old flow only checked the content-length header
  // and then parsed unbounded.
  const body = await readCappedJson(request, OCR_BODY_LIMIT_BYTES);
  if (!body.ok) {
    return body.response.status === 413
      ? payloadTooLarge("Page image too large.")
      : invalidJson();
  }
  const image =
    typeof body.data === "object" && body.data !== null && "image" in body.data
      ? (body.data as { image?: unknown }).image
      : undefined;

  // Real data-URL allowlist (audit-2 H-12): `data:image/` prefix alone
  // admitted svg+xml and headerless payloads; the magic-byte sniff decides.
  if (
    typeof image !== "string" ||
    image.length > MAX_IMAGE_DATAURL_CHARS ||
    !ALLOWED_MIME_PREFIXES.some((p) => image.startsWith(p))
  ) {
    return NextResponse.json({ error: "glm_error" }, { status: 400 });
  }
  const base64 = image.slice(image.indexOf(";base64,") + ";base64,".length);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return NextResponse.json({ error: "glm_error" }, { status: 400 });
  }
  if (bytes.length === 0 || !sniffImageType(bytes)) {
    return NextResponse.json({ error: "glm_error" }, { status: 400 });
  }

  const { baseUrl, model, apiKey } = glmEnv();

  // Cheap availability gate first: an unreachable container must surface as
  // `glm_model_unavailable` (picker-level problem), not a generic page error.
  const available = await probeGlmModel({ baseUrl, model, apiKey });
  if (!available) {
    return NextResponse.json({ error: "glm_model_unavailable" }, { status: 503 });
  }

  const res = await httpChatCompletions({
    baseUrl,
    model,
    apiKey,
    messages: [
      { role: "system", content: GLM_TRANSCRIBE_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this page:" },
          { type: "image_url", image_url: { url: image } },
        ],
      },
    ],
    maxTokens: 2000,
    timeoutMs: PAGE_TIMEOUT_MS,
  });

  if (!res.ok) {
    // audit-3 F-F10: capacity (upstream 429) is retryable and must not read
    // as a page-read failure; a timeout keeps its own code.
    if (res.error === "rate_limited") {
      return NextResponse.json({ error: "glm_rate_limited" }, { status: 429 });
    }
    const status = res.error === "timeout" ? 504 : 502;
    return NextResponse.json(
      { error: res.error === "timeout" ? "glm_timeout" : "glm_error" },
      { status },
    );
  }
  return NextResponse.json({ text: res.text });
}

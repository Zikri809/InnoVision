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
 * container (vLLM, OpenAI-compatible).
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
 * Contract (mirrors the previous direct-from-browser behavior):
 *  - GET  → `{ available }` (model probe; drives the engine picker)
 *  - POST `{ image: dataUrl }` (ONE rasterized page) → `{ text }`
 *    Typed failures: `glm_model_unavailable` / `glm_timeout` / `glm_error`.
 */

// A single canvas-rasterized page as base64 — generous ceiling, but bounded.
const MAX_IMAGE_DATAURL_CHARS = 32_000_000;
// {image:"data:image/png;base64,<32M>"} JSON slack on top of the data URL.
const OCR_BODY_LIMIT_BYTES = MAX_IMAGE_DATAURL_CHARS + 4096;
const PAGE_TIMEOUT_MS = 90_000;

// Classroom scale, not DoS scale: one page per click, a 60-page deck at a
// sane pace stays far below this; a scripted 32MB×N loop does not.
const OCR_RATE = { limit: 20, windowMs: 60 * 1000 };

const GLM_TRANSCRIBE_PROMPT =
  "You are an OCR engine. Transcribe ALL visible text from this page image " +
  "faithfully, preserving structure (headings, bullets, tables as text). " +
  "Output ONLY the transcribed text, no commentary.";

const ALLOWED_MIME_PREFIXES = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"] as const;

function glmEnv(): { baseUrl: string; model: string } {
  return {
    baseUrl: process.env.GLM_BASE_URL || "http://localhost:11434",
    model: process.env.OCR_GLM_MODEL || "glm-ocr",
  };
}

export async function GET() {
  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  const { baseUrl, model } = glmEnv();
  const available = await probeGlmModel({ baseUrl, model });
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
    return NextResponse.json({ error: "glm_error" }, { status: 429 });
  }

  // Streaming-capped read: rejects over-cap bodies (header OR stream) before
  // they materialize. The old flow only checked the content-length header
  // and then parsed unbounded.
  const body = await readCappedJson(request, OCR_BODY_LIMIT_BYTES);
  if (!body.ok) {
    return body.response.status === 413
      ? payloadTooLarge("Page image too large.")
      : invalidJson();
  }  const image =
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

  const { baseUrl, model } = glmEnv();

  // Cheap availability gate first: an unreachable container must surface as
  // `glm_model_unavailable` (picker-level problem), not a generic page error.
  const available = await probeGlmModel({ baseUrl, model });
  if (!available) {
    return NextResponse.json({ error: "glm_model_unavailable" }, { status: 503 });
  }

  const res = await httpChatCompletions({
    baseUrl,
    model,
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
    const status = res.error === "timeout" ? 504 : 502;
    return NextResponse.json(
      { error: res.error === "timeout" ? "glm_timeout" : "glm_error" },
      { status },
    );
  }
  return NextResponse.json({ text: res.text });
}

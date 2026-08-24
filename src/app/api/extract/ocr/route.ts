import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { httpChatCompletions, probeGlmModel } from "@/lib/ai/http-compat";
import { checkSameOrigin, invalidJson, payloadTooLarge } from "@/lib/http";

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
 * Contract (mirrors the previous direct-from-browser behavior):
 *  - GET  → `{ available }` (model probe; drives the engine picker)
 *  - POST `{ image: dataUrl }` (ONE rasterized page) → `{ text }`
 *    Typed failures: `glm_model_unavailable` / `glm_timeout` / `glm_error`.
 */

// A single canvas-rasterized page as base64 — generous ceiling, but bounded.
const MAX_IMAGE_DATAURL_CHARS = 32_000_000;
const PAGE_TIMEOUT_MS = 90_000;

const GLM_TRANSCRIBE_PROMPT =
  "You are an OCR engine. Transcribe ALL visible text from this page image " +
  "faithfully, preserving structure (headings, bullets, tables as text). " +
  "Output ONLY the transcribed text, no commentary.";

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

  // Reject oversized bodies BEFORE buffering the JSON.
  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_IMAGE_DATAURL_CHARS) {
    return payloadTooLarge("Page image too large.");
  }

  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }
  const image =
    typeof body === "object" && body !== null && "image" in body
      ? (body as { image?: unknown }).image
      : undefined;
  if (
    typeof image !== "string" ||
    !image.startsWith("data:image/") ||
    image.length > MAX_IMAGE_DATAURL_CHARS
  ) {
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

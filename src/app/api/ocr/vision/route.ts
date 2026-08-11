import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { VisionOcrSchema } from "@/lib/ai/validation";
import { createAiClient, chatCompletions, VISION_MODEL } from "@/lib/ai/client";
import { base64ByteLength, MAX_IMAGE_BASE64_CHARS } from "@/lib/extract/types";
import {
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  payloadTooLarge,
  rateLimited,
  timeout,
} from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VISION_RATE = { limit: 30, windowMs: 60 * 60 * 1000 };

/**
 * POST /api/ocr/vision — cloud vision OCR (opt-in, costs tokens).
 *
 * Input: { images: base64[] } — page renders happen CLIENT-side (pdf.js); the
 * route forwards the base64 to the configured vision LLM and returns
 * concatenated markdown text. Images are NEVER stored.
 *
 * Limits (S6/G5):
 *  - ≤ 3 images per request (client batches sequentially).
 *  - Per-image decoded bytes ≤ MAX_IMAGE_BASE64_CHARS (~1.3 MB) → 413.
 *  - Body size computed from base64 length (chars → bytes), NOT `z.string().max`
 *    (which counts characters).
 *  - baseURL is env-configured only; any `baseUrl`/`url` field in the body is
 *    ignored (SSRF guard, S8).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  if (!rateLimit(`aiVision:${auth.userId}`, VISION_RATE)) {
    return rateLimited("Too many vision requests. Try again in an hour.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = VisionOcrSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid vision payload."));
  }

  const { images } = parsed.data;
  for (const img of images) {
    if (base64ByteLength(img) > MAX_IMAGE_BASE64_CHARS) {
      return payloadTooLarge("One of the images exceeds the size limit.");
    }
  }

  const ai = createAiClient();
  const messages = [
    {
      role: "system" as const,
      content:
        "You are an OCR engine. Transcribe ALL visible text from the image(s), " +
        "preserving structure (headings, bullets, tables as markdown). " +
        "Output ONLY the transcribed text, no commentary.",
    },
    {
      role: "user" as const,
      content: images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: img },
      })),
    },
  ];

  const result = await chatCompletions({
    client: ai,
    model: VISION_MODEL,
    messages: messages as Parameters<typeof chatCompletions>[0]["messages"],
    maxTokens: 3000,
    // OCR transcription is plain text — forcing json_object mode breaks on
    // providers that require the word "json" in the prompt.
    jsonMode: false,
  });

  if (!result.ok) {
    if (result.error === "timeout") {
      return timeout("The vision request timed out. Please try again.");
    }
    return internalError("The vision service could not process the images right now.");
  }

  return NextResponse.json({ text: result.text });
}

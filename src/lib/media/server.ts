import {
  checkMultipartLength,
  contentTypeFor,
  extFor,
  sniffImageType,
  type SniffedImageType,
} from "./validation";

export type ParsedImageUpload =
  | { ok: true; buffer: Buffer; type: SniffedImageType; ext: string; contentType: string }
  | { ok: false; response: Response };

/**
 * Shared multipart intake for image upload routes (question images, avatars).
 * Order matters and mirrors the incident-clips pattern:
 *   declared-length gate → formData() → Blob/size checks → magic-byte sniff.
 *
 * The sniff result — never the client-declared MIME — decides the stored
 * extension and content-type, so a mislabeled payload can't land in storage
 * under the wrong type. SVG is rejected by construction (no signature match).
 */
export async function parseImageUpload(
  request: Request,
  maxBytes: number,
  fieldName = "image",
): Promise<ParsedImageUpload> {
  const lengthError = checkMultipartLength(request, maxBytes);
  if (lengthError) return { ok: false, response: lengthError };

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, response: invalidBodyResponse(`Expected multipart/form-data with an \`${fieldName}\` file.`) };
  }

  const file = form.get(fieldName);
  if (!(file instanceof Blob)) {
    return { ok: false, response: invalidBodyResponse(`An \`${fieldName}\` file is required.`) };
  }
  if (file.size === 0) {
    return { ok: false, response: invalidBodyResponse("The uploaded file is empty.") };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      response: tooLargeResponse(`Upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`),
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const type = sniffImageType(buffer);
  if (!type) {
    return {
      ok: false,
      response: invalidBodyResponse("The file is not a recognized image (PNG, JPEG, or WebP)."),
    };
  }

  return { ok: true, buffer, type, ext: extFor(type), contentType: contentTypeFor(type) };
}

function invalidBodyResponse(message: string): Response {
  return Response.json(
    { error: "invalid_body", message },
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function tooLargeResponse(message: string): Response {
  return Response.json(
    { error: "payload_too_large", message },
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

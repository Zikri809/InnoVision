/**
 * Client-side PRE-validation for image picks — UX only. The server's
 * magic-byte sniff (validation.ts) stays the authority; a bypassed client
 * yields a 4xx, never corruption. Pure and dependency-free so it runs under
 * the Node vitest environment (no URL.createObjectURL / DOM here).
 */

export const ACCEPTED_IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

export const ACCEPTED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export type ImagePickError = "badType" | "tooLarge";

/**
 * Accept-gate mirroring the bucket's allowed MIME types. Extension OR declared
 * MIME passing is enough client-side (the sniff decides the stored type).
 * Exactly-at-cap passes; anything larger fails. Zero-byte files are rejected —
 * they can never carry valid image magic bytes.
 */
export function validateImageFile(
  file: Pick<File, "name" | "size" | "type">,
  maxBytes: number,
): { ok: true } | { ok: false; error: ImagePickError } {
  const nonEmpty = file.size > 0;
  const typeOk =
    nonEmpty &&
    (ACCEPTED_IMAGE_EXT_RE.test(file.name) ||
      ACCEPTED_IMAGE_MIME.has(file.type));
  if (!typeOk) return { ok: false, error: "badType" };
  if (file.size > maxBytes) return { ok: false, error: "tooLarge" };
  return { ok: true };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1,
  );
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

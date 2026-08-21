/**
 * Pre-decode image dimension probe (decompression-bomb guard).
 *
 * Parsing PNG IHDR / JPEG SOF headers directly means an absurdly large image
 * is rejected BEFORE the browser decodes it into a multi-hundred-MB bitmap.
 * The canvas clamp in tesseract.ts/glm-ocr.ts still bounds rasterization, but
 * by then the decode has already happened — this is the cheap early gate.
 */

/** Max decoded pixels (w*h) accepted from an uploaded image (~64 MP ≈ A4 @ ~700dpi). */
export const MAX_IMAGE_PIXELS = 64_000_000;

/**
 * Throws `image_too_large` when the container header declares dimensions
 * beyond MAX_IMAGE_PIXELS. Returns silently for unknown containers (the
 * decoder will produce its own natural error for genuinely broken files) and
 * for truncated headers (probe window too small — extremely rare).
 */
export async function assertSafeImageDimensions(file: File | Blob): Promise<void> {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const dims = probeImageDimensions(head);
  if (dims && dims.width > 0 && dims.height > 0) {
    if (dims.width * dims.height > MAX_IMAGE_PIXELS) {
      throw new Error("image_too_large");
    }
  }
}

type Dimensions = { width: number; height: number };

/** Best-effort header sniff. Returns null for anything that isn't PNG/JPEG. */
export function probeImageDimensions(head: Uint8Array): Dimensions | null {
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (head.length > 4 && head[0] === 0xff && head[1] === 0xd8) {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = head[i + 1];
      // SOF0–SOF15 carry dimensions; DHT (C4), JPG (C8), DAC (CC) are not SOF.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (head[i + 5] << 8) | head[i + 6];
        const width = (head[i + 7] << 8) | head[i + 8];
        return { width, height };
      }
      const len = (head[i + 2] << 8) | head[i + 3];
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

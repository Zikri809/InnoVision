import { describe, expect, it } from "vitest";
import {
  assertSafeImageDimensions,
  MAX_IMAGE_PIXELS,
  probeImageDimensions,
} from "@/lib/extract/image-guard";

/** Minimal PNG: signature + IHDR with big-endian width/height at 16/20. */
function pngHeader(width: number, height: number): Uint8Array {
  const head = new Uint8Array(24);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(head.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return head;
}

/** JPEG with the given SOF0 dimensions, preceded by an APP1 (EXIF) segment. */
function jpegHeader(width: number, height: number): Uint8Array {
  const app1Len = 16; // marker + len bytes excluded from len field
  const sofLen = 15; // SOF0 segment length value
  const head = new Uint8Array(2 + 2 + app1Len + 2 + sofLen - 2 + 8);
  let i = 0;
  head[i++] = 0xff;
  head[i++] = 0xd8; // SOI
  // APP1 (skipped by the scan)
  head[i++] = 0xff;
  head[i++] = 0xe1;
  head[i++] = (app1Len >> 8) & 0xff;
  head[i++] = app1Len & 0xff;
  i += app1Len - 2; // segment payload (len counts itself, so payload is len-2)
  // SOF0
  head[i++] = 0xff;
  head[i++] = 0xc0;
  head[i++] = (sofLen >> 8) & 0xff;
  head[i++] = sofLen & 0xff;
  head[i++] = 0x08; // precision
  head[i++] = (height >> 8) & 0xff;
  head[i++] = height & 0xff;
  head[i++] = (width >> 8) & 0xff;
  head[i] = width & 0xff;
  return head;
}

function blobFrom(head: Uint8Array): Blob {
  return new Blob([head.slice().buffer as ArrayBuffer]);
}

describe("probeImageDimensions", () => {
  it("reads PNG IHDR dimensions", () => {
    expect(probeImageDimensions(pngHeader(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("reads JPEG SOF0 dimensions past an EXIF APP1 segment", () => {
    expect(probeImageDimensions(jpegHeader(800, 600))).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("returns null for garbage / non-image bytes", () => {
    const garbage = new TextEncoder().encode("this is not an image at all");
    expect(probeImageDimensions(garbage)).toBeNull();
  });

  it("returns null for a too-short PNG-magic prefix", () => {
    expect(probeImageDimensions(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("assertSafeImageDimensions", () => {
  it("accepts a normal image silently", async () => {
    await expect(
      assertSafeImageDimensions(blobFrom(pngHeader(4000, 3000))),
    ).resolves.toBeUndefined();
  });

  it("throws image_too_large beyond the pixel budget", async () => {
    // 10000 x 7000 = 70 MP > MAX_IMAGE_PIXELS (64 MP), fits comfortably in JPEG u16.
    await expect(
      assertSafeImageDimensions(blobFrom(jpegHeader(10_000, 7_000))),
    ).rejects.toThrow("image_too_large");
    expect(MAX_IMAGE_PIXELS).toBe(64_000_000);
  });

  it("passes at exactly the pixel cap boundary minus one", async () => {
    const w = 8000;
    const h = Math.floor(MAX_IMAGE_PIXELS / w); // exactly under when multiplied back
    await expect(
      assertSafeImageDimensions(blobFrom(pngHeader(w, h))),
    ).resolves.toBeUndefined();
  });

  it("ignores unknown containers (decoder owns that error)", async () => {
    await expect(
      assertSafeImageDimensions(blobFrom(new TextEncoder().encode("nope"))),
    ).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  ACCEPTED_IMAGE_EXT_RE,
  formatBytes,
  validateImageFile,
} from "./client";

const MAX = 5 * 1024 * 1024;

function file(
  overrides: Partial<{ name: string; size: number; type: string }> = {},
): File {
  return {
    name: "image.png",
    size: 1024,
    type: "image/png",
    ...overrides,
  } as unknown as File;
}

describe("validateImageFile", () => {
  it.each([
    { name: "pic.png", type: "image/png" },
    { name: "pic.jpg", type: "image/jpeg" },
    { name: "pic.jpeg", type: "" },
    { name: "pic.webp", type: "" },
    { name: "PIC.PNG", type: "" },
    { name: "camera photo.JPG", type: "" },
    { name: "mislabeled.gif", type: "image/png" },
    { name: "", type: "image/webp" },
  ])("accepts $name ($type)", (f) => {
    expect(validateImageFile(file(f), MAX)).toEqual({ ok: true });
  });

  it.each([
    { name: "doc.pdf", type: "" },
    { name: "anim.gif", type: "image/gif" },
    { name: "noext", type: "" },
    { name: "pic.heic", type: "image/heic" },
    { name: "pic.png.exe", type: "" },
    { name: "", type: "" },
    { name: "data", type: "IMAGE/PNG" },
    { name: "empty.png", type: "", size: 0 },
  ])("rejects $name ($type) as badType", (f) => {
    expect(validateImageFile(file(f), MAX)).toEqual({
      ok: false,
      error: "badType",
    });
  });

  it("accepts a file at exactly the cap", () => {
    expect(validateImageFile(file({ size: MAX }), MAX)).toEqual({ ok: true });
  });

  it("rejects a file one byte over the cap", () => {
    expect(validateImageFile(file({ size: MAX + 1 }), MAX)).toEqual({
      ok: false,
      error: "tooLarge",
    });
  });

  it("type-checks BEFORE size (badType wins on a huge non-image)", () => {
    expect(
      validateImageFile(file({ name: "huge.zip", type: "", size: MAX + 1 }), MAX),
    ).toEqual({ ok: false, error: "badType" });
  });

  it("rejects an empty name AND empty MIME (nothing to identify it by)", () => {
    expect(validateImageFile(file({ name: "", type: "" }), MAX)).toEqual({
      ok: false,
      error: "badType",
    });
  });

  it("MIME set is case-sensitive (browsers send lowercase — pins the contract)", () => {
    expect(validateImageFile(file({ name: "data", type: "IMAGE/PNG" }), MAX)).toEqual(
      { ok: false, error: "badType" },
    );
  });

  it("rejects zero-byte files (can never carry valid image magic bytes)", () => {
    expect(validateImageFile(file({ size: 0 }), MAX)).toEqual({
      ok: false,
      error: "badType",
    });
  });

  it("extension regex is anchored and case-insensitive", () => {
    expect(ACCEPTED_IMAGE_EXT_RE.test("a.JPEG")).toBe(true);
    expect(ACCEPTED_IMAGE_EXT_RE.test("a.jpeg.bak")).toBe(false);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [5 * 1024 * 1024, "5 MB"],
    [1536, "1.5 KB"],
    [1.5 * 1024 ** 3, "1.5 GB"],
    // Beyond the largest unit the index clamps instead of printing "undefined".
    [1024 ** 4, "1024 GB"],
  ])("formats %d as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

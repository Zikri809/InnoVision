import { describe, expect, it } from "vitest";
import {
  checkMultipartLength,
  contentTypeFor,
  extFor,
  isWellFormedQuestionImagePath,
  isValidAvatarPath,
  sniffImageType,
} from "./validation";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UID = "11111111-2222-3333-4444-555555555555";
const IMG_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function buf(bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

function requestWithLength(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("content-length", value);
  return new Request("https://app.test/api/x", { method: "POST", headers });
}

describe("sniffImageType", () => {
  it("accepts a real PNG header", () => {
    expect(sniffImageType(buf([...PNG_MAGIC, 0x00, 0x01]))).toBe("png");
  });

  it("accepts JPEG SOI", () => {
    expect(sniffImageType(buf([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
  });

  it("accepts WebP RIFF container", () => {
    const riff = [...Buffer.from("RIFF"), 0x00, 0x00, 0x00, 0x00, ...Buffer.from("WEBP")];
    expect(sniffImageType(buf(riff))).toBe("webp");
  });

  it("rejects garbage bytes", () => {
    expect(sniffImageType(buf([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]))).toBeNull();
  });

  it("rejects truncated headers (shorter than signature)", () => {
    expect(sniffImageType(buf(PNG_MAGIC.slice(0, 4)))).toBeNull();
    expect(sniffImageType(buf([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(Buffer.from("RIFFWEBP"))).toBeNull();
  });

  it("rejects an empty buffer", () => {
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it("does not mistake RIFF-non-WebP for webp", () => {
    const riff = [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")];
    expect(sniffImageType(buf(riff))).toBeNull();
  });
});

describe("extFor / contentTypeFor", () => {
  it("maps sniff types to canonical ext + content-type", () => {
    expect(extFor("png")).toBe("png");
    expect(extFor("jpeg")).toBe("jpg");
    expect(extFor("webp")).toBe("webp");
    expect(contentTypeFor("png")).toBe("image/png");
    expect(contentTypeFor("jpeg")).toBe("image/jpeg");
    expect(contentTypeFor("webp")).toBe("image/webp");
  });
});

describe("checkMultipartLength", () => {
  it("accepts a declared length within cap", () => {
    expect(checkMultipartLength(requestWithLength("1024"), 5 * 1024 * 1024)).toBeNull();
  });

  it("accepts exactly cap + slack (multipart framing)", () => {
    const atCap = 5 * 1024 * 1024 + 64 * 1024;
    expect(checkMultipartLength(requestWithLength(String(atCap)), 5 * 1024 * 1024)).toBeNull();
  });

  it("rejects over-cap declared length with 413", () => {
    const res = checkMultipartLength(
      requestWithLength(String(6 * 1024 * 1024)),
      5 * 1024 * 1024,
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(413);
  });

  it("rejects a MISSING content-length header (chunked) with 413", () => {
    const res = checkMultipartLength(requestWithLength(null), 5 * 1024 * 1024);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(413);
  });

  it("rejects an unparseable content-length with 413", () => {
    const res = checkMultipartLength(requestWithLength("abc"), 5 * 1024 * 1024);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(413);
  });
});

describe("isWellFormedQuestionImagePath (owner-agnostic sign-route guard)", () => {
  const good = `${UID}/${IMG_ID}.png`;

  it("accepts the two-segment uuid.ext contract for ANY owner uid", () => {
    expect(isWellFormedQuestionImagePath(good)).toBe(true);
    expect(isWellFormedQuestionImagePath(`${UID}/${IMG_ID}.jpg`)).toBe(true);
    expect(isWellFormedQuestionImagePath(`${UID}/${IMG_ID}.jpeg`)).toBe(true);
    expect(isWellFormedQuestionImagePath(`${UID}/${IMG_ID}.webp`)).toBe(true);
  });

  it("rejects traversal and nested/extra segments", () => {
    expect(isWellFormedQuestionImagePath(`${UID}/../${IMG_ID}.png`)).toBe(false);
    expect(isWellFormedQuestionImagePath(`${UID}/sub/${IMG_ID}.png`)).toBe(false);
    expect(isWellFormedQuestionImagePath(`../${UID}/${IMG_ID}.png`)).toBe(false);
    expect(isWellFormedQuestionImagePath(`${IMG_ID}.png`)).toBe(false);
  });

  it("rejects non-uuid ids, bad owners, and bad extensions", () => {
    expect(isWellFormedQuestionImagePath(`${UID}/notauuid.png`)).toBe(false);
    expect(
      isWellFormedQuestionImagePath(`notauuid-123/${IMG_ID}.png`),
    ).toBe(false);
    expect(isWellFormedQuestionImagePath(`${UID}/${IMG_ID}.svg`)).toBe(false);
    expect(isWellFormedQuestionImagePath(`${UID}/${IMG_ID}.png.exe`)).toBe(false);
    expect(isWellFormedQuestionImagePath(`${UID}/.png`)).toBe(false);
  });
});

describe("isValidAvatarPath", () => {
  it("accepts uid/avatar.<img-ext>", () => {
    expect(isValidAvatarPath(`${UID}/avatar.png`, UID)).toBe(true);
    expect(isValidAvatarPath(`${UID}/avatar.jpg`, UID)).toBe(true);
    expect(isValidAvatarPath(`${UID}/avatar.jpeg`, UID)).toBe(true);
    expect(isValidAvatarPath(`${UID}/avatar.webp`, UID)).toBe(true);
  });

  it("rejects foreign prefixes, wrong filename, traversal, bad ext", () => {
    expect(isValidAvatarPath(`${UID}/photo.png`, UID)).toBe(false);
    expect(isValidAvatarPath(`${UID}/../etc/avatar.png`, UID)).toBe(false);
    expect(isValidAvatarPath(`${UID}/avatar.svg`, UID)).toBe(false);
    expect(isValidAvatarPath(`other/${UID}/avatar.png`, UID)).toBe(false);
    expect(isValidAvatarPath(`${UID}/avatar`, UID)).toBe(false);
  });
});

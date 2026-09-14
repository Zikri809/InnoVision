import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  extFor,
  isOwnedQuizSourcePath,
  isWellFormedQuestionImagePath,
  isWellFormedQuizSourcePath,
  isValidAvatarPath,
  sniffImageType,
} from "./validation";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UID = "11111111-2222-3333-4444-555555555555";
const IMG_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const QUIZ_ID = "cccccccc-dddd-eeee-ffff-000000000000";

function buf(bytes: number[]): Buffer {
  return Buffer.from(bytes);
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

describe("checkMultipartLength removed (audit-3 G-F7)", () => {
  it("is no longer exported (dead pre-H-04 header-only gate)", async () => {
    const mod = await import("./validation");
    expect("checkMultipartLength" in mod).toBe(false);
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

describe("isWellFormedQuizSourcePath / isOwnedQuizSourcePath (audit-3 C-F1)", () => {
  const good = `${UID}/${QUIZ_ID}/${IMG_ID}-notes.pdf`;

  it("accepts the uid/quizId/<uuid>-<filename> contract", () => {
    expect(isWellFormedQuizSourcePath(good)).toBe(true);
    expect(isWellFormedQuizSourcePath(`${UID}/${QUIZ_ID}/${IMG_ID}-a_b.c.pdf`)).toBe(true);
  });

  it("rejects traversal, extra/empty segments, and bad folder shapes", () => {
    expect(isWellFormedQuizSourcePath(`${UID}/${QUIZ_ID}/../${IMG_ID}-x.pdf`)).toBe(false);
    expect(isWellFormedQuizSourcePath(`${UID}/${QUIZ_ID}/sub/${IMG_ID}-x.pdf`)).toBe(false);
    expect(isWellFormedQuizSourcePath(`${UID}//${IMG_ID}-x.pdf`)).toBe(false);
    expect(isWellFormedQuizSourcePath(`${UID}/${IMG_ID}-x.pdf`)).toBe(false);
    expect(isWellFormedQuizSourcePath(`${IMG_ID}-x.pdf`)).toBe(false);
    expect(isWellFormedQuizSourcePath(`notauuid/${QUIZ_ID}/${IMG_ID}-x.pdf`)).toBe(false);
    // File name must START with a UUID followed by `-<rest>`.
    expect(isWellFormedQuizSourcePath(`${UID}/${QUIZ_ID}/x.pdf`)).toBe(false);
    expect(isWellFormedQuizSourcePath(`${UID}/${QUIZ_ID}/${IMG_ID}.pdf`)).toBe(false);
  });

  it("pins the owner prefix (cross-tenant poison fails closed)", () => {
    expect(isOwnedQuizSourcePath(good, UID)).toBe(true);
    const other = "99999999-8888-7777-6666-555555555555";
    expect(isOwnedQuizSourcePath(`${other}/${QUIZ_ID}/${IMG_ID}-x.pdf`, UID)).toBe(false);
  });
});

describe("isValidAvatarPath", () => {  it("accepts uid/avatar.<img-ext>", () => {
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

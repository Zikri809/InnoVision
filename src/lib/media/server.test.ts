import { describe, expect, it } from "vitest";
import { parseImageUpload } from "./server";
import { MAX_AVATAR_BYTES } from "./validation";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function multipartRequest(
  parts: { name: string; value: Blob | string; filename?: string; type?: string }[],
  declaredLength?: number,
): Request {
  const form = new FormData();
  let bytes = 0;
  for (const p of parts) {
    if (typeof p.value === "string") {
      form.append(p.name, p.value);
      bytes += p.value.length;
    } else {
      form.append(p.name, p.value, p.filename ?? "upload");
      bytes += p.value.size;
    }
  }
  const headers: Record<string, string> = {
    // Browsers declare content-length for uploads; Node doesn't auto-set it.
    "content-length": String(declaredLength ?? bytes + 512),
  };
  return new Request("https://app.test/api/x", { method: "POST", headers, body: form });
}

describe("parseImageUpload", () => {
  it("accepts a valid PNG and derives ext/content-type from the SNIFF", async () => {
    const file = new File([PNG], "photo.png", { type: "image/png" });
    const req = multipartRequest([{ name: "image", value: file }]);
    const res = await parseImageUpload(req, MAX_AVATAR_BYTES);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.type).toBe("png");
      expect(res.ext).toBe("png");
      expect(res.contentType).toBe("image/png");
    }
  });

  it("trusts bytes over the client-declared MIME (mislabeled payload)", async () => {
    const file = new File([PNG], "evil.txt", { type: "text/plain" });
    const req = multipartRequest([{ name: "image", value: file }]);
    const res = await parseImageUpload(req, MAX_AVATAR_BYTES);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.contentType).toBe("image/png");
  });

  it("rejects non-image magic bytes with 400", async () => {
    const file = new File([Buffer.from("<html>not an image</html>")], "x.png", { type: "image/png" });
    const req = multipartRequest([{ name: "image", value: file }]);
    const res = await parseImageUpload(req, MAX_AVATAR_BYTES);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it("rejects an empty file and a missing field", async () => {
    const emptyReq = multipartRequest([
      { name: "image", value: new File([], "empty.png", { type: "image/png" }) },
    ]);
    const emptyRes = await parseImageUpload(emptyReq, MAX_AVATAR_BYTES);
    expect(emptyRes.ok).toBe(false);
    if (!emptyRes.ok) expect(emptyRes.response.status).toBe(400);

    const missingReq = multipartRequest([{ name: "other", value: "hello" }]);
    const missingRes = await parseImageUpload(missingReq, MAX_AVATAR_BYTES);
    expect(missingRes.ok).toBe(false);
    if (!missingRes.ok) expect(missingRes.response.status).toBe(400);
  });

  it("rejects oversize files with 413 after buffering", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]);
    const req = multipartRequest([
      { name: "image", value: new File([big], "big.png", { type: "image/png" }) },
    ]);
    const res = await parseImageUpload(req, MAX_AVATAR_BYTES);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
  });

  it("honors the custom field name", async () => {
    const req = multipartRequest([{ name: "clip", value: new File([PNG], "p.png") }]);
    const res = await parseImageUpload(req, MAX_AVATAR_BYTES, "clip");
    expect(res.ok).toBe(true);
  });
});

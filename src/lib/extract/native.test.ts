import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  nativeExtract,
  detectNativeType,
} from "@/lib/extract/native";
import {
  base64ByteLength,
  batch,
  isAllowedExtension,
  MIN_CHARS_PER_PAGE,
} from "@/lib/extract/types";

const fixture = (name: string): ArrayBuffer => {
  const p = path.resolve(__dirname, "__fixtures__", name);
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

describe("U-E1 — digital PDF (text layer) → native wins", () => {
  it("extracts text with engine='native' and lowConfidence false", async () => {
    const res = await nativeExtract(fixture("chapter-sample.pdf"), "chapter-sample.pdf", {
      node: true,
    });
    expect(res.engine).toBe("native");
    expect(res.pages).toBe(1);
    expect(res.text).toContain("Velocity is the rate of change of displacement.");
    expect(res.lowConfidence).toBe(false);
  });
});

describe("U-E3 — text-density heuristic (≥40 chars/page)", () => {
  it("marks low confidence below the threshold", async () => {
    // A single-page PDF with very little text → lowConfidence true.
    const data = fixture("chapter-sample.pdf");
    // Override via a tiny synthetic "dense" check by testing the rule directly
    // against the helper logic below (nativeExtract computes avg = len/nonEmpty).
    const res = await nativeExtract(data, "chapter-sample.pdf", { node: true });
    // This fixture is dense (3 sentences); construct a sparse case by using a
    // plain-text file with <40 chars.
    const sparse = new TextEncoder().encode("Hello.").buffer as ArrayBuffer;
    const sparseRes = await nativeExtract(sparse, "notes.txt", { node: true });
    expect(sparseRes.engine).toBe("native");
    expect(sparseRes.lowConfidence).toBe(true);
    expect(MIN_CHARS_PER_PAGE).toBe(40);
    expect(res.lowConfidence).toBe(false);
  });
});

describe("U-E5 — extracted text is no longer truncated", () => {
  it("returns the full text regardless of length", async () => {
    const big = "A".repeat(20_000);
    const res = await nativeExtract(new TextEncoder().encode(big).buffer as ArrayBuffer, "notes.txt", { node: true });
    expect(res.text.length).toBe(20_000);
  });
});

describe("U-E6 — DOCX/PPTX/image routed to correct extractor", () => {
  it("routes .docx to mammoth via nativeExtract (built in-test with jszip)", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
       <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
         <w:body><w:p><w:r><w:t>Mammoth extracted this DOCX text.</w:t></w:r></w:p></w:body>
       </w:document>`,
    );
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const res = await nativeExtract(ab, "doc.docx", { node: true });
    expect(res.engine).toBe("native");
    expect(res.text).toContain("Mammoth extracted this DOCX text.");
  });

  it("routes .pptx to jszip slide text nodes", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const slide = `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>
          <p:sp><p:txBody><a:p><a:r><a:t>Slide One Heading</a:t></a:r></a:p></p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>`;
    zip.file("ppt/slides/slide1.xml", slide);
    zip.file("ppt/slides/slide2.xml", slide.replace("Slide One Heading", "Slide Two Heading"));
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const res = await nativeExtract(ab, "deck.pptx", { node: true });
    expect(res.engine).toBe("native");
    expect(res.text).toContain("Slide One Heading");
    expect(res.text).toContain("Slide Two Heading");
    expect(res.pages).toBe(2);
  });

  it("plain text passthrough", async () => {
    const ab = new TextEncoder().encode("Just some plain markdown text here.").buffer as ArrayBuffer;
    const res = await nativeExtract(ab, "notes.md", { node: true });
    expect(res.engine).toBe("native");
    expect(res.text).toContain("plain markdown");
  });
});

describe("U-E7 — corrupt/zero-byte file → clean error", () => {
  it("throws for unsupported file types", async () => {
    const ab = new TextEncoder().encode("MZ...").buffer as ArrayBuffer;
    await expect(nativeExtract(ab, "virus.exe", { node: true })).rejects.toThrow("unsupported_file_type");
  });

  it("returns empty for a zero-byte text file (no crash)", async () => {
    const ab = new ArrayBuffer(0);
    const res = await nativeExtract(ab, "empty.txt", { node: true });
    expect(res.engine).toBe("native");
    expect(res.text).toBe("");
    expect(res.pages).toBe(0);
  });
});

describe("U-E12 — file type/size validation helper", () => {
  it("accepts allowed extensions", () => {
    expect(isAllowedExtension("chapter.pdf")).toBe(true);
    expect(isAllowedExtension("deck.PPTX")).toBe(true);
    expect(isAllowedExtension("notes.md")).toBe(true);
  });
  it("rejects disallowed extensions", () => {
    expect(isAllowedExtension("virus.exe")).toBe(false);
    expect(isAllowedExtension("archive.zip")).toBe(false);
  });
});

describe("U-E10 — base64 byte estimator", () => {
  it("computes decoded length for data URLs and raw base64", () => {
    const raw = Buffer.from("hello world").toString("base64");
    expect(base64ByteLength(raw)).toBe(11);
    expect(base64ByteLength("data:image/png;base64," + raw)).toBe(11);
  });
  it("handles empty", () => {
    expect(base64ByteLength("")).toBe(0);
  });
});

describe("U-E9 — vision batch splitter", () => {
  it("splits into ≤3-page batches", () => {
    const pages = Array.from({ length: 7 }, (_, i) => `p${i}`);
    const groups = batch(pages, 3);
    expect(groups.map((g) => g.length)).toEqual([3, 3, 1]);
    expect(groups.flat()).toEqual(pages);
  });
});

describe("detectNativeType", () => {
  it("maps extensions", () => {
    expect(detectNativeType("a.pdf")).toBe("pdf");
    expect(detectNativeType("a.docx")).toBe("docx");
    expect(detectNativeType("a.pptx")).toBe("pptx");
    expect(detectNativeType("a.txt")).toBe("text");
  });
});

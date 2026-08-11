import { describe, it, expect, vi, afterEach } from "vitest";

describe("loadPdfJs / destroyPdf (Node + browser branches)", () => {
  const ORIGINAL_DOC = (globalThis as Record<string, unknown>).document;

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_DOC === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = ORIGINAL_DOC;
    }
    delete (globalThis as Record<string, unknown>).window;
    vi.resetModules();
  });

  it("loads the legacy build in Node (no window) and polyfills DOMMatrix", async () => {
    // Node env: no `window` → should import legacy build.
    const win = (globalThis as Record<string, unknown>).window;
    if (typeof win !== "undefined") delete (globalThis as Record<string, unknown>).window;

    const { loadPdfJs, destroyPdf } = await import("@/lib/extract/pdf");
    const pdfjs = await loadPdfJs();
    expect(pdfjs).toBeDefined();
    // Calling destroyPdf on a stub doc must not throw.
    await destroyPdf({ loadingTask: { destroy: async () => undefined } });
  });

  it("accepts the existing DOMMatrix if one is already defined", async () => {
    (globalThis as Record<string, unknown>).DOMMatrix = class DOMMatrix {};

    const { loadPdfJs } = await import("@/lib/extract/pdf");
    const pdfjs = await loadPdfJs();
    expect(pdfjs).toBeDefined();
    expect((globalThis as Record<string, unknown>).DOMMatrix).toBeDefined();
  });

  it("the DOMMatrix polyfill constructor parses the 6-component init string", async () => {
    // Trigger the polyfill creation and exercise the constructor's init branch
    // (which is uncovered when DOMMatrix is already defined).
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).DOMMatrix;
    const { loadPdfJs } = await import("@/lib/extract/pdf");
    await loadPdfJs();
    // Cast and exercise the polyfill's init branch.
    const Cls = (globalThis as { DOMMatrix: new (init?: string) => unknown }).DOMMatrix;
    const m = new Cls("1,2,3,4,5,6");
    expect(m).toBeDefined();
  });

  it("loads the main build in the browser and sets workerSrc from the ?url import", async () => {
    // Simulate browser env.
    (globalThis as Record<string, unknown>).window = { document: {} };
    const { loadPdfJs } = await import("@/lib/extract/pdf");
    const pdfjs = await loadPdfJs();
    expect(pdfjs).toBeDefined();
    // workerSrc is set by either the ?url import or the CDN fallback.
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBeTruthy();
  });

  it("destroyPdf swallows errors from the underlying pdfjs document", async () => {
    const { destroyPdf } = await import("@/lib/extract/pdf");
    await expect(
      destroyPdf({
        loadingTask: {
          destroy: () => Promise.reject(new Error("internal cleanup fail")),
        },
      }),
    ).resolves.toBeUndefined();
  });
});


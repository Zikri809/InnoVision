/**
 * Shared pdfjs-dist loader for the extraction pipeline (browser + Node).
 *
 * Browser: bundles the worker via a `?url` import so PDF text extraction and
 * page rasterization work without Google's CDN (venue/edu Wi-Fi often blocks
 * it; P9 self-hosts models). Falls back to the CDN worker if the ?url import
 * is unavailable in a given bundler.
 *
 * Node: uses the legacy build with a minimal DOMMatrix polyfill and no worker.
 */

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export async function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (isBrowser()) {
    const pdfjs = await import("pdfjs-dist");
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      try {
        const workerUrl = (
          (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")) as { default: string }
        ).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      } catch {
        pdfjs.GlobalWorkerOptions.workerSrc =
          `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
      }
    }
    return pdfjs;
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      constructor(init?: string) {
        if (init) {
          const m = init.split(",").map(Number);
          if (m.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = m;
        }
      }
    } as unknown as typeof DOMMatrix;
  }
  return pdfjs as unknown as typeof import("pdfjs-dist");
}

/** Type-safe destroy for a pdf.js document (works across main/legacy builds). */
export async function destroyPdf(doc: { loadingTask: { destroy(): Promise<void> } }): Promise<void> {
  try {
    await doc.loadingTask.destroy();
  } catch {
    /* ignore cleanup errors */
  }
}

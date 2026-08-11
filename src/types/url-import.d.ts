/**
 * Ambient type declarations for Next.js/Vite `?url` imports (used by
 * lib/extract/pdf.ts to bundle the pdf.js worker as a URL).
 */
declare module "*?url" {
  const url: string;
  export default url;
}

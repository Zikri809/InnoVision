/**
 * Quiz source-provenance parsing (grounded-search.md §7).
 *
 * `quizzes.sources` is a permanent MIXED-SHAPE jsonb array (the 0016 freeze
 * trigger makes legacy rows immutable):
 *  - legacy file entry: {id, filename, storage_path, added_at, mode?}
 *  - web entry (0040):  {id, kind:"web", url, title, retrieved_at, query}
 *
 * The parser is TOTAL: any malformed/foreign element is skipped, never
 * thrown — a hand-edited or future-shaped row must not crash the builder.
 * Pure and shared so unit tests pin the tolerance directly.
 */

export type QuizSourceRow =
  | {
      kind: "file";
      id: string | null;
      filename: string;
      storagePath: string;
      addedAt: string | null;
    }
  | {
      kind: "web";
      id: string | null;
      url: string;
      title: string;
      retrievedAt: string | null;
      query: string | null;
    };

/** http(s) URL with no whitespace — mirrors the 0040 RPC-side predicate. */
function isHttpUrl(url: string): boolean {
  return url.length <= 2048 && /^https?:\/\/\S+$/i.test(url);
}

export function parseQuizSources(raw: unknown): QuizSourceRow[] {
  if (!Array.isArray(raw)) return [];
  const out: QuizSourceRow[] = [];
  for (const el of raw) {
    if (typeof el !== "object" || el === null) continue;
    const o = el as Record<string, unknown>;
    if (o.kind === "web") {
      const url = typeof o.url === "string" ? o.url : "";
      if (!isHttpUrl(url)) continue;
      out.push({
        kind: "web",
        id: typeof o.id === "string" ? o.id : null,
        url,
        title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : url,
        retrievedAt: typeof o.retrieved_at === "string" ? o.retrieved_at : null,
        query: typeof o.query === "string" ? o.query : null,
      });
      continue;
    }
    // Legacy file shape (no `kind` field) — tolerate the historical keys.
    const storagePath = typeof o.storage_path === "string" ? o.storage_path : "";
    if (!storagePath) continue;
    out.push({
      kind: "file",
      id: typeof o.id === "string" ? o.id : null,
      filename:
        typeof o.filename === "string" && o.filename.trim()
          ? o.filename.trim()
          : storagePath.split("/").pop() || storagePath,
      storagePath,
      addedAt: typeof o.added_at === "string" ? o.added_at : null,
    });
  }
  return out;
}

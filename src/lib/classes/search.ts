export type SearchableClass = {
  id: string;
  title?: string | null;
  join_code?: string | null;
  [key: string]: unknown;
};

/**
 * Normalizes strings by stripping diacritics / accents, converting to lowercase,
 * and trimming leading/trailing whitespace.
 */
function normalizeSearchString(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Filter classes by title or join code with diacritic/accent insensitivity,
 * runtime nullish safety, multi-word token AND-matching, and whitespace tolerance.
 */
export function filterArchivedClasses<T extends SearchableClass>(
  classes: readonly T[],
  query: string
): T[] {
  const normalizedQuery = normalizeSearchString(query);
  if (!normalizedQuery) return [...classes];

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...classes];

  return classes.filter((c) => {
    const titleNorm = normalizeSearchString(c.title ?? "");
    const codeNorm = normalizeSearchString(c.join_code ?? "");
    const combined = `${titleNorm} ${codeNorm}`;

    // All query tokens must match either the title or join code
    return tokens.every((token) => combined.includes(token));
  });
}

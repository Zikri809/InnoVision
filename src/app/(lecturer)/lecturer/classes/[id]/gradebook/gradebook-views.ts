import type { GradebookRow } from "@/lib/results/gradebook";

/**
 * Pure view-shaping helpers for the RA-1 gradebook matrix (search, attempt
 * status filter, sort). Same discipline as gradebook.ts / list-order.ts:
 * 100% pure, Node-unit-testable, consumed only by the client island so
 * on-screen ordering is deterministic and testable.
 *
 * Null semantics: a student with null matric sorts AFTER non-null matrics
 * (and the em-dash cumulative stays last under overall-% sorts) — matches
 * the table's honesty rule of never inventing values.
 */

export type GradebookStatusFilter = "all" | "attempted" | "unattempted";

export type GradebookSortKey =
  | "default"
  | "name-asc"
  | "name-desc"
  | "matric-asc"
  | "matric-desc"
  | "overall-desc"
  | "overall-asc";

/**
 * Normalizes strings by stripping diacritics / accents, converting to
 * lowercase, and trimming leading/trailing whitespace (same contract as
 * classes/search.ts).
 */
function normalizeSearchString(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function hasAttempted(row: GradebookRow): boolean {
  return row.cells.some((cell) => cell !== null);
}

/**
 * Filter gradebook rows by search query (multi-token AND-match over the
 * student's display name and matric number, diacritic/case-insensitive,
 * whitespace tolerant) and attempt status. An empty query with status
 * "all" returns the rows unchanged (same array contents, new array).
 */
export function filterGradebookRows(
  rows: readonly GradebookRow[],
  query: string,
  status: GradebookStatusFilter,
): GradebookRow[] {
  let out = [...rows];

  if (status === "attempted") {
    out = out.filter(hasAttempted);
  } else if (status === "unattempted") {
    out = out.filter((row) => !hasAttempted(row));
  }

  const normalizedQuery = normalizeSearchString(query);
  if (!normalizedQuery) return out;

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return out;

  return out.filter((row) => {
    const nameNorm = normalizeSearchString(row.fullName ?? row.studentId);
    const matricNorm = normalizeSearchString(row.matricNo ?? "");
    const combined = `${nameNorm} ${matricNorm}`;
    // All query tokens must match the name or the matric number
    return tokens.every((token) => combined.includes(token));
  });
}

/**
 * Compares two nullable keys nulls-last, delegating non-null comparison to
 * `cmp` (which encodes the direction). Swapping arguments to invert a sort
 * would also invert the null handling, so direction lives in `cmp` instead.
 */
function compareNullsLast<T>(
  a: T | null,
  b: T | null,
  cmp: (x: T, y: T) => number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b);
}

/**
 * Sort gradebook rows. "default" keeps the roster (enrollment) order — the
 * base array is copied but not reordered, so the e2e contract of
 * enrollment-ordered rendering in the unsorted state is preserved.
 * Names never go null here (studentId fallback); matric and cumulative%
 * follow the nulls-last rule.
 */
export function sortGradebookRows(
  rows: readonly GradebookRow[],
  sortKey: GradebookSortKey,
): GradebookRow[] {
  const out = [...rows];
  if (sortKey === "default") return out;

  const nameOf = (row: GradebookRow) => row.fullName ?? row.studentId;

  switch (sortKey) {
    case "name-asc":
      out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      break;
    case "name-desc":
      out.sort((a, b) => nameOf(b).localeCompare(nameOf(a)));
      break;
    case "matric-asc":
      out.sort((a, b) =>
        compareNullsLast(a.matricNo, b.matricNo, (x, y) => x.localeCompare(y)),
      );
      break;
    case "matric-desc":
      out.sort((a, b) =>
        compareNullsLast(a.matricNo, b.matricNo, (x, y) => y.localeCompare(x)),
      );
      break;
    case "overall-desc":
      out.sort((a, b) =>
        compareNullsLast(a.cumulativePercent, b.cumulativePercent, (x, y) => y - x),
      );
      break;
    case "overall-asc":
      out.sort((a, b) =>
        compareNullsLast(a.cumulativePercent, b.cumulativePercent, (x, y) => x - y),
      );
      break;
  }
  return out;
}

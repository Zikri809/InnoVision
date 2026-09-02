import { describe, expect, it } from "vitest";
import {
  filterGradebookRows,
  sortGradebookRows,
  type GradebookSortKey,
  type GradebookStatusFilter,
} from "./gradebook-views";
import type { GradebookRow } from "@/lib/results/gradebook";

function row(overrides: {
  studentId: string;
  fullName?: string | null;
  matricNo?: string | null;
  cells?: GradebookRow["cells"];
  cumulativePercent?: number | null;
}): GradebookRow {
  return {
    studentId: overrides.studentId,
    fullName: overrides.fullName ?? null,
    matricNo: overrides.matricNo ?? null,
    cells: overrides.cells ?? [],
    cumulativePercent: overrides.cumulativePercent ?? null,
  };
}

const CELL = (percent: number) => ({
  sessionId: `s-${percent}`,
  score: percent,
  total: 100,
  percent,
  attempt: 1,
});

const ROSTER = [
  row({
    studentId: "s1",
    fullName: "Ahmad Zulkifli",
    matricNo: "A123456",
    cells: [CELL(80)],
    cumulativePercent: 80,
  }),
  row({
    studentId: "s2",
    fullName: "Siti Nurhaliza",
    matricNo: "B654321",
    cells: [null, CELL(50)],
    cumulativePercent: 50,
  }),
  row({
    studentId: "s3",
    fullName: null,
    matricNo: null,
    cells: [null, null],
    cumulativePercent: null,
  }),
];

describe("RA-1 gradebook views — filterGradebookRows", () => {
  it("returns all rows (new array, same order) for empty query + status all", () => {
    const out = filterGradebookRows(ROSTER, "", "all");
    expect(out.map((r) => r.studentId)).toEqual(["s1", "s2", "s3"]);
    expect(out).not.toBe(ROSTER);
  });

  it("matches name case-insensitively and diacritic-insensitively", () => {
    expect(filterGradebookRows(ROSTER, "ahmad", "all").map((r) => r.studentId)).toEqual(["s1"]);
    expect(filterGradebookRows(ROSTER, "ZULKIFLI", "all").map((r) => r.studentId)).toEqual(["s1"]);
  });

  it("matches by matric number substring", () => {
    expect(filterGradebookRows(ROSTER, "654", "all").map((r) => r.studentId)).toEqual(["s2"]);
    expect(filterGradebookRows(ROSTER, "a123456", "all").map((r) => r.studentId)).toEqual(["s1"]);
  });

  it("requires ALL tokens to match (AND semantics), spanning name and matric", () => {
    // "zul" is in s1's name, "a123" is in s1's matric — combined match.
    expect(filterGradebookRows(ROSTER, "zul a123", "all").map((r) => r.studentId)).toEqual(["s1"]);
    // No single row carries both tokens.
    expect(filterGradebookRows(ROSTER, "ahmad b654321", "all")).toEqual([]);
  });

  it("falls back to studentId when fullName is null", () => {
    expect(filterGradebookRows(ROSTER, "s3", "all").map((r) => r.studentId)).toEqual(["s3"]);
  });

  it("is whitespace tolerant", () => {
    expect(filterGradebookRows(ROSTER, "  ahmad   ", "all").map((r) => r.studentId)).toEqual(["s1"]);
  });

  it("status attempted keeps only rows with at least one non-null cell", () => {
    expect(filterGradebookRows(ROSTER, "", "attempted").map((r) => r.studentId)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("status unattempted keeps only rows with all-null cells", () => {
    expect(filterGradebookRows(ROSTER, "", "unattempted").map((r) => r.studentId)).toEqual(["s3"]);
  });

  it("combines status filter with search query", () => {
    // s1 attempted and matches "ahmad"; s3 matches nothing anyway.
    expect(filterGradebookRows(ROSTER, "ahmad", "unattempted")).toEqual([]);
    expect(filterGradebookRows(ROSTER, "zul", "attempted").map((r) => r.studentId)).toEqual(["s1"]);
  });

  it("does not mutate the input array", () => {
    const snapshot = [...ROSTER];
    filterGradebookRows(ROSTER, "ahmad", "attempted");
    sortGradebookRows(ROSTER, "name-desc");
    expect(ROSTER).toEqual(snapshot);
  });
});

describe("RA-1 gradebook views — sortGradebookRows", () => {
  const SORT_ROWS = [
    row({
      studentId: "sid-1",
      fullName: "Chong Wei",
      matricNo: "C111111",
      cells: [CELL(40)],
      cumulativePercent: 40,
    }),
    row({
      studentId: "sid-2",
      fullName: "Aina Sofea",
      matricNo: "A222222",
      cells: [CELL(90)],
      cumulativePercent: 90,
    }),
    row({
      studentId: "sid-3",
      fullName: "Deepa Letchumi",
      matricNo: null,
      cells: [null, null],
      cumulativePercent: null,
    }),
    row({
      studentId: "sid-4",
      fullName: "Bala Krishnan",
      matricNo: "B333333",
      cells: [CELL(65)],
      cumulativePercent: 65,
    }),
  ];

  it("default preserves enrollment order (copy, not reorder)", () => {
    expect(sortGradebookRows(SORT_ROWS, "default").map((r) => r.studentId)).toEqual([
      "sid-1",
      "sid-2",
      "sid-3",
      "sid-4",
    ]);
  });

  it("sorts name asc / desc", () => {
    expect(sortGradebookRows(SORT_ROWS, "name-asc").map((r) => r.fullName)).toEqual([
      "Aina Sofea",
      "Bala Krishnan",
      "Chong Wei",
      "Deepa Letchumi",
    ]);
    expect(sortGradebookRows(SORT_ROWS, "name-desc").map((r) => r.fullName)).toEqual([
      "Deepa Letchumi",
      "Chong Wei",
      "Bala Krishnan",
      "Aina Sofea",
    ]);
  });

  it("sorts name using studentId fallback when fullName is null", () => {
    const rows = [
      row({ studentId: "zzz", fullName: null }),
      row({ studentId: "aaa", fullName: null }),
    ];
    expect(sortGradebookRows(rows, "name-asc").map((r) => r.studentId)).toEqual(["aaa", "zzz"]);
  });

  it("sorts matric asc / desc with nulls last", () => {
    expect(sortGradebookRows(SORT_ROWS, "matric-asc").map((r) => r.matricNo)).toEqual([
      "A222222",
      "B333333",
      "C111111",
      null,
    ]);
    expect(sortGradebookRows(SORT_ROWS, "matric-desc").map((r) => r.matricNo)).toEqual([
      "C111111",
      "B333333",
      "A222222",
      null,
    ]);
  });

  it("sorts overall desc / asc with nulls last", () => {
    expect(sortGradebookRows(SORT_ROWS, "overall-desc").map((r) => r.cumulativePercent)).toEqual([
      90,
      65,
      40,
      null,
    ]);
    expect(sortGradebookRows(SORT_ROWS, "overall-asc").map((r) => r.cumulativePercent)).toEqual([
      40,
      65,
      90,
      null,
    ]);
  });

  it("filter + sort compose (search then overall-desc)", () => {
    const filtered = filterGradebookRows(SORT_ROWS, "", "attempted");
    const sorted = sortGradebookRows(filtered, "overall-desc");
    expect(sorted.map((r) => r.cumulativePercent)).toEqual([90, 65, 40]);
  });

  it("exhaustive sort keys return without throwing", () => {
    const keys: GradebookSortKey[] = [
      "default",
      "name-asc",
      "name-desc",
      "matric-asc",
      "matric-desc",
      "overall-desc",
      "overall-asc",
    ];
    for (const key of keys) {
      expect(sortGradebookRows(SORT_ROWS, key).length).toBe(4);
    }
  });

  it("accepts every status filter without throwing", () => {
    const statuses: GradebookStatusFilter[] = ["all", "attempted", "unattempted"];
    for (const status of statuses) {
      expect(filterGradebookRows(SORT_ROWS, "", status).length).toBeGreaterThan(0);
    }
  });
});

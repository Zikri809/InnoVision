import { describe, it, expect } from "vitest";
import { filterArchivedClasses } from "../search";

const MOCK_CLASSES = [
  { id: "1", title: "CS 101: Intro to Python (Fall 2026)", join_code: "PY101A", quizCount: 5, archived_at: "2026-01-01" },
  { id: "2", title: "MATH 201: Linear Algebra [Advanced]", join_code: "MTH201", quizCount: 2, archived_at: "2026-01-02" },
  { id: "3", title: "BIO 100 & Chemistry", join_code: "BIO100", quizCount: 0, archived_at: "2026-01-03" },
  { id: "4", title: "Français Avancé: Littérature & Café Culture", join_code: "FRN401", quizCount: 1, archived_at: "2026-01-04" },
  { id: "5", title: null, join_code: "NULL01", quizCount: 0, archived_at: "2026-01-05" },
];

describe("filterArchivedClasses", () => {
  it("returns all classes when query is empty or only whitespace", () => {
    expect(filterArchivedClasses(MOCK_CLASSES, "")).toHaveLength(5);
    expect(filterArchivedClasses(MOCK_CLASSES, "   ")).toHaveLength(5);
  });

  it("performs case-insensitive substring matching on title", () => {
    const results = filterArchivedClasses(MOCK_CLASSES, "python");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
  });

  it("handles multi-word out-of-order token matching", () => {
    const results = filterArchivedClasses(MOCK_CLASSES, "CS 2026");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
  });

  it("handles accented unicode diacritics seamlessly (e.g. francais -> Français, cafe -> Café)", () => {
    const resultsFrench = filterArchivedClasses(MOCK_CLASSES, "francais");
    expect(resultsFrench).toHaveLength(1);
    expect(resultsFrench[0].id).toBe("4");

    const resultsCafe = filterArchivedClasses(MOCK_CLASSES, "cafe");
    expect(resultsCafe).toHaveLength(1);
    expect(resultsCafe[0].id).toBe("4");
  });

  it("handles regex special characters safely without errors", () => {
    expect(() => filterArchivedClasses(MOCK_CLASSES, "(")).not.toThrow();
    expect(() => filterArchivedClasses(MOCK_CLASSES, "[Advanced]")).not.toThrow();
    expect(filterArchivedClasses(MOCK_CLASSES, "[Advanced]")).toHaveLength(1);
  });

  it("trims multiple surrounding and internal whitespace", () => {
    const results = filterArchivedClasses(MOCK_CLASSES, "  linear   algebra  ");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("2");
  });

  it("matches join_code case-insensitively and with padding", () => {
    const results = filterArchivedClasses(MOCK_CLASSES, "  py101a  ");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
  });

  it("handles nullish/undefined fields gracefully without crashing", () => {
    const results = filterArchivedClasses(MOCK_CLASSES, "NULL01");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("5");
  });

  it("preserves immutability of the source classes array", () => {
    const original = Object.freeze([...MOCK_CLASSES]);
    const results = filterArchivedClasses(original, "python");
    expect(results).toHaveLength(1);
    expect(results).not.toBe(original);
  });

  it("returns empty array when no classes match", () => {
    expect(filterArchivedClasses(MOCK_CLASSES, "Nonexistent Subject")).toEqual([]);
    expect(filterArchivedClasses([], "python")).toEqual([]);
  });
});

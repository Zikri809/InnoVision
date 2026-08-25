import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildExportModel } from "./export";
import { buildWorkbook } from "./export-workbook";
import type { WorkbookLabels } from "./export-workbook";
import type { BuildExportInput } from "./export";

const NOW = 1_700_000_000_000;

const labels: WorkbookLabels = {
  sheetResults: "Results",
  sheetKey: "Questions & Key",
  sheetDist: "Choice Distribution",
  colNum: "#",
  colMatric: "Matric No",
  colName: "Name",
  colStatus: "Status",
  colScore: "Score",
  colTotal: "Total",
  colPercent: "%",
  colStarted: "Started",
  colSubmitted: "Submitted",
  colDuration: "Duration",
  colFaceFails: "Face fails",
  colFocusPauses: "Focus pauses",
  colType: "Type",
  colPrompt: "Question",
  unknownStudent: "Student",
  colCorrect: "Correct answer",
  colExplanation: "Explanation",
  colAnswered: "Times answered",
  colTimesCorrect: "Times correct",
  colPercentCorrect: "% correct",
  colOption: "Option",
  colOptionText: "Option text",
  colIsCorrect: "Is correct",
  colChosenCount: "Chosen count",
  colChosenPercent: "% of choosers",
  statusCompleted: "Completed",
  statusFlagged: "Flagged",
  statusAbandoned: "Abandoned",
  statusInProgress: "In progress",
  statusNotStarted: "Not started",
  unanswered: "—",
  generatedLine: "Generated {datetime}",
  classLabel: "Class",
  modeLabel: "Mode",
  truncatedWarning: "Truncated export — showing the first {count} rows only.",
};

function input(): BuildExportInput {
  return {
    quiz: { title: "Quiz 1", mode: "assessment", status: "closed" },
    className: "Section 01",
    generatedAtISO: new Date(NOW).toISOString(),
    questions: [
      {
        id: "q1",
        order_index: 0,
        type: "mcq",
        prompt: "Pick one",
        options: ["Alpha", "Beta"],
        correct_index: 1,
        explanation: "Because.",
      },
    ],
    roster: [
      { student_id: "s1", full_name: "Ali", matric_no: "A23CS0001" },
      { student_id: "s2", full_name: "Beta", matric_no: null },
    ],
    sessions: [
      {
        id: "sess",
        student_id: "s1",
        status: "completed",
        score: 1,
        started_at: new Date(NOW - 60_000).toISOString(),
        submitted_at: new Date(NOW).toISOString(),
        last_activity_at: new Date(NOW).toISOString(),
        face_fail_streak: 0,
        focus_pause_count: 0,
      },
    ],
    answers: [
      { session_id: "sess", question_id: "q1", selected_index: 1, is_correct: true },
    ],
    nowMs: NOW,
  };
}

describe("buildWorkbook (smoke)", () => {
  it("produces a non-empty buffer with the three expected sheets", async () => {
    const model = buildExportModel(input());
    const buffer = await buildWorkbook(model, labels);
    expect(buffer.byteLength).toBeGreaterThan(100);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Results",
      "Questions & Key",
      "Choice Distribution",
    ]);
  });

  it("writes the roster row with matric and per-question cell text", async () => {
    const model = buildExportModel(input());
    const buffer = await buildWorkbook(model, labels);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const results = wb.getWorksheet("Results")!;
    // Row 4 header; data starts at row 5 (no truncation warning).
    expect(results.getCell(4, 2).value).toBe("Matric No");
    expect(results.getCell(5, 2).value).toBe("A23CS0001");
    expect(results.getCell(5, 13).value).toBe("B — Beta");
    // Not-started roster student present in row 6 (status column = 4).
    expect(results.getCell(6, 4).value).toBe("Not started");
  });

  it("marks the correct option on the key sheet", async () => {
    const model = buildExportModel(input());
    const buffer = await buildWorkbook(model, labels);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const key = wb.getWorksheet("Questions & Key")!;
    // Option B column carries the ✓ marker; the letter lands in col 9.
    expect(String(key.getCell(3, 5).value)).toContain("✓");
    expect(key.getCell(3, 9).value).toBe("B");
  });

  it("hides integrity columns for practice mode (Q cells shift left)", async () => {
    const raw = input();
    raw.quiz.mode = "practice";
    const buffer = await buildWorkbook(buildExportModel(raw), labels);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const results = wb.getWorksheet("Results")!;
    // Header: 10 fixed cols + Q1 = 11 wide; col 11 is Face-fails-free.
    expect(results.getCell(4, 10).value).toBe("Duration");
    expect(results.getCell(4, 11).value).toBe("Q1");
    expect(results.getCell(5, 11).value).toBe("B — Beta");
  });

  it("renders the truncation warning at row 5 and data from row 6", async () => {
    const raw = input();
    raw.roster = Array.from({ length: 100 }, (_, i) => ({
      student_id: `s${i}`,
      full_name: `Student ${i}`,
      matric_no: null,
    }));
    raw.sessions = Array.from({ length: 200 }, (_, i) => ({
      id: `sess${i}`,
      student_id: `s${i}`,
      status: "completed" as const,
      score: 0,
      started_at: new Date(NOW).toISOString(),
      submitted_at: new Date(NOW).toISOString(),
      last_activity_at: new Date(NOW).toISOString(),
      face_fail_streak: 0,
      focus_pause_count: 0,
    }));
    const buffer = await buildWorkbook(buildExportModel(raw), labels);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const results = wb.getWorksheet("Results")!;
    expect(String(results.getCell(5, 1).value)).toContain("Truncated");
    // Row 6 holds the first student's serial number.
    expect(results.getCell(6, 1).value).toBe(1);
  });
});

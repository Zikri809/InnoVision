import ExcelJS from "exceljs";
import type { ExportModel } from "./export";
import { optionLetter, summarizeQuestionStats } from "./export";

/**
 * Workbook ASSEMBLY for the lecturer Excel export (PLAN_MATRIC_EXCEL_EXPORT
 * §2.4). Pure-ish: takes the built model + a localized label dictionary and
 * returns xlsx bytes. All user-authored strings were sanitized at the MODEL
 * layer (safeText) — this module must never wrap user text in a `{ formula }`
 * or hyperlink shape (the only ways exceljs executes cell content).
 */

export type WorkbookLabels = {
  sheetResults: string;
  sheetKey: string;
  sheetDist: string;
  colNum: string;
  colMatric: string;
  colName: string;
  colStatus: string;
  colScore: string;
  colTotal: string;
  colPercent: string;
  colStarted: string;
  colSubmitted: string;
  colDuration: string;
  colFaceFails: string;
  colFocusPauses: string;
  colType: string;
  colPrompt: string;
  unknownStudent: string;
  colCorrect: string;
  colExplanation: string;
  colAnswered: string;
  colTimesCorrect: string;
  colPercentCorrect: string;
  colOption: string;
  colOptionText: string;
  colIsCorrect: string;
  colChosenCount: string;
  colChosenPercent: string;
  statusCompleted: string;
  statusFlagged: string;
  statusAbandoned: string;
  statusInProgress: string;
  statusNotStarted: string;
  unanswered: string;
  generatedLine: string;
  classLabel: string;
  modeLabel: string;
  truncatedWarning: string;
};

const HEADER_FILL = "FFF3EDE2"; // clay-warm neutral, matches the app palette
const HEADER_TEXT = "FF3D3D3D";
const CORRECT_GREEN = "FF166534";
const WRONG_RED = "FFB91C1C";
const MAX_WIDTH = 60;

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: HEADER_TEXT } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  row.height = 22;
}

function autoWidth(col: Partial<ExcelJS.Column>): void {
  let max = 10;
  col.eachCell?.({ includeEmpty: false }, (cell) => {
    const len = String(cell.value ?? "").length + 2;
    if (len > max) max = len;
  });
  col.width = Math.min(max, MAX_WIDTH);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function formatDurationSec(sec: number | null): string {
  if (sec === null || sec < 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export async function buildWorkbook(
  model: ExportModel,
  labels: WorkbookLabels,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "InnoVision";
  wb.created = new Date(model.meta.generatedAtISO);

  const statusLabel = (status: ExportModel["students"][number]["status"]): string => {
    switch (status) {
      case "completed":
        return labels.statusCompleted;
      case "flagged":
        return labels.statusFlagged;
      case "abandoned":
        return labels.statusAbandoned;
      case "in_progress":
        return labels.statusInProgress;
      case "not_started":
        return labels.statusNotStarted;
    }
  };

  const contextLine = `${labels.classLabel}: ${model.meta.className ?? "—"}   ·   ${labels.modeLabel}: ${model.meta.mode}   ·   ${labels.generatedLine.replace("{datetime}", formatDateTime(model.meta.generatedAtISO))}`;

  // ── Sheet 1: Results ──────────────────────────────────────────────────────
  const results = wb.addWorksheet(labels.sheetResults, {
    views: [{ state: "frozen", ySplit: 4, xSplit: 3 }],
  });

  const showIntegrity = model.meta.mode === "assessment";
  const headerCells = [
    labels.colNum,
    labels.colMatric,
    labels.colName,
    labels.colStatus,
    labels.colScore,
    labels.colTotal,
    labels.colPercent,
    labels.colStarted,
    labels.colSubmitted,
    labels.colDuration,
    ...(showIntegrity ? [labels.colFaceFails, labels.colFocusPauses] : []),
    ...model.questions.map((q) => `Q${q.index}`),
  ];

  results.mergeCells(1, 1, 1, headerCells.length);
  const titleCell = results.getCell(1, 1);
  titleCell.value = model.meta.quizTitle || "Results";
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { vertical: "middle" };
  results.getRow(1).height = 24;

  results.mergeCells(2, 1, 2, headerCells.length);
  results.getCell(2, 1).value = contextLine;
  results.getCell(2, 1).font = { italic: true, size: 10, color: { argb: "FF6B6B6B" } };

  const headerRow = results.getRow(4);
  headerRow.values = headerCells;
  styleHeaderRow(headerRow);

  if (model.meta.truncated) {
    results.mergeCells(5, 1, 5, headerCells.length);
    const warn = results.getCell(5, 1);
    warn.value = labels.truncatedWarning.replace("{count}", String(Math.max(model.meta.attemptedCount, model.students.length)));
    warn.font = { bold: true, color: { argb: WRONG_RED } };
    warn.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
  }

  model.students.forEach((s, i) => {
    const rowIndex = model.meta.truncated ? 6 + i : 5 + i;
    const row = results.getRow(rowIndex);
    const base = [
      i + 1,
      s.matricNo ?? "",
      // Match the dashboard: blank-name rows (left-class orphans, null-name
      // roster entries) never render as an empty cell on the grade artifact.
      s.fullName || labels.unknownStudent,
      statusLabel(s.status),
      s.score,
      s.total,
      s.percent === null ? null : s.percent / 100,
      s.startedAtISO ? formatDateTime(s.startedAtISO) : "",
      s.submittedAtISO ? formatDateTime(s.submittedAtISO) : "",
      formatDurationSec(s.durationSec),
      ...(showIntegrity ? [s.faceFails ?? "", s.focusPauses ?? ""] : []),
      ...s.answers.map((a) => a ?? labels.unanswered),
    ];
    row.values = base;

    // Percentage column: real numeric percent format (sortable).
    const percentCell = row.getCell(7);
    percentCell.numFmt = "0%";

    // Color the per-question cells by correctness.
    const firstQCol = (showIntegrity ? 12 : 10) + 1;
    s.answerCorrect.forEach((ok, qi) => {
      const cell = row.getCell(firstQCol + qi);
      if (ok === true) cell.font = { color: { argb: CORRECT_GREEN } };
      else if (ok === false) cell.font = { color: { argb: WRONG_RED } };
    });
  });

  results.columns.forEach((col) => autoWidth(col));
  results.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4, column: headerCells.length },
  };

  // ── Sheet 2: Questions & Key ─────────────────────────────────────────────
  const key = wb.addWorksheet(labels.sheetKey, { views: [{ state: "frozen", ySplit: 3 }] });
  key.mergeCells(1, 1, 1, 9);
  const keyTitle = key.getCell(1, 1);
  keyTitle.value = `${model.meta.quizTitle || ""} — ${contextLine}`;
  keyTitle.font = { italic: true, size: 10, color: { argb: "FF6B6B6B" } };

  const stats = summarizeQuestionStats(model);
  const keyHeader = key.getRow(2);
  keyHeader.values = [
    labels.colNum,
    labels.colType,
    labels.colPrompt,
    ...["A", "B", "C", "D", "E"].map((l) => `${labels.colOption} ${l}`),
    labels.colCorrect,
    labels.colExplanation,
    labels.colAnswered,
    labels.colTimesCorrect,
    labels.colPercentCorrect,
  ];
  styleHeaderRow(keyHeader);

  model.questions.forEach((q, i) => {
    const row = key.getRow(3 + i);
    // QT-1: multi rows mark EVERY correct option and the Correct Answer
    // column carries the joined letters ("A,C").
    const optionCols = [0, 1, 2, 3, 4].map((oi) =>
      q.options[oi] != null
        ? `${q.options[oi]}${
            q.correctIndices
              ? q.correctIndices.includes(oi)
                ? " ✓"
                : ""
              : oi === q.correctIndex
                ? " ✓"
                : ""
          }`
        : "",
    );
    row.values = [
      `Q${q.index}`,
      q.type,
      q.prompt,
      ...optionCols,
      q.correctIndices
        ? q.correctIndices.map((i) => optionLetter(i)).join(",")
        : optionLetter(q.correctIndex ?? 0),
      q.explanation ?? "",
      stats[i].timesAnswered,
      stats[i].timesCorrect,
      stats[i].percentCorrect / 100,
    ];
    row.getCell(13).numFmt = "0%";
  });
  key.columns.forEach((col) => autoWidth(col));

  // ── Sheet 3: Choice Distribution ─────────────────────────────────────────
  const dist = wb.addWorksheet(labels.sheetDist, { views: [{ state: "frozen", ySplit: 2 }] });
  dist.mergeCells(1, 1, 1, 7);
  const distTitle = dist.getCell(1, 1);
  distTitle.value = `${model.meta.quizTitle || ""} — ${contextLine}`;
  distTitle.font = { italic: true, size: 10, color: { argb: "FF6B6B6B" } };

  const distHeader = dist.getRow(2);
  distHeader.values = [
    labels.colNum,
    labels.colPrompt,
    labels.colOption,
    labels.colOptionText,
    labels.colIsCorrect,
    labels.colChosenCount,
    labels.colChosenPercent,
  ];
  styleHeaderRow(distHeader);

  let r = 3;
  model.questions.forEach((q, qi) => {
    model.distribution[qi].forEach((d) => {
      const row = dist.getRow(r++);
      row.values = [
        `Q${q.index}`,
        q.prompt,
        optionLetter(d.optionIndex),
        q.options[d.optionIndex] ?? "",
        q.correctIndices
          ? q.correctIndices.includes(d.optionIndex)
            ? "✓"
            : ""
          : d.optionIndex === q.correctIndex
            ? "✓"
            : "",
        d.chosenCount,
        d.chosenPercent / 100,
      ];
      row.getCell(7).numFmt = "0%";
    });
  });
  dist.columns.forEach((col) => autoWidth(col));

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

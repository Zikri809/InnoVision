import { stripBidiControls, OPTION_MAX, PROMPT_MAX } from "./validation";

/**
 * Bulk-import line parser (AP-1, PLAN_R_AUTHORING_PRODUCTIVITY).
 *
 * Grammar — one question per non-empty line, pipe-separated, forgiving:
 *   prompt | optA | optB | [optC] [optD] [optE] | *correctLetter
 * The correct answer is given EITHER as a trailing `*<letter>` cell OR as an
 * asterisk prefix on the option cell itself (`*B) text`, or a bare `*text`
 * whose position marks the answer). A line whose answer cell is a
 * true/false word (true/false/t/f/benar/salah, case-insensitive, with or
 * without the asterisk) builds a `true_false` row with canonical
 * True/False options — `prompt | true`.
 *
 * Deliberately NOT supported: `|` inside text (no escaping — extra cells
 * surface as a distinct per-row problem, not a silent shift), comma-CSV
 * quoting, and explanations (the v1 grammar keeps rows short).
 *
 * Parsing is total: it NEVER throws. Every line yields either a row or a
 * problem — never both. The caller rejects the whole batch atomically when
 * `problems.length > 0` (show-all-problems-before-commit UX).
 */

export type ImportProblemCode =
  | "tooManyRows"
  | "tooFewOptions"
  | "tooManyCells"
  | "emptyCell"
  | "emptyPrompt"
  | "promptTooLong"
  | "optionTooLong"
  | "duplicateOptions"
  | "missingAnswer"
  | "badAnswerMark"
  | "answerOutOfRange"
  | "doubleMark";

export interface ImportProblem {
  /** Original 1-based line number in the pasted text (blank lines counted). */
  line: number;
  code: ImportProblemCode;
  /** Interpolation params for the i18n message (ICU `{max}`). */
  params?: { max: number };
}

export interface ParsedImportRow {
  line: number;
  type: "mcq" | "true_false";
  prompt: string;
  options: string[];
  correctIndex: number;
}

export interface ImportParseResult {
  rows: ParsedImportRow[];
  problems: ImportProblem[];
}

const MAX_OPTIONS = 5;
/** prompt + 5 options + answer cell. */
const MAX_CELLS = 2 + MAX_OPTIONS;
const TF_TRUE = new Set(["true", "t", "benar"]);
const TF_FALSE = new Set(["false", "f", "salah"]);
const ANSWER_LETTERS = "abcde";

type AnswerForm =
  | { kind: "letter"; index: number }
  | { kind: "tf"; isTrue: boolean }
  | { kind: "none" };

function cleanCell(raw: string): string {
  return stripBidiControls(raw).trim();
}

function isTfWord(value: string): boolean {
  const v = value.toLowerCase();
  return TF_TRUE.has(v) || TF_FALSE.has(v);
}

interface MarkedOption {
  text: string;
  /** 0-based answer index when the `*` prefix carries a letter (`*B) …`). */
  letterIndex: number | null;
  /** Plain `*text` marking — the answer is the option's own position. */
  marked: boolean;
}

/** Parse an option cell's leading `*` marking, if any. */
function parseOptionMark(cell: string): MarkedOption {
  if (!cell.startsWith("*")) {
    return { text: cell, letterIndex: null, marked: false };
  }
  const rest = cell.slice(1);
  // `*B) text` / `*B. text` / `*B text` — letter form. The delimiter after
  // the letter is REQUIRED: without it `*always` would corrupt option text
  // into "lways". A bare `*b` (no delimiter, no text) marks the option
  // whose text is literally "b" by position.
  const letterMatch = rest.match(/^([a-eA-E])(?:[\)\.\:]\s*|\s+)(.+)$/);
  if (letterMatch) {
    return {
      text: letterMatch[2].trim(),
      letterIndex: ANSWER_LETTERS.indexOf(letterMatch[1].toLowerCase()),
      marked: true,
    };
  }
  // Bare `*text` — position marking.
  return { text: rest.trim(), letterIndex: null, marked: true };
}

/**
 * Parse pasted pipe-separated question text into preview rows + problems.
 * `maxRows` bounds the batch (the caller passes its remaining quiz capacity
 * so over-cap pastes fail here; extra lines fold into ONE problem rather
 * than one per line).
 */
export function parseImportText(text: string, maxRows = 30): ImportParseResult {
  const rows: ParsedImportRow[] = [];
  const problems: ImportProblem[] = [];
  const lines = text.split(/\r?\n/);
  let overflowReported = false;

  lines.forEach((rawLine, lineIdx) => {
    const line = lineIdx + 1;
    const trimmed = rawLine.trim();
    if (trimmed === "") return;

    if (rows.length >= maxRows) {
      if (!overflowReported) {
        problems.push({ line, code: "tooManyRows", params: { max: maxRows } });
        overflowReported = true;
      }
      return;
    }

    const fail = (code: ImportProblemCode, params?: { max: number }) => {
      problems.push({ line, code, params });
    };

    const cells = trimmed.split("|").map(cleanCell);
    // Tolerate exactly one trailing empty cell (trailing separator habit).
    if (cells.length > 1 && cells[cells.length - 1] === "") {
      cells.pop();
    }

    const prompt = cells[0];
    if (prompt === "") {
      fail("emptyPrompt");
      return;
    }

    // ── Answer extraction ────────────────────────────────────────────────
    const last = cells[cells.length - 1];
    let answer: AnswerForm = { kind: "none" };
    // Cells between the prompt and the answer cell (empty for none-form).
    let optionCells: string[];

    if (last.startsWith("*")) {
      const rest = last.slice(1).trim();
      const letter = rest.length === 1 ? ANSWER_LETTERS.indexOf(rest.toLowerCase()) : -1;
      if (rest === "") {
        fail("badAnswerMark");
        return;
      }
      if (letter >= 0) {
        answer = { kind: "letter", index: letter };
        optionCells = cells.slice(1, -1);
      } else if (isTfWord(rest)) {
        answer = { kind: "tf", isTrue: TF_TRUE.has(rest.toLowerCase()) };
        optionCells = cells.slice(1, -1);
      } else {
        // `*B) Berlin` in the LAST position — not a trailing answer cell,
        // but an option cell carrying its own marking. Fall through to the
        // option-marking form.
        optionCells = cells.slice(1);
      }
    } else if (isTfWord(last)) {
      answer = { kind: "tf", isTrue: TF_TRUE.has(last.toLowerCase()) };
      optionCells = cells.slice(1, -1);
    } else {
      optionCells = cells.slice(1);
    }

    // ── True/false rows (canonical True/False options, no option cells) ──
    if (answer.kind === "tf") {
      const tfMarkCount = optionCells.filter((m) => parseOptionMark(m).marked).length;
      if (tfMarkCount === 0) {
        if (optionCells.length > 0) {
          // Extra cells mean the line was probably an mcq with a mistyped
          // answer cell — surface the pipe problem instead of guessing.
          fail("tooManyCells", { max: MAX_CELLS });
          return;
        }
        const row: ParsedImportRow = {
          line,
          type: "true_false",
          prompt,
          options: ["True", "False"],
          correctIndex: answer.isTrue ? 0 : 1,
        };
        if (validateLengths(row, fail)) {
          rows.push(row);
        }
        return;
      }
      // A tf-looking last cell WITH a marked option cell is an mcq whose
      // option text happens to be "true"/"false" — re-include that cell as
      // an option and fall through to the mcq path.
      optionCells = cells.slice(1);
    }

    // ── MCQ rows ─────────────────────────────────────────────────────────
    const marked = optionCells.map(parseOptionMark);
    const markCount = marked.filter((m) => m.marked).length;

    if (answer.kind === "none" && markCount === 0) {
      fail("missingAnswer");
      return;
    }
    if (answer.kind === "letter" && markCount > 0) {
      fail("doubleMark");
      return;
    }
    if (markCount > 1) {
      fail("doubleMark");
      return;
    }

    if (optionCells.length < 2) {
      fail("tooFewOptions");
      return;
    }
    if (optionCells.length > MAX_OPTIONS) {
      // Almost always a `|` inside option/prompt text — say so explicitly.
      fail("tooManyCells", { max: MAX_CELLS });
      return;
    }
    if (marked.some((m) => m.text === "")) {
      fail("emptyCell");
      return;
    }

    let correctIndex: number;
    if (answer.kind === "letter") {
      correctIndex = answer.index;
    } else {
      const markPos = marked.findIndex((m) => m.marked);
      const mark = marked[markPos];
      // `*B) text` — the letter carries the answer; position ignored.
      correctIndex = mark.letterIndex !== null ? mark.letterIndex : markPos;
    }
    if (correctIndex < 0 || correctIndex >= optionCells.length) {
      fail("answerOutOfRange");
      return;
    }

    const options = marked.map((m) => m.text);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
      fail("duplicateOptions");
      return;
    }

    const row: ParsedImportRow = { line, type: "mcq", prompt, options, correctIndex };
    if (validateLengths(row, fail)) {
      rows.push(row);
    }
  });

  return { rows, problems };
}

/** Returns true when the row is within the Zod-mirrored length limits. */
function validateLengths(
  row: ParsedImportRow,
  fail: (code: ImportProblemCode, params?: { max: number }) => void,
): boolean {
  if (row.prompt.length > PROMPT_MAX) {
    fail("promptTooLong", { max: PROMPT_MAX });
    return false;
  }
  if (row.options.some((o) => o.length > OPTION_MAX)) {
    fail("optionTooLong", { max: OPTION_MAX });
    return false;
  }
  return true;
}

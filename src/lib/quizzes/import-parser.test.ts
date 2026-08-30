import { describe, expect, it } from "vitest";

import {
  parseImportText,
  type ImportProblem,
  type ParsedImportRow,
} from "./import-parser";

/**
 * U-AP1-* — bulk-import line parser (AP-1, PLAN_R_AUTHORING_PRODUCTIVITY).
 * The parser is the client-side gate for the whole batch: rows must map
 * 1:1 onto QuestionInputSchema semantics (2–5 distinct options, correct
 * index in range, prompt/option length caps) so a "valid preview" never
 * 400s at the route boundary.
 */

function rowOf(result: { rows: ParsedImportRow[] }, i = 0): ParsedImportRow {
  return result.rows[i];
}

function codes(result: { problems: ImportProblem[] }): string[] {
  return result.problems.map((p) => p.code);
}

describe("parseImportText — trailing answer-letter cell form", () => {
  it("U-AP1-1 parses a plain 4-option mcq", () => {
    const r = parseImportText("What is 2+2? | 1 | 2 | 3 | 4 | *C");
    expect(r.problems).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(rowOf(r)).toMatchObject({
      line: 1,
      type: "mcq",
      prompt: "What is 2+2?",
      options: ["1", "2", "3", "4"],
      correctIndex: 2,
    });
  });

  it("U-AP1-2 accepts lowercase letters", () => {
    const r = parseImportText("Pick | a | b | *a");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).correctIndex).toBe(0);
  });

  it("U-AP1-3 answers out of range are rejected (*E on 3 options)", () => {
    const r = parseImportText("Pick | a | b | c | *E");
    expect(r.rows).toEqual([]);
    expect(codes(r)).toEqual(["answerOutOfRange"]);
  });
});

describe("parseImportText — asterisk option-prefix marking", () => {
  it("U-AP1-4 parses `*B) text` letter form", () => {
    const r = parseImportText("Capital? | Paris | London | *B) Berlin");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).options).toEqual(["Paris", "London", "Berlin"]);
    expect(rowOf(r).correctIndex).toBe(1);
  });

  it("U-AP1-5 parses `*B. text` and `*B text` variants", () => {
    for (const line of ["Q? | x | *B. y", "Q? | x | *B y"]) {
      const r = parseImportText(line);
      expect(r.problems).toEqual([]);
      expect(rowOf(r).correctIndex).toBe(1);
      expect(rowOf(r).options).toEqual(["x", "y"]);
    }
  });

  it("U-AP1-6 bare `*text` marks by position", () => {
    const r = parseImportText("Q? | one | *two | three");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).options).toEqual(["one", "two", "three"]);
    expect(rowOf(r).correctIndex).toBe(1);
  });

  it("U-AP1-7 bare `*b` on a single-letter option keeps its text", () => {
    const r = parseImportText("Q? | a | *b | c");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).options).toEqual(["a", "b", "c"]);
    expect(rowOf(r).correctIndex).toBe(1);
  });

  it("U-AP1-8 double marking (trailing cell AND option prefix) is rejected", () => {
    const r = parseImportText("Q? | *a | b | *A");
    expect(r.rows).toEqual([]);
    expect(codes(r)).toEqual(["doubleMark"]);
  });

  it("U-AP1-9 multiple marked options build a multi_select row (QT-1)", () => {
    const r = parseImportText("Q? | *one | *two | three");
    expect(codes(r)).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].type).toBe("multi_select");
    expect(r.rows[0].correctIndices).toEqual([0, 1]);
    expect(r.rows[0].correctIndex).toBeUndefined();
  });

  it("U-AP1-9b letter-form multi marks map by letter and emit a sorted set", () => {
    const r = parseImportText("Q? | *C) berlin | paris | *A) rome");
    expect(codes(r)).toEqual([]);
    expect(r.rows[0].type).toBe("multi_select");
    expect(r.rows[0].options).toEqual(["berlin", "paris", "rome"]);
    expect(r.rows[0].correctIndices).toEqual([0, 2]);
  });

  it("U-AP1-9c a multi mark out of range is answerOutOfRange", () => {
    const r = parseImportText("Q? | *one | two | *E) x");
    expect(r.rows).toEqual([]);
    expect(codes(r)).toEqual(["answerOutOfRange"]);
  });

  it("U-AP1-9d a multi row with 5 options is multiTooManyOptions (gesture palm-commit cap)", () => {
    const r = parseImportText("Q? | *one | *two | three | four | five");
    expect(r.rows).toEqual([]);
    expect(codes(r)).toEqual(["multiTooManyOptions"]);
  });

  it("U-AP1-10 an asterisk prefix without any answer is missingAnswer", () => {
    const r = parseImportText("Q? | one | two");
    expect(r.rows).toEqual([]);
    expect(codes(r)).toEqual(["missingAnswer"]);
  });

  it("U-AP1-10b a delimiter-less `*<letter><text>` option is position-marked, not corrupted", () => {
    // `*always` must NOT parse as letter `a` + text `lways` (silent data
    // corruption found in audit round 1).
    const r = parseImportText("Q? | x | *always | y");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).options).toEqual(["x", "always", "y"]);
    expect(rowOf(r).correctIndex).toBe(1);
  });
});

describe("parseImportText — true/false rows", () => {
  it("U-AP1-11 parses `prompt | true` with canonical options", () => {
    const r = parseImportText("The sky is blue | true");
    expect(r.problems).toEqual([]);
    expect(rowOf(r)).toMatchObject({
      type: "true_false",
      prompt: "The sky is blue",
      options: ["True", "False"],
      correctIndex: 0,
    });
  });

  it("U-AP1-12 parses false/t/f and Malay benar/salah", () => {
    for (const [answer, index] of [
      ["false", 1],
      ["FALSE", 1],
      ["t", 0],
      ["F", 1],
      ["benar", 0],
      ["Salah", 1],
    ] as const) {
      const r = parseImportText(`Q? | ${answer}`);
      expect(r.problems).toEqual([]);
      expect(rowOf(r).type).toBe("true_false");
      expect(rowOf(r).correctIndex).toBe(index);
    }
  });

  it("U-AP1-13 accepts the asterisked true/false cell too", () => {
    const r = parseImportText("Q? | *true");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).type).toBe("true_false");
  });

  it("U-AP1-14 a 3-option line ending in true stays mcq", () => {
    const r = parseImportText("Q? | true | false | maybe | *B");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).type).toBe("mcq");
    expect(rowOf(r).correctIndex).toBe(1);
  });

  it("U-AP1-15 true/false with extra option cells is tooManyCells", () => {
    const r = parseImportText("Q? | yes | true");
    expect(r.rows).toEqual([]);
    expect(codes(r)).toEqual(["tooManyCells"]);
  });

  it("U-AP1-15b a marked mcq whose last option is literally 'true' stays mcq", () => {
    const r = parseImportText("Q? | *a | b | true");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).type).toBe("mcq");
    expect(rowOf(r).options).toEqual(["a", "b", "true"]);
    expect(rowOf(r).correctIndex).toBe(0);
  });
});

describe("parseImportText — structure problems", () => {
  it("U-AP1-16 too few options", () => {
    const r = parseImportText("Q? | only | *A");
    expect(codes(r)).toEqual(["tooFewOptions"]);
  });

  it("U-AP1-17 more than 5 options reports the pipe problem", () => {
    const r = parseImportText("Q? | 1 | 2 | 3 | 4 | 5 | 6 | *A");
    expect(codes(r)).toEqual(["tooManyCells"]);
  });

  it("U-AP1-18 an embedded pipe pushing past 5 options is caught", () => {
    // "Choose A | B carefully" is ambiguous, but the error only fires once
    // the split yields MORE than the grammar's cells — here 6 options.
    const r = parseImportText("Choose A | B carefully | a1 | b2 | c3 | d4 | e5 | f6 | *A");
    expect(codes(r)).toEqual(["tooManyCells"]);
  });

  it("U-AP1-19 tolerates exactly one trailing empty cell", () => {
    const r = parseImportText("Q? | a | b | *A |");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).options).toEqual(["a", "b"]);
  });

  it("U-AP1-20 empty cells are a problem, never silently dropped", () => {
    const r = parseImportText("Q? |  | b | *A");
    expect(codes(r)).toEqual(["emptyCell"]);
  });

  it("U-AP1-21 empty prompt is a problem", () => {
    const r = parseImportText("| a | b | *A");
    expect(codes(r)).toEqual(["emptyPrompt"]);
  });

  it("U-AP1-22 a bare `*` cell is a bad answer mark", () => {
    const r = parseImportText("Q? | a | b | *");
    expect(codes(r)).toEqual(["badAnswerMark"]);
  });
});

describe("parseImportText — normalization and limits", () => {
  it("U-AP1-23 strips bidi controls and trims every cell", () => {
    const r = parseImportText("\u202EPrompt\u202C | \u200Bopt\u200F A | B | *a");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).prompt).toBe("Prompt");
    expect(rowOf(r).options[0]).toBe("opt A");
  });

  it("U-AP1-24 duplicate options (case-insensitive) are rejected", () => {
    const r = parseImportText("Q? | Paris | paris | *A");
    expect(codes(r)).toEqual(["duplicateOptions"]);
  });

  it("U-AP1-25 prompt over 2000 chars is rejected with the cap", () => {
    const r = parseImportText(`${"x".repeat(2001)} | a | b | *A`);
    expect(codes(r)).toEqual(["promptTooLong"]);
    expect(r.problems[0].params).toEqual({ max: 2000 });
  });

  it("U-AP1-26 option over 500 chars is rejected with the cap", () => {
    const r = parseImportText(`Q? | ${"x".repeat(501)} | b | *A`);
    expect(codes(r)).toEqual(["optionTooLong"]);
    expect(r.problems[0].params).toEqual({ max: 500 });
  });

  it("U-AP1-27 handles CRLF line endings and skips blank lines", () => {
    const r = parseImportText("Q1? | a | b | *A\r\n\r\n   \r\nQ2? | c | d | *B");
    expect(r.problems).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1].line).toBe(4);
  });

  it("U-AP1-28 problem lines report ORIGINAL 1-based line numbers", () => {
    const r = parseImportText("Q1? | a | b | *A\nbroken line no answer\nQ3? | c | d | *B");
    expect(r.rows).toHaveLength(2);
    expect(r.problems).toEqual([{ line: 2, code: "missingAnswer" }]);
  });

  it("U-AP1-29 caps the batch at maxRows with ONE problem", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Q${i}? | a | b | *A`).join("\n");
    const r = parseImportText(text, 30);
    expect(r.rows).toHaveLength(30);
    expect(codes(r)).toEqual(["tooManyRows"]);
    expect(r.problems[0].params).toEqual({ max: 30 });
  });

  it("U-AP1-30 empty input yields nothing", () => {
    expect(parseImportText("")).toEqual({ rows: [], problems: [] });
    expect(parseImportText("\n \n")).toEqual({ rows: [], problems: [] });
  });

  it("U-AP1-31 a zero-option `Q? | *A` line is tooFewOptions", () => {
    const r = parseImportText("Q? | *A");
    expect(r.rows).toEqual([]);
    expect(codes(r)).toEqual(["tooFewOptions"]);
  });

  it("U-AP1-32 `*B.y` consumes the period as the delimiter", () => {
    const r = parseImportText("Q? | x | *B.y");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).options).toEqual(["x", "y"]);
    expect(rowOf(r).correctIndex).toBe(1);
  });

  it("U-AP1-33 a trailing non-letter mark `*9` degrades to a position-marked option", () => {
    const r = parseImportText("Q? | a | b | *9");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).options).toEqual(["a", "b", "9"]);
    expect(rowOf(r).correctIndex).toBe(2);
  });

  it("U-AP1-34 a bare `true` line is a true/false row whose PROMPT is 'true'", () => {
    const r = parseImportText("true");
    expect(r.problems).toEqual([]);
    expect(rowOf(r).type).toBe("true_false");
    expect(rowOf(r).prompt).toBe("true");
  });
});

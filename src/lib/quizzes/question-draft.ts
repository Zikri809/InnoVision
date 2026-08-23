/**
 * Pure option-array draft reducers for question editing.
 *
 * Extracted because the identical logic lived copy-pasted in
 * quiz-builder-client.tsx and edit-question-dialog.tsx. Pure functions over
 * `string[]` + correctIndex — trivially unit-testable, framework-free.
 *
 * Invariants maintained by every operation:
 *  - options.length stays within [2, 5]
 *  - option strings are trimmed non-empty at the call site's discretion
 *  - correctIndex always points at an EXISTING option (shifts on removal /
 *    move so the marked answer follows its option)
 */

export const QUESTION_OPTIONS_MAX = 5;

export type OptionDraftOp =
  | { kind: "set"; index: number; value: string }
  | { kind: "add" }
  | { kind: "remove"; index: number }
  | { kind: "move"; from: number; to: number };

export interface OptionDraftState {
  options: string[];
  correctIndex: number;
}

function clampCorrect(index: number, length: number): number {
  if (index < 0) return 0;
  if (index >= length) return Math.max(0, length - 1);
  return index;
}

/** Apply one draft operation; returns the new state (inputs untouched). */
export function applyOptionDraftOp(
  state: OptionDraftState,
  op: OptionDraftOp,
): OptionDraftState {
  switch (op.kind) {
    case "set": {
      if (op.index < 0 || op.index >= state.options.length) return state;
      const options = [...state.options];
      options[op.index] = op.value;
      return { ...state, options };
    }

    case "add": {
      if (state.options.length >= QUESTION_OPTIONS_MAX) return state;
      const options = [...state.options, ""];
      return { ...state, options };
    }

    case "remove": {
      // Never drop below 2 options (mcq floor mirrors the DB CHECK).
      if (state.options.length <= 2) return state;
      if (op.index < 0 || op.index >= state.options.length) return state;
      const options = state.options.filter((_, i) => i !== op.index);
      let correctIndex = state.correctIndex;
      if (op.index < correctIndex) correctIndex -= 1;
      else if (op.index === correctIndex) correctIndex = 0;
      return { options, correctIndex: clampCorrect(correctIndex, options.length) };
    }

    case "move": {
      const { from, to } = op;
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= state.options.length ||
        to >= state.options.length
      ) {
        return state;
      }
      const options = [...state.options];
      const [moved] = options.splice(from, 1);
      options.splice(to, 0, moved);
      // The marked answer follows its option.
      let correctIndex = state.correctIndex;
      if (correctIndex === from) correctIndex = to;
      else if (from < correctIndex && to >= correctIndex) correctIndex -= 1;
      else if (from > correctIndex && to <= correctIndex) correctIndex += 1;
      return { options, correctIndex };
    }
  }
}

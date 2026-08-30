/**
 * Pure option-array draft reducers for question editing.
 *
 * Extracted because the identical logic lived copy-pasted in
 * quiz-builder-client.tsx and edit-question-dialog.tsx. Pure functions over
 * `string[]` + the answer key — trivially unit-testable, framework-free.
 *
 * Invariants maintained by every operation:
 *  - options.length stays within [2, 5]
 *  - option strings are trimmed non-empty at the call site's discretion
 *  - the answer key always points at EXISTING options: for single-answer
 *    questions `correctIndex` shifts on removal / move so the marked answer
 *    follows its option; for multi-select (QT-1) `correctIndices` is the
 *    sorted+distinct set that follows its options (removal filters the index
 *    and decrements higher ones; move re-maps through the permutation)
 */

export const QUESTION_OPTIONS_MAX = 5;

export type OptionDraftOp =
  | { kind: "set"; index: number; value: string }
  | { kind: "add" }
  | { kind: "remove"; index: number }
  | { kind: "move"; from: number; to: number };

export interface OptionDraftState {
  options: string[];
  /** Single-answer key. Undefined on multi-select drafts. */
  correctIndex?: number;
  /** QT-1: sorted+distinct multi answer key. Undefined on single-answer drafts. */
  correctIndices?: number[];
}

function clampCorrect(index: number, length: number): number {
  if (index < 0) return 0;
  if (index >= length) return Math.max(0, length - 1);
  return index;
}

/** Map a single index through an option removal (undefined when it WAS it). */
function remapRemove(index: number, removed: number): number {
  if (index === removed) return -1; // caller decides the replacement
  if (index > removed) return index - 1;
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
      if (state.correctIndices !== undefined) {
        // QT-1: the SET follows its options — dropped members fall away,
        // higher members shift down; stays sorted+distinct by construction.
        const correctIndices = state.correctIndices
          .map((i) => remapRemove(i, op.index))
          .filter((i) => i >= 0)
          .sort((a, b) => a - b);
        return { options, correctIndices };
      }
      let correctIndex = state.correctIndex ?? 0;
      const remapped = remapRemove(correctIndex, op.index);
      if (remapped === -1) correctIndex = 0;
      else correctIndex = remapped;
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
      // The marked answer(s) follow their option(s): re-derive each key index
      // from where its option landed after the splice.
      const landedAt = (idx: number): number => {
        if (idx === from) return to;
        if (from < idx && idx <= to) return idx - 1;
        if (to <= idx && idx < from) return idx + 1;
        return idx;
      };
      if (state.correctIndices !== undefined) {
        const correctIndices = [
          ...new Set(state.correctIndices.map(landedAt)),
        ].sort((a, b) => a - b);
        return { options, correctIndices };
      }
      return { options, correctIndex: landedAt(state.correctIndex ?? 0) };
    }
  }
}

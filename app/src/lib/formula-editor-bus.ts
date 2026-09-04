/**
 * Bridge between "the caret is in a formula" and the formula editor dialog.
 *
 * Same shape as `table-editor-bus.ts` and for the same reason: the editor is
 * per-pane, the dialog is one modal, and the pane hands over its own write-back
 * closure so the dialog never has to know which editor it is talking to.
 */
import { reactive } from 'vue';

export interface FormulaEditSession {
  /** LaTeX between the delimiters — empty when inserting a new formula. */
  latex: string;
  /** Whether the existing span was `$$…$$`. */
  display: boolean;
  /** Labels already defined in this document, for the reference picker. */
  labels: Array<{ label: string; display: string }>;
  /**
   * Write the formula back. The pane adds the delimiters, because only it can
   * see what surrounds the span — a display formula in the middle of a
   * sentence must not be broken onto its own lines.
   */
  apply: (latex: string, display: boolean) => void;
}

export const formulaEditor = reactive<{ session: FormulaEditSession | null }>({
  session: null,
});

export function openFormulaEditor(session: FormulaEditSession): void {
  formulaEditor.session = session;
}

export function closeFormulaEditor(): void {
  formulaEditor.session = null;
}

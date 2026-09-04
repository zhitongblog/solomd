/**
 * The bridge between "the caret is in a table" and the grid editor dialog.
 *
 * The editor is per-pane; the dialog is one modal for the whole window. Rather
 * than have App.vue reach into whichever pane has focus, the pane that found
 * the table hands over its own `apply` closure — so the dialog never needs to
 * know which editor it is talking to, or whether that editor is CodeMirror or
 * the Windows plain-textarea one.
 */
import { reactive } from 'vue';

export interface TableEditSession {
  /** The table's Markdown source, exactly as it appears in the document. */
  source: string;
  /** Write an edited table back over the original range. */
  apply: (markdown: string) => void;
}

export const tableEditor = reactive<{ session: TableEditSession | null }>({
  session: null,
});

export function openTableEditor(session: TableEditSession): void {
  tableEditor.session = session;
}

export function closeTableEditor(): void {
  tableEditor.session = null;
}

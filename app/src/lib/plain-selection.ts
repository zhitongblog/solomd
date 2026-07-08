/**
 * #126 — selection bridge for the Windows plain-textarea editor.
 *
 * The toolbar "AI rewrite" button reads the selection from CodeMirror views
 * (`EditorView.findFromDOM`), but since v4.6.4 Windows has no CodeMirror at
 * all — the plain block editor replaced it — so the button always failed with
 * "Select some text first" even with a visible selection (the ⌘/Ctrl+J keymap
 * was re-wired in v4.7.0; the button was not).
 *
 * Editor.vue registers a getter per mounted plain editor; UI chrome (Toolbar)
 * asks the registry as a fallback after the CodeMirror scan finds nothing.
 * Textareas retain selectionStart/End on blur, so the selection survives the
 * toolbar click.
 */
export interface PlainSelection {
  selection: string;
  from: number;
  to: number;
}

type Getter = () => PlainSelection | null;

const getters = new Set<Getter>();

/** Register a selection getter; returns the unregister function. */
export function registerPlainSelectionGetter(fn: Getter): () => void {
  getters.add(fn);
  return () => {
    getters.delete(fn);
  };
}

/** First non-empty selection across all mounted plain editors, or null. */
export function getPlainSelection(): PlainSelection | null {
  for (const g of getters) {
    const s = g();
    if (s && s.from !== s.to && s.selection.trim()) return s;
  }
  return null;
}

/**
 * Pointer-drag awareness for CodeMirror 6 view plugins.
 *
 * Several of our plugins (`cm-live-preview`, `cm-live-blocks`,
 * `cm-live-render`) rebuild their decoration set on every `selectionSet`
 * update so markdown markers or widgets toggle as the cursor crosses lines.
 * That works fine for keyboard movement and single clicks, but during a
 * mouse drag-selection it tears down and re-mounts DOM nodes (especially
 * `Decoration.replace` widgets with `contenteditable="false"`) under the
 * pointer. On Windows WebView2 that mid-drag mutation breaks pointer
 * capture — the OS focus leaves the editor and the drag aborts.
 *
 * This module owns one editor-wide "is the user currently drag-selecting"
 * flag, exposed via `isDragging(state)`. Plugins call it in their
 * `update()` and skip selection-only rebuilds while it's true. When the
 * pointer is released we dispatch `dragEndEffect`; plugins should treat
 * that as a forced rebuild so widgets reflect the final selection.
 *
 * Wire `dragAwareExtension()` into the editor once (Editor.vue) and any
 * number of plugins can read it.
 */

import { StateEffect, StateField, Transaction } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

// `dragStartEffect` is exported only so dev / self-test code can verify the
// field is wired; production code never imports it directly.
export const dragStartEffect = StateEffect.define<null>();
export const dragEndEffect = StateEffect.define<null>();

const dragField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(dragStartEffect)) return true;
      if (e.is(dragEndEffect)) return false;
    }
    // Any document edit means the user is typing, not drag-selecting. Clear
    // the flag unconditionally so a stale "dragging" state can never outlive
    // an edit and keep decoration rebuilds frozen (would look like the editor
    // stopped updating / "can't input"). Cheap belt-and-suspenders on top of
    // the pointer-based clearing below.
    if (tr.docChanged && value) return false;
    return value;
  },
});

const dragTracker = ViewPlugin.fromClass(
  class {
    cleanup: (() => void) | null = null;

    constructor(view: EditorView) {
      // A primary-button pointer is pressed inside the editor (a *potential*
      // drag). We deliberately do NOT freeze rebuilds yet — a bare click must
      // never freeze them, otherwise a click whose `pointerup` we never see
      // (native text-drag, right-click menu, Windows WebView2 pointer-capture
      // loss) would leave the editor frozen until the next click. That was
      // the v4.3.x "can't type, then it fixes itself" report.
      let pointerDown = false;

      const start = () => {
        if (!view.state.field(dragField, false)) {
          view.dispatch({ effects: dragStartEffect.of(null) });
        }
      };
      const end = () => {
        pointerDown = false;
        if (view.state.field(dragField, false)) {
          view.dispatch({ effects: dragEndEffect.of(null) });
        }
      };

      const onDown = (e: PointerEvent) => {
        // Touch drags don't reproduce the WebView2 capture loss and CM has
        // its own touch handling; only guard mouse / pen, primary button.
        if (e.pointerType === 'touch' || e.button !== 0) return;
        pointerDown = true;
      };
      const onMove = (e: PointerEvent) => {
        if (!pointerDown) return;
        // Self-heal: a move with the primary button no longer held means the
        // `pointerup` was missed — bail out of the (potential) drag now.
        if ((e.buttons & 1) === 0) { end(); return; }
        // Genuine button-held drag-select in progress → freeze rebuilds.
        start();
      };

      view.scrollDOM.addEventListener('pointerdown', onDown);
      // `window` (not `document`) so we still see movement / release even if
      // the user dragged out onto the scrollbar / titlebar / menubar.
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      // Losing the window (app switch, Cmd-Tab) can swallow the pointerup.
      window.addEventListener('blur', end);
      this.cleanup = () => {
        view.scrollDOM.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
      };
    }

    destroy() {
      this.cleanup?.();
      this.cleanup = null;
    }
  },
);

export function dragAwareExtension() {
  return [dragField, dragTracker];
}

export function isDragging(state: EditorState): boolean {
  return state.field(dragField, false) ?? false;
}

export function isDragEndTransaction(tr: Transaction): boolean {
  return tr.effects.some((e) => e.is(dragEndEffect));
}

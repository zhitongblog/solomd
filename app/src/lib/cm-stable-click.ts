/**
 * #167 — stationary clicks must stay clicks, even when the layout shifts
 * mid-press.
 *
 * Repro: switch to a tab whose live-block widgets are still rendering
 * (mermaid SVG, images without intrinsic size yet) and click. The widget
 * finishes while the button is down, content below it shifts, and
 * CodeMirror's default mouse-selection re-queries the (unchanged) pointer
 * position against the NEW geometry — the head lands lines away from the
 * anchor and the user gets a phantom multi-line selection instead of a
 * caret. High frequency right after tab switches because `setState`
 * rebuilds every async widget.
 *
 * This style keeps the press anchored to the DOC position captured at
 * mousedown. Until the pointer genuinely travels (>4px), `get` always
 * returns a plain cursor there and `update` refuses the re-query that the
 * default style runs after every view update. Once a real drag starts,
 * behavior matches the default (including re-query, which edge-autoscroll
 * needs). Modified/double/triple clicks and drags of an existing selection
 * fall through to CodeMirror's built-in handling.
 */

import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

const DRAG_THRESHOLD_PX = 4;

export function stableClickSelection() {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.detail > 1) return null;
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null;
    const startX = event.clientX;
    const startY = event.clientY;
    let startPos = view.posAtCoords({ x: startX, y: startY }, false);
    if (startPos == null) return null;
    // A press inside the current selection may be the start of a text
    // drag-and-drop — let the default style decide.
    const sel = view.state.selection.main;
    if (!sel.empty && startPos >= sel.from && startPos <= sel.to) return null;
    let dragging = false;
    let lastHead = startPos;
    return {
      get(cur: MouseEvent) {
        if (
          !dragging &&
          (Math.abs(cur.clientX - startX) > DRAG_THRESHOLD_PX ||
            Math.abs(cur.clientY - startY) > DRAG_THRESHOLD_PX)
        ) {
          dragging = true;
        }
        if (!dragging) return EditorSelection.single(startPos!);
        const pos = view.posAtCoords({ x: cur.clientX, y: cur.clientY }, false);
        if (pos != null) lastHead = pos;
        return EditorSelection.single(startPos!, lastHead);
      },
      update(update) {
        if (update.docChanged) {
          startPos = update.changes.mapPos(startPos!);
          lastHead = update.changes.mapPos(lastHead);
        }
        return dragging;
      },
    };
  });
}

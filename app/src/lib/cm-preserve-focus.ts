import { EditorView } from '@codemirror/view';

/**
 * Focus through CodeMirror so its native DOM selection matches editor state.
 * WKWebView can scroll to the old native caret despite preventScroll, so keep
 * the viewport as well — including when it is at the document start (#586).
 */
export function focusCodeMirrorWithoutScroll(view: Pick<EditorView, 'focus' | 'scrollDOM'>): void {
  const scroller = view.scrollDOM;
  const top = scroller.scrollTop;
  const left = scroller.scrollLeft;
  try {
    view.focus();
  } finally {
    if (scroller.scrollTop !== top) scroller.scrollTop = top;
    if (scroller.scrollLeft !== left) scroller.scrollLeft = left;
  }
}

/**
 * CodeMirror normally focuses before applying a mouse selection. In WebKit
 * that can scroll to the previous caret, moving the text under the pointer.
 * Focus without scrolling before its selection styles run, then let the
 * normal click/drag handling place the cursor. Returning null does not claim
 * the selection, consume the event, or change modified/multi-click behavior.
 */
export function preservePointerFocusScroll() {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button === 0 && !view.hasFocus) focusCodeMirrorWithoutScroll(view);
    return null;
  });
}

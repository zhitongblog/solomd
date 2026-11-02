/**
 * Double-click on Chinese / Japanese / Korean text selects a word, not the
 * whole run between two punctuation marks.
 *
 * CodeMirror's built-in double-click groups characters by its char
 * categorizer, which files every CJK ideograph under "word" — so with no
 * spaces to break on, double-clicking 这是 in 这是一句中文。selects
 * 这是一句中文. The ⌘D / "Select Word" command already segments with
 * `Intl.Segmenter` (lib/editor-commands.ts `wordRangeAt`); this style makes
 * the mouse agree with it. Only double-clicks that land on CJK take this path;
 * everything else (Latin words, punctuation, modified clicks) falls through to
 * CodeMirror's default handling, unchanged.
 */

import { EditorView } from '@codemirror/view';
import { EditorSelection, type EditorState } from '@codemirror/state';
import { wordRangeAt } from './editor-commands';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

interface Range {
  from: number;
  to: number;
}

/** The CJK word covering the character at `charPos`, in doc offsets. */
export function cjkWordAt(state: EditorState, charPos: number): Range | null {
  if (charPos < 0 || charPos >= state.doc.length) return null;
  const line = state.doc.lineAt(charPos);
  if (charPos >= line.to) return null;
  const off = charPos - line.from;
  const r = wordRangeAt(line.text, off, off + 1);
  if (!r) return null;
  const text = line.text.slice(r.from, r.to);
  if (!CJK.test(text)) return null;
  return { from: r.from + line.from, to: r.to + line.from };
}

/**
 * `posAtCoords` snaps to the nearest character boundary, so a press on the
 * right half of a glyph returns the position after it. Recover the glyph the
 * pointer is actually over.
 */
function charAtCoords(view: EditorView, x: number, y: number, precise = true): number | null {
  const pos = precise ? view.posAtCoords({ x, y }) : view.posAtCoords({ x, y }, false);
  if (pos == null) return null;
  const line = view.state.doc.lineAt(pos);
  if (pos > line.from) {
    const after = view.coordsAtPos(pos, 1);
    if (pos >= line.to || (after && x < after.left)) return pos - 1;
  }
  return pos;
}

/**
 * Range for a triple-click line selection (and optional drag across lines),
 * excluding the trailing newline character so copying a triple-clicked line
 * does not append an extra blank line.
 */
export function tripleClickLineRange(
  state: EditorState,
  anchorPos: number,
  headPos: number = anchorPos,
): { anchor: number; head: number } {
  const aClamped = Math.max(0, Math.min(anchorPos, state.doc.length));
  const hClamped = Math.max(0, Math.min(headPos, state.doc.length));
  const anchorLine = state.doc.lineAt(aClamped);
  const headLine = state.doc.lineAt(hClamped);
  if (headLine.from < anchorLine.from) {
    return { anchor: anchorLine.to, head: headLine.from };
  }
  return { anchor: anchorLine.from, head: headLine.to };
}

export function cjkDoubleClickSelection() {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0) return null;
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null;
    if (event.detail >= 3) {
      const startPos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
      if (startPos == null) return null;
      let anchorPos = startPos;
      let lastPos = startPos;
      return {
        get(cur: MouseEvent) {
          const curPos = view.posAtCoords({ x: cur.clientX, y: cur.clientY }, false);
          if (curPos != null) lastPos = curPos;
          const range = tripleClickLineRange(view.state, anchorPos, lastPos);
          return EditorSelection.single(range.anchor, range.head);
        },
        update(update) {
          if (update.docChanged) {
            anchorPos = update.changes.mapPos(anchorPos, 1);
            lastPos = update.changes.mapPos(lastPos, 1);
          }
          return true;
        },
      };
    }
    if (event.detail !== 2) return null;
    const c = charAtCoords(view, event.clientX, event.clientY);
    if (c == null) return null;
    let anchor = cjkWordAt(view.state, c);
    if (!anchor) return null;
    let lastHc: number | null = null;
    return {
      get(cur: MouseEvent) {
        const hc = charAtCoords(view, cur.clientX, cur.clientY, false) ?? lastHc;
        if (hc != null) lastHc = hc;
        if (hc == null || (hc >= anchor!.from && hc < anchor!.to)) {
          return EditorSelection.single(anchor!.from, anchor!.to);
        }
        // Dragging after the double-click extends by whole words where the
        // pointer is over one, by characters elsewhere.
        const w = cjkWordAt(view.state, hc);
        if (hc < anchor!.from) return EditorSelection.single(anchor!.to, w ? w.from : hc);
        return EditorSelection.single(anchor!.from, w ? w.to : hc + 1);
      },
      update(update) {
        if (update.docChanged) {
          anchor = {
            from: update.changes.mapPos(anchor!.from, 1),
            to: update.changes.mapPos(anchor!.to, -1),
          };
          if (lastHc != null) lastHc = update.changes.mapPos(lastHc, 1);
        }
        return true;
      },
    };
  });
}

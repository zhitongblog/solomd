import type { DecorationSet, ViewUpdate } from '@codemirror/view';

/**
 * IME composition guard (#108).
 *
 * While the user is mid-composition — e.g. typing pinyin with Sogou or the
 * Microsoft IME on Windows — any ViewPlugin that rebuilds its decorations on
 * the composing line tears down and re-creates that line's DOM. Windows
 * WebView2 reacts to the mid-composition DOM swap by silently dropping the
 * active composition, which is the "一会能打上一会打不上 / 吃字" symptom users hit
 * with Sogou (issue #108).
 *
 * The fix mirrors the existing drag-freeze pattern in cm-drag-aware.ts: while
 * `view.composing` is true we don't rebuild decorations at all, we only map the
 * current set through the update's doc changes so its positions stay valid.
 * CodeMirror fires a normal `docChanged` update the moment composition commits
 * (compositionend), so the decorations rebuild correctly one tick later — the
 * frozen frame is never visible to the user because it only lasts while the IME
 * candidate window is open on that same line.
 *
 * Returns the mapped (frozen) decoration set to assign when composition is
 * active, or `null` when the caller should rebuild normally.
 */
export function frozenDuringComposition(
  update: ViewUpdate,
  current: DecorationSet,
): DecorationSet | null {
  // (1) While the IME candidate window is open, never rebuild — the
  // mid-composition DOM swap silently drops the active composition on
  // WebView2 (the original #108 "吃字" symptom).
  if (update.view.composing) return current.map(update.changes);
  // (2) ALSO defer the rebuild on the composition-COMMIT transaction itself.
  // CodeMirror marks the commit `docChanged` with userEvent
  // `input.type.compose`, and it arrives the tick `view.composing` has just
  // flipped back to false — so guard (1) misses it. Rebuilding here swaps the
  // line's DOM and collides with the *next* rapid composition, which WebView2
  // then aborts. With Sogou that dropped every other Chinese-punctuation
  // press → "中文标点符号要输入两次" (must type twice). We map positions
  // through the change instead; the next non-composition update (a cursor
  // move, the next character) rebuilds the decorations cleanly one tick later.
  if (update.transactions.some((tr) => tr.isUserEvent('input.type.compose'))) {
    return current.map(update.changes);
  }
  return null;
}

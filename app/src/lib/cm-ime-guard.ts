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
  if (!update.view.composing) return null;
  return current.map(update.changes);
}

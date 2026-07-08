import { StateEffect, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, type DecorationSet, type ViewUpdate } from '@codemirror/view';

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
  if (!isImeComposing(update)) return null;
  return current.map(update.changes);
}

let imeComposing = false;
let imeFreezeActive = false;
let imeIdleTimer: ReturnType<typeof setTimeout> | null = null;
const isWindowsImeHost =
  typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);

export const imeSafeFlushEffect = StateEffect.define<void>();

export function isImeComposingActive(): boolean {
  return imeComposing || imeFreezeActive;
}

/**
 * Best-effort IME guard for ViewPlugins.
 *
 * CodeMirror's `view.composing` is the main signal, but the companion
 * state field can flip on the same event loop turn slightly earlier for
 * some update sequences. Checking both avoids a narrow "first keystroke"
 * window where a decoration rebuild can still sneak through.
 */
export function isImeComposing(update: ViewUpdate): boolean {
  return update.view.composing || imeComposing || imeFreezeActive;
}

export function isImeSafeFlushTransaction(tr: Transaction): boolean {
  return tr.effects.some((effect) => effect.is(imeSafeFlushEffect));
}

function holdImeFreeze(view: EditorView, composing: boolean) {
  imeComposing = composing;
  if (!isWindowsImeHost) return;
  imeFreezeActive = true;
  if (imeIdleTimer) clearTimeout(imeIdleTimer);
  imeIdleTimer = setTimeout(() => {
    imeIdleTimer = null;
    if (imeComposing) return;
    imeFreezeActive = false;
    view.dispatch({ effects: imeSafeFlushEffect.of() });
  }, composing ? 240 : 180);
}

/**
 * Tracks native composition events in editor state so StateField-based
 * decoration producers can also freeze during IME input. CodeMirror exposes
 * `view.composing` to ViewPlugins, but block widgets must be provided from a
 * StateField, where there is no EditorView.
 */
export function imeCompositionGuard(): Extension {
  return [
    EditorView.domEventHandlers({
      compositionstart(_event, view) {
        holdImeFreeze(view, true);
        return false;
      },
      beforeinput(event: InputEvent, view) {
        if (
          event.isComposing ||
          event.inputType === 'insertCompositionText' ||
          event.inputType === 'deleteCompositionText'
        ) {
          holdImeFreeze(view, true);
        } else if (
          event.inputType === 'insertText' ||
          event.inputType === 'deleteContentBackward' ||
          event.inputType === 'deleteContentForward'
        ) {
          holdImeFreeze(view, false);
        }
        return false;
      },
      compositionend(_event, view) {
        imeComposing = false;
        holdImeFreeze(view, false);
        return false;
      },
      compositioncancel(_event, view) {
        imeComposing = false;
        holdImeFreeze(view, false);
        return false;
      },
    }),
  ];
}

/**
 * StateField companion to `frozenDuringComposition`. While composition is
 * active, keep the current DecorationSet and only map it through document
 * changes. When composition ends, return null so the caller can rebuild.
 */
export function frozenFieldDuringComposition(
  tr: Transaction,
  current: DecorationSet,
): DecorationSet | null {
  if (!imeComposing && !imeFreezeActive) return null;
  return current.map(tr.changes);
}

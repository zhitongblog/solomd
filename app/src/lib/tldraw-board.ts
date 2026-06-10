/**
 * tldraw-board.ts — the clean, tldraw-free shared surface for the whiteboard
 * feature. It re-exports the pure markdown helpers from `tldraw-markdown.ts`
 * and owns the framework-agnostic `BoardThemeTokens` type so that consumers
 * (the CM widget, the preview pipeline, the overlay) can be fully typed
 * WITHOUT importing `tldraw-runtime.ts` (which dynamic-imports the real tldraw
 * package and therefore is the only file vue-tsc flags as missing-module).
 *
 * Keeping the theme type here — not in tldraw-runtime.ts — means every caller
 * compiles cleanly and the tldraw dependency is isolated to a single adapter.
 */

export {
  findTldrawFences,
  serializeTldrawFence,
  parseTldrawFence,
  isTldrawFenceInfo,
  fenceLengthForSnapshot,
  newBoardId,
  emptyBoardFence,
  parseSnapshotJson,
  TLDRAW_DEFAULT_HEIGHT,
} from './tldraw-markdown';
export type { TldrawFence, TldrawFenceMatch } from './tldraw-markdown';

/** Framework-agnostic theme tokens handed to the tldraw runtime adapter. */
export interface BoardThemeTokens {
  /** 'light' | 'dark' — drives tldraw's colorScheme. */
  colorScheme: 'light' | 'dark';
  /** BCP-47 locale (e.g. 'en', 'zh') for tldraw's UI. */
  locale: string;
}

import { findTldrawFences, serializeTldrawFence } from './tldraw-markdown';

/**
 * Splice a new snapshot (and optional height/width) into the ```tldraw fence
 * with `boardId`, returning the updated source. ONLY that fence is rewritten —
 * everything else in the note is byte-identical. The fence attributes
 * (id/height/width) are preserved unless overridden. Returns the original
 * source unchanged when no matching board is found (e.g. the fence was deleted
 * out from under a debounced edit — the stale-block race guard).
 *
 * Used by the editor writeback (CM widget → tabs.setContent) and the overlay.
 */
export function replaceBoardSnapshot(
  source: string,
  boardId: string,
  snapshot: string,
  dims?: { height?: string; width?: string },
): string {
  const fences = findTldrawFences(source);
  // Prefer an exact id match; fall back to the sole board when id is empty
  // (a freshly inserted board the user hasn't saved yet may serialize before
  // the id round-trips). Never touch the wrong board when several exist.
  let target = fences.find((f) => f.boardId === boardId && boardId !== '');
  if (!target && (boardId === '' || fences.length === 1)) {
    target = fences[0];
  }
  if (!target) return source;
  const rewritten = serializeTldrawFence({
    boardId: target.boardId || boardId,
    height: dims?.height ?? target.height,
    width: dims?.width ?? target.width,
    snapshot,
  });
  return source.slice(0, target.from) + rewritten + source.slice(target.to);
}

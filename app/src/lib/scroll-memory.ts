/**
 * Shared per-tab scroll & caret memory (#467, #406).
 *
 * Kept at module scope rather than inside `<script setup>` of `Editor.vue` /
 * `Preview.vue` so that switching view modes (`liveEdit` ↔ `edit` ↔ `split` ↔
 * `preview` ↔ `reading` — which mounts/unmounts `<Editor>`, `<Preview>`, or
 * `<TileRoot>`) never garbage-collects the remembered scroll and caret state
 * of open tabs.
 */

export interface TabCaretSnapshot {
  caret: number;
  scrollTop: number;
  /** 1-based source line at the top of the viewport. */
  topLine?: number;
  /** Active block index in the Windows plain-live block editor. */
  activeBlock?: number;
  /** Caret offset inside the active block in the Windows plain-live editor. */
  blockCaret?: number;
  /** #486 — Document offset of the visual anchor line (caret line if in view, else top visible line). */
  anchorPos?: number;
  /** #486 — Visual Y offset (`block.top - scrollTop`) of `anchorPos` relative to the viewport top. */
  anchorViewportTop?: number;
}

export const tabCaretMemory = new Map<string, TabCaretSnapshot>();

export const previewScrollMemory = new Map<string, number>();

export const tabTopLineMemory = new Map<string, number>();

export interface ViewportLineAnchor {
  /** 1-based source line of the anchor (caret line if visible in viewport, else top visible line). */
  line: number;
  /** Visual distance in px from the top of the scroll container to the anchor line. */
  offsetTop: number;
}

/** #487 — Remember the visual viewport offset of the active line when switching view modes. */
export const tabViewportAnchorMemory = new Map<string, ViewportLineAnchor>();


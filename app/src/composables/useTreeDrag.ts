import { ref } from 'vue';

/**
 * Shared drag state for the file tree (#290 / #267).
 *
 * It lives in its own module because the tree is two components in one file:
 * `<script setup>` owns the move itself, while the recursive `FileTreeNode`
 * is declared in a plain `<script>` block and can't close over setup's
 * bindings. Both import from here instead of prop-drilling drag state through
 * every level of the tree.
 *
 * ★ The drag is driven by POINTER events, not the HTML5 Drag and Drop API.
 * This app has learned that twice already — #86 (tab reorder) and #131
 * (sidebar pane reorder) both started on HTML5 DnD and had to be rewritten:
 * the webview ships with `dragDropEnabled: true` because the app needs the
 * native OS file-drop ("drop a file to open it", image drop), and that native
 * handler swallows in-page drags. `dragstart` still fires, which is what makes
 * it look like it works; `dragover` and `drop` never arrive.
 */

/** Absolute path of the node being dragged, or null when nothing is. */
export const dragPath = ref<string | null>(null);

/** Whether the dragged node is a folder — the drop handler needs it after
 *  the drag state has already been cleared. */
export const dragIsDir = ref(false);

/** Folder path currently highlighted as the drop target, or null. */
export const dropTarget = ref<string | null>(null);

/** Set for one click after a real drag, so the trailing click doesn't also
 *  open the file / toggle the folder that was just dropped. Consumed by the
 *  click handler, the same way PaneTabBar does it. */
export const suppressClick = ref(false);

export function endDrag() {
  dragPath.value = null;
  dragIsDir.value = false;
  dropTarget.value = null;
}

/** The separator this path is written with — Windows paths keep backslashes. */
export function sepOf(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

export function parentDir(p: string): string {
  return p.replace(/[\\/][^\\/]+$/, '');
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * Whether dropping `from` into the folder `dest` is a legal move. Rejected:
 *   - dropping onto the folder it already lives in (a no-op that would still
 *     flash a toast and refresh the tree),
 *   - dropping a folder onto itself or anywhere inside its own subtree
 *     (the OS refuses this with a localized errno, so we catch it first and
 *     never show the drop cursor for it).
 */
export function canDropInto(from: string, dest: string): boolean {
  if (!from || !dest) return false;
  if (dest === from) return false;
  if (parentDir(from) === dest) return false;
  const withSep = from.endsWith(sepOf(from)) ? from : from + sepOf(from);
  if (dest.startsWith(withSep)) return false;
  return true;
}

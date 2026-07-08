/**
 * v4.6.1 F2 — open / close surface for the dedicated TypeLensView.
 *
 * Same event-based model as `useBasesView` / `useInboxView` / `useSavedViews`:
 * this composable owns no state. It dispatches `window` CustomEvents that
 * App.vue listens for and toggles a local boolean to swap `TypeLensView` in
 * for `TileRoot`. The open event carries the canonical type name so the view
 * knows which type's members to list. Keeping it event-based means App.vue
 * wires the listeners in a single block and we never touch an off-limits store.
 *
 * Events:
 *   - `solomd:open-type-lens`  (detail: { typeName }) → show TypeLensView
 *   - `solomd:close-type-lens`                        → back to the editor
 */

export interface UseTypeLens {
  /** Show the full-pane lens for one type, listing its members. */
  openTypeLens(typeName: string): void;
  /** Return to the normal editor view. */
  closeTypeLens(): void;
}

export const TYPE_LENS_OPEN_EVENT = 'solomd:open-type-lens';
export const TYPE_LENS_CLOSE_EVENT = 'solomd:close-type-lens';

export function useTypeLens(): UseTypeLens {
  function openTypeLens(typeName: string) {
    window.dispatchEvent(
      new CustomEvent(TYPE_LENS_OPEN_EVENT, { detail: { typeName } }),
    );
  }
  function closeTypeLens() {
    window.dispatchEvent(new CustomEvent(TYPE_LENS_CLOSE_EVENT));
  }
  return { openTypeLens, closeTypeLens };
}

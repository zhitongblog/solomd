/**
 * Tiny composable that exposes the public surface for opening / closing the
 * Bases (YAML properties table) view.
 *
 * Integration model: this composable does NOT own state. It dispatches DOM
 * events on `window` that App.vue listens for and toggles a local boolean to
 * swap `BasesView` in for `TileRoot`. Keeping it event-based means we don't
 * have to modify any of the off-limits stores/components — App.vue can wire
 * the listener in a single line.
 *
 * Events:
 *   - `solomd:open-bases`  → show BasesView
 *   - `solomd:close-bases` → hide BasesView (back to editor)
 *
 * Usage from a command:
 *   const { openBases } = useBasesView();
 *   openBases();
 */

export interface UseBasesView {
  /** Show the Bases properties table in place of the editor. */
  openBases(): void;
  /** Return to the normal editor view. */
  closeBases(): void;
  /** Toggle. */
  toggleBases(): void;
}

export const BASES_OPEN_EVENT = 'solomd:open-bases';
export const BASES_CLOSE_EVENT = 'solomd:close-bases';

export function useBasesView(): UseBasesView {
  function openBases() {
    window.dispatchEvent(new CustomEvent(BASES_OPEN_EVENT));
  }
  function closeBases() {
    window.dispatchEvent(new CustomEvent(BASES_CLOSE_EVENT));
  }
  function toggleBases() {
    // Convention: anyone listening should treat a re-dispatch of "open" as
    // a toggle if it's already open. We use a dedicated toggle event so the
    // listener can decide.
    window.dispatchEvent(new CustomEvent('solomd:toggle-bases'));
  }
  return { openBases, closeBases, toggleBases };
}

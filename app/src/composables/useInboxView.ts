/**
 * v4.6 F6 — open / close surface for the dedicated InboxView.
 *
 * Same event-based model as `useBasesView`: this composable owns no state, it
 * just dispatches `window` CustomEvents that App.vue listens for and toggles a
 * local boolean to swap `InboxView` in for `TileRoot`. Keeping it event-based
 * means App.vue wires the listeners in a single block and we don't touch any
 * off-limits store.
 *
 * Events:
 *   - `solomd:open-inbox`  → show InboxView
 *   - `solomd:close-inbox` → hide InboxView (back to the editor)
 */

export interface UseInboxView {
  /** Show the dedicated Inbox workflow view in place of the editor. */
  openInbox(): void;
  /** Return to the normal editor view. */
  closeInbox(): void;
}

export const INBOX_OPEN_EVENT = 'solomd:open-inbox';
export const INBOX_CLOSE_EVENT = 'solomd:close-inbox';

export function useInboxView(): UseInboxView {
  function openInbox() {
    window.dispatchEvent(new CustomEvent(INBOX_OPEN_EVENT));
  }
  function closeInbox() {
    window.dispatchEvent(new CustomEvent(INBOX_CLOSE_EVENT));
  }
  return { openInbox, closeInbox };
}

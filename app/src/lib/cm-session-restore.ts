/**
 * Session-restore extension for CodeMirror 6.
 *
 * Debounces doc-change updates and persists the buffer to
 * `localStorage` under `solomd.session.<tabId>`. On editor mount, the
 * Editor component is responsible for reading the saved value and
 * re-dispatching it into the doc if the tab was otherwise empty.
 *
 * This extension also exposes small helpers so the caller can read &
 * clear the saved session in one place.
 */

import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

const KEY_PREFIX = 'solomd.session.';
const DEBOUNCE_MS = 500;

export function sessionKey(tabId: string): string {
  return KEY_PREFIX + tabId;
}

export function readSession(tabId: string): string | null {
  try {
    return localStorage.getItem(sessionKey(tabId));
  } catch {
    return null;
  }
}

export function clearSession(tabId: string): void {
  try {
    localStorage.removeItem(sessionKey(tabId));
  } catch {
    /* ignore */
  }
}

export function writeSession(tabId: string, content: string): void {
  try {
    localStorage.setItem(sessionKey(tabId), content);
  } catch {
    /* quota, ignore */
  }
}

export function sessionRestoreExtension(tabId: string) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(_view: EditorView) {}

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (this.timer) clearTimeout(this.timer);
        const content = update.state.doc.toString();
        this.timer = setTimeout(() => {
          writeSession(tabId, content);
          this.timer = null;
        }, DEBOUNCE_MS);
      }

      destroy() {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
      }
    },
  );
}

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

/**
 * A trailing-edge debounce that can be flushed. The session snapshot used to
 * be a bare `setTimeout` that `destroy()` cancelled, so whatever was typed in
 * the last 500 ms before a quit, a window close or a tab switch never reached
 * storage and was missing after the restart.
 */
export function createDebouncedWrite<T>(
  write: (value: T) => void,
  delayMs: number,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
) {
  let handle: unknown = null;
  let pending: { value: T } | null = null;
  const flush = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    write(value);
  };
  return {
    schedule(value: T) {
      pending = { value };
      if (handle !== null) timers.clear(handle);
      handle = timers.set(flush, delayMs);
    },
    /** Write the pending value now, if there is one. */
    flush,
    get pending() {
      return pending !== null;
    },
  };
}

/** Dispatched before saves and window closes (useFiles.ts, App.vue) so every
 *  debounced edit reaches the store and storage first. */
const FLUSH_EVENT = 'solomd:flush-content-sync';

export function sessionRestoreExtension(tabId: string) {
  return ViewPlugin.fromClass(
    class {
      private writer = createDebouncedWrite<string>(
        (content) => writeSession(tabId, content),
        DEBOUNCE_MS,
      );
      private onFlush = () => this.writer.flush();

      constructor(_view: EditorView) {
        window.addEventListener(FLUSH_EVENT, this.onFlush);
        window.addEventListener('pagehide', this.onFlush);
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        this.writer.schedule(update.state.doc.toString());
      }

      destroy() {
        // Flush, don't drop: destroy runs on tab switch, editor teardown and
        // window close, and the pending snapshot is the newest text there is.
        this.writer.flush();
        window.removeEventListener(FLUSH_EVENT, this.onFlush);
        window.removeEventListener('pagehide', this.onFlush);
      }
    },
  );
}

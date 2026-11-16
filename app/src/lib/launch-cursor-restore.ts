/**
 * Restore a session's cursor only while the user has not taken control of the
 * editor. Mounting needs a short delay, but a click during that delay must
 * never be overwritten by the old cursor (and its scroll-into-view request) (#586).
 */
interface Cursor {
  line: number;
  col: number;
}

interface CursorEditor {
  setCaret?: (line: number, col: number) => void;
  gotoLine?: (line: number) => void;
}

interface RestoreOptions {
  getTabId: () => string | undefined;
  canRestore: () => boolean;
  getEditor: () => CursorEditor | null;
  takeCursor: (tabId: string) => Cursor | null;
  hasViewportMemory: (tabId: string) => boolean;
}

export function createLaunchCursorRestore(
  options: RestoreOptions,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
) {
  let timer: unknown = null;
  const cancel = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  return {
    schedule() {
      cancel();
      const tabId = options.getTabId();
      if (!tabId || !options.canRestore()) return;
      timer = timers.set(() => {
        timer = null;
        if (options.getTabId() !== tabId || !options.canRestore()) return;
        const editor = options.getEditor();
        if (!editor) return;
        const cursor = options.takeCursor(tabId);
        if (!cursor || (cursor.line <= 1 && cursor.col <= 1) || options.hasViewportMemory(tabId)) return;
        if (editor.setCaret) editor.setCaret(cursor.line, cursor.col);
        else editor.gotoLine?.(cursor.line);
      }, 150);
    },
    userIntent() {
      cancel();
      const tabId = options.getTabId();
      if (tabId) options.takeCursor(tabId);
    },
    cancel,
  };
}

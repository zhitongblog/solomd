/**
 * Deletes you can take back.
 *
 * A delete used to be final the moment it was confirmed: the file went to the
 * OS trash and getting it back meant leaving the app and digging through
 * Finder / Explorer. This holds the delete for a few seconds instead, so an
 * "Undo" in the toast is just a cancelled timer.
 *
 * The file is not touched during that window — nothing is staged, copied or
 * moved. That makes the failure mode the safe one: if the app is killed while
 * a delete is pending, the delete simply never happens. (Staging into a
 * holding area would invert that — a crash would leave the file somewhere the
 * user never put it.) The cost is that the file still exists on disk for those
 * few seconds; the tree hides it so the app stays honest about what the user
 * asked for.
 *
 * Committing early is important, not optional: a pending path must be flushed
 * before anything else touches it (creating a file with the same name, a
 * rename onto it, switching workspaces, quitting), or the timer would fire
 * later and delete whatever now sits at that path.
 */

import { ref } from 'vue';

export interface PendingDelete {
  path: string;
  name: string;
  isDir: boolean;
  /** Runs the real delete. */
  commit: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

/** How long an undo stays on offer. Long enough to read the toast and react,
 *  short enough that the file isn't lingering on disk in a state the user
 *  believes is gone. */
export const UNDO_WINDOW_MS = 8000;

// Module-level: one queue for the whole window, shared by every caller.
const pending = ref<Map<string, PendingDelete>>(new Map());

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** True when `path` (or an ancestor of it) is waiting to be deleted, and so
 *  should not be shown as though it still exists. */
export function isDeletePending(path: string): boolean {
  if (pending.value.size === 0) return false;
  const p = normalize(path);
  for (const key of pending.value.keys()) {
    if (p === key || p.startsWith(key + '/')) return true;
  }
  return false;
}

export function usePendingDeletes() {
  /**
   * Hide `path` and delete it after the undo window closes.
   *
   * Scheduling a second delete for a path that is already pending flushes the
   * first one — the timers must never stack up on the same target.
   */
  async function schedule(entry: {
    path: string;
    name: string;
    isDir: boolean;
    commit: () => Promise<void>;
    delayMs?: number;
  }): Promise<void> {
    const key = normalize(entry.path);
    await flush(key);
    const timer = setTimeout(() => {
      void run(key);
    }, entry.delayMs ?? UNDO_WINDOW_MS);
    pending.value.set(key, {
      path: entry.path,
      name: entry.name,
      isDir: entry.isDir,
      commit: entry.commit,
      timer,
    });
    // Reassign so Vue sees the change (Map mutation is not reactive on its own).
    pending.value = new Map(pending.value);
  }

  /** Take the delete back. Returns false if the window already closed. */
  function undo(path: string): boolean {
    const key = normalize(path);
    const item = pending.value.get(key);
    if (!item) return false;
    clearTimeout(item.timer);
    pending.value.delete(key);
    pending.value = new Map(pending.value);
    return true;
  }

  /** Run a pending delete now rather than waiting out the window. */
  async function flush(path: string): Promise<void> {
    const key = normalize(path);
    if (!pending.value.has(key)) return;
    const item = pending.value.get(key)!;
    clearTimeout(item.timer);
    await run(key);
  }

  /** Run every pending delete now — workspace switch, window close. */
  async function flushAll(): Promise<void> {
    const keys = [...pending.value.keys()];
    for (const key of keys) {
      const item = pending.value.get(key);
      if (item) clearTimeout(item.timer);
      await run(key);
    }
  }

  /** Commit anything pending at or under `path`, so a create / rename onto
   *  that path can't be undone by a timer that fires afterwards. */
  async function flushUnder(path: string): Promise<void> {
    const p = normalize(path);
    const keys = [...pending.value.keys()].filter(
      (k) => k === p || k.startsWith(p + '/') || p.startsWith(k + '/'),
    );
    for (const key of keys) await flush(key);
  }

  return { pending, schedule, undo, flush, flushAll, flushUnder, isDeletePending };
}

async function run(key: string): Promise<void> {
  const item = pending.value.get(key);
  if (!item) return;
  // Drop it from the queue first: a commit that throws must not leave the path
  // hidden forever, and the tree refresh below will bring it back into view.
  pending.value.delete(key);
  pending.value = new Map(pending.value);
  await item.commit();
}

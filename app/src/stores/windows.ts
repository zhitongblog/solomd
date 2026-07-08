import { defineStore } from 'pinia';

/**
 * windows.ts — auxiliary-window registry (#103).
 *
 * The "Open file in new window" feature spawns extra Tauri webview windows.
 * Three bugs made those windows un-restorable across restarts:
 *   1. They used timestamp labels (`solomd-<Date.now()>`), so the
 *      window-state plugin couldn't match them on relaunch.
 *   2. Nothing tracked which auxiliary windows *should* exist, so only the
 *      main window ever came back.
 *   3. Each window's tabs were persisted to the same per-folder bucket, so
 *      multiple windows on one folder clobbered each other.
 *
 * This store is the persistent registry. It lives in localStorage under
 * `solomd.windows.v1` and is shared by every window instance (localStorage
 * is per-origin, and all SoloMD windows share the same origin). The main
 * window reads it on startup to re-spawn auxiliary windows; auxiliary
 * windows register themselves on open and unregister on close.
 *
 * Window labels are deterministic — `solomd-window-<N>` — assigned from a
 * monotonic counter persisted here. Stable labels let
 * `tauri-plugin-window-state` restore each window's size/position reliably.
 */

const LS_KEY = 'solomd.windows.v1';

/** Stable label prefix for auxiliary windows. The main window keeps the
 *  fixed `main` label assigned by tauri.conf.json. */
export const AUX_LABEL_PREFIX = 'solomd-window-';

/** True for any auxiliary (non-main) window label. */
export function isAuxLabel(label: string): boolean {
  return label.startsWith(AUX_LABEL_PREFIX);
}

export interface AuxWindowEntry {
  /** The file path this window was opened to show (its initial document). */
  path: string;
  /** The workspace folder this window's tabs are scoped to, if any. */
  folder: string | null;
}

interface WindowsState {
  /** Monotonic counter for assigning stable auxiliary window labels. */
  counter: number;
  /** Registry of auxiliary windows that should persist across restarts,
   *  keyed by their stable label. Entries are removed when the user
   *  explicitly closes a window. */
  registry: Record<string, AuxWindowEntry>;
}

function load(): WindowsState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WindowsState>;
      return {
        counter: typeof parsed.counter === 'number' ? parsed.counter : 0,
        registry:
          parsed.registry && typeof parsed.registry === 'object'
            ? (parsed.registry as Record<string, AuxWindowEntry>)
            : {},
      };
    }
  } catch {}
  return { counter: 0, registry: {} };
}

export const useWindowsStore = defineStore('windows', {
  state: (): WindowsState => load(),
  getters: {
    /** All registered auxiliary window labels. */
    auxLabels(state): string[] {
      return Object.keys(state.registry);
    },
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({ counter: this.counter, registry: this.registry }),
        );
      } catch {}
    },
    /** Reload from localStorage. Other windows mutate the same key, so the
     *  in-memory copy can go stale; callers that need a fresh view (e.g. the
     *  main window restoring on startup) call this first. */
    reload() {
      const fresh = load();
      this.counter = fresh.counter;
      this.registry = fresh.registry;
    },
    /** Allocate the next stable auxiliary window label and return it. The
     *  counter is persisted immediately so two near-simultaneous opens can't
     *  collide on a label. */
    nextAuxLabel(): string {
      this.reload();
      this.counter += 1;
      const label = `${AUX_LABEL_PREFIX}${this.counter}`;
      this.persist();
      return label;
    },
    /** Record that an auxiliary window with `label` is open, showing `path`
     *  (scoped to `folder`). Persisted so the main window can re-spawn it. */
    register(label: string, entry: AuxWindowEntry) {
      this.reload();
      this.registry[label] = entry;
      this.persist();
    },
    /** Drop an auxiliary window from the registry — called when the user
     *  explicitly closes it, so it isn't resurrected on the next launch. */
    unregister(label: string) {
      this.reload();
      if (label in this.registry) {
        delete this.registry[label];
        this.persist();
      }
    },
  },
});

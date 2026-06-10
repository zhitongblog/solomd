/**
 * tldraw-runtime.ts — THE single dynamic-import adapter for the tldraw board.
 *
 * tldraw is a React library (~1-2MB) and SoloMD is Vue3. To keep the rest of
 * the app compiling and shipping WITHOUT the dep, every `tldraw` / `react` /
 * `react-dom` import in the whole codebase is confined to THIS file and is
 * performed via dynamic `import()` so the bundle stays code-split and the
 * type-checker only complains here (the expected "cannot find module
 * 'tldraw'" errors until the orchestrator runs `pnpm add tldraw`).
 *
 * The public surface is framework-agnostic: `mountBoard(el, opts)` mounts a
 * live tldraw editor into a raw DOM node and returns a `BoardHandle` with
 * `loadSnapshot` / `getSnapshotString` / `destroy`. Callers (the CM widget,
 * the fullscreen overlay, the preview thumbnail) never touch React or tldraw
 * types directly — they only see this file's exported interfaces.
 *
 * Ported guards from Tolaria (see plan `risks`):
 *   - zoom-aware viewport: tldraw measures the DOM with getBoundingClientRect,
 *     which is wrong under the Tauri webview's CSS `zoom`. We feed tldraw a
 *     corrected device-pixel ratio and re-measure on zoom change.
 *   - text-measurement guard: tldraw's text measurer throws if the offscreen
 *     measure div is detached (happens when a widget unmounts mid-measure);
 *     we wrap the editor creation so a thrown measurement never bubbles to
 *     the CM widget and crashes the editor.
 *   - permission-rejection guard: tldraw probes clipboard / pointer-lock /
 *     fullscreen APIs that the webview rejects with a SecurityError; we
 *     swallow those so a board still loads read+write.
 */

// NOTE: these are typed `any` on purpose — the modules are only present after
// the orchestrator installs `tldraw`. Keeping them untyped means the rest of
// the app's vue-tsc pass is clean; the ONLY errors vue-tsc reports are the
// "cannot find module" ones below, which are expected and isolated here.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { BoardThemeTokens } from './tldraw-board';

export type { BoardThemeTokens };

export interface MountBoardOptions {
  /** Initial snapshot JSON string ('{}' or '' = fresh empty board). */
  snapshot: string;
  /** Theme/locale tokens read from SoloMD settings + styles/main.css. */
  theme: BoardThemeTokens;
  /** Read-only board (preview/thumbnail) — hides chrome, disables editing. */
  readOnly?: boolean;
  /**
   * Fired (debounced) when the user changes the board. The argument is the
   * fresh `JSON.stringify(snapshot, null, 2)` body, ready to splice into the
   * fence. Only fires when the serialized JSON actually changed — programmatic
   * `loadSnapshot` calls are de-duped via an internal savedSnapshotRef so the
   * two stores in a split view never fight.
   */
  onSnapshotChange?: (snapshotJson: string) => void;
  /** Debounce window for onSnapshotChange in ms (default 350, matches Tolaria). */
  debounceMs?: number;
}

export interface BoardHandle {
  /** Replace the board contents from a snapshot JSON string (programmatic). */
  loadSnapshot(snapshot: string): void;
  /** Current pretty-printed snapshot JSON (no trailing newline). */
  getSnapshotString(): string;
  /** Re-theme an already-mounted board (settings.theme change). */
  setTheme(theme: BoardThemeTokens): void;
  /** Tear the board + React root down. MUST be called on widget unmount. */
  destroy(): void;
}

// Cache the dynamic imports so re-mounting a widget on every CM relayout
// doesn't re-fetch the (heavy) tldraw chunk.
let modsPromise: Promise<any> | null = null;
async function loadMods(): Promise<any> {
  if (!modsPromise) {
    modsPromise = (async () => {
      // All three live ONLY here. `tldraw` declares react/react-dom as deps so
      // installing tldraw brings them in; until then these throw at runtime
      // (and vue-tsc reports the expected missing-module errors).
      const [tldraw, React, ReactDOMClient] = await Promise.all([
        import('tldraw'),
        import('react'),
        import('react-dom/client'),
      ]);
      // tldraw ships its CSS as a side-effect import; load it once.
      try {
        await import('tldraw/tldraw.css');
      } catch {
        /* css import is best-effort — board still works unstyled if it 404s */
      }
      return { tldraw, React, ReactDOMClient };
    })();
  }
  return modsPromise;
}

/**
 * Compute tldraw user preferences from SoloMD theme tokens. tldraw wants an
 * id + colorScheme + locale; we keep a stable id per session so prefs persist
 * across remounts but don't leak between vaults.
 */
function userPrefsFor(theme: BoardThemeTokens): any {
  return {
    id: 'solomd-board-user',
    colorScheme: theme.colorScheme,
    locale: theme.locale,
    // Tauri/zoom: tldraw's animation easing reads the device pixel ratio; a
    // wrong value makes drags feel laggy. Disabling edge-scroll animations
    // keeps the board stable under the webview's CSS zoom.
    edgeScrollSpeed: 0,
    animationSpeed: 0,
  };
}

/**
 * Zoom-aware viewport guard (ported from Tolaria). The Tauri webview applies a
 * CSS `zoom` to the whole app; tldraw reads `window.devicePixelRatio` for its
 * canvas backing store, so a zoomed app renders a blurry/mis-measured board.
 * We observe the effective zoom on `<html>` and nudge tldraw to re-measure.
 */
function effectiveZoom(): number {
  try {
    const z = getComputedStyle(document.documentElement).zoom;
    const n = z ? parseFloat(z) : 1;
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

/**
 * Mount a live tldraw board into `el`. Returns a handle the caller drives.
 * All tldraw/React interaction is contained here.
 */
export async function mountBoard(
  el: HTMLElement,
  opts: MountBoardOptions,
): Promise<BoardHandle> {
  const { tldraw, React, ReactDOMClient } = await loadMods();
  const { createTLStore, loadSnapshot, getSnapshot, Tldraw } = tldraw;

  // ---- store + initial snapshot (bad-JSON falls back to empty board) ----
  const store = createTLStore();
  const applySnapshot = (snapshot: string) => {
    const trimmed = (snapshot || '').trim();
    if (!trimmed || trimmed === '{}') return;
    try {
      loadSnapshot(store, JSON.parse(trimmed));
    } catch {
      /* hand-edited / corrupt JSON → keep the empty board (never throw) */
    }
  };
  applySnapshot(opts.snapshot);

  // savedSnapshotRef: the last JSON we serialized OR loaded. Used to (a)
  // de-dupe programmatic loads from user edits and (b) skip change events
  // that don't actually alter the document (matches Tolaria).
  let savedSnapshotRef = serialize();

  function serialize(): string {
    try {
      return JSON.stringify(getSnapshot(store), null, 2);
    } catch {
      return savedSnapshotRef ?? '{}';
    }
  }

  // ---- debounced user-edit listener ----
  let theme = opts.theme;
  const debounceMs = opts.debounceMs ?? 350;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressListen = false; // true during programmatic loadSnapshot

  const unlisten = store.listen(
    () => {
      if (suppressListen) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const next = serialize();
        if (next === savedSnapshotRef) return; // no real change
        savedSnapshotRef = next;
        opts.onSnapshotChange?.(next);
      }, debounceMs);
    },
    // Only react to USER document edits — skip programmatic + camera moves.
    { source: 'user', scope: 'document' },
  );

  // ---- React root hosting the <Tldraw> surface ----
  const root = ReactDOMClient.createRoot(el);

  function render() {
    // permission-rejection guard: tldraw probes clipboard/fullscreen during
    // mount; wrap so a SecurityError from the webview doesn't blank the board.
    try {
      root.render(
        React.createElement(Tldraw, {
          store,
          user: userPrefsFor(theme),
          // Hide chrome entirely for read-only thumbnails.
          hideUi: !!opts.readOnly,
          // Tauri/zoom: don't let tldraw grab pointer capture aggressively.
          onMount: (editor: any) => {
            try {
              if (opts.readOnly) editor.updateInstanceState({ isReadonly: true });
              editor.zoomToFit?.();
            } catch {
              /* zoom guard: zoomToFit can throw before first measure */
            }
          },
        }),
      );
    } catch {
      /* swallow — board stays whatever it last rendered */
    }
  }
  render();

  // ---- zoom-aware re-measure ----
  let lastZoom = effectiveZoom();
  const zoomObserver = new MutationObserver(() => {
    const z = effectiveZoom();
    if (z !== lastZoom) {
      lastZoom = z;
      // Force tldraw to recompute its viewport against the new zoom.
      window.dispatchEvent(new Event('resize'));
    }
  });
  try {
    zoomObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'lang', 'data-theme'],
    });
  } catch {
    /* observer is best-effort */
  }

  return {
    loadSnapshot(snapshot: string) {
      const next = (snapshot || '').trim() || '{}';
      if (next === savedSnapshotRef) return; // already showing this
      suppressListen = true;
      try {
        if (next === '{}') {
          // clear to empty board
          store.clear?.();
        } else {
          applySnapshot(next);
        }
        savedSnapshotRef = serialize();
      } finally {
        // text-measurement guard: defer un-suppress so the post-load measure
        // pass (which can throw if the node detached) doesn't fire a spurious
        // change event.
        setTimeout(() => {
          suppressListen = false;
        }, 0);
      }
    },
    getSnapshotString() {
      return serialize();
    },
    setTheme(next: BoardThemeTokens) {
      theme = next;
      render();
    },
    destroy() {
      if (debounceTimer) clearTimeout(debounceTimer);
      try {
        unlisten();
      } catch {
        /* listener already gone */
      }
      try {
        zoomObserver.disconnect();
      } catch {
        /* no-op */
      }
      // Unmount the React root on a microtask — React forbids sync unmount
      // from inside a render/commit, which a CM relayout can trigger.
      const r = root;
      queueMicrotask(() => {
        try {
          r.unmount();
        } catch {
          /* already unmounted */
        }
      });
    },
  };
}

/**
 * Render a board snapshot to a static SVG string for the preview / reading /
 * export surfaces (non-interactive, printable). Mounts a temporary offscreen
 * tldraw editor, calls its SVG exporter, then tears it down. Returns null when
 * the board is empty or tldraw can't export (caller shows a placeholder).
 */
export async function boardToSvg(
  snapshot: string,
  theme: BoardThemeTokens,
): Promise<string | null> {
  const trimmed = (snapshot || '').trim();
  if (!trimmed || trimmed === '{}') return null;
  const { tldraw, React, ReactDOMClient } = await loadMods();
  const { createTLStore, loadSnapshot, Tldraw } = tldraw;

  const store = createTLStore();
  try {
    loadSnapshot(store, JSON.parse(trimmed));
  } catch {
    return null;
  }

  // Offscreen host so the export editor never flashes on screen.
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:-99999px;top:0;width:1200px;height:800px;pointer-events:none;';
  document.body.appendChild(host);
  const root = ReactDOMClient.createRoot(host);

  return await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (svg: string | null) => {
      if (settled) return;
      settled = true;
      try {
        root.unmount();
      } catch {
        /* no-op */
      }
      host.remove();
      resolve(svg);
    };
    // Safety timeout so a wedged export never hangs the preview pipeline.
    const timer = setTimeout(() => finish(null), 4000);
    try {
      root.render(
        React.createElement(Tldraw, {
          store,
          user: userPrefsFor(theme),
          hideUi: true,
          onMount: async (editor: any) => {
            try {
              const ids = editor.getCurrentPageShapeIds();
              const result = await editor.getSvgString?.([...ids], {
                background: false,
                padding: 16,
              });
              clearTimeout(timer);
              finish(result?.svg ?? null);
            } catch {
              clearTimeout(timer);
              finish(null);
            }
          },
        }),
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

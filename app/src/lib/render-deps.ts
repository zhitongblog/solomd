/**
 * KaTeX and highlight.js, loaded after the first paint instead of with it.
 *
 * Both used to be static imports of `markdown.ts` (and KaTeX of
 * `cm-live-blocks.ts`), which put the math typesetter and 36 grammars into
 * the entry chunk — compiled on every launch before anything is drawn,
 * whether or not the note has a formula or a code fence in it. KaTeX was in
 * there twice, too: the ESM build for the editor and the CJS build behind
 * markdown-it-katex, with mhchem registered only on the first — so `\ce{}`
 * never rendered in the preview of a production build. Same move as
 * `mermaid-lazy.ts`, with one difference: these are used *synchronously*
 * (markdown-it's `highlight` hook, a widget's `toDOM()`), so callers cannot
 * await them. Instead:
 *
 *   - `preloadRenderDeps()` starts both imports once the app has painted, so
 *     in practice they are ready before the user scrolls to a formula.
 *   - A sync caller that gets there first uses `getKatex()` / `getHljs()`,
 *     finds `null`, renders the plain source, and the load it kicks off ends
 *     with `onRenderDepsChange` listeners re-rendering (preview, both
 *     editors). `renderDepsVersion()` is the cache-key ingredient for that.
 *   - Async callers (exports, slideshow) just `await loadRenderDeps()`.
 *
 * Kept free of Vue so `markdown.ts` still runs under plain `node --test`.
 */
import type katexNS from 'katex';
import type { HLJSApi } from 'highlight.js';

type Katex = typeof katexNS;

let katex: Katex | null = null;
let hljs: HLJSApi | null = null;
let katexLoading: Promise<Katex> | null = null;
let hljsLoading: Promise<HLJSApi> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch (e) {
      console.error('[render-deps] listener failed', e);
    }
  }
}

export function loadKatex(): Promise<Katex> {
  if (!katexLoading) {
    katexLoading = Promise.all([
      import('katex'),
      // mhchem (`\ce`, `\pu`) registers its macros on the KaTeX singleton at
      // import time, so it must be in before the first render is announced.
      // Fetched alongside rather than after: it imports the same instance.
      // @ts-ignore — side-effect module, no types shipped
      import('katex/contrib/mhchem'),
    ]).then(([m]) => {
      katex = m.default;
      bump();
      return katex;
    });
    // A failed chunk load must not wedge every later render on a rejected
    // promise: forget it so the next request retries.
    katexLoading.catch((e) => {
      console.error('[render-deps] katex failed to load', e);
      katexLoading = null;
    });
  }
  return katexLoading;
}

export function loadHljs(): Promise<HLJSApi> {
  if (!hljsLoading) {
    hljsLoading = import('./hljs-setup').then((m) => {
      hljs = m.createHljs();
      bump();
      return hljs;
    });
    hljsLoading.catch((e) => {
      console.error('[render-deps] highlight.js failed to load', e);
      hljsLoading = null;
    });
  }
  return hljsLoading;
}

/** Both modules — for callers that render once and can wait (exports). */
export async function loadRenderDeps(): Promise<void> {
  await Promise.all([loadKatex(), loadHljs()]);
}

/** The loaded module, or null (and a load is started). Never blocks. */
export function getKatex(): Katex | null {
  if (!katex) void loadKatex().catch(() => {});
  return katex;
}

export function getHljs(): HLJSApi | null {
  if (!hljs) void loadHljs().catch(() => {});
  return hljs;
}

/** Bumps each time a module finishes loading — part of render cache keys. */
export function renderDepsVersion(): number {
  return version;
}

/** Called after each module loads. Returns the unsubscribe function. */
export function onRenderDepsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Start both loads once the first contentful paint has happened and the main
 * thread is idle — compiling ~400 KB earlier would compete with that paint,
 * which is the whole point of splitting them out. A frame alone is not
 * enough: the first frames after mount can be an empty shell. Where the
 * engine does not report paint timing, a fixed delay stands in; the idle
 * timeout bounds the wait on a machine that never goes idle.
 */
export function preloadRenderDeps(): void {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const go = () => void loadRenderDeps().catch(() => {});
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 1500 });
    else setTimeout(go, 50);
  };
  const painted = () =>
    typeof performance !== 'undefined' &&
    performance.getEntriesByType?.('paint').some((e) => e.name === 'first-contentful-paint');
  if (painted()) return start();
  try {
    const po = new PerformanceObserver(() => {
      if (!painted()) return;
      po.disconnect();
      start();
    });
    po.observe({ type: 'paint', buffered: true });
  } catch {
    // No paint timing at all — the fallback below covers it.
  }
  setTimeout(start, 1000);
}

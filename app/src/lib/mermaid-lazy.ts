/**
 * Mermaid, loaded the first time a diagram actually needs rendering.
 *
 * It used to be a static import in five modules, which put its ~1 MB of
 * parser and renderer into the entry chunk — paid on every cold start, by
 * every user, including the ones whose notes contain no diagrams at all.
 * Windows felt it worst: WebView2 has to compile the whole entry chunk
 * before the first paint.
 *
 * `initialize` is still last-call-wins on a single shared instance, exactly
 * as it was when each module reached for the singleton directly.
 *
 * Rendering always goes through `safeRender` below. Left to itself, mermaid
 * draws its "Syntax error in text" bomb into a `<div id="d<id>">` appended to
 * `document.body` and, on a parse error, throws *before* removing it. That
 * stray node sat under the app shell for good: the next scroll-into-view
 * scrolled `<body>` and pushed the tab bar and toolbar off-screen until a
 * restart. Every caller already shows its own inline error, so mermaid is
 * told never to render one (`suppressErrorRendering`), it draws into a
 * throw-away off-screen host we own, and whatever it leaves behind is
 * removed whether the render succeeded or not.
 */
import type mermaidNS from 'mermaid';

type Mermaid = typeof mermaidNS;
type MermaidConfig = Parameters<Mermaid['initialize']>[0];
type RenderResult = Awaited<ReturnType<Mermaid['render']>>;

/** The only part of mermaid our callers use, made safe to fail. */
export interface SafeMermaid {
  render(id: string, code: string): Promise<RenderResult>;
}

/** The subset of mermaid that `safeRender` drives (lets tests pass a fake). */
export interface MermaidRenderer {
  render(id: string, code: string, container?: Element): Promise<RenderResult>;
}

let loading: Promise<Mermaid> | null = null;
let renderSeq = 0;

export function loadMermaid(): Promise<Mermaid> {
  if (!loading) loading = import('mermaid').then((m) => m.default);
  return loading;
}

/** Remove every temporary node mermaid may have created for `id`. */
export function removeMermaidLeftovers(id: string, doc: Document = document): void {
  for (const tmp of [`d${id}`, `i${id}`]) {
    doc.getElementById(tmp)?.remove();
  }
  // A bare `<svg id="<id>">` directly under <body> is a leftover too.
  // Rendered output lives in our own wrappers (`.mermaid-block` etc.).
  const svg = doc.getElementById(id);
  if (svg && svg.parentElement === doc.body) svg.remove();
}

/**
 * #276 — Mermaid v11 treats `@` inside an unquoted `[...]` label as the new
 * `A@{ shape: ... }` syntax and `(` / `)` as a nested shape delimiter, failing
 * with an inscrutable parser error. Wrapping those unquoted labels in `"..."`
 * restores the Mermaid v10 behaviour users expect.
 */
const UNQUOTED_BRACKET_LABEL_RE = /([^\s\[>-]\s*\[)(?!["\[/\\()])([^\]\n]*[@()][^\]\n]*)(\])/g;

export function quoteUnquotedMermaidLabels(code: string): string {
  return code.replace(UNQUOTED_BRACKET_LABEL_RE, (_m, open: string, body: string, close: string) => {
    const escaped = body.replace(/"/g, '&quot;');
    return `${open}"${escaped}"${close}`;
  });
}

export function formatMermaidError(err: unknown, code?: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  if (code && /\[[^\]"\n]*[@()][^\]"\n]*\]/.test(code) && !raw.includes('A["')) {
    return `${raw}\nHint: Wrap node labels containing "@" or "()" in quotes, e.g. A["label @ info"]`;
  }
  return raw;
}

/**
 * Render into a host that is in the document (mermaid measures text with
 * getBBox, which needs layout) but out of flow and invisible, then drop it.
 */
export async function safeRender(
  mermaid: MermaidRenderer,
  id: string,
  code: string,
  doc: Document = document,
): Promise<RenderResult> {
  // Callers number their ids per component, so two split panes previewing
  // the same note both asked for `mmd-1` at once: the first render's cleanup
  // then removed the second one's work-in-progress `#dmmd-1` and it failed
  // with "element.firstChild is null". A page-wide suffix keeps every render
  // (and the `#id` selectors inside its SVG) distinct.
  const renderId = `${id}-r${++renderSeq}`;
  const host = doc.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('data-mermaid-scratch', '1');
  const width = Math.max(320, doc.body?.clientWidth || 1000);
  host.setAttribute(
    'style',
    `position:fixed;left:-100000px;top:0;width:${width}px;` +
      'visibility:hidden;pointer-events:none;overflow:hidden;',
  );
  doc.body.appendChild(host);
  try {
    return await mermaid.render(renderId, code, host);
  } catch (firstErr) {
    // #276 — if the diagram failed to parse and contains unquoted `@` or `()`
    // inside `[...]` node labels, retry once with those labels quoted.
    const quoted = quoteUnquotedMermaidLabels(code);
    if (quoted !== code) {
      removeMermaidLeftovers(renderId, doc);
      host.innerHTML = '';
      const retryId = `${id}-r${++renderSeq}`;
      try {
        return await mermaid.render(retryId, quoted, host);
      } catch {
        removeMermaidLeftovers(retryId, doc);
      }
    }
    const msg = formatMermaidError(firstErr, code);
    if (firstErr instanceof Error && msg !== firstErr.message) {
      firstErr.message = msg;
    }
    throw firstErr instanceof Error ? firstErr : new Error(msg);
  } finally {
    host.remove();
    removeMermaidLeftovers(renderId, doc);
  }
}

/** Load (once) and configure. Callers are all async already. */
export async function initMermaid(config: MermaidConfig): Promise<SafeMermaid> {
  const mermaid = await loadMermaid();
  mermaid.initialize({ ...config, suppressErrorRendering: true });
  return { render: (id, code) => safeRender(mermaid, id, code) };
}

/**
 * #522 — end the current task so pending input events, frames and timers
 * run before the next heavy chunk. An `await` on a resolved promise only
 * pumps microtasks: the chain never returns to the task queue, so a note
 * with dozens of diagrams starves input and rAF for its whole render burst.
 *
 * A `setTimeout(0)` macrotask is deliberate. Chromium's `scheduler.yield()`
 * was tried first (including `priority: 'user-visible'`) but measured worse
 * in the #522 harness: 7 rAF frames / 122 ms worst gap over 50 diagrams,
 * versus 53 frames / 64 ms with the timer — its user-priority continuation
 * keeps getting scheduled ahead of rendering. WebKit / WebView2 fall through
 * to this same path anyway, so there is one behaviour everywhere.
 */
export function yieldToMain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * #522 — a note with dozens of mermaid diagrams froze the UI for up to a
 * minute on open: every surface that renders mermaid (the preview pane, the
 * plain-block pass, and the live-edit decoration build) fired all of its
 * renders at once, back to back. `mermaid.render` is CPU-bound JS on the
 * main thread, and one `await` chain of already-resolved promises never
 * hands control back to the task queue, so input and frames starve.
 *
 * This FIFO runs one render job at a time and yields between jobs, so the
 * total CPU is unchanged but the loop stays interruptible. `front: true`
 * puts viewport jobs in a separate FIFO ahead of the background fill while
 * preserving their document order. The queue is page-wide on purpose: the
 * preview pane and the live editor can be showing the same note, and letting
 * them race their renders is exactly the burst this exists to prevent.
 */
type MermaidJob = () => Promise<void>;
interface QueuedMermaidJob {
  job: MermaidJob;
  done: () => void;
}
const mermaidFrontQueue: QueuedMermaidJob[] = [];
const mermaidBackQueue: QueuedMermaidJob[] = [];
let mermaidDraining = false;

async function drainMermaidQueue(): Promise<void> {
  if (mermaidDraining) return;
  mermaidDraining = true;
  try {
    while (mermaidFrontQueue.length || mermaidBackQueue.length) {
      const queue = mermaidFrontQueue.length ? mermaidFrontQueue : mermaidBackQueue;
      const { job, done } = queue.shift()!;
      try {
        await job();
      } catch {
        /* jobs own their error reporting */
      }
      done();
      await yieldToMain();
    }
  } finally {
    mermaidDraining = false;
  }
}

/**
 * Run `job` through the shared serial queue. Resolves once the job has run
 * (so inflight-tracking callers can keep their "same render, one waiter"
 * semantics). Errors inside the job do not reject this promise — the job
 * itself is responsible for reporting them.
 */
export function queueMermaidJob(job: MermaidJob, opts: { front?: boolean } = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    const entry = { job, done: resolve };
    (opts.front ? mermaidFrontQueue : mermaidBackQueue).push(entry);
    void drainMermaidQueue();
  });
}

/* ---- #522 shared SVG cache ---------------------------------------------
 * The live-edit widgets had their own cache in cm-live-blocks.ts; the
 * preview pane had none, so split view rebuilt its HTML on every keystroke
 * and re-rendered every diagram in the note each time. One page-wide cache
 * keyed by (theme, source) means a diagram is drawn once for the whole
 * window, by whichever surface asked first.
 */
export interface CachedMermaidSvg {
  svg: string | null;
  bindFunctions?: ((el: Element) => void) | null;
  error: string | null;
}

type MermaidThemeName = 'dark' | 'default';
const MERMAID_CACHE_LIMIT = 200;
const mermaidSvgCache = new Map<string, CachedMermaidSvg>();
const mermaidSvgInflight = new Map<string, Promise<CachedMermaidSvg>>();
const mermaidCacheKey = (theme: string, code: string) => `${theme}\u0000${code}`;

function storeMermaidSvg(key: string, value: CachedMermaidSvg): void {
  // Re-insert so the Map's iteration order doubles as an eviction order.
  mermaidSvgCache.delete(key);
  mermaidSvgCache.set(key, value);
  while (mermaidSvgCache.size > MERMAID_CACHE_LIMIT) {
    const oldest = mermaidSvgCache.keys().next().value;
    if (oldest === undefined) break;
    mermaidSvgCache.delete(oldest);
  }
}

/** Synchronous read for widgets that must decide placeholder vs finished SVG. */
export function peekMermaidSvg(theme: MermaidThemeName, code: string): CachedMermaidSvg | undefined {
  return mermaidSvgCache.get(mermaidCacheKey(theme, code));
}

/**
 * Render `code` once, serialised through the queue, and resolve with the
 * cached entry (an `error` entry instead of an SVG on failure). Concurrent
 * callers for the same theme+source share one job, so a split view plus a
 * live-edit pane never draws the same diagram twice.
 *
 * `initMermaid` is called *inside* the job on purpose: `initialize` is
 * last-call-wins on mermaid's singleton, so configuring a theme while an
 * earlier queued job is still waiting would render it in the wrong palette.
 */
export function renderMermaidCached(
  theme: MermaidThemeName,
  code: string,
  opts: { front?: boolean } = {},
): Promise<CachedMermaidSvg> {
  const key = mermaidCacheKey(theme, code);
  const hit = mermaidSvgCache.get(key);
  if (hit && (hit.svg || hit.error)) return Promise.resolve(hit);
  const pending = mermaidSvgInflight.get(key);
  if (pending) return pending;
  // Reserve the slot so a second caller doesn't start a duplicate render.
  storeMermaidSvg(key, { svg: null, error: null });
  const job = queueMermaidJob(async () => {
    try {
      const mermaid = await initMermaid({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
      });
      const { svg, bindFunctions } = await mermaid.render(`mmd-${++renderSeq}`, code);
      storeMermaidSvg(key, { svg, bindFunctions, error: null });
    } catch (e) {
      storeMermaidSvg(key, {
        svg: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, opts).then(() => mermaidSvgCache.get(key) ?? { svg: null, error: 'Mermaid render failed' });
  mermaidSvgInflight.set(key, job);
  void job.finally(() => mermaidSvgInflight.delete(key));
  return job;
}

/**
 * #462 — Wire Mermaid interactive tooltips & click callbacks on a rendered
 * diagram container, and ensure SVG nodes with `[title]` attributes also have
 * a native `<svg:title>` child so browser hover tooltips work reliably across
 * all diagram types and security levels.
 */
export function bindMermaidInteractions(
  container: Element,
  bindFunctions?: ((el: Element) => void) | null,
): void {
  try {
    bindFunctions?.(container);
  } catch {
    /* ignore d3 binding errors on detached/partial nodes */
  }
  const doc = container.ownerDocument ?? document;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  for (const el of Array.from(container.querySelectorAll('[title]'))) {
    const tip = el.getAttribute('title')?.trim();
    if (!tip) continue;
    const hasTitleChild = Array.from(el.children).some(
      (c) => c.tagName.toLowerCase() === 'title',
    );
    if (!hasTitleChild) {
      const titleEl = doc.createElementNS(SVG_NS, 'title');
      titleEl.textContent = tip;
      el.insertBefore(titleEl, el.firstChild);
    }
  }
}

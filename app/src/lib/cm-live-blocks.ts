/**
 * CodeMirror 6 block-level live-preview decorations for Markdown.
 *
 * Two block widgets, both gated on the cursor NOT being in the matched
 * block (move cursor in → source comes back):
 *
 *   1. **Image lines.** A line whose content is only `![alt](url)` (whitespace
 *      around it is fine, no other text) renders as an `<img>` element.
 *      Falls back to the source line if the image can't load.
 *
 *   2. **Tables.** A contiguous block of pipe-delimited lines with a
 *      separator row (the standard GFM table shape) renders as a real
 *      `<table>`. Tables don't need `extractImageRoot`, just markdown-it
 *      run on the source slice.
 *
 * This is the v3.6 implementation of issue #44 — "live edit should support
 * image / table live render". Companion to `cm-live-preview.ts` which
 * handles inline marker hiding.
 */

import { RangeSetBuilder, StateField, StateEffect, Prec, EditorSelection, Transaction, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { isDragging, isDragEndTransaction } from './cm-drag-aware';
import { frozenFieldDuringComposition, isImeSafeFlushTransaction } from './cm-ime-guard';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';

// Block decorations (Decoration.replace with `block: true`) MUST come from a
// StateField — CM6 throws "Block decorations may not be specified via plugins"
// if a ViewPlugin emits them. So this whole module is a state field, not a
// view plugin. `relayoutEffect` lets the async Mermaid render (and any other
// out-of-band trigger) ask the field to recompute.
const relayoutEffect = StateEffect.define<null>();
import {
  installSvgImageFallbacks,
  isLocalSvgPath,
  resolveImagePath,
  resolveImageSrc,
  rewriteImageUrls,
} from './image-resolve';
import { renderMarkdown, extractImageRoot } from './markdown';
import { findHtmlBlockEnd } from './html-live-render';
import { plantumlSvgUrl } from './plantuml';
import { initMermaid } from './mermaid-lazy';
import { getKatex, onRenderDepsChange, renderDepsVersion } from './render-deps';
import {
  parseTldrawFence,
  TLDRAW_DEFAULT_HEIGHT,
  type BoardThemeTokens,
} from './tldraw-board';

// v4.3.0 issue #57a — live-render math + Mermaid blocks in the editor.
// Mermaid is async; we render lazily into a counter-keyed cache so the
// widget toDOM() can pull a ready SVG without re-rendering. The cache is
// keyed on theme + source text → SVG so the same diagram across multiple panes
// renders once per theme.
//
// #354: this used to render with theme 'default' always, so in a dark theme
// the diagram's dark lines and labels sat on the dark editor background and
// all but vanished. The theme now comes from the editor (same mapping as
// preview), and it's part of the key, so switching theme renders fresh SVG
// instead of reusing the light one.
type MermaidTheme = 'dark' | 'default';
const mermaidSvgCache = new Map<string, { svg: string | null; error: string | null }>();
let mermaidIdSeq = 0;
const mermaidKey = (source: string, theme: MermaidTheme) => `${theme}\u0000${source}`;
// In-flight renders. A second caller has to wait for the same render, not
// return straight away: the widget's toDOM relies on the promise resolving
// only once the SVG is in the cache, to trigger the rebuild that swaps the
// "Rendering…" placeholder for the diagram. Returning early made that rebuild
// run before the render finished, and the placeholder stayed for good.
const mermaidInflight = new Map<string, Promise<void>>();
function ensureMermaidRendered(source: string, theme: MermaidTheme): Promise<void> {
  const key = mermaidKey(source, theme);
  const pending = mermaidInflight.get(key);
  if (pending) return pending;
  if (mermaidSvgCache.has(key)) return Promise.resolve();
  // Reserve the slot first so concurrent calls don't double-render.
  mermaidSvgCache.set(key, { svg: null, error: null });
  const job = (async () => {
    try {
      const id = `cm-mmd-${++mermaidIdSeq}`;
      const mermaid = await initMermaid({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
      });
      const { svg } = await mermaid.render(id, source);
      mermaidSvgCache.set(key, { svg, error: null });
    } catch (e) {
      mermaidSvgCache.set(key, { svg: null, error: (e as Error).message });
    } finally {
      mermaidInflight.delete(key);
    }
  })();
  mermaidInflight.set(key, job);
  return job;
}

// `^\s*!\[<alt>\](<url>)\s*$` — whole-line image with no surrounding prose.
// Why whole-line: replacing inline images would split text in the middle and
// break the natural reading flow of the source. We only collapse images that
// are visually their own paragraph.
const IMAGE_LINE_RE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;

// Pipe table heuristic: a header line, a separator (`---` / `:---:`), then
// at least one body row. We don't try to parse the GFM grammar ourselves —
// markdown-it does that — we only need a cheap detector to decide which
// line ranges to swap with widgets.
function isPipeRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
}
function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  // `| --- | :---: |` etc. Only `:`, `-`, ` `, `|` characters allowed,
  // and at least one `-` per cell.
  return (
    isPipeRow(line) &&
    // `-` must be last in the class so it's a literal, not the range `:`..`|`
    // (which excludes `-` at 0x2D and made every real separator row fail —
    // tables never collapsed to a widget in live-edit).
    /^\|[\s:|-]+\|$/.test(trimmed) &&
    /-{3,}/.test(trimmed)
  );
}

// Images report their real height only after they load, and CM6 does not
// re-measure widget heights on its own — until something else triggers a
// measure, the height map (gutter numbers, scroll anchoring, click→pos
// mapping) is off by the full image height. Nudge the relayout plugin once
// per load burst, and remember natural sizes so re-rendered widgets reserve
// the right box up front (no layout shift at all on subsequent renders —
// `.cm-live-block img { max-width:100%; height:auto }` keeps the attribute
// pair behaving as an aspect-ratio hint, not a fixed size).
const imageNaturalSizes = new Map<string, { w: number; h: number }>();
let relayoutTimer: ReturnType<typeof setTimeout> | null = null;

// KaTeX / highlight.js finished loading: rebuild, so widgets rendered without
// them (see the `deps` field on each) remount with the real output.
onRenderDepsChange(() => {
  try {
    window.dispatchEvent(new CustomEvent('solomd:cm-relayout'));
  } catch {}
});

function scheduleImageRelayout(): void {
  if (relayoutTimer) return;
  relayoutTimer = setTimeout(() => {
    relayoutTimer = null;
    try {
      window.dispatchEvent(new CustomEvent('solomd:cm-relayout'));
    } catch {}
  }, 50);
}

function trackImageHeights(root: HTMLElement): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const cached = imageNaturalSizes.get(img.src);
    if (cached && !img.hasAttribute('width') && !img.hasAttribute('height')) {
      img.width = cached.w;
      img.height = cached.h;
    }
    const done = () => {
      if (img.naturalWidth && img.naturalHeight) {
        imageNaturalSizes.set(img.src, { w: img.naturalWidth, h: img.naturalHeight });
      }
      scheduleImageRelayout();
    };
    if (img.complete) {
      // Cache hit: `complete` is already true here, but the box gets its real
      // height only after the (async) decode + this widget entering layout —
      // both past CM's initial measure. Still needs a relayout pass.
      done();
      continue;
    }
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  }
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly localPath: string | null = null,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.localPath === this.localPath;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--image';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.draggable = false;
    if (this.localPath) img.dataset.solomdLocalSrc = this.localPath;
    img.onerror = () => {
      // Image failed to load — fall back to a small "broken image" caption
      // rather than a giant empty box. The source text is one cursor-move
      // away regardless.
      if (this.localPath) return;
      wrap.classList.add('cm-live-block--broken');
      wrap.textContent = `🖼 ${this.alt || this.src}`;
    };
    wrap.appendChild(img);
    installSvgImageFallbacks(wrap);
    trackImageHeights(wrap);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class TableWidget extends WidgetType {
  // Cells can hold math / code: a widget built before KaTeX or highlight.js
  // arrived must not count as equal to the one built after (render-deps.ts).
  private readonly deps = renderDepsVersion();

  constructor(private readonly source: string) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.deps === this.deps;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--table';
    // Render the table source through the same markdown pipeline used by the
    // preview pane so we get GFM alignment, inline formatting, etc. for free.
    // We strip everything except the table rows from the rendered output.
    const html = renderMarkdown(this.source);
    wrap.innerHTML = html;
    trackImageHeights(wrap);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** Raw block HTML rendered with the same markdown-it pipeline as Preview.vue. */
class HtmlBlockWidget extends WidgetType {
  private readonly deps = renderDepsVersion();

  constructor(
    private readonly source: string,
    private readonly imageRoot: string | null,
    private readonly filePath?: string,
  ) {
    super();
  }

  eq(other: HtmlBlockWidget): boolean {
    return (
      other.source === this.source &&
      other.imageRoot === this.imageRoot &&
      other.filePath === this.filePath &&
      other.deps === this.deps
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--html';
    wrap.innerHTML = rewriteImageUrls(
      renderMarkdown(this.source),
      this.imageRoot,
      this.filePath,
    );
    installSvgImageFallbacks(wrap);
    trackImageHeights(wrap);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// v4.3.0 issue #57a — block math (`$$...$$`). Goes through markdown-it so
// it picks up the same KaTeX renderer used in the preview pane. We render
// the wrapping `$$\n…\n$$` literal so markdown-it-katex sees it as block
// math and emits `<span class="katex-display">`.
class MathWidget extends WidgetType {
  private readonly deps = renderDepsVersion();

  constructor(private readonly source: string) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.source === this.source && other.deps === this.deps;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--math';
    try {
      wrap.innerHTML = renderMarkdown(this.source);
    } catch (e) {
      wrap.classList.add('cm-live-block--broken');
      wrap.textContent = `∑ ${(e as Error).message}`;
    }
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// v4.5.5 — inline math (`$…$`). Standard markdown parsers don't emit
// inline-math nodes, so cm-live-render's syntax-tree pass can't see them.
// We detect spans with inlineMathSpans() below and replace each with a
// KaTeX render while the caret is off the line (click in → source returns).
class InlineMathWidget extends WidgetType {
  private readonly deps = renderDepsVersion();

  constructor(private readonly tex: string) {
    super();
  }

  eq(other: InlineMathWidget): boolean {
    return other.tex === this.tex && other.deps === this.deps;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-live-inline-math';
    // KaTeX still loading (render-deps.ts): show the source, which is what
    // the line reads without the widget; the load triggers a rebuild.
    const katex = getKatex();
    if (!katex) {
      span.textContent = `$${this.tex}$`;
      return span;
    }
    try {
      span.innerHTML = katex.renderToString(this.tex, {
        throwOnError: false,
        displayMode: false,
      });
    } catch {
      span.classList.add('cm-live-inline-math--broken');
      span.textContent = `$${this.tex}$`;
    }
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// Detect inline math `$…$` spans within a single line. Offsets are relative
// to the line start. Guards against the common false positives so prose isn't
// mangled:
//   - `$$` block-math delimiters are skipped (handled as block widgets).
//   - `$` inside inline code spans (`` `…$…` ``) is ignored.
//   - escaped `\$` neither opens nor closes.
//   - currency like `$5` / `$5 and $10`: an opening `$` can't be followed by
//     whitespace, and a closing `$` followed by a digit is rejected.
//   - empty or space-padded content (`$ $`, `$x $`) is rejected.
function inlineMathSpans(text: string): Array<{ start: number; end: number; tex: string }> {
  const spans: Array<{ start: number; end: number; tex: string }> = [];
  const n = text.length;
  // Mask out inline-code spans (matched backtick runs of equal length).
  const code = new Array<boolean>(n).fill(false);
  for (let p = 0; p < n; ) {
    if (text[p] === '`') {
      let len = 1;
      while (p + len < n && text[p + len] === '`') len++;
      let q = p + len;
      let closed = -1;
      while (q < n) {
        if (text[q] === '`') {
          let len2 = 1;
          while (q + len2 < n && text[q + len2] === '`') len2++;
          if (len2 === len) { closed = q + len2; break; }
          q += len2;
        } else q++;
      }
      if (closed >= 0) { for (let k = p; k < closed; k++) code[k] = true; p = closed; }
      else p += len;
    } else p++;
  }
  let i = 0;
  while (i < n) {
    if (text[i] !== '$' || code[i]) { i++; continue; }
    if (i > 0 && text[i - 1] === '\\') { i++; continue; }          // escaped \$
    if (text[i + 1] === '$') { i += 2; continue; }                  // $$ block delimiter
    if (i + 1 >= n || /\s/.test(text[i + 1])) { i++; continue; }    // opening must hug content
    let j = i + 1;
    let close = -1;
    while (j < n) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '$' && !code[j]) { close = j; break; }
      j++;
    }
    if (close < 0) { i++; continue; }
    const content = text.slice(i + 1, close);
    if (!content.trim() || /\s$/.test(content)) { i = close + 1; continue; }   // empty / space-padded
    if (close + 1 < n && /\d/.test(text[close + 1])) { i = close + 1; continue; } // currency $5
    spans.push({ start: i, end: close + 1, tex: content });
    i = close + 1;
  }
  return spans;
}

// v4.3.0 issue #57a — mermaid fenced blocks. Mermaid is async so we render
// into a module-level cache; toDOM() pulls the SVG when available, falls
// back to a "rendering…" placeholder, then dispatches `solomd:cm-relayout`
// to ask the editor to rebuild decorations once the cache fills.
class MermaidWidget extends WidgetType {
  /** Whether the cache held a finished result when this widget was built. */
  private readonly settled: boolean;

  constructor(
    private readonly source: string,
    private readonly theme: MermaidTheme,
  ) {
    super();
    const cached = mermaidSvgCache.get(mermaidKey(source, theme));
    this.settled = !!(cached && (cached.svg || cached.error));
  }

  eq(other: MermaidWidget): boolean {
    // A theme change must remount the widget with the other theme's SVG. So
    // must the render finishing: if the placeholder and the finished widget
    // compared equal, CodeMirror would keep the "Rendering…" DOM.
    return (
      other.source === this.source &&
      other.theme === this.theme &&
      other.settled === this.settled
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--mermaid';
    const cached = mermaidSvgCache.get(mermaidKey(this.source, this.theme));
    if (cached?.svg) {
      wrap.innerHTML = cached.svg;
    } else if (cached?.error) {
      wrap.classList.add('cm-live-block--broken');
      wrap.textContent = `Mermaid: ${cached.error}`;
    } else {
      wrap.textContent = '⌛ Rendering Mermaid…';
      ensureMermaidRendered(this.source, this.theme).then(() => {
        // Ask the field to recompute now that the SVG cache is filled. We
        // can't hold an EditorView here (block decorations live in a state
        // field, built without a view), so signal via a window event that
        // the companion relayout plugin turns into a `relayoutEffect`.
        try {
          window.dispatchEvent(new CustomEvent('solomd:cm-relayout'));
        } catch {}
      });
    }
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// v4.10 issue #163 — ```plantuml fence rendered via the configured PlantUML
// server (opt-in; see lib/plantuml.ts for the privacy story). Same reveal
// model as mermaid/tables: cursor inside → source. The <img> reports its
// final size only after load, so onload nudges the relayout plugin to make
// CM re-measure the block height.
class PlantumlWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly url: string,
  ) {
    super();
  }

  eq(other: PlantumlWidget): boolean {
    return other.source === this.source && other.url === this.url;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--plantuml';
    const img = document.createElement('img');
    img.alt = 'PlantUML diagram';
    img.src = this.url;
    img.addEventListener('load', () => {
      try {
        window.dispatchEvent(new CustomEvent('solomd:cm-relayout'));
      } catch {}
    });
    img.addEventListener('error', () => {
      wrap.classList.add('cm-live-block--broken');
      wrap.textContent = 'PlantUML render failed — check the server setting';
      try {
        window.dispatchEvent(new CustomEvent('solomd:cm-relayout'));
      } catch {}
    });
    wrap.appendChild(img);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// v4.6 F7 — ```tldraw fenced whiteboard. Unlike mermaid (which collapses only
// when the cursor leaves), the board ALWAYS replaces the fence: the JSON is
// never meant to be hand-edited. The widget mounts a LIVE tldraw editor via the
// dynamic-import adapter (tldraw-runtime.ts) so the rest of the app compiles
// without the dep. Edits debounce 350ms inside the adapter, then splice ONLY
// the fence body back through the writeback callback (→ tabs.setContent),
// exactly like Tolaria's onSnapshotChange → tldrawMarkdown round-trip.
class TldrawWidget extends WidgetType {
  constructor(
    private readonly boardId: string,
    private readonly height: string,
    private readonly width: string,
    private readonly snapshot: string,
    private readonly opts: BlockOptions,
  ) {
    super();
  }

  // Re-mount only when the board IDENTITY or stored snapshot changes — NOT on
  // every keystroke elsewhere in the doc. This is what makes the always-render
  // model viable: a relayout that doesn't touch this fence reuses the same
  // widget DOM (eq → true) so the tldraw instance is never torn down (avoids
  // the canvas remounting on every keystroke near it, per the plan's risks).
  eq(other: TldrawWidget): boolean {
    return (
      other.boardId === this.boardId &&
      other.height === this.height &&
      other.width === this.width &&
      other.snapshot === this.snapshot
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--tldraw';
    wrap.setAttribute('data-board-id', this.boardId);
    // Bordered card lives one level down so the wrap's padding (the old
    // inter-block margin, see #155) stays outside the border.
    const card = document.createElement('div');
    card.className = 'cm-tldraw-card';
    const h = parseInt(this.height, 10);
    card.style.height = `${Number.isFinite(h) && h > 0 ? h : 520}px`;
    if (this.width) card.style.maxWidth = `${this.width}px`;
    wrap.appendChild(card);

    // Overflow toolbar: a fullscreen toggle that pops the board into the
    // WhiteboardOverlay (full-window editor). The board id + current snapshot
    // are handed off so the overlay edits the SAME fence.
    const toolbar = document.createElement('div');
    toolbar.className = 'cm-tldraw-toolbar';
    const strings = this.opts.getBoardStrings?.() ?? {
      loading: 'Loading whiteboard…',
      openFull: 'Open fullscreen',
      loadFailed: 'Whiteboard failed to load',
    };
    const fullBtn = document.createElement('button');
    fullBtn.className = 'cm-tldraw-fullscreen';
    fullBtn.type = 'button';
    fullBtn.title = strings.openFull;
    fullBtn.setAttribute('aria-label', strings.openFull);
    fullBtn.textContent = '⛶';
    fullBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
    fullBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const handle = (wrap as unknown as { __boardHandle?: { getSnapshotString(): string } })
        .__boardHandle;
      const snap = handle?.getSnapshotString?.() ?? this.snapshot;
      window.dispatchEvent(
        new CustomEvent('solomd:whiteboard-open', {
          detail: {
            boardId: this.boardId,
            tabId: this.opts.getTabId?.() ?? '',
            snapshot: snap,
          },
        }),
      );
    });
    toolbar.appendChild(fullBtn);
    card.appendChild(toolbar);

    const surface = document.createElement('div');
    surface.className = 'cm-tldraw-surface';
    card.appendChild(surface);

    const placeholder = document.createElement('div');
    placeholder.className = 'cm-tldraw-loading';
    const spinner = document.createElement('span');
    spinner.className = 'cm-tldraw-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const loadingLabel = document.createElement('span');
    loadingLabel.textContent = strings.loading;
    placeholder.append(spinner, loadingLabel);
    surface.appendChild(placeholder);

    // Mount asynchronously — the adapter dynamic-imports tldraw on first use.
    const theme: BoardThemeTokens = this.opts.getBoardTheme?.() ?? {
      colorScheme: 'light',
      locale: 'en',
    };
    const boardId = this.boardId;
    let destroyed = false;
    void import('./tldraw-runtime')
      .then(({ mountBoard }) =>
        mountBoard(surface, {
          snapshot: this.snapshot,
          theme,
          onSnapshotChange: (snapshotJson) => {
            // Splice the new snapshot back into the note's Markdown. We resolve
            // the fence by board id at write time (positions drift as the doc
            // is edited), keeping height/width attributes intact.
            this.opts.onBoardEdit?.(boardId, snapshotJson);
          },
        }),
      )
      .then((handle) => {
        if (destroyed) {
          handle.destroy();
          return;
        }
        placeholder.remove();
        (wrap as unknown as { __boardHandle?: unknown }).__boardHandle = handle;
        // Expose the live board instance for the dev-bridge self-test.
        try {
          const reg =
            ((window as any).__solomdBoards ||= new Map<string, unknown>());
          reg.set(boardId, handle);
        } catch {
          /* dev-only */
        }
      })
      .catch((e) => {
        placeholder.className = 'cm-tldraw-loading cm-live-block--broken';
        placeholder.textContent = `${strings.loadFailed}: ${(e as Error).message}`;
      });

    // Stash a teardown hook the widget's destroy() path can call.
    (wrap as unknown as { __destroyBoard?: () => void }).__destroyBoard = () => {
      destroyed = true;
      const handle = (wrap as unknown as { __boardHandle?: { destroy(): void } })
        .__boardHandle;
      try {
        handle?.destroy();
      } catch {
        /* already gone */
      }
      try {
        (window as any).__solomdBoards?.delete(boardId);
      } catch {
        /* dev-only */
      }
    };

    return wrap;
  }

  destroy(dom: HTMLElement): void {
    // CM calls destroy() when the widget DOM is removed (relayout / unmount).
    // Tear down the tldraw React root so we don't leak an editor per relayout.
    (dom as unknown as { __destroyBoard?: () => void }).__destroyBoard?.();
  }

  // The board owns all pointer/keyboard interaction inside its canvas — let
  // those events through to tldraw rather than routing them to CodeMirror.
  ignoreEvent(): boolean {
    return true;
  }
}

interface BlockOptions {
  /** Workspace context for resolving relative image paths. */
  getImageRoot?: () => string | null;
  /** Active note's filesystem path so relative paths resolve to its dir. */
  getFilePath?: () => string | undefined;
  /** Theme/locale tokens handed to a mounted tldraw board (F7). */
  getBoardTheme?: () => BoardThemeTokens;
  /** Active tab id — the fullscreen overlay writes edits back to it (F7). */
  getTabId?: () => string;
  /**
   * F7 writeback: a whiteboard's snapshot changed. `snapshotJson` is the fresh
   * pretty-printed body to splice into the ```tldraw fence with `boardId`.
   */
  onBoardEdit?: (boardId: string, snapshotJson: string) => void;
  /**
   * F7 i18n: localized strings for the inline board chrome (loading text,
   * fullscreen button tooltip, load-failure prefix). Optional — sensible
   * English fallbacks are used when absent so the widget never shows a raw key.
   */
  getBoardStrings?: () => { loading: string; openFull: string; loadFailed: string };
  /**
   * #354 — Mermaid theme for the current app theme ('dark' for any dark
   * theme). Absent → 'default'. A change takes effect on the next rebuild;
   * the editor dispatches a relayout when the theme changes.
   */
  getMermaidTheme?: () => 'dark' | 'default';
  /** v4.10 #163 — PlantUML opt-in + server; absent/disabled → fences stay source. */
  getPlantuml?: () => { enabled: boolean; server: string };
  /**
   * #353 "Always show Markdown markers": the source stays visible whatever the
   * caret does, so nothing collapses and nothing jumps when a line is clicked.
   * Images still render, as a block below their own (visible) source line;
   * tables, math, HTML blocks and diagrams keep their source. tldraw boards
   * are unaffected — they never reveal source anyway.
   */
  keepSource?: () => boolean;
}

function buildBlockDecorations(state: EditorState, opts: BlockOptions): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const sel = state.selection.main;
        const cursorLine = state.doc.lineAt(sel.from).number;
        const cursorLineEnd = state.doc.lineAt(sel.to).number;
        const keepSource = opts.keepSource?.() === true;

        // Single pass over the whole doc — for each line, decide:
        //   * is it a standalone image line we should replace? (1 line)
        //   * is it the start of a table block we should collapse? (N lines)
        // Tables are walked as ranges so we don't double-iterate. (We walk
        // the full doc, not just the viewport: block decorations come from a
        // state field, which has no viewport — and CM only renders the
        // visible slice anyway, so this stays cheap.)
        const doc = state.doc;
        const lastLine = doc.lines;
        const sourceLines = Array.from(
          { length: lastLine },
          (_, index) => doc.line(index + 1).text,
        );
        let i = 1;
        while (i <= lastLine) {
          const line = doc.line(i);

          // Raw block HTML (`<div>…</div>`, `<details>`, HTML tables, etc.).
          // Preview.vue has always rendered this through markdown-it, but live
          // edit previously left the tags visible. Collapse the complete block
          // while the caret is outside; entering it reveals the source again.
          const htmlEndIndex = findHtmlBlockEnd(sourceLines, i - 1);
          if (htmlEndIndex !== null) {
            const endI = htmlEndIndex + 1;
            const cursorInside =
              keepSource ||
              (cursorLine >= i && cursorLine <= endI) ||
              (cursorLineEnd >= i && cursorLineEnd <= endI);
            if (!cursorInside) {
              const blockFrom = line.from;
              const blockTo = doc.line(endI).to;
              const source = doc.sliceString(blockFrom, blockTo);
              builder.add(
                blockFrom,
                blockTo,
                Decoration.replace({
                  widget: new HtmlBlockWidget(
                    source,
                    opts.getImageRoot?.() ?? null,
                    opts.getFilePath?.(),
                  ),
                  block: true,
                }),
              );
            }
            i = endI + 1;
            continue;
          }

          // Image line.
          const imgMatch = IMAGE_LINE_RE.exec(line.text);
          if (imgMatch) {
            if (keepSource) {
              // Render below the source line and leave the line alone, so
              // clicking into it changes nothing on screen.
              const root = opts.getImageRoot?.() ?? null;
              const filePath = opts.getFilePath?.();
              const src = resolveImageSrc(imgMatch[2], root, filePath);
              const localPath = resolveImagePath(imgMatch[2], root, filePath);
              builder.add(
                line.to,
                line.to,
                Decoration.widget({
                  widget: new ImageWidget(src, imgMatch[1], isLocalSvgPath(localPath) ? localPath : null),
                  block: true,
                  side: 1,
                }),
              );
              i += 1;
              continue;
            }
            const cursorInside = i >= cursorLine && i <= cursorLineEnd;
            if (!cursorInside) {
              const alt = imgMatch[1];
              const rawSrc = imgMatch[2];
              const root = opts.getImageRoot?.() ?? null;
              const filePath = opts.getFilePath?.();
              const src = resolveImageSrc(rawSrc, root, filePath);
              const localPath = resolveImagePath(rawSrc, root, filePath);
              builder.add(
                line.from,
                line.to,
                Decoration.replace({
                  widget: new ImageWidget(src, alt, isLocalSvgPath(localPath) ? localPath : null),
                  block: true,
                }),
              );
            }
            i += 1;
            continue;
          }

          // v4.3.0 issue #57a — block math (`$$…$$`).
          // Recognise either inline `$$E=mc^2$$` on a single line OR a
          // multi-line block opened with a `$$` line and closed with a `$$`
          // line. We only collapse if the cursor is outside.
          const trimmedLine = line.text.trim();
          if (trimmedLine.startsWith('$$')) {
            // Single-line `$$ ... $$`?
            if (trimmedLine.endsWith('$$') && trimmedLine.length > 4) {
              const cursorInside = keepSource || cursorLine === i || cursorLineEnd === i;
              if (!cursorInside) {
                builder.add(
                  line.from,
                  line.to,
                  Decoration.replace({
                    widget: new MathWidget(line.text),
                    block: true,
                  }),
                );
              }
              i += 1;
              continue;
            }
            // Multi-line block — scan forward for the closing `$$` line.
            let endI = i + 1;
            while (endI <= lastLine) {
              const next = doc.line(endI);
              if (next.text.trim().startsWith('$$')) break;
              endI += 1;
            }
            if (endI <= lastLine) {
              const cursorInside = keepSource || (cursorLine >= i && cursorLine <= endI);
              const cursorInsideEnd = cursorLineEnd >= i && cursorLineEnd <= endI;
              if (!cursorInside && !cursorInsideEnd) {
                const blockFrom = doc.line(i).from;
                const blockTo = doc.line(endI).to;
                const source = doc.sliceString(blockFrom, blockTo);
                builder.add(
                  blockFrom,
                  blockTo,
                  Decoration.replace({
                    widget: new MathWidget(source),
                    block: true,
                  }),
                );
              }
              i = endI + 1;
              continue;
            }
          }

          // v4.6 F7 — ```tldraw fenced whiteboard. The fence carries
          // id/height/width attributes and a variable-length backtick run
          // (3+, grown past backticks inside the JSON). Unlike every other
          // block here there is NO cursor-inside gating: the board always
          // replaces the fence (the JSON is never hand-edited), so the canvas
          // stays mounted while you type around it.
          const tldrawOpen = /^\s*(`{3,})\s*tldraw\b([^\n]*)$/i.exec(line.text);
          if (tldrawOpen) {
            const ticks = tldrawOpen[1].length;
            const closeRe = new RegExp(`^\\s*\`{${ticks},}\\s*$`);
            let endI = i + 1;
            while (endI <= lastLine && !closeRe.test(doc.line(endI).text)) {
              endI += 1;
            }
            if (endI <= lastLine) {
              const info = `tldraw${tldrawOpen[2]}`;
              let body = '';
              for (let k = i + 1; k < endI; k++) {
                body += (k > i + 1 ? '\n' : '') + doc.line(k).text;
              }
              const fence = parseTldrawFence(info, body) ?? {
                boardId: '',
                height: TLDRAW_DEFAULT_HEIGHT,
                width: '',
                snapshot: body.trim(),
              };
              const blockFrom = doc.line(i).from;
              const blockTo = doc.line(endI).to;
              builder.add(
                blockFrom,
                blockTo,
                Decoration.replace({
                  widget: new TldrawWidget(
                    fence.boardId,
                    fence.height,
                    fence.width,
                    fence.snapshot,
                    opts,
                  ),
                  block: true,
                }),
              );
              i = endI + 1;
              continue;
            }
          }

          // v4.3.0 issue #57a — ```mermaid fenced block. Pre-render to SVG
          // via the mermaid cache; the widget waits for the SVG and asks
          // CM to rebuild decorations once ready.
          if (/^\s*```\s*mermaid\s*$/i.test(line.text)) {
            let endI = i + 1;
            while (endI <= lastLine) {
              const next = doc.line(endI);
              if (/^\s*```\s*$/.test(next.text)) break;
              endI += 1;
            }
            if (endI <= lastLine) {
              const cursorInside = keepSource || (cursorLine >= i && cursorLine <= endI);
              const cursorInsideEnd = cursorLineEnd >= i && cursorLineEnd <= endI;
              if (!cursorInside && !cursorInsideEnd) {
                // Body is between the opening and closing fence.
                let body = '';
                for (let k = i + 1; k < endI; k++) {
                  body += (k > i + 1 ? '\n' : '') + doc.line(k).text;
                }
                const blockFrom = doc.line(i).from;
                const blockTo = doc.line(endI).to;
                // Kick off async render outside the build loop.
                const mermaidTheme = opts.getMermaidTheme?.() ?? 'default';
                ensureMermaidRendered(body, mermaidTheme);
                builder.add(
                  blockFrom,
                  blockTo,
                  Decoration.replace({
                    widget: new MermaidWidget(body, mermaidTheme),
                    block: true,
                  }),
                );
              }
              i = endI + 1;
              continue;
            }
          }

          // v4.10 issue #163 — ```plantuml / ```puml fence (opt-in).
          const plantumlCfg = opts.getPlantuml?.();
          if (
            plantumlCfg?.enabled &&
            plantumlCfg.server &&
            /^\s*```\s*(plantuml|puml)\s*$/i.test(line.text)
          ) {
            let endI = i + 1;
            while (endI <= lastLine) {
              const next = doc.line(endI);
              if (/^\s*```\s*$/.test(next.text)) break;
              endI += 1;
            }
            if (endI <= lastLine) {
              const cursorInside = keepSource || (cursorLine >= i && cursorLine <= endI);
              const cursorInsideEnd = cursorLineEnd >= i && cursorLineEnd <= endI;
              if (!cursorInside && !cursorInsideEnd) {
                let body = '';
                for (let k = i + 1; k < endI; k++) {
                  body += (k > i + 1 ? '\n' : '') + doc.line(k).text;
                }
                const blockFrom = doc.line(i).from;
                const blockTo = doc.line(endI).to;
                builder.add(
                  blockFrom,
                  blockTo,
                  Decoration.replace({
                    widget: new PlantumlWidget(body, plantumlSvgUrl(plantumlCfg.server, body)),
                    block: true,
                  }),
                );
              }
              i = endI + 1;
              continue;
            }
          }

          // Table block — header + separator + ≥1 body row.
          if (isPipeRow(line.text) && i + 1 <= lastLine) {
            const sepLine = doc.line(i + 1);
            if (isSeparatorRow(sepLine.text) && i + 2 <= lastLine) {
              // Walk forward as long as we keep seeing pipe rows.
              let endI = i + 2;
              while (endI <= lastLine) {
                const next = doc.line(endI);
                if (!isPipeRow(next.text)) break;
                endI += 1;
              }
              const tableEnd = endI - 1; // last pipe row
              if (tableEnd >= i + 2) {
                const cursorInside =
                  keepSource ||
                  (cursorLine >= i && cursorLine <= tableEnd
                    ? true
                    : cursorLineEnd >= i && cursorLineEnd <= tableEnd);
                if (!cursorInside) {
                  const blockFrom = doc.line(i).from;
                  const blockTo = doc.line(tableEnd).to;
                  const source = doc.sliceString(blockFrom, blockTo);
                  builder.add(
                    blockFrom,
                    blockTo,
                    Decoration.replace({
                      widget: new TableWidget(source),
                      block: true,
                    }),
                  );
                }
                i = tableEnd + 1;
                continue;
              }
            }
          }

          // v4.5.5 — inline math `$…$` on an otherwise-plain line. Render each
          // span while the caret is off this line (same reveal model as the
          // block widgets above: move the caret onto the line to edit source).
          // Cheap pre-check: only the (rare) lines that actually contain a `$`
          // pay for the inline-math regex + code-span mask. Plain prose lines
          // — the overwhelming majority in a large doc — short-circuit here, so
          // this whole-doc pass doesn't get measurably slower (#5 perf).
          const inlineCursorHere = keepSource || (i >= cursorLine && i <= cursorLineEnd);
          if (!inlineCursorHere && line.text.indexOf('$') !== -1) {
            for (const span of inlineMathSpans(line.text)) {
              builder.add(
                line.from + span.start,
                line.from + span.end,
                Decoration.replace({ widget: new InlineMathWidget(span.tex) }),
              );
            }
          }

          i += 1;
        }

        return builder.finish();
}

/**
 * Live-render of standalone images / tables / block-math / Mermaid in the
 * WYSIWYG "live edit" mode. Returns a StateField (block decorations are not
 * allowed from view plugins) plus a companion view plugin that turns the
 * async-Mermaid `solomd:cm-relayout` window event into a field recompute.
 */
export function liveBlocksExtension(opts: BlockOptions = {}) {
  const field = StateField.define<DecorationSet>({
    create: (state) => buildBlockDecorations(state, opts),
    update(deco, tr) {
      // Rebuild on edits, on a relayout signal (Mermaid SVG ready), and on
      // the drag-end flush. Selection moves rebuild too (cursor entering a
      // block reveals its source), but not mid-drag — see cm-drag-aware.ts.
      const frozen = frozenFieldDuringComposition(tr, deco);
      if (frozen) return frozen;
      if (isImeSafeFlushTransaction(tr)) return buildBlockDecorations(tr.state, opts);
      if (tr.docChanged) return buildBlockDecorations(tr.state, opts);
      if (tr.effects.some((e) => e.is(relayoutEffect))) {
        return buildBlockDecorations(tr.state, opts);
      }
      if (isDragEndTransaction(tr)) return buildBlockDecorations(tr.state, opts);
      if (tr.selection && !isDragging(tr.state)) {
        return buildBlockDecorations(tr.state, opts);
      }
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Mermaid renders asynchronously; when its SVG cache fills, the widget
  // fires `solomd:cm-relayout`. Translate that into a `relayoutEffect` so the
  // field rebuilds and the widget remounts with the finished SVG.
  const relayout = ViewPlugin.fromClass(
    class {
      private readonly onRelayout: () => void;
      constructor(view: EditorView) {
        this.onRelayout = () => {
          view.dispatch({ effects: relayoutEffect.of(null) });
        };
        window.addEventListener('solomd:cm-relayout', this.onRelayout);
      }
      destroy() {
        window.removeEventListener('solomd:cm-relayout', this.onRelayout);
      }
    },
  );

  // #155 — ↑/↓ across a collapsed block widget. CM's default vertical motion
  // has no valid cursor position inside a replaced range, so from the line
  // next to a table/math/mermaid widget it hops clear over the block. Reveal
  // model says the caret should land ON the block's edge line instead, which
  // expands it to source. We compute the default target first and only step
  // in when that target would jump past a collapsed range.
  const arrowIntoBlock = (forward: boolean) => (view: EditorView) => {
    const sel = view.state.selection.main;
    if (!sel.empty || view.state.selection.ranges.length > 1) return false;
    const deco = view.state.field(field, false);
    if (!deco) return false;
    const doc = view.state.doc;
    const fromLine = doc.lineAt(sel.head);
    const def = view.moveVertically(sel, forward);
    const toLineNo = doc.lineAt(def.head).number;
    let handled = false;
    deco.between(0, doc.length, (from, to, d) => {
      if (!(d.spec as { block?: boolean }).block) return;
      // tldraw boards never reveal their source (no cursor-inside gating in
      // buildBlockDecorations), so parking the caret inside one just hides
      // it — let the default motion hop over the fence instead.
      if ((d.spec as { widget?: unknown }).widget instanceof TldrawWidget) return;
      const a = doc.lineAt(from).number;
      const b = doc.lineAt(to).number;
      const jumpedOver = forward
        ? fromLine.number < a && toLineNo > b
        : fromLine.number > b && toLineNo < a;
      if (!jumpedOver) return;
      const edge = doc.line(forward ? a : b);
      const col = Math.min(sel.head - fromLine.from, edge.length);
      view.dispatch({
        selection: { anchor: edge.from + col },
        scrollIntoView: true,
        userEvent: 'select',
      });
      handled = true;
      return false;
    });
    return handled;
  };
  const blockArrowKeymap = Prec.high(
    keymap.of([
      { key: 'ArrowUp', run: arrowIntoBlock(false) },
      { key: 'ArrowDown', run: arrowIntoBlock(true) },
    ]),
  );

  // #155 (vim) — the arrow keymap above never sees vim's `j`/`k`, which run
  // through @replit/codemirror-vim's own key handling, so vim motions still
  // hopped clear over collapsed blocks. Instead of chasing vim's dispatch
  // path, catch the *signature* of that hop at the transaction level: an
  // empty-cursor selection moving in one step from the line directly above a
  // collapsed block to the line directly below it (or the reverse). Only a
  // single-line vertical motion produces that pair, so counted jumps (`5j`),
  // searches and `G` stay untouched; pointer selections are excluded
  // explicitly. Retarget to the block's edge line — same reveal model as the
  // arrow fix.
  const vimBlockHop = EditorState.transactionFilter.of((tr) => {
    if (tr.docChanged || !tr.selection) return tr;
    const userEvent = tr.annotation(Transaction.userEvent);
    if (userEvent && userEvent.includes('pointer')) return tr;
    const prev = tr.startState.selection.main;
    const next = tr.newSelection.main;
    if (!prev.empty || !next.empty || tr.newSelection.ranges.length > 1) return tr;
    const doc = tr.startState.doc;
    const fromNo = doc.lineAt(prev.head).number;
    const toNo = doc.lineAt(next.head).number;
    if (Math.abs(toNo - fromNo) < 2) return tr;
    const deco = tr.startState.field(field, false);
    if (!deco) return tr;
    let retarget: number | null = null;
    deco.between(0, doc.length, (from, to, d) => {
      if (!(d.spec as { block?: boolean }).block) return;
      if ((d.spec as { widget?: unknown }).widget instanceof TldrawWidget) return;
      const a = doc.lineAt(from).number;
      const b = doc.lineAt(to).number;
      const forwardHop = fromNo === a - 1 && toNo === b + 1;
      const backwardHop = fromNo === b + 1 && toNo === a - 1;
      if (!forwardHop && !backwardHop) return;
      const edge = doc.line(forwardHop ? a : b);
      const col = Math.min(prev.head - doc.lineAt(prev.head).from, edge.length);
      retarget = edge.from + col;
      return false;
    });
    if (retarget === null) return tr;
    return [tr, { selection: EditorSelection.cursor(retarget), scrollIntoView: true, sequential: true }];
  });

  return [field, relayout, blockArrowKeymap, vimBlockHop];
}

/** Suggested CSS — pulled out so the editor's theme owns the rule set. */
export const liveBlocksTheme = EditorView.theme({
  // #155 — block widgets must NOT carry vertical margins: CodeMirror measures
  // widget height via the border box, so margin space is invisible to its
  // height map. The resulting drift between the height map and the real DOM
  // below a table/image/math widget made ↑/↓ teleport across whole screens
  // (moveVertically scans with height-map coordinates). Spacing lives in
  // padding instead, which IS measured.
  '.cm-live-block': {
    margin: '0',
    padding: '0.6em 0',
    cursor: 'text',
  },
  '.cm-live-block--image img': {
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '6px',
    display: 'block',
  },
  '.cm-live-block--html': {
    maxWidth: '100%',
    overflowX: 'auto',
  },
  '.cm-live-block--html img': {
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '6px',
  },
  '.cm-live-block--html table': {
    borderCollapse: 'collapse',
  },
  '.cm-live-block--html th, .cm-live-block--html td': {
    border: '1px solid var(--border)',
    padding: '6px 12px',
  },
  '.cm-live-block--broken': {
    color: 'var(--text-faint)',
    fontStyle: 'italic',
  },
  '.cm-live-block--table table': {
    borderCollapse: 'collapse',
    margin: '0.4em 0',
    fontSize: '0.95em',
    // Body text runs at 1.8; table rows read better tighter (as in preview).
    lineHeight: '1.6',
  },
  '.cm-live-block--table th, .cm-live-block--table td': {
    border: '1px solid var(--border)',
    padding: '6px 12px',
    textAlign: 'left',
  },
  '.cm-live-block--table thead th': {
    background: 'var(--bg-elev)',
    fontWeight: '600',
  },
  // v4.3.0 issue #57a — paddings fold in the 0.6em that used to come from the
  // shared margin (see #155 note above) so the visual rhythm is unchanged.
  '.cm-live-block--math': {
    padding: '1em 0',
    overflowX: 'auto',
    textAlign: 'center',
  },
  '.cm-live-block--mermaid': {
    padding: '1.2em 0',
    textAlign: 'center',
  },
  '.cm-live-block--mermaid svg': {
    maxWidth: '100%',
    height: 'auto',
  },
  // v4.10 #163
  '.cm-live-block--plantuml': {
    padding: '1.2em 0',
    textAlign: 'center',
  },
  '.cm-live-block--plantuml img': {
    maxWidth: '100%',
    height: 'auto',
  },
  // v4.6 F7 — tldraw whiteboard card. A bordered surface hosting the live
  // canvas; the inner `.cm-tldraw-surface` fills it so tldraw can measure.
  // The bordered card is an inner element (`.cm-tldraw-card`) so the outer
  // block can keep its measurable padding (#155) without the border growing
  // around it.
  '.cm-live-block--tldraw': {
    width: '100%',
  },
  '.cm-tldraw-card': {
    position: 'relative',
    width: '100%',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    overflow: 'hidden',
    background: 'var(--bg)',
  },
  '.cm-tldraw-surface': {
    position: 'absolute',
    inset: '0',
  },
  '.cm-tldraw-loading': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    height: '100%',
    color: 'var(--text-faint)',
    fontStyle: 'italic',
    fontSize: '13px',
  },
  '.cm-tldraw-spinner': {
    width: '14px',
    height: '14px',
    border: '2px solid var(--border)',
    borderTopColor: 'var(--accent, var(--text-faint))',
    borderRadius: '50%',
    animation: 'cm-tldraw-spin 0.7s linear infinite',
    flex: '0 0 auto',
  },
  '@keyframes cm-tldraw-spin': {
    to: { transform: 'rotate(360deg)' },
  },
  '.cm-tldraw-toolbar': {
    position: 'absolute',
    top: '6px',
    right: '6px',
    zIndex: '5',
    display: 'flex',
    gap: '4px',
  },
  '.cm-tldraw-fullscreen': {
    appearance: 'none',
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    borderRadius: '6px',
    width: '26px',
    height: '26px',
    lineHeight: '1',
    cursor: 'pointer',
    fontSize: '14px',
    opacity: '0.85',
  },
  '.cm-tldraw-fullscreen:hover': {
    opacity: '1',
  },
});

// Re-exported helpers in case the editor wants to wire up the imageRoot
// extractor from outside.
export { extractImageRoot };

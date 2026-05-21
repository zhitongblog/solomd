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

import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { resolveImageSrc } from './image-resolve';
import { renderMarkdown, extractImageRoot } from './markdown';
import mermaid from 'mermaid';

// v4.3.0 issue #57a — live-render math + Mermaid blocks in the editor.
// Mermaid is async; we render lazily into a counter-keyed cache so the
// widget toDOM() can pull a ready SVG without re-rendering. The cache is
// keyed on source text → SVG so the same diagram across multiple panes
// renders once.
const mermaidSvgCache = new Map<string, { svg: string | null; error: string | null }>();
let mermaidIdSeq = 0;
async function ensureMermaidRendered(source: string): Promise<void> {
  if (mermaidSvgCache.has(source)) return;
  // Reserve the slot first so concurrent calls don't double-render.
  mermaidSvgCache.set(source, { svg: null, error: null });
  try {
    const id = `cm-mmd-${++mermaidIdSeq}`;
    const { svg } = await mermaid.render(id, source);
    mermaidSvgCache.set(source, { svg, error: null });
  } catch (e) {
    mermaidSvgCache.set(source, { svg: null, error: (e as Error).message });
  }
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
    /^\|[\s:-|]+\|$/.test(trimmed) &&
    /-{3,}/.test(trimmed)
  );
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--image';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.draggable = false;
    img.onerror = () => {
      // Image failed to load — fall back to a small "broken image" caption
      // rather than a giant empty box. The source text is one cursor-move
      // away regardless.
      wrap.classList.add('cm-live-block--broken');
      wrap.textContent = `🖼 ${this.alt || this.src}`;
    };
    wrap.appendChild(img);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class TableWidget extends WidgetType {
  constructor(private readonly source: string) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--table';
    // Render the table source through the same markdown pipeline used by the
    // preview pane so we get GFM alignment, inline formatting, etc. for free.
    // We strip everything except the table rows from the rendered output.
    const html = renderMarkdown(this.source);
    wrap.innerHTML = html;
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
  constructor(private readonly source: string) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.source === this.source;
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

// v4.3.0 issue #57a — mermaid fenced blocks. Mermaid is async so we render
// into a module-level cache; toDOM() pulls the SVG when available, falls
// back to a "rendering…" placeholder, then dispatches `solomd:cm-relayout`
// to ask the editor to rebuild decorations once the cache fills.
class MermaidWidget extends WidgetType {
  constructor(private readonly source: string, private readonly view: EditorView) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--mermaid';
    const cached = mermaidSvgCache.get(this.source);
    if (cached?.svg) {
      wrap.innerHTML = cached.svg;
    } else if (cached?.error) {
      wrap.classList.add('cm-live-block--broken');
      wrap.textContent = `Mermaid: ${cached.error}`;
    } else {
      wrap.textContent = '⌛ Rendering Mermaid…';
      ensureMermaidRendered(this.source).then(() => {
        // Force CM to rebuild decorations now that the cache has the SVG.
        try {
          this.view.dispatch({});
        } catch {}
      });
    }
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

interface BlockOptions {
  /** Workspace context for resolving relative image paths. */
  getImageRoot?: () => string | null;
  /** Active note's filesystem path so relative paths resolve to its dir. */
  getFilePath?: () => string | undefined;
}

export function liveBlocksPlugin(opts: BlockOptions = {}) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const sel = view.state.selection.main;
        const cursorLine = view.state.doc.lineAt(sel.from).number;
        const cursorLineEnd = view.state.doc.lineAt(sel.to).number;

        // Single pass over the visible doc — for each line, decide:
        //   * is it a standalone image line we should replace? (1 line)
        //   * is it the start of a table block we should collapse? (N lines)
        // Tables are walked as ranges so we don't double-iterate.
        const doc = view.state.doc;
        const lastLine = doc.lines;
        let i = 1;
        while (i <= lastLine) {
          const line = doc.line(i);

          // Skip lines outside the viewport — performance only; widgets must
          // still build in the visible range.
          if (!view.visibleRanges.some((r) => r.from <= line.to && r.to >= line.from)) {
            i += 1;
            continue;
          }

          // Image line.
          const imgMatch = IMAGE_LINE_RE.exec(line.text);
          if (imgMatch) {
            const cursorInside = i >= cursorLine && i <= cursorLineEnd;
            if (!cursorInside) {
              const alt = imgMatch[1];
              const rawSrc = imgMatch[2];
              const root = opts.getImageRoot?.() ?? null;
              const filePath = opts.getFilePath?.();
              const src = resolveImageSrc(rawSrc, root, filePath);
              builder.add(
                line.from,
                line.to,
                Decoration.replace({
                  widget: new ImageWidget(src, alt),
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
              const cursorInside = cursorLine === i || cursorLineEnd === i;
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
              const cursorInside = cursorLine >= i && cursorLine <= endI;
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
              const cursorInside = cursorLine >= i && cursorLine <= endI;
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
                ensureMermaidRendered(body);
                builder.add(
                  blockFrom,
                  blockTo,
                  Decoration.replace({
                    widget: new MermaidWidget(body, view),
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
                  cursorLine >= i && cursorLine <= tableEnd
                    ? true
                    : cursorLineEnd >= i && cursorLineEnd <= tableEnd;
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

          i += 1;
        }

        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Suggested CSS — pulled out so the editor's theme owns the rule set. */
export const liveBlocksTheme = EditorView.theme({
  '.cm-live-block': {
    margin: '0.6em 0',
    padding: '0',
    cursor: 'text',
  },
  '.cm-live-block--image img': {
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '6px',
    display: 'block',
  },
  '.cm-live-block--broken': {
    color: 'var(--text-faint)',
    fontStyle: 'italic',
  },
  '.cm-live-block--table table': {
    borderCollapse: 'collapse',
    margin: '0.4em 0',
    fontSize: '0.95em',
  },
  '.cm-live-block--table th, .cm-live-block--table td': {
    border: '1px solid var(--border)',
    padding: '6px 12px',
    textAlign: 'left',
  },
  '.cm-live-block--table thead th': {
    background: 'var(--bg-soft)',
    fontWeight: '600',
  },
  // v4.3.0 issue #57a
  '.cm-live-block--math': {
    padding: '0.4em 0',
    overflowX: 'auto',
    textAlign: 'center',
  },
  '.cm-live-block--mermaid': {
    padding: '0.6em 0',
    textAlign: 'center',
  },
  '.cm-live-block--mermaid svg': {
    maxWidth: '100%',
    height: 'auto',
  },
});

// Re-exported helpers in case the editor wants to wire up the imageRoot
// extractor from outside.
export { extractImageRoot };

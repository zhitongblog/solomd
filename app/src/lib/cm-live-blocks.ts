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
import yaml from 'js-yaml';
import { keymap } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { SearchQuery, getSearchQuery, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { syntaxTree } from '@codemirror/language';
import { isDragging, isDragEndTransaction } from './cm-drag-aware';
import { frozenFieldDuringComposition, isImeSafeFlushTransaction } from './cm-ime-guard';
import { applySearchMarksIn, clearSearchMarksIn, findPreviewHitsInText } from './preview-search-hits';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';

export const setExternalSearchQueryEffect = StateEffect.define<string>();

// ---------------------------------------------------------------------------
// #626 — Collapsible YAML Frontmatter Properties Widget for Live Edit.
// ---------------------------------------------------------------------------
let frontmatterCollapsedSession = false;

function formatFmDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return String(d);
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').slice(0, 19);
}

function renderFmValueDom(val: unknown): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'cm-frontmatter-card__val';
  if (val === null || val === undefined) {
    wrap.classList.add('md-frontmatter-empty');
    wrap.textContent = '—';
    return wrap;
  }
  if (val instanceof Date) {
    wrap.classList.add('md-frontmatter-date');
    wrap.textContent = formatFmDate(val);
    return wrap;
  }
  if (typeof val === 'boolean') {
    const badge = document.createElement('span');
    badge.className = `md-frontmatter-bool md-frontmatter-bool--${val ? 'true' : 'false'}`;
    badge.textContent = val ? '✓ true' : '✕ false';
    wrap.appendChild(badge);
    return wrap;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) {
      wrap.classList.add('md-frontmatter-empty');
      wrap.textContent = '[]';
      return wrap;
    }
    const chips = document.createElement('span');
    chips.className = 'md-frontmatter-chips';
    for (const item of val) {
      const chip = document.createElement('span');
      chip.className = 'md-frontmatter-chip';
      chip.textContent =
        item instanceof Date
          ? formatFmDate(item)
          : typeof item === 'object' && item !== null
            ? JSON.stringify(item)
            : String(item ?? '');
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);
    return wrap;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^https?:\/\/\S+$/i.test(trimmed)) {
      const a = document.createElement('a');
      a.className = 'md-frontmatter-link';
      a.href = trimmed;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = trimmed;
      a.addEventListener('mousedown', (e) => e.stopPropagation());
      wrap.appendChild(a);
      return wrap;
    }
    wrap.textContent = val;
    return wrap;
  }
  if (typeof val === 'object') {
    const code = document.createElement('code');
    code.textContent = JSON.stringify(val);
    wrap.appendChild(code);
    return wrap;
  }
  wrap.textContent = String(val);
  return wrap;
}

class FrontmatterWidget extends WidgetType {
  readonly yamlBody: string;
  readonly editPos: number;

  constructor(yamlBody: string, editPos: number) {
    super();
    this.yamlBody = yamlBody;
    this.editPos = editPos;
  }

  eq(other: FrontmatterWidget): boolean {
    return this.yamlBody === other.yamlBody && this.editPos === other.editPos;
  }

  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cm-frontmatter-card';

    let entries: [string, unknown][] | null = null;
    let parseErr: string | null = null;
    try {
      const parsed = yaml.load(this.yamlBody);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries = Object.entries(parsed as Record<string, unknown>);
      } else if (this.yamlBody.trim() === '') {
        entries = [];
      } else {
        parseErr = 'Frontmatter must be a YAML mapping (key: value).';
      }
    } catch (e) {
      parseErr = e instanceof Error ? e.message : String(e);
    }

    const head = document.createElement('div');
    head.className = 'cm-frontmatter-card__head';

    const titleWrap = document.createElement('span');
    titleWrap.className = 'cm-frontmatter-card__title';
    const chevron = document.createElement('span');
    chevron.textContent = frontmatterCollapsedSession ? '▸' : '▾';
    const label = document.createElement('span');
    label.textContent = 'YAML Frontmatter';
    titleWrap.appendChild(chevron);
    titleWrap.appendChild(label);
    if (entries) {
      const badge = document.createElement('span');
      badge.className = 'cm-frontmatter-card__badge';
      badge.textContent = String(entries.length);
      titleWrap.appendChild(badge);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'cm-frontmatter-card__edit';
    editBtn.textContent = 'YAML';
    editBtn.title = 'Edit YAML frontmatter';
    editBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetPos = Math.min(this.editPos, view.state.doc.length);
      view.dispatch({
        selection: { anchor: targetPos },
        scrollIntoView: true,
      });
      view.focus();
    });

    head.appendChild(titleWrap);
    head.appendChild(editBtn);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'cm-frontmatter-card__body';
    if (frontmatterCollapsedSession && !parseErr) {
      body.style.display = 'none';
    }

    if (parseErr) {
      const errEl = document.createElement('div');
      errEl.className = 'cm-frontmatter-card__err';
      errEl.textContent = parseErr;
      body.appendChild(errEl);
    } else if (entries && entries.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'cm-frontmatter-card__grid';
      for (const [k, v] of entries) {
        const keyEl = document.createElement('span');
        keyEl.className = 'cm-frontmatter-card__key';
        keyEl.textContent = k;
        grid.appendChild(keyEl);
        grid.appendChild(renderFmValueDom(v));
      }
      body.appendChild(grid);
    } else {
      const emptyEl = document.createElement('span');
      emptyEl.className = 'md-frontmatter-empty';
      emptyEl.textContent = 'Empty frontmatter';
      body.appendChild(emptyEl);
    }

    head.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      frontmatterCollapsedSession = !frontmatterCollapsedSession;
      chevron.textContent = frontmatterCollapsedSession ? '▸' : '▾';
      body.style.display = frontmatterCollapsedSession ? 'none' : '';
    });

    card.appendChild(body);
    return card;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export const externalSearchQueryField = StateField.define<string>({
  create: () => '',
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setExternalSearchQueryEffect)) return e.value.trim();
    }
    if (tr.docChanged || searchPanelOpen(tr.state)) return '';
    return value;
  },
});

const externalMatchMark = Decoration.mark({ class: 'cm-searchMatch' });
const externalSelectedMatchMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

export function externalSearchHighlightExtension() {
  const highlighter = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        const prev = update.startState.field(externalSearchQueryField, false) ?? '';
        const next = update.state.field(externalSearchQueryField, false) ?? '';
        const prevPanel = searchPanelOpen(update.startState);
        const nextPanel = searchPanelOpen(update.state);
        if (
          prev !== next ||
          prevPanel !== nextPanel ||
          (next && (update.docChanged || update.selectionSet || update.viewportChanged))
        ) {
          this.decorations = this.build(update.view);
        }
      }
      build(view: EditorView): DecorationSet {
        if (searchPanelOpen(view.state)) return Decoration.none;
        const ext = view.state.field(externalSearchQueryField, false) ?? '';
        if (!ext) return Decoration.none;
        const sq = new SearchQuery({ search: ext });
        if (!sq.valid) return Decoration.none;
        const builder = new RangeSetBuilder<Decoration>();
        const ranges = view.visibleRanges;
        for (let i = 0; i < ranges.length; i++) {
          let { from, to } = ranges[i];
          while (i < ranges.length - 1 && to > ranges[i + 1].from - 500) {
            to = ranges[++i].to;
          }
          const cur = sq.getCursor(view.state, from, to);
          for (let step = cur.next(); !step.done; step = cur.next()) {
            const m = step.value;
            if (m.from >= m.to) continue;
            const selected = view.state.selection.ranges.some(
              (r) => r.from === m.from && r.to === m.to,
            );
            builder.add(m.from, m.to, selected ? externalSelectedMatchMark : externalMatchMark);
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clearOnEscape = keymap.of([
    {
      key: 'Escape',
      run(view) {
        const ext = view.state.field(externalSearchQueryField, false) ?? '';
        if (!ext || searchPanelOpen(view.state)) return false;
        view.dispatch({ effects: setExternalSearchQueryEffect.of('') });
        return true;
      },
    },
  ]);

  return [externalSearchQueryField, Prec.low(highlighter), clearOnEscape];
}

function activeEditorSearchSpec(
  state: EditorState,
): { search: string; caseSensitive: boolean } | null {
  if (searchPanelOpen(state)) {
    const q = getSearchQuery(state);
    if (q.valid && q.search.trim()) {
      return { search: q.search, caseSensitive: q.caseSensitive };
    }
    return null;
  }
  const ext = state.field(externalSearchQueryField, false);
  if (ext && ext.trim()) {
    return { search: ext.trim(), caseSensitive: false };
  }
  return null;
}

// Block decorations (Decoration.replace with `block: true`) MUST come from a
// StateField — CM6 throws "Block decorations may not be specified via plugins"
// if a ViewPlugin emits them. So this whole module is a state field, not a
// view plugin. `relayoutEffect` lets the async Mermaid render (and any other
// out-of-band trigger) ask the field to recompute.
const relayoutEffect = StateEffect.define<null>();

/**
 * #530 — Explicit user fold/unfold toggle for ` ```mermaid ` code blocks in
 * Live Edit mode (`true` = fold code body and show `[+] ```mermaid` + diagram;
 * `false` = expand code body and show `[-] ```mermaid` + code + diagram).
 */
export const toggleMermaidFoldEffect = StateEffect.define<{
  line: number;
  collapsed: boolean;
}>();

const mermaidFoldState = StateField.define<ReadonlyMap<number, boolean>>({
  create: () => new Map(),
  update(map, tr) {
    for (const e of tr.effects) {
      if (e.is(resetBlockFoldOverridesEffect)) {
        return new Map();
      }
    }
    let next: Map<number, boolean> | null = null;
    if (tr.docChanged && map.size > 0) {
      next = new Map();
      for (const [oldLine, val] of map.entries()) {
        if (oldLine >= 1 && oldLine <= tr.startState.doc.lines) {
          const oldPos = tr.startState.doc.line(oldLine).from;
          const newPos = tr.changes.mapPos(oldPos, 1);
          const newLine = tr.state.doc.lineAt(Math.min(newPos, tr.state.doc.length));
          if (/^\s*(`{3,}|~{3,})\s*(mermaid|markmap|mm|excalidraw|plantuml|puml)\s*$/i.test(newLine.text)) {
            next.set(newLine.number, val);
          }
        }
      }
    }
    for (const e of tr.effects) {
      if (e.is(toggleMermaidFoldEffect)) {
        if (!next) next = new Map(map);
        next.set(e.value.line, e.value.collapsed);
      }
    }
    return next ?? map;
  },
});

export const toggleTableFoldEffect = StateEffect.define<{
  line: number;
  collapsed: boolean;
}>();

export const resetBlockFoldOverridesEffect = StateEffect.define<null>();

const tableFoldState = StateField.define<ReadonlyMap<number, boolean>>({
  create: () => new Map(),
  update(map, tr) {
    for (const e of tr.effects) {
      if (e.is(resetBlockFoldOverridesEffect)) {
        return new Map();
      }
    }
    let next: Map<number, boolean> | null = null;
    if (tr.docChanged && map.size > 0) {
      next = new Map();
      for (const [oldLine, val] of map.entries()) {
        if (oldLine >= 1 && oldLine <= tr.startState.doc.lines) {
          const oldPos = tr.startState.doc.line(oldLine).from;
          const newPos = tr.changes.mapPos(oldPos, 1);
          const newLine = tr.state.doc.lineAt(Math.min(newPos, tr.state.doc.length));
          if (newLine.text.includes('|')) {
            next.set(newLine.number, val);
          }
        }
      }
    }
    for (const e of tr.effects) {
      if (e.is(toggleTableFoldEffect)) {
        if (!next) next = new Map(map);
        next.set(e.value.line, e.value.collapsed);
      }
    }
    return next ?? map;
  },
});
import {
  installSvgImageFallbacks,
  isLocalSvgPath,
  resolveImagePath,
  resolveImageSrc,
  rewriteImageUrls,
} from './image-resolve';
import { renderMarkdown, extractImageRoot } from './markdown';
import { parseTable, type TableModel } from './markdown-table';
import {
  HEADER_ROW,
  applyCellEdit,
  applyCellEditAndAppendRow,
  cellText,
  normalizeCellInput,
  stepCell,
  stepCellVertical,
} from './table-cell-edit';
import { undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import { findHtmlBlockEnd } from './html-live-render';
import { openRenderedLink } from './link-open';
import {
  extractImageReferenceDefinitions,
  findMarkdownImagesInLine,
  parseImageAltSize,
} from './md-image-url';
import { plantumlSvgUrl } from './plantuml';
import { renderMarkmapSvg } from './markmap-render';
import { renderExcalidrawSvg } from './excalidraw';
import { bindMermaidInteractions, peekMermaidSvg, renderMermaidCached } from './mermaid-lazy';
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
// #522 — the SVG cache and the serial render queue now live in mermaid-lazy,
// shared with the preview pane. This module used to own a private cache AND
// kick off a render for every mermaid fence while building decorations over
// the whole document: opening a note with 50 diagrams started 50 concurrent
// CPU-bound renders and, worse, each completion dispatched a full relayout
// (i.e. 50 more full-document decoration builds). Renders now start only
// from `MermaidWidget.toDOM()`, which CodeMirror calls for visible blocks,
// so off-screen diagrams cost nothing until they scroll into view.

// Pipe table heuristic: a header line, a separator (`---` / `:---:`), then
// at least one body row. We don't try to parse the GFM grammar ourselves —
// markdown-it does that — we only need a cheap detector to decide which
// line ranges to swap with widgets.
// #480 — tables inside blockquotes (`> | a | b |`) carry leading `>` markers;
// strip the quote prefix when checking pipe rows, while requiring every row
// of the table to share the same blockquote nesting depth.
function quoteDepth(line: string): number {
  const m = line.match(/^\s*((?:>\s*)+)/);
  if (!m) return 0;
  return (m[1].match(/>/g) || []).length;
}
function stripQuotePrefix(line: string): string {
  return line.replace(/^\s*(?:>\s*)+/, '');
}
function hasUnescapedPipe(text: string): boolean {
  const n = text.length;
  let p = 0;
  while (p < n) {
    if (text[p] === '`') {
      let ticks = 1;
      while (p + ticks < n && text[p + ticks] === '`') ticks++;
      let q = p + ticks;
      let closed = -1;
      while (q < n) {
        if (text[q] === '`') {
          let ticks2 = 1;
          while (q + ticks2 < n && text[q + ticks2] === '`') ticks2++;
          if (ticks2 === ticks) {
            closed = q + ticks2;
            break;
          }
          q += ticks2;
        } else {
          q++;
        }
      }
      p = closed >= 0 ? closed : p + ticks;
      continue;
    }
    if (text[p] === '\\' && p + 1 < n) {
      p += 2;
      continue;
    }
    if (text[p] === '|') return true;
    p++;
  }
  return false;
}
function isPipeRow(line: string, expectedQuoteDepth?: number): boolean {
  if (expectedQuoteDepth !== undefined && quoteDepth(line) !== expectedQuoteDepth) return false;
  const trimmed = stripQuotePrefix(line).trim();
  if (!trimmed || trimmed === '|') return false;
  if (/^(?:[-+*]\s|\d+[.)]\s|#{1,6}\s|```|~~~)/.test(trimmed)) return false;
  return hasUnescapedPipe(trimmed);
}
function isSeparatorRow(line: string, expectedQuoteDepth?: number): boolean {
  if (expectedQuoteDepth !== undefined && quoteDepth(line) !== expectedQuoteDepth) return false;
  const trimmed = stripQuotePrefix(line).trim();
  if (!trimmed.includes('|')) return false;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = inner.split('|');
  if (cells.length === 0) return false;
  let hasRealCell = false;
  for (const c of cells) {
    if (c.trim() === '') continue;
    if (!/^\s*:?-+:?\s*$/.test(c)) return false;
    hasRealCell = true;
  }
  return hasRealCell;
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

// #522 — coalesce relayout requests. Every finished mermaid render used to
// dispatch its own event, so N diagrams triggered N full-document decoration
// rebuilds; one timer collapses a burst into a single rebuild.
function scheduleRelayout(): void {
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
    if (
      cached &&
      !img.hasAttribute('width') &&
      !img.hasAttribute('height') &&
      !img.style.width &&
      !img.style.height
    ) {
      img.width = cached.w;
      img.height = cached.h;
    }
    const done = () => {
      if (img.naturalWidth && img.naturalHeight) {
        imageNaturalSizes.set(img.src, { w: img.naturalWidth, h: img.naturalHeight });
      }
      scheduleRelayout();
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
  private readonly src: string;
  private readonly alt: string;
  private readonly localPath: string | null;
  private readonly lineNumber: number;
  private readonly inline: boolean;
  private readonly cleanAlt: string;
  private readonly width: string | null;
  private readonly height: string | null;

  // Plain field assignments, not TS parameter properties: node --test strips
  // types only and rejects parameter-property syntax, and the regression
  // tests below build real decorations through liveBlocksExtension().
  constructor(
    src: string,
    alt: string,
    localPath: string | null = null,
    lineNumber: number = 0,
    inline: boolean = false,
    explicitWidth: string | null = null,
    explicitHeight: string | null = null,
  ) {
    super();
    this.src = src;
    this.alt = alt;
    this.localPath = localPath;
    this.lineNumber = lineNumber;
    this.inline = inline;
    const parsed = parseImageAltSize(alt);
    this.cleanAlt = parsed.alt;
    this.width = explicitWidth || parsed.width;
    this.height = explicitHeight || parsed.height;
  }

  eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.localPath === this.localPath &&
      other.lineNumber === this.lineNumber &&
      other.inline === this.inline &&
      other.width === this.width &&
      other.height === this.height
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement(this.inline ? 'span' : 'div');
    wrap.className = this.inline
      ? 'cm-live-block cm-live-block--image cm-live-block--image-inline'
      : 'cm-live-block cm-live-block--image';
    const img = document.createElement('img');
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.referrerPolicy = 'no-referrer';
    img.alt = this.cleanAlt;
    img.loading = 'lazy';
    img.draggable = false;
    if (this.width) img.style.width = this.width;
    if (this.height) img.style.height = this.height;
    if (this.lineNumber > 0) img.dataset.solomdLine = String(this.lineNumber);
    if (this.localPath) img.dataset.solomdLocalSrc = this.localPath;
    img.src = this.src;
    img.onerror = () => {
      // Image failed to load — fall back to a small "broken image" caption
      // rather than a giant empty box. The source text is one cursor-move
      // away regardless.
      if (this.localPath) return;
      wrap.classList.add('cm-live-block--broken');
      wrap.textContent = `🖼 ${this.cleanAlt || this.src}`;
    };
    wrap.appendChild(img);
    installSvgImageFallbacks(wrap);
    trackImageHeights(wrap);
    return wrap;
  }

  ignoreEvent(event: Event): boolean {
    if (event.type === 'contextmenu') return true;
    if (event instanceof MouseEvent && event.button === 2) return true;
    return false;
  }
}

/**
 * #504 — Compute the character offset within a Markdown pipe-table row line
 * (`| col0 | col1 |`) for the `colIdx`-th cell (0-based), ignoring escaped
 * `\|` and pipes inside inline code spans. `clickRatio` (0..1) maps the
 * horizontal click position across the trimmed cell text.
 */
export function findTableCellOffsetInLine(
  lineText: string,
  colIdx: number,
  clickRatio = 1,
): number {
  const n = lineText.length;
  const pipes: number[] = [];
  let p = 0;
  while (p < n) {
    if (lineText[p] === '`') {
      let ticks = 1;
      while (p + ticks < n && lineText[p + ticks] === '`') ticks++;
      let q = p + ticks;
      let closed = -1;
      while (q < n) {
        if (lineText[q] === '`') {
          let ticks2 = 1;
          while (q + ticks2 < n && lineText[q + ticks2] === '`') ticks2++;
          if (ticks2 === ticks) {
            closed = q + ticks2;
            break;
          }
          q += ticks2;
        } else {
          q++;
        }
      }
      p = closed >= 0 ? closed : p + ticks;
      continue;
    }
    if (lineText[p] === '\\' && p + 1 < n) {
      p += 2;
      continue;
    }
    if (lineText[p] === '|') {
      pipes.push(p);
    }
    p++;
  }
  if (pipes.length === 0) return n;
  const prefixLen = (lineText.match(/^\s*(?:>\s*)*/)?.[0] ?? '').length;
  const trimmedEnd = lineText.trimEnd().length;
  const bounds: number[] = [];
  if (pipes[0] !== prefixLen) {
    bounds.push(prefixLen - 1);
  }
  bounds.push(...pipes);
  if (pipes[pipes.length - 1] !== trimmedEnd - 1) {
    bounds.push(n);
  }
  const maxCellIdx = Math.max(0, bounds.length - 2);
  const cellIdx = Math.max(0, Math.min(colIdx, maxCellIdx));
  const cellStart = bounds[cellIdx] + 1;
  const cellEnd = bounds[cellIdx + 1] ?? n;
  const rawCell = lineText.slice(cellStart, cellEnd);
  const firstNonSpace = rawCell.search(/\S/);
  if (firstNonSpace < 0) {
    return Math.min(cellStart + 1, cellEnd);
  }
  const lastNonSpace = rawCell.trimEnd().length;
  const contentStart = cellStart + firstNonSpace;
  const contentEnd = cellStart + lastNonSpace;
  const ratio = Math.max(0, Math.min(1, Number.isFinite(clickRatio) ? clickRatio : 1));
  return contentStart + Math.round((contentEnd - contentStart) * ratio);
}

function dedentTableSource(source: string): string {
  const lines = source.split('\n');
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^[ \t]*/);
    const indent = m ? m[0].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent) || minIndent <= 0) return source;
  return lines.map((line) => (line.length >= minIndent ? line.slice(minIndent) : line)).join('\n');
}

function tableIndentCols(source: string): number {
  let minCols = Infinity;
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
    let cols = 0;
    for (const ch of lead) cols += ch === '\t' ? 4 - (cols % 4) : 1;
    if (cols < minCols) minCols = cols;
  }
  return Number.isFinite(minCols) && minCols > 0 ? minCols : 0;
}

/**
 * The cell a rebuilt table widget should re-open after a write-back.
 *
 * Committing a cell replaces the whole widget, so the DOM holding the caret is
 * destroyed and cannot be focused again. The replacement reads this at build
 * time and puts the caret back — which is why it is module state and not a
 * field on the widget being thrown away.
 */
let pendingCellFocus: { from: number; row: number; col: number; at: number } | null = null;

export interface ActiveTableCellSession {
  from: number;
  to: number;
  row: number;
  col: number;
  cellEl: HTMLTableCellElement;
  tableEl: HTMLTableElement;
  wrapEl: HTMLElement;
  /** Returns the up-to-date TableModel including any un-flushed edits in the active cell. */
  getCurrentModel: () => TableModel | null;
  /** Cancels pending blur commit (e.g. when a TableToolbar button is about to replace the whole table). */
  cancelCommit: () => void;
}

let activeTableCellSession: ActiveTableCellSession | null = null;

export function getActiveTableCellSession(
  root?: HTMLElement | null,
): ActiveTableCellSession | null {
  if (!activeTableCellSession || !activeTableCellSession.cellEl.isConnected) {
    activeTableCellSession = null;
    return null;
  }
  if (root && !root.contains(activeTableCellSession.cellEl)) {
    return null;
  }
  return activeTableCellSession;
}

export function requestTableCellFocus(from: number, row: number, col: number): void {
  pendingCellFocus = { from, row, col, at: Date.now() };
}

export interface DomTableEditorAdapter {
  source: string;
  from: number;
  to: number;
  isReadOnly: () => boolean;
  commitMarkdown: (markdown: string, nextFocus: { row: number; col: number } | null) => void;
  exitTable: (direction: 'before' | 'after' | 'stay') => void;
  onUndo?: () => boolean;
  onRedo?: () => boolean;
}

export type DomTableBeginState = 'editing' | 'started' | false;

export interface DomTableEditorHandle {
  begin: (ev: MouseEvent, cell: HTMLTableCellElement) => DomTableBeginState;
  focusCell: (row: number, col: number, caret?: 'start' | 'end') => boolean;
}

function isCaretAtCellBoundary(cell: HTMLElement, boundary: 'start' | 'end'): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!cell.contains(range.startContainer)) return false;
  const testRange = document.createRange();
  testRange.selectNodeContents(cell);
  if (boundary === 'start') {
    testRange.setEnd(range.startContainer, range.startOffset);
  } else {
    testRange.setStart(range.endContainer, range.endOffset);
  }
  return (testRange.toString() ?? '').length === 0;
}

function wrapCellSelectionWithMarkdown(cell: HTMLElement, marker: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!cell.contains(range.commonAncestorContainer)) return;
  const selected = range.toString();
  const replacement = `${marker}${selected}${marker}`;
  range.deleteContents();
  const textNode = document.createTextNode(replacement);
  range.insertNode(textNode);
  const nextRange = document.createRange();
  if (selected.length > 0) {
    nextRange.setStart(textNode, marker.length);
    nextRange.setEnd(textNode, marker.length + selected.length);
  } else {
    nextRange.setStart(textNode, marker.length);
    nextRange.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(nextRange);
}

/**
 * #500 — Shared in-place DOM table cell editor used by both CodeMirror's
 * `TableWidget` and the Windows Plain Live Block Editor.
 */
export function bindDomTableCellEditor(
  wrap: HTMLElement,
  adapter: DomTableEditorAdapter,
): DomTableEditorHandle | null {
  const table = wrap.querySelector('table');
  if (!table || adapter.from < 0 || adapter.to < 0) return null;

  wrap.dataset.tableFrom = String(adapter.from);
  wrap.dataset.tableTo = String(adapter.to);

  const head = table.tHead;
  let bodyRow = 0;
  for (const row of Array.from(table.rows)) {
    const r = head && row.parentElement === head ? HEADER_ROW : bodyRow++;
    for (const cell of Array.from(row.cells)) {
      cell.dataset.row = String(r);
      cell.dataset.col = String(cell.cellIndex);
    }
  }

  let active: { cell: HTMLTableCellElement; row: number; col: number; html: string } | null = null;
  let written = false;
  let suppressCommit = false;

  const model = () => parseTable(adapter.source) ?? null;

  const getCurrentModel = (): TableModel | null => {
    const m = model();
    if (!m) return null;
    if (!active) return m;
    const text = normalizeCellInput(active.cell.textContent ?? '');
    if (active.row === HEADER_ROW) {
      if (active.col >= 0 && active.col < m.header.length) {
        const header = m.header.slice();
        header[active.col] = text;
        return { ...m, header };
      }
      return m;
    }
    if (active.row >= 0 && active.row < m.rows.length && active.col >= 0 && active.col < m.header.length) {
      const rows = m.rows.map((r, idx) => {
        if (idx !== active!.row) return r;
        const copy = r.slice();
        copy[active!.col] = text;
        return copy;
      });
      return { ...m, rows };
    }
    return m;
  };

  const notifySession = () => {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('solomd:table-cell-session'));
    }
  };

  const syncSession = () => {
    if (active) {
      activeTableCellSession = {
        from: adapter.from,
        to: adapter.to,
        row: active.row,
        col: active.col,
        cellEl: active.cell,
        tableEl: table,
        wrapEl: wrap,
        getCurrentModel,
        cancelCommit: () => {
          suppressCommit = true;
          leave();
        },
      };
    } else if (activeTableCellSession?.wrapEl === wrap) {
      activeTableCellSession = null;
    }
    notifySession();
  };

  const caretToEdge = (cell: HTMLElement, edge: 'start' | 'end' = 'end') => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(edge === 'start');
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const leave = (): { row: number; col: number; text: string } | null => {
    const a = active;
    if (!a) return null;
    active = null;
    const text = a.cell.textContent ?? '';
    a.cell.classList.remove('cm-live-table__cell--editing');
    a.cell.removeAttribute('contenteditable');
    a.cell.removeAttribute('spellcheck');
    a.cell.removeAttribute('tabindex');
    if (!written) {
      a.cell.innerHTML = a.html;
    }
    syncSession();
    return { row: a.row, col: a.col, text };
  };

  const commit = (
    focus: { row: number; col: number } | null,
    appendRow = false,
  ): boolean => {
    const done = leave();
    if (!done || written || suppressCommit) return false;
    if (appendRow) {
      const appended = applyCellEditAndAppendRow(adapter.source, done.row, done.col, done.text);
      if (!appended) return false;
      written = true;
      const targetFocus = focus ?? { row: appended.nextRow, col: appended.nextCol };
      pendingCellFocus = {
        from: adapter.from,
        row: targetFocus.row,
        col: targetFocus.col,
        at: Date.now(),
      };
      adapter.commitMarkdown(appended.markdown, targetFocus);
      return true;
    }
    const markdown = applyCellEdit(adapter.source, done.row, done.col, done.text);
    if (!markdown) return false;
    written = true;
    if (focus) {
      pendingCellFocus = { from: adapter.from, row: focus.row, col: focus.col, at: Date.now() };
    }
    adapter.commitMarkdown(markdown, focus);
    return true;
  };

  const start = (cell: HTMLTableCellElement): boolean => {
    if (adapter.isReadOnly()) return false;
    const m = model();
    if (!m) return false;
    const row = Number(cell.dataset.row ?? HEADER_ROW);
    const col = Number(cell.dataset.col ?? cell.cellIndex);
    if (col < 0 || col >= m.header.length) return false;
    if (row !== HEADER_ROW && (row < 0 || row >= m.rows.length)) return false;
    clearSearchMarksIn(cell);
    active = { cell, row, col, html: cell.innerHTML };
    cell.textContent = cellText(m, row, col);
    cell.classList.add('cm-live-table__cell--editing');
    cell.setAttribute('contenteditable', 'true');
    cell.setAttribute('spellcheck', 'false');
    cell.setAttribute('tabindex', '-1');
    cell.focus({ preventScroll: true });
    syncSession();
    return true;
  };

  const scrollCellIntoView = (cell: HTMLTableCellElement): void => {
    try {
      cell.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch {
      // Fallback for non-standard scrollIntoView implementations.
    }
    const scroller = wrap.closest?.('.plain-block-editor, .plain-live-host, .cm-scroller') as HTMLElement | null;
    if (!scroller || typeof cell.getBoundingClientRect !== 'function' || typeof scroller.getBoundingClientRect !== 'function') {
      return;
    }
    const cellRect = cell.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    if (!(scrollerRect.height > 0) || !(cellRect.height > 0)) return;
    const pad = 8;
    if (cellRect.top < scrollerRect.top + pad) {
      scroller.scrollTop -= scrollerRect.top + pad - cellRect.top;
    } else if (cellRect.bottom > scrollerRect.bottom - pad) {
      scroller.scrollTop += cellRect.bottom - (scrollerRect.bottom - pad);
    }
  };

  const focusCell = (row: number, col: number, caret: 'start' | 'end' = 'end'): boolean => {
    const cell = wrap.querySelector<HTMLTableCellElement>(
      `[data-row="${row}"][data-col="${col}"]`,
    );
    if (!cell || !start(cell)) return false;
    caretToEdge(cell, caret);
    scrollCellIntoView(cell);
    return true;
  };

  let cleanupFirstPressDrag: (() => void) | null = null;

  const begin = (ev: MouseEvent, cell: HTMLTableCellElement): DomTableBeginState => {
    if (adapter.isReadOnly()) return false;
    const row = Number(cell.dataset.row ?? HEADER_ROW);
    const col = Number(cell.dataset.col ?? cell.cellIndex);
    if (active && active.cell === cell) {
      // Already editing this cell: do NOT preventDefault on mousedown so the
      // browser natively repositions the caret at the clicked glyph, selects
      // words on double-click, and supports native mouse-drag text selection.
      return 'editing';
    }
    cleanupFirstPressDrag?.();
    cleanupFirstPressDrag = null;
    if (active) commit({ row, col });
    if (written) return 'started';
    if (!start(cell)) return false;

    const range = caretRangeAt(ev.clientX, ev.clientY);
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    if (range && cell.contains(range.startContainer)) {
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else {
      caretToEdge(cell, 'end');
    }

    // Also support click-and-drag text selection right on the very first press
    // that enters the cell (where mousedown had to replace rendered HTML with
    // plain text and preventDefault).
    if (
      sel &&
      sel.rangeCount > 0 &&
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      const initRange = sel.getRangeAt(0);
      const anchorNode = initRange.startContainer;
      const anchorOffset = initRange.startOffset;
      const startX = ev.clientX;
      const startY = ev.clientY;
      let dragging = false;
      const stopDrag = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', stopDrag);
        window.removeEventListener('blur', stopDrag);
        if (cleanupFirstPressDrag === stopDrag) cleanupFirstPressDrag = null;
      };
      const onMove = (moveEv: MouseEvent) => {
        if (!active || active.cell !== cell || !cell.isConnected) {
          stopDrag();
          return;
        }
        if ((moveEv.buttons & 1) === 0) {
          stopDrag();
          return;
        }
        if (!dragging && Math.abs(moveEv.clientX - startX) + Math.abs(moveEv.clientY - startY) < 3) {
          return;
        }
        dragging = true;
        const headRange = caretRangeAt(moveEv.clientX, moveEv.clientY);
        if (headRange && cell.contains(headRange.startContainer) && typeof sel.setBaseAndExtent === 'function') {
          sel.setBaseAndExtent(anchorNode, anchorOffset, headRange.startContainer, headRange.startOffset);
        }
      };
      cleanupFirstPressDrag = stopDrag;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', stopDrag);
      window.addEventListener('blur', stopDrag);
    }

    return 'started';
  };

  wrap.addEventListener(
    'keydown',
    (ev: KeyboardEvent) => {
      if (!active) return;
      const here = { row: active.row, col: active.col };
      const isMod = ev.metaKey || ev.ctrlKey;

      // Formatting, Select-All & Undo/Redo shortcuts inside cell
      if (isMod && !ev.altKey) {
        const lower = ev.key.toLowerCase();
        if (lower === 'a' && !ev.shiftKey) {
          ev.preventDefault();
          ev.stopPropagation();
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(active.cell);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          return;
        }
        if (lower === 'b' && !ev.shiftKey) {
          ev.preventDefault();
          ev.stopPropagation();
          wrapCellSelectionWithMarkdown(active.cell, '**');
          notifySession();
          return;
        }
        if (lower === 'i' && !ev.shiftKey) {
          ev.preventDefault();
          ev.stopPropagation();
          wrapCellSelectionWithMarkdown(active.cell, '*');
          notifySession();
          return;
        }
        if (lower === 'e' && !ev.shiftKey) {
          ev.preventDefault();
          ev.stopPropagation();
          wrapCellSelectionWithMarkdown(active.cell, '`');
          notifySession();
          return;
        }
        if (lower === 'z' && !ev.shiftKey && adapter.onUndo) {
          ev.preventDefault();
          ev.stopPropagation();
          leave();
          pendingCellFocus = { from: adapter.from, row: here.row, col: here.col, at: Date.now() };
          adapter.onUndo();
          return;
        }
        if (((lower === 'z' && ev.shiftKey) || (lower === 'y' && !ev.shiftKey)) && adapter.onRedo) {
          ev.preventDefault();
          ev.stopPropagation();
          leave();
          pendingCellFocus = { from: adapter.from, row: here.row, col: here.col, at: Date.now() };
          adapter.onRedo();
          return;
        }
      }

      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        leave();
        adapter.exitTable('stay');
        return;
      }

      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        if (isMod) {
          commit(null);
          adapter.exitTable('after');
          return;
        }
        const m = model();
        const next = m ? stepCellVertical(m, here.row, here.col, ev.shiftKey ? -1 : 1) : null;
        const target = next ?? here;
        if (commit(target)) return;
        if (next && focusCell(next.row, next.col, 'end')) return;
        return;
      }

      if (ev.key === 'Tab') {
        ev.preventDefault();
        ev.stopPropagation();
        const m = model();
        const next = m ? stepCell(m, here.row, here.col, ev.shiftKey ? -1 : 1) : null;
        if (!next && !ev.shiftKey && m) {
          // Pressing Tab on the very last cell of the table appends a new row like Excel.
          commit({ row: m.rows.length, col: 0 }, true);
          return;
        }
        if (commit(next)) return;
        if (next && focusCell(next.row, next.col, 'end')) return;
        leave();
        adapter.exitTable(ev.shiftKey ? 'before' : 'after');
        return;
      }

      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        if (ev.shiftKey || ev.altKey || isMod) return;
        ev.preventDefault();
        ev.stopPropagation();
        const dir: -1 | 1 = ev.key === 'ArrowUp' ? -1 : 1;
        const m = model();
        const next = m ? stepCellVertical(m, here.row, here.col, dir) : null;
        if (next) {
          if (commit(next)) return;
          focusCell(next.row, next.col, 'end');
          return;
        }
        commit(null);
        adapter.exitTable(dir < 0 ? 'before' : 'after');
        return;
      }

      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        if (ev.shiftKey || ev.altKey || isMod) return;
        const isLeft = ev.key === 'ArrowLeft';
        if (!isCaretAtCellBoundary(active.cell, isLeft ? 'start' : 'end')) {
          return;
        }
        const m = model();
        const next = m ? stepCell(m, here.row, here.col, isLeft ? -1 : 1) : null;
        if (!next) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (commit(next)) return;
        focusCell(next.row, next.col, isLeft ? 'end' : 'start');
      }
    },
    true,
  );

  // #616 — Prevent regular caret/selection/typing keys (ArrowLeft, ArrowRight,
  // Shift+Arrow*, Home/End, Backspace, Vim keys) from bubbling out of the
  // active contenteditable cell into CodeMirror / Vim / window handlers.
  wrap.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (active) ev.stopPropagation();
  });

  wrap.addEventListener('focusout', (ev: FocusEvent) => {
    if (!active) return;
    if (ev.target !== active.cell) return;
    const next = ev.relatedTarget as Node | null;
    if (next && wrap.contains(next)) return;
    commit(null);
  });

  if (pendingCellFocus && pendingCellFocus.from === adapter.from) {
    const pending = pendingCellFocus;
    pendingCellFocus = null;
    if (Date.now() - pending.at < 1500) {
      const m = model();
      const clampedRow = m
        ? pending.row < 0
          ? HEADER_ROW
          : m.rows.length > 0
            ? Math.min(pending.row, m.rows.length - 1)
            : HEADER_ROW
        : pending.row;
      const clampedCol = m
        ? Math.max(0, Math.min(pending.col, m.header.length - 1))
        : pending.col;
      requestAnimationFrame(() => {
        if (wrap.isConnected) focusCell(clampedRow, clampedCol, 'end');
      });
    }
  }

  return { begin, focusCell };
}

function syncTableWidgetSearchMarks(wrap: HTMLElement, state: EditorState): HTMLElement | null {
  const spec = activeEditorSearchSpec(state);
  if (!spec) {
    clearSearchMarksIn(wrap);
    return null;
  }
  const marks = applySearchMarksIn(wrap, spec.search, { caseSensitive: spec.caseSensitive });
  if (marks.length === 0) return null;
  const from = Number(wrap.dataset.tableFrom ?? -1);
  const to = Number(wrap.dataset.tableTo ?? -1);
  const sel = state.selection.main;
  if (from >= 0 && to >= from && sel.from >= from && sel.to <= to) {
    const source = state.doc.sliceString(from, Math.min(to, state.doc.length));
    const localOffset = Math.max(0, sel.from - from);
    const hitLineOffset = source.slice(0, localOffset).split('\n').length - 1;
    const targetRow = hitLineOffset <= 0 ? HEADER_ROW : hitLineOffset - 2;
    const lineStart = source.lastIndexOf('\n', Math.max(0, localOffset - 1)) + 1;
    const beforeInLine = source.slice(lineStart, localOffset);
    let pipes = 0;
    let lastPipe = -1;
    for (let k = 0; k < beforeInLine.length; k++) {
      if (beforeInLine[k] === '\\') {
        k++;
        continue;
      }
      if (beforeInLine[k] === '|') {
        pipes++;
        lastPipe = k;
      }
    }
    const rawLine = source.slice(lineStart).split('\n')[0] ?? '';
    const hasLeadingPipe = /^\s*\|/.test(rawLine);
    const targetCol = Math.max(0, hasLeadingPipe ? pipes - 1 : pipes);
    const cellEl = wrap.querySelector<HTMLElement>(
      `[data-row="${targetRow}"][data-col="${targetCol}"]`,
    );
    if (cellEl) {
      const cellMarks = marks.filter((m) => cellEl.contains(m));
      if (cellMarks.length > 0) {
        const beforeInCell = beforeInLine.slice(lastPipe + 1);
        const ord = Math.min(
          cellMarks.length - 1,
          findPreviewHitsInText(beforeInCell, spec.search, Infinity, spec.caseSensitive).hits.length,
        );
        const chosen = cellMarks[ord] ?? cellMarks[0];
        chosen.classList.add('ps-mark--current');
        return chosen;
      }
    }
    marks[0].classList.add('ps-mark--current');
    return marks[0];
  }
  return null;
}

const tableEditorHandles = new WeakMap<HTMLElement, DomTableEditorHandle>();

class TableWidget extends WidgetType {
  // Cells can hold math / code: a widget built before KaTeX or highlight.js
  // arrived must not count as equal to the one built after (render-deps.ts).
  private readonly deps = renderDepsVersion();
  private readonly source: string;
  private readonly imageRoot: string | null;
  private readonly filePath?: string;
  private readonly startLine: number;
  // Document range this widget replaces. Cell editing writes back through it;
  // -1 means "unknown" (a widget built without one simply stays read-only).
  private readonly from: number;
  private readonly to: number;
  private readonly hideSourceBtn: boolean;

  constructor(
    source: string,
    imageRoot: string | null = null,
    filePath?: string,
    startLine: number = 0,
    from: number = -1,
    to: number = -1,
    hideSourceBtn: boolean = false,
  ) {
    super();
    this.source = source;
    this.imageRoot = imageRoot;
    this.filePath = filePath;
    this.startLine = startLine;
    this.from = from;
    this.to = to;
    this.hideSourceBtn = hideSourceBtn;
  }

  eq(other: TableWidget): boolean {
    return (
      other.source === this.source &&
      other.imageRoot === this.imageRoot &&
      other.filePath === this.filePath &&
      other.startLine === this.startLine &&
      other.from === this.from &&
      other.to === this.to &&
      other.hideSourceBtn === this.hideSourceBtn &&
      other.deps === this.deps
    );
  }

  toDOM(view?: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--table';
    // Visually align list-indented tables (e.g. pasted after Shift+Enter soft
    // break) under the enclosing list item's body column, matching cm-live-render.
    const indentCols = tableIndentCols(this.source);
    if (indentCols > 0) {
      const marginEm =
        indentCols === 2
          ? 0.95
          : indentCols === 3
            ? 1.15
            : indentCols === 4
              ? 1.65
              : Math.min(8, indentCols * 0.55);
      wrap.style.marginLeft = `${marginEm.toFixed(2)}em`;
    }
    // Render the table source through the same markdown pipeline used by the
    // preview pane so we get GFM alignment, inline formatting, etc. for free.
    // Dedent common leading spaces/tabs so a 4-space indented table nested
    // inside a list item is rendered as a <table> rather than an indented
    // <pre><code> block when sliced out of its parent list context.
    const rawHtml = renderMarkdown(dedentTableSource(this.source));
    wrap.innerHTML = rewriteImageUrls(rawHtml, this.imageRoot, this.filePath);
    installSvgImageFallbacks(wrap);
    trackImageHeights(wrap);
    const cellEditor = this.createCellEditor(wrap, view);
    if (cellEditor) {
      tableEditorHandles.set(wrap, cellEditor);
    }

    if (this.startLine > 0 && !this.hideSourceBtn) {
      const srcBtn = document.createElement('button');
      srcBtn.type = 'button';
      srcBtn.className = 'cm-table-source-btn';
      srcBtn.textContent = '</> 源码';
      srcBtn.title = '展开表格 Markdown 源码';
      srcBtn.setAttribute('aria-label', srcBtn.title);
      srcBtn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      srcBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const v = view ?? EditorView.findFromDOM(srcBtn);
        if (!v || this.startLine < 1 || this.startLine > v.state.doc.lines) return;
        const lineObj = v.state.doc.line(this.startLine);
        v.dispatch({
          selection: { anchor: lineObj.from },
          effects: toggleTableFoldEffect.of({ line: this.startLine, collapsed: false }),
        });
        v.focus();
      });
      wrap.appendChild(srcBtn);
    }

    wrap.addEventListener('pointerdown', (ev: PointerEvent) => {
      const target = ev.target as Element | null;
      if (target?.closest?.('.cm-live-table__cell--editing')) {
        ev.stopPropagation();
      }
    });

    // #504 — Clicking a rendered table cell in Live mode places the caret at
    // the exact Markdown table row (header or body row) and column cell offset,
    // and anchors scrollTop so the clicked row stays under the mouse cursor
    // instead of jumping to the very start or end of the table.
    wrap.addEventListener('mousedown', (ev: MouseEvent) => {
      if (ev.button !== 0 || !view || this.startLine <= 0) return;
      const target = ev.target as Element | null;
      if (target?.closest?.('a')) return;
      const cell = target?.closest?.('th, td') as HTMLTableCellElement | null;
      const tr = target?.closest?.('tr') as HTMLTableRowElement | null;
      if (!cell && !tr) return;

      // #500 — a click on a cell edits that cell in place. The caret mapping
      // below is what used to turn the table back into source lines the moment
      // anything needed changing; it stays as the fallback for read-only panes
      // and for clicks that land on a row but not on a cell.
      const beginState = cell ? cellEditor?.begin(ev, cell) : false;
      if (beginState) {
        if (beginState === 'started') {
          ev.preventDefault();
        }
        ev.stopPropagation();
        return;
      }

      let targetLineNum = this.startLine;
      const sectionTag = tr?.parentElement?.tagName;
      if (sectionTag === 'THEAD') {
        targetLineNum = this.startLine;
      } else if (sectionTag === 'TBODY' && tr?.parentElement) {
        const rows = Array.from(tr.parentElement.children).filter((el) => el.tagName === 'TR');
        const rowIdx = Math.max(0, rows.indexOf(tr));
        targetLineNum = this.startLine + 2 + rowIdx;
      } else if (tr) {
        const table = tr.closest('table');
        const allRows = table ? Array.from(table.querySelectorAll('tr')) : [];
        const idx = allRows.indexOf(tr);
        targetLineNum = idx <= 0 ? this.startLine : this.startLine + 1 + idx;
      }
      targetLineNum = Math.max(1, Math.min(view.state.doc.lines, targetLineNum));

      const colIdx = cell ? Math.max(0, cell.cellIndex) : 0;
      let clickRatio = 1;
      if (cell) {
        const rect = cell.getBoundingClientRect();
        const innerLeft = rect.left + 12;
        const innerWidth = Math.max(1, rect.width - 24);
        clickRatio = Math.max(0, Math.min(1, (ev.clientX - innerLeft) / innerWidth));
      }

      const docLine = view.state.doc.line(targetLineNum);
      const colOffset = findTableCellOffsetInLine(docLine.text, colIdx, clickRatio);
      const targetPos = docLine.from + colOffset;
      const clickClientY = ev.clientY;

      ev.preventDefault();
      ev.stopPropagation();
      view.focus();
      view.dispatch({
        selection: { anchor: targetPos },
        userEvent: 'select.pointer',
      });
      requestAnimationFrame(() => {
        const coords = view.coordsAtPos(targetPos);
        if (!coords) return;
        const scroller = view.scrollDOM;
        const scrollerRect = scroller.getBoundingClientRect();
        const desiredY = Math.max(
          scrollerRect.top + 24,
          Math.min(scrollerRect.bottom - 24, clickClientY),
        );
        const delta = coords.top - desiredY;
        if (Math.abs(delta) > 4) {
          scroller.scrollTop += delta;
        }
      });
    });

      if (view) {
        syncTableWidgetSearchMarks(wrap, view.state);
      }

      return wrap;
    }

  /**
   * #500 — edit a table cell where it is, instead of falling back to the source.
   */
  private createCellEditor(
    wrap: HTMLElement,
    view?: EditorView,
  ): DomTableEditorHandle | null {
    if (!view || this.from < 0 || this.to < 0) return null;
    return bindDomTableCellEditor(wrap, {
      source: this.source,
      from: this.from,
      to: this.to,
      isReadOnly: () => view.state.readOnly,
      commitMarkdown: (markdown) => {
        view.dispatch({
          changes: { from: this.from, to: this.to, insert: markdown },
          userEvent: 'input.table-cell',
        });
      },
      exitTable: (direction) => {
        const doc = view.state.doc;
        if (direction === 'before') {
          const startLineNo = doc.lineAt(Math.max(0, Math.min(this.from, doc.length))).number;
          if (startLineNo > 1) {
            const prevLine = doc.line(startLineNo - 1);
            view.dispatch({ selection: { anchor: prevLine.to }, scrollIntoView: true });
          } else {
            view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
          }
        } else if (direction === 'after') {
          const endLineNo = doc.lineAt(Math.max(0, Math.min(this.to, doc.length))).number;
          if (endLineNo < doc.lines) {
            const nextLine = doc.line(endLineNo + 1);
            view.dispatch({ selection: { anchor: nextLine.from }, scrollIntoView: true });
          } else {
            view.dispatch({
              changes: { from: doc.length, to: doc.length, insert: '\n' },
              selection: { anchor: doc.length + 1 },
              scrollIntoView: true,
            });
          }
        }
        view.focus();
      },
      onUndo: () => cmUndo(view),
      onRedo: () => cmRedo(view),
    });
  }

  ignoreEvent(event: Event): boolean {
    if (event.type === 'selectionchange') return true;
    const target = event.target as Element | null;
    if (target?.closest?.('a')) return false;
    return !!target?.closest?.('th, td, tr');
  }

  ignoreMutation(): boolean {
    return true;
  }
}

function caretRangeAt(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (px: number, py: number) => Range | null;
    caretPositionFromPoint?: (px: number, py: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === 'function') {
    return doc.caretRangeFromPoint(x, y);
  }
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const range = document.createRange();
  range.setStart(pos.offsetNode, pos.offset);
  range.collapse(true);
  return range;
}

/** Raw block HTML rendered with the same markdown-it pipeline as Preview.vue. */
class HtmlBlockWidget extends WidgetType {
  private readonly deps = renderDepsVersion();
  private readonly source: string;
  private readonly imageRoot: string | null;
  private readonly filePath?: string;
  private readonly lineNumber: number;

  constructor(
    source: string,
    imageRoot: string | null,
    filePath?: string,
    lineNumber: number = 0,
  ) {
    super();
    this.source = source;
    this.imageRoot = imageRoot;
    this.filePath = filePath;
    this.lineNumber = lineNumber;
  }

  eq(other: HtmlBlockWidget): boolean {
    return (
      other.source === this.source &&
      other.imageRoot === this.imageRoot &&
      other.filePath === this.filePath &&
      other.lineNumber === this.lineNumber &&
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
    if (this.lineNumber > 0) {
      for (const img of Array.from(wrap.querySelectorAll('img'))) {
        img.dataset.solomdLine = String(this.lineNumber);
      }
    }
    installSvgImageFallbacks(wrap);
    trackImageHeights(wrap);
    this.bindDetailsToggles(wrap);
    return wrap;
  }

  /**
   * A rendered `<details>` folds in place. Its summary is a control of the
   * rendered view, not an editing gesture: letting the editor take the press
   * put the caret inside the block and replaced this widget with the block's
   * source on the very click that should have folded it, so the disclosure
   * triangle did nothing at all.
   */
  private bindDetailsToggles(wrap: HTMLElement): void {
    for (const summary of Array.from(wrap.querySelectorAll('summary'))) {
      const details = summary.parentElement;
      if (!(details instanceof HTMLDetailsElement)) continue;
      summary.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      summary.addEventListener('click', (event) => {
        // Cancel the native activation and flip `open` ourselves, so exactly
        // one toggle happens per click whatever else handles the event.
        event.preventDefault();
        details.open = !details.open;
        scheduleRelayout();
      });
    }
  }

  ignoreEvent(event: Event): boolean {
    if (event.type === 'contextmenu') return true;
    if (event instanceof MouseEvent && event.button === 2) return true;
    // Summary presses belong to the disclosure (see bindDetailsToggles); every
    // other press in the block keeps revealing the source, as before.
    return event.target instanceof Element && event.target.closest('summary') !== null;
  }
}

// v4.3.0 issue #57a — block math (`$$...$$`). Goes through markdown-it so
// it picks up the same KaTeX renderer used in the preview pane. We render
// the wrapping `$$\n…\n$$` literal so markdown-it-katex sees it as block
// math and emits `<span class="katex-display">`.
class MathWidget extends WidgetType {
  private readonly deps = renderDepsVersion();
  private readonly source: string;

  constructor(source: string) {
    super();
    this.source = source;
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
  private readonly tex: string;

  constructor(tex: string) {
    super();
    this.tex = tex;
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
    if (code[i]) { i++; continue; }
    // #433 — LaTeX `\( ... \)` and inline `\[ ... \]` delimiters (DeepSeek / ChatGPT).
    if (
      text[i] === '\\' &&
      (i === 0 || text[i - 1] !== '\\') &&
      (text[i + 1] === '(' || text[i + 1] === '[')
    ) {
      const closeChar = text[i + 1] === '[' ? ']' : ')';
      let j = i + 2;
      let close = -1;
      while (j < n - 1) {
        if (!code[j] && text[j] === '\\' && text[j + 1] === closeChar) {
          let bs = 0;
          let k = j;
          while (k >= i + 2 && text[k] === '\\') { bs++; k--; }
          if (bs % 2 === 1) { close = j; break; }
        }
        j++;
      }
      if (close >= 0) {
        const content = text.slice(i + 2, close).trim();
        if (content) {
          spans.push({ start: i, end: close + 2, tex: content });
          i = close + 2;
          continue;
        }
      }
      i += 2;
      continue;
    }
    if (text[i] !== '$') { i++; continue; }
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
/**
 * #530 — Inline `+` / `−` fold toggle button on the opening ` ```mermaid `
 * fence line so users can expand or collapse the Mermaid source code while
 * keeping the rendered diagram below.
 */
class MermaidFoldToggleWidget extends WidgetType {
  readonly startLine: number;
  readonly endLine: number;
  readonly collapsed: boolean;

  constructor(startLine: number, endLine: number, collapsed: boolean) {
    super();
    this.startLine = startLine;
    this.endLine = endLine;
    this.collapsed = collapsed;
  }

  eq(other: MermaidFoldToggleWidget): boolean {
    return (
      other.startLine === this.startLine &&
      other.endLine === this.endLine &&
      other.collapsed === this.collapsed
    );
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cm-mermaid-fold-btn${this.collapsed ? ' is-collapsed' : ' is-expanded'}`;
    btn.textContent = this.collapsed ? '+' : '−';
    btn.title = this.collapsed ? '展开 Mermaid 代码' : '折叠 Mermaid 代码';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-expanded', String(!this.collapsed));
    const handleToggle = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
      const view = EditorView.findFromDOM(btn);
      if (!view) return;
      const doc = view.state.doc;
      if (this.startLine < 1 || this.startLine > doc.lines) return;
      const nextCollapsed = !this.collapsed;
      const openLine = doc.line(this.startLine);
      const closeLineNo = Math.min(this.endLine, doc.lines);
      const bodyStartPos =
        this.startLine + 1 <= closeLineNo
          ? doc.line(this.startLine + 1).from
          : openLine.to;
      const bodyEndPos = doc.line(closeLineNo).to;
      const sel = view.state.selection.main;
      const cursorInBody =
        nextCollapsed &&
        ((sel.from >= bodyStartPos && sel.from <= bodyEndPos) ||
          (sel.to >= bodyStartPos && sel.to <= bodyEndPos));
      view.dispatch({
        ...(cursorInBody ? { selection: { anchor: openLine.from } } : {}),
        effects: toggleMermaidFoldEffect.of({
          line: this.startLine,
          collapsed: nextCollapsed,
        }),
      });
    };
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener('click', handleToggle);
    return btn;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class TableFoldToggleWidget extends WidgetType {
  readonly startLine: number;
  readonly endLine: number;
  readonly collapsed: boolean;

  constructor(startLine: number, endLine: number, collapsed: boolean) {
    super();
    this.startLine = startLine;
    this.endLine = endLine;
    this.collapsed = collapsed;
  }

  eq(other: TableFoldToggleWidget): boolean {
    return (
      other.startLine === this.startLine &&
      other.endLine === this.endLine &&
      other.collapsed === this.collapsed
    );
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cm-mermaid-fold-btn cm-table-fold-btn${this.collapsed ? ' is-collapsed' : ' is-expanded'}`;
    btn.textContent = this.collapsed ? '+' : '−';
    btn.title = this.collapsed ? '展开表格源码' : '折叠并渲染表格';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-expanded', String(!this.collapsed));
    const handleToggle = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
      const view = EditorView.findFromDOM(btn);
      if (!view) return;
      const doc = view.state.doc;
      if (this.startLine < 1 || this.startLine > doc.lines) return;
      const nextCollapsed = !this.collapsed;
      const openLine = doc.line(this.startLine);
      const closeLineNo = Math.min(this.endLine, doc.lines);
      const blockFrom = openLine.from;
      const blockTo = doc.line(closeLineNo).to;
      const sel = view.state.selection.main;
      const cursorInside =
        nextCollapsed &&
        ((sel.from >= blockFrom && sel.from <= blockTo) ||
          (sel.to >= blockFrom && sel.to <= blockTo));
      const safePos = blockFrom > 0 ? blockFrom - 1 : Math.min(doc.length, blockTo + 1);
      view.dispatch({
        ...(cursorInside ? { selection: { anchor: safePos } } : {}),
        effects: toggleTableFoldEffect.of({
          line: this.startLine,
          collapsed: nextCollapsed,
        }),
      });
    };
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener('click', handleToggle);
    return btn;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class MermaidWidget extends WidgetType {
  /** Whether the cache held a finished result when this widget was built. */
  private readonly settled: boolean;
  private readonly source: string;
  private readonly theme: MermaidTheme;
  private readonly filePath?: string;

  constructor(source: string, theme: MermaidTheme, filePath?: string) {
    super();
    this.source = source;
    this.theme = theme;
    this.filePath = filePath;
    const cached = peekMermaidSvg(theme, source);
    this.settled = !!(cached && (cached.svg || cached.error));
  }

  eq(other: MermaidWidget): boolean {
    // A theme change must remount the widget with the other theme's SVG. So
    // must the render finishing: if the placeholder and the finished widget
    // compared equal, CodeMirror would keep the "Rendering…" DOM.
    return (
      other.source === this.source &&
      other.theme === this.theme &&
      other.filePath === this.filePath &&
      other.settled === this.settled
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--mermaid';
    const cached = peekMermaidSvg(this.theme, this.source);
    if (cached?.svg) {
      wrap.innerHTML = cached.svg;
      bindMermaidInteractions(wrap, cached.bindFunctions);
      wrap.addEventListener('click', (ev) => {
        const anchor = (ev.target as Element | null)?.closest?.('a');
        if (anchor) {
          openRenderedLink(anchor, ev, this.filePath);
        }
      });
    } else if (cached?.error) {
      wrap.classList.add('cm-live-block--broken');
      wrap.textContent = `Mermaid: ${cached.error}`;
    } else {
      wrap.textContent = '⌛ Rendering Mermaid…';
      // Only widgets CodeMirror actually mounted reach toDOM(), so this is
      // the viewport gate: off-screen diagrams are never queued. `front`
      // keeps a freshly scrolled-into-view diagram ahead of any background
      // work from the preview pane.
      void renderMermaidCached(this.theme, this.source, { front: true }).then(() => {
        // Ask the field to recompute now that the SVG cache is filled. We
        // can't hold an EditorView here (block decorations live in a state
        // field, built without a view), so signal via a window event that
        // the companion relayout plugin turns into a `relayoutEffect`.
        scheduleRelayout();
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
  readonly source: string;
  readonly url: string;

  constructor(source: string, url: string) {
    super();
    this.source = source;
    this.url = url;
  }
  eq(other: PlantumlWidget): boolean {
    return other.source === this.source && other.url === this.url;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--plantuml';
    const img = document.createElement('img');
    img.referrerPolicy = 'no-referrer';
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

// #363 — ```markmap fenced mindmap rendered synchronously as a vector SVG tree.
class MarkmapWidget extends WidgetType {
  readonly source: string;

  constructor(source: string) {
    super();
    this.source = source;
  }

  eq(other: MarkmapWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--mermaid cm-live-block--markmap';
    wrap.innerHTML = renderMarkmapSvg(this.source);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// Gitee #IK9BC3 — ```excalidraw fenced scene rendered synchronously as a vector SVG.
class ExcalidrawWidget extends WidgetType {
  readonly source: string;

  constructor(source: string) {
    super();
    this.source = source;
  }

  eq(other: ExcalidrawWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-block cm-live-block--mermaid cm-live-block--excalidraw';
    wrap.innerHTML = renderExcalidrawSvg(this.source);
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
  private readonly boardId: string;
  private readonly height: string;
  private readonly width: string;
  private readonly snapshot: string;
  private readonly opts: BlockOptions;

  constructor(
    boardId: string,
    height: string,
    width: string,
    snapshot: string,
    opts: BlockOptions,
  ) {
    super();
    this.boardId = boardId;
    this.height = height;
    this.width = width;
    this.snapshot = snapshot;
    this.opts = opts;
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
  /**
   * #605 "Pure WYSIWYG" (`hideActiveLineMarkers && !alwaysShowMarkers`):
   * hovering, clicking, moving the cursor, or selecting text never reveals raw
   * Markdown syntax or `</> 源码` buttons.
   */
  pureWysiwyg?: () => boolean;
}

function buildBlockDecorations(state: EditorState, opts: BlockOptions): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const sel = state.selection.main;
        const cursorLine = state.doc.lineAt(sel.from).number;
        const cursorLineEnd = state.doc.lineAt(sel.to).number;
        const keepSource = opts.keepSource?.() === true;
        const pureWysiwyg = !keepSource && opts.pureWysiwyg?.() === true;

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
        // #457 — every line scan below (raw HTML blocks, <img> lines, tables,
        // math) must stay inert inside code blocks: a ```vue fence whose
        // template holds <div>…</div> had its middle replaced by an
        // HtmlBlockWidget and rendered as real HTML while the preview (which
        // keeps fence content literal) looked fine. Take code-block ranges
        // from the same lezer tree the fenced-line decorations use — it
        // already owns the fence/list/indent rules, so the scans stay in
        // step with what live mode actually renders, in every nesting shape.
        // Includes indented CodeBlocks (same "literal code, never live
        // markdown" contract in the preview). Block OPENING lines stay false
        // here so the dedicated ```mermaid / ```plantuml / ```tldraw handlers
        // below still match on them.
        const fenceBody: boolean[] = new Array(lastLine).fill(false);
        syntaxTree(state).iterate({
          enter: (node) => {
            if (node.name !== 'FencedCode') return;
            const startLine = state.doc.lineAt(node.from).number;
            const endLine = state.doc.lineAt(Math.min(node.to, doc.length)).number;
            for (let ln = startLine + 1; ln <= endLine; ln += 1) {
              fenceBody[ln - 1] = true;
            }
          },
        });
        // CodeMirror's Lezer parser only parses the first ~3KB synchronously on
        // initial state creation, so FencedCode nodes past that viewport horizon
        // may not exist in `syntaxTree(state)` yet. Run a fast line-level fence
        // pass across `sourceLines` so fenced code blocks anywhere in a long
        // document never have their inner tables/math/HTML replaced by widgets.
        let activeFenceChar = '';
        let activeFenceLen = 0;
        let closeFenceRe: RegExp | null = null;
        for (let idx = 0; idx < lastLine; idx += 1) {
          const stripped = stripQuotePrefix(sourceLines[idx]);
          if (!activeFenceChar) {
            const openMatch = stripped.match(/^\s*(?:(?:[-+*]|\d+[.)])\s+)*(`{3,}|~{3,})(.*)$/);
            if (openMatch) {
              const marker = openMatch[1];
              const info = openMatch[2];
              // Backtick fences cannot contain backticks in their info string.
              if (marker[0] !== '`' || !info.includes('`')) {
                activeFenceChar = marker[0];
                activeFenceLen = marker.length;
                closeFenceRe = new RegExp(
                  `^\\s*(?:(?:[-+*]|\\d+[.)])\\s+)*${activeFenceChar}{${activeFenceLen},}\\s*$`,
                );
              }
            }
          } else {
            fenceBody[idx] = true;
            if (closeFenceRe && closeFenceRe.test(stripped)) {
              activeFenceChar = '';
              activeFenceLen = 0;
              closeFenceRe = null;
            }
          }
        }
        const imageRefs = extractImageReferenceDefinitions(sourceLines, fenceBody);
        let i = 1;

        // #626 — Leading YAML frontmatter block (`---\n...\n---` on line 1).
        // Replace with a collapsible properties card when the caret is outside;
        // moving the caret into lines 1..fmEnd reveals syntax-highlighted YAML.
        if (lastLine >= 2 && sourceLines[0].trim() === '---') {
          let fmEndLine = 0;
          const scanLimit = Math.min(lastLine, 200);
          for (let ln = 2; ln <= scanLimit; ln += 1) {
            const trimmed = sourceLines[ln - 1].trim();
            if (trimmed === '---' || trimmed === '...') {
              fmEndLine = ln;
              break;
            }
          }
          if (fmEndLine >= 2) {
            const cursorInside =
              keepSource ||
              (cursorLine >= 1 && cursorLine <= fmEndLine) ||
              (cursorLineEnd >= 1 && cursorLineEnd <= fmEndLine);
            if (!cursorInside) {
              const blockFrom = doc.line(1).from;
              const blockTo = doc.line(fmEndLine).to;
              const yamlBody = sourceLines.slice(1, fmEndLine - 1).join('\n');
              const editPos = fmEndLine >= 2 ? doc.line(2).from : blockFrom;
              builder.add(
                blockFrom,
                blockTo,
                Decoration.replace({
                  widget: new FrontmatterWidget(yamlBody, editPos),
                  block: true,
                }),
              );
            }
            i = fmEndLine + 1;
          }
        }

        while (i <= lastLine) {
          const line = doc.line(i);

          // Fence body (or closing fence): the content is code, never
          // live-renderable markdown — skip every scan below.
          if (fenceBody[i - 1]) {
            i += 1;
            continue;
          }

          // Raw block HTML (`<div>…</div>`, `<details>`, HTML tables, etc.).
          // Preview.vue has always rendered this through markdown-it, but live
          // edit previously left the tags visible. Collapse the complete block
          // while the caret is outside; entering it reveals the source again.
          const htmlEndIndex = findHtmlBlockEnd(sourceLines, i - 1);
          if (htmlEndIndex !== null) {
            const endI = htmlEndIndex + 1;
            const cursorInside =
              keepSource ||
              (!pureWysiwyg &&
                ((cursorLine >= i && cursorLine <= endI) ||
                  (cursorLineEnd >= i && cursorLineEnd <= endI)));
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
                    i,
                  ),
                  block: true,
                }),
              );
            }
            i = endI + 1;
            continue;
          }

          // Standalone HTML `<img ...>` line (#446 / #561 / #605).
          // Keep the source line visible above the rendered image by default,
          // or replace the line completely when Pure WYSIWYG (`pureWysiwyg`) is on.
          if (/^\s*<img\b[^>]*>\s*$/i.test(line.text)) {
            const imgHtmlWidget = new HtmlBlockWidget(
              line.text,
              opts.getImageRoot?.() ?? null,
              opts.getFilePath?.(),
              i,
            );
            if (pureWysiwyg) {
              builder.add(
                line.from,
                line.to,
                Decoration.replace({ widget: imgHtmlWidget, block: true }),
              );
            } else {
              builder.add(
                line.to,
                line.to,
                Decoration.widget({ widget: imgHtmlWidget, block: true, side: 1 }),
              );
            }
            i += 1;
            continue;
          }

          // #506 / #561 / #605 — Standalone Markdown image line (`![alt](url)`,
          // `[![alt](img)](link)`, `![[1] alt](url)`, `![alt](<url>)`,
          // `![alt][ref]`, etc.). Keep the Markdown source line visible above
          // the rendered image widget unless Pure WYSIWYG (`pureWysiwyg`) is on.
          const lineImages = findMarkdownImagesInLine(line.text, imageRefs);
          const isStandaloneImage =
            lineImages.length === 1 &&
            line.text.slice(0, lineImages[0].start).trim() === '' &&
            line.text.slice(lineImages[0].end).trim() === '';
          if (isStandaloneImage) {
            const imgSpan = lineImages[0];
            const root = opts.getImageRoot?.() ?? null;
            const filePath = opts.getFilePath?.();
            const src = resolveImageSrc(imgSpan.src, root, filePath);
            const localPath = resolveImagePath(imgSpan.src, root, filePath);
            const needsFallback =
              isLocalSvgPath(localPath) ||
              localPath.startsWith('saf:') ||
              /^\/(?:storage\/emulated\/0|sdcard)\//i.test(localPath);
            const imageWidget = new ImageWidget(
              src,
              imgSpan.alt,
              needsFallback ? localPath : null,
              i,
              false,
              imgSpan.width ?? null,
              imgSpan.height ?? null,
            );
            if (pureWysiwyg) {
              builder.add(
                line.from,
                line.to,
                Decoration.replace({ widget: imageWidget, block: true }),
              );
            } else {
              builder.add(
                line.to,
                line.to,
                Decoration.widget({ widget: imageWidget, block: true, side: 1 }),
              );
            }
            i += 1;
            continue;
          }

          // v4.3.0 issue #57a / #433 — block math (`$$…$$` or `\[…\]`).
          // Recognise either inline `$$E=mc^2$$` / `\[E=mc^2\]` on a single
          // line OR a multi-line block opened with `$$` / `\[` and closed with
          // `$$` / `\]`. We only collapse if the cursor is outside (or pureWysiwyg is on).
          const trimmedLine = line.text.trim();
          if (trimmedLine.startsWith('$$') || trimmedLine.startsWith('\\[')) {
            const isBracket = trimmedLine.startsWith('\\[');
            const closeDelim = isBracket ? '\\]' : '$$';
            // Single-line `$$ ... $$` or `\[ ... \]`?
            if (trimmedLine.endsWith(closeDelim) && trimmedLine.length > 4) {
              const cursorInside =
                keepSource || (!pureWysiwyg && (cursorLine === i || cursorLineEnd === i));
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
            // Multi-line block — scan forward for the closing `$$` or `\]` line.
            let endI = i + 1;
            while (endI <= lastLine) {
              const nextTrimmed = doc.line(endI).text.trim();
              if (
                isBracket
                  ? nextTrimmed.startsWith('\\]') || nextTrimmed.endsWith('\\]')
                  : nextTrimmed.startsWith('$$') || nextTrimmed.endsWith('$$')
              ) {
                break;
              }
              endI += 1;
            }
            if (endI <= lastLine) {
              const cursorInside =
                keepSource ||
                (!pureWysiwyg &&
                  ((cursorLine >= i && cursorLine <= endI) ||
                    (cursorLineEnd >= i && cursorLineEnd <= endI)));
              if (!cursorInside) {
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

          // v4.3.0 issue #57a / #372 — ```mermaid fenced block. Pre-render to SVG
          // via the mermaid cache; the widget waits for the SVG and asks
          // CM to rebuild decorations once ready.
          if (/^\s*(`{3,}|~{3,})\s*mermaid\s*$/i.test(line.text)) {
            let endI = i + 1;
            while (endI <= lastLine) {
              const next = doc.line(endI);
              if (/^\s*(`{3,}|~{3,})\s*$/.test(next.text)) break;
              endI += 1;
            }
            if (endI <= lastLine) {
              // Body is between the opening and closing fence.
              let body = '';
              for (let k = i + 1; k < endI; k++) {
                body += (k > i + 1 ? '\n' : '') + doc.line(k).text;
              }
              const blockFrom = doc.line(i).from;
              const blockTo = doc.line(endI).to;
              // #522 — no render kick-off here. This loop covers the whole
              // document (state fields have no viewport), so calling it
              // once per fence meant every diagram rendered on open. The
              // widget's toDOM() starts the render for visible blocks only.
              const mermaidTheme = opts.getMermaidTheme?.() ?? 'default';
              const foldMap = state.field(mermaidFoldState, false);
              const foldOverride = foldMap?.get(i);
              // #530 / #536 — Keep Mermaid source folded when the cursor merely
              // lands on or passes through the fence boundaries (line `i` or `endI`)
              // so arrow-key navigation never causes the page to jump. Only expand
              // when manually unfolded via the `+` button (`foldOverride === false`),
              // when `keepSource` is true, or when selection is strictly on an
              // inner body line (`i + 1 .. endI - 1`, e.g. right after `/mermaid`).
              const cursorInsideBody =
                !pureWysiwyg &&
                ((cursorLine >= i + 1 && cursorLine < endI) ||
                  (cursorLineEnd >= i + 1 && cursorLineEnd < endI));
              const defaultCollapsed = !keepSource;
              const collapsed = pureWysiwyg
                ? true
                : cursorInsideBody
                  ? false
                  : foldOverride !== undefined
                    ? foldOverride
                    : defaultCollapsed;
              if (!pureWysiwyg) {
                builder.add(
                  blockFrom,
                  blockFrom,
                  Decoration.widget({
                    widget: new MermaidFoldToggleWidget(i, endI, collapsed),
                    side: -1,
                  }),
                );
              }
              if (collapsed) {
                const bodyFrom =
                  pureWysiwyg || i + 1 > endI ? blockFrom : doc.line(i + 1).from;
                builder.add(
                  bodyFrom,
                  blockTo,
                  Decoration.replace({
                    widget: new MermaidWidget(body, mermaidTheme, opts.getFilePath?.()),
                    block: true,
                  }),
                );
              } else {
                // #372 / #530 — When expanded, keep the Mermaid code block
                // editable and render the live Mermaid diagram directly below
                // the closing fence.
                builder.add(
                  blockTo,
                  blockTo,
                  Decoration.widget({
                    widget: new MermaidWidget(body, mermaidTheme, opts.getFilePath?.()),
                    block: true,
                    side: 1,
                  }),
                );
              }
              i = endI + 1;
              continue;
            }
          }

          // #363 — ```markmap / ```mm fenced mindmap block.
          if (/^\s*(`{3,}|~{3,})\s*(markmap|mm)\s*$/i.test(line.text)) {
            let endI = i + 1;
            while (endI <= lastLine) {
              const next = doc.line(endI);
              if (/^\s*(`{3,}|~{3,})\s*$/.test(next.text)) break;
              endI += 1;
            }
            if (endI <= lastLine) {
              let body = '';
              for (let k = i + 1; k < endI; k++) {
                body += (k > i + 1 ? '\n' : '') + doc.line(k).text;
              }
              const blockFrom = doc.line(i).from;
              const blockTo = doc.line(endI).to;
              const foldMap = state.field(mermaidFoldState, false);
              const foldOverride = foldMap?.get(i);
              const cursorInsideBody =
                !pureWysiwyg &&
                ((cursorLine >= i + 1 && cursorLine < endI) ||
                  (cursorLineEnd >= i + 1 && cursorLineEnd < endI));
              const defaultCollapsed = !keepSource;
              const collapsed = pureWysiwyg
                ? true
                : cursorInsideBody
                  ? false
                  : foldOverride !== undefined
                    ? foldOverride
                    : defaultCollapsed;
              if (!pureWysiwyg) {
                builder.add(
                  blockFrom,
                  blockFrom,
                  Decoration.widget({
                    widget: new MermaidFoldToggleWidget(i, endI, collapsed),
                    side: -1,
                  }),
                );
              }
              if (collapsed) {
                const bodyFrom =
                  pureWysiwyg || i + 1 > endI ? blockFrom : doc.line(i + 1).from;
                builder.add(
                  bodyFrom,
                  blockTo,
                  Decoration.replace({
                    widget: new MarkmapWidget(body),
                    block: true,
                  }),
                );
              } else {
                builder.add(
                  blockTo,
                  blockTo,
                  Decoration.widget({
                    widget: new MarkmapWidget(body),
                    block: true,
                    side: 1,
                  }),
                );
              }
              i = endI + 1;
              continue;
            }
          }

          // Gitee #IK9BC3 — ```excalidraw fenced drawing block.
          if (/^\s*(`{3,}|~{3,})\s*excalidraw\s*$/i.test(line.text)) {
            let endI = i + 1;
            while (endI <= lastLine) {
              const next = doc.line(endI);
              if (/^\s*(`{3,}|~{3,})\s*$/.test(next.text)) break;
              endI += 1;
            }
            if (endI <= lastLine) {
              let body = '';
              for (let k = i + 1; k < endI; k++) {
                body += (k > i + 1 ? '\n' : '') + doc.line(k).text;
              }
              const blockFrom = doc.line(i).from;
              const blockTo = doc.line(endI).to;
              const foldMap = state.field(mermaidFoldState, false);
              const foldOverride = foldMap?.get(i);
              const cursorInsideBody =
                !pureWysiwyg &&
                ((cursorLine >= i + 1 && cursorLine < endI) ||
                  (cursorLineEnd >= i + 1 && cursorLineEnd < endI));
              const defaultCollapsed = !keepSource;
              const collapsed = pureWysiwyg
                ? true
                : cursorInsideBody
                  ? false
                  : foldOverride !== undefined
                    ? foldOverride
                    : defaultCollapsed;
              if (!pureWysiwyg) {
                builder.add(
                  blockFrom,
                  blockFrom,
                  Decoration.widget({
                    widget: new MermaidFoldToggleWidget(i, endI, collapsed),
                    side: -1,
                  }),
                );
              }
              if (collapsed) {
                const bodyFrom =
                  pureWysiwyg || i + 1 > endI ? blockFrom : doc.line(i + 1).from;
                builder.add(
                  bodyFrom,
                  blockTo,
                  Decoration.replace({
                    widget: new ExcalidrawWidget(body),
                    block: true,
                  }),
                );
              } else {
                builder.add(
                  blockTo,
                  blockTo,
                  Decoration.widget({
                    widget: new ExcalidrawWidget(body),
                    block: true,
                    side: 1,
                  }),
                );
              }
              i = endI + 1;
              continue;
            }
          }

          // v4.10 issue #163 / #536 — ```plantuml / ```puml fence (opt-in).
          const plantumlCfg = opts.getPlantuml?.();
          if (
            plantumlCfg?.enabled &&
            plantumlCfg.server &&
            /^\s*(`{3,}|~{3,})\s*(plantuml|puml)\s*$/i.test(line.text)
          ) {
            let endI = i + 1;
            while (endI <= lastLine) {
              const next = doc.line(endI);
              if (/^\s*(`{3,}|~{3,})\s*$/.test(next.text)) break;
              endI += 1;
            }
            if (endI <= lastLine) {
              let body = '';
              for (let k = i + 1; k < endI; k++) {
                body += (k > i + 1 ? '\n' : '') + doc.line(k).text;
              }
              const blockFrom = doc.line(i).from;
              const blockTo = doc.line(endI).to;
              const foldMap = state.field(mermaidFoldState, false);
              const foldOverride = foldMap?.get(i);
              const cursorInsideBody =
                !pureWysiwyg &&
                ((cursorLine >= i + 1 && cursorLine < endI) ||
                  (cursorLineEnd >= i + 1 && cursorLineEnd < endI));
              const defaultCollapsed = !keepSource;
              const collapsed = pureWysiwyg
                ? true
                : cursorInsideBody
                  ? false
                  : foldOverride !== undefined
                    ? foldOverride
                    : defaultCollapsed;
              if (!pureWysiwyg) {
                builder.add(
                  blockFrom,
                  blockFrom,
                  Decoration.widget({
                    widget: new MermaidFoldToggleWidget(i, endI, collapsed),
                    side: -1,
                  }),
                );
              }
              if (collapsed) {
                const bodyFrom =
                  pureWysiwyg || i + 1 > endI ? blockFrom : doc.line(i + 1).from;
                builder.add(
                  bodyFrom,
                  blockTo,
                  Decoration.replace({
                    widget: new PlantumlWidget(body, plantumlSvgUrl(plantumlCfg.server, body)),
                    block: true,
                  }),
                );
              } else {
                builder.add(
                  blockTo,
                  blockTo,
                  Decoration.widget({
                    widget: new PlantumlWidget(body, plantumlSvgUrl(plantumlCfg.server, body)),
                    block: true,
                    side: 1,
                  }),
                );
              }
              i = endI + 1;
              continue;
            }
          }

          // Table block — header + separator + ≥0 body rows (including inside blockquotes, #480).
          const tableQuoteDepth = quoteDepth(line.text);
          if (
            isPipeRow(line.text, tableQuoteDepth) &&
            !isSeparatorRow(line.text, tableQuoteDepth) &&
            i + 1 <= lastLine
          ) {
            const sepLine = doc.line(i + 1);
            if (isSeparatorRow(sepLine.text, tableQuoteDepth)) {
              // Walk forward as long as we keep seeing pipe rows at the same quote depth,
              // stopping if a new adjacent table (header + separator row) begins immediately.
              let endI = i + 2;
              while (endI <= lastLine) {
                const next = doc.line(endI);
                if (!isPipeRow(next.text, tableQuoteDepth)) break;
                if (
                  !isSeparatorRow(next.text, tableQuoteDepth) &&
                  endI + 1 <= lastLine &&
                  isSeparatorRow(doc.line(endI + 1).text, tableQuoteDepth)
                ) {
                  break;
                }
                endI += 1;
              }
              const tableEnd = endI - 1; // last pipe row (or separator row for header-only tables)
              if (tableEnd >= i + 1) {
                const blockFrom = doc.line(i).from;
                const blockTo = doc.line(tableEnd).to;
                const source = doc.sliceString(blockFrom, blockTo);
                // #500 / #605 — Standard and list-indented GFM tables stay rendered in
                // Live Edit mode so cells are edited in place like Excel (Nomo,
                // NoteGen, VNote, Typora). In Pure WYSIWYG mode (`pureWysiwyg`),
                // tables stay rendered at all times without the `</> 源码` button.
                const canInlineEdit = tableQuoteDepth === 0 && parseTable(source) !== null;
                const tableFoldMap = state.field(tableFoldState, false);
                const tableFoldOverride = tableFoldMap?.get(i);
                const cursorInsideTable =
                  (cursorLine >= i && cursorLine <= tableEnd) ||
                  (cursorLineEnd >= i && cursorLineEnd <= tableEnd);
                const defaultTableCollapsed =
                  !keepSource && (pureWysiwyg || canInlineEdit || !cursorInsideTable);
                const tableCollapsed = pureWysiwyg
                  ? true
                  : tableFoldOverride !== undefined
                    ? tableFoldOverride
                    : defaultTableCollapsed;
                if (tableCollapsed) {
                  builder.add(
                    blockFrom,
                    blockTo,
                    Decoration.replace({
                      widget: new TableWidget(
                        source,
                        opts.getImageRoot?.() ?? null,
                        opts.getFilePath?.(),
                        i,
                        blockFrom,
                        blockTo,
                        pureWysiwyg,
                      ),
                      block: true,
                    }),
                  );
                } else {
                  builder.add(
                    blockFrom,
                    blockFrom,
                    Decoration.widget({
                      widget: new TableFoldToggleWidget(i, tableEnd, false),
                      side: -1,
                    }),
                  );
                }
                i = tableEnd + 1;
                continue;
              }
            }
          }

          // #506 — When `keepSource` is enabled and this non-standalone line
          // (e.g. a list item `- ![alt](url)` or blockquote `> ![alt](url)`)
          // carries a Markdown image, render it below the source line.
          if (keepSource && lineImages.length > 0) {
            const firstImg = lineImages[0];
            const root = opts.getImageRoot?.() ?? null;
            const filePath = opts.getFilePath?.();
            const src = resolveImageSrc(firstImg.src, root, filePath);
            const localPath = resolveImagePath(firstImg.src, root, filePath);
            const needsFallback =
              isLocalSvgPath(localPath) ||
              localPath.startsWith('saf:') ||
              /^\/(?:storage\/emulated\/0|sdcard)\//i.test(localPath);
            builder.add(
              line.to,
              line.to,
              Decoration.widget({
                widget: new ImageWidget(
                  src,
                  firstImg.alt,
                  needsFallback ? localPath : null,
                  i,
                  false,
                  firstImg.width ?? null,
                  firstImg.height ?? null,
                ),
                block: true,
                side: 1,
              }),
            );
            i += 1;
            continue;
          }

          // v4.5.5 / #506 / #605 — inline math (`$…$`) and inline / list-item /
          // blockquote images (`- ![alt](url)`, `> ![alt](url)`, inline `![alt](url)`)
          // on an otherwise-plain line.
          const inlineCursorHere =
            keepSource || (!pureWysiwyg && i >= cursorLine && i <= cursorLineEnd);
          if (!inlineCursorHere) {
            const hasMathCandidate =
              line.text.indexOf('$') !== -1 ||
              line.text.indexOf('\\(') !== -1 ||
              line.text.indexOf('\\[') !== -1;
            if (lineImages.length > 0 || hasMathCandidate) {
              const inlineSpans: Array<{ start: number; end: number; deco: Decoration }> = [];
              const root = lineImages.length > 0 ? (opts.getImageRoot?.() ?? null) : null;
              const filePath = lineImages.length > 0 ? opts.getFilePath?.() : undefined;
              for (const imgSpan of lineImages) {
                const src = resolveImageSrc(imgSpan.src, root, filePath);
                const localPath = resolveImagePath(imgSpan.src, root, filePath);
                const needsFallback =
                  isLocalSvgPath(localPath) ||
                  localPath.startsWith('saf:') ||
                  /^\/(?:storage\/emulated\/0|sdcard)\//i.test(localPath);
                inlineSpans.push({
                  start: imgSpan.start,
                  end: imgSpan.end,
                  deco: Decoration.replace({
                    widget: new ImageWidget(
                      src,
                      imgSpan.alt,
                      needsFallback ? localPath : null,
                      i,
                      true,
                      imgSpan.width ?? null,
                      imgSpan.height ?? null,
                    ),
                  }),
                });
              }
              if (hasMathCandidate) {
                for (const mathSpan of inlineMathSpans(line.text)) {
                  const overlapsImage = lineImages.some(
                    (im) => mathSpan.start < im.end && mathSpan.end > im.start,
                  );
                  if (!overlapsImage) {
                    inlineSpans.push({
                      start: mathSpan.start,
                      end: mathSpan.end,
                      deco: Decoration.replace({ widget: new InlineMathWidget(mathSpan.tex) }),
                    });
                  }
                }
              }
              inlineSpans.sort((a, b) => a.start - b.start);
              for (const item of inlineSpans) {
                builder.add(line.from + item.start, line.from + item.end, item.deco);
              }
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
      if (isDragEndTransaction(tr)) return buildBlockDecorations(tr.state, opts);
      // Freeze block widget replacements completely during pointer drag so
      // incremental Lezer parsing (~700 lines into a large file) or async
      // Mermaid relayouts cannot mount/unmount widgets mid-drag and shift the
      // document height under the pointer. `isDragEndTransaction` above flushes
      // the final state as soon as the pointer is released.
      if (isDragging(tr.state)) {
        return deco.map(tr.changes);
      }
      if (
        tr.effects.some(
          (e) =>
            e.is(relayoutEffect) ||
            e.is(toggleMermaidFoldEffect) ||
            e.is(toggleTableFoldEffect) ||
            e.is(resetBlockFoldOverridesEffect),
        )
      ) {
        return buildBlockDecorations(tr.state, opts);
      }
      if (tr.selection) {
        // `buildBlockDecorations` only depends on the 1-indexed start/end line
        // numbers of `selection.main` (and ignores selection altogether when
        // `keepSource` is active). Skipping intra-line selection updates avoids
        // rebuilding all block decorations on every character typed in Find
        // (`a` -> `ab` -> `abc`) or intra-line `Enter` match jumps.
        if (opts.keepSource?.() === true || opts.pureWysiwyg?.() === true) {
          return deco.map(tr.changes);
        }
        const prevSel = tr.startState.selection.main;
        const nextSel = tr.state.selection.main;
        const prevFromLine = tr.startState.doc.lineAt(prevSel.from).number;
        const prevToLine = tr.startState.doc.lineAt(prevSel.to).number;
        const nextFromLine = tr.state.doc.lineAt(nextSel.from).number;
        const nextToLine = tr.state.doc.lineAt(nextSel.to).number;
        if (prevFromLine !== nextFromLine || prevToLine !== nextToLine) {
          return buildBlockDecorations(tr.state, opts);
        }
      }
      // Note: Do NOT rebuild full-document block decorations on background
      // incremental Lezer `syntaxTree` parse slices (`!tr.docChanged`).
      // `buildBlockDecorations` already performs a complete synchronous
      // line-level fence scan across all lines on `create` and `docChanged`;
      // rebuilding on every background parse chunk froze Find scrolling on
      // large `.md` files.
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
      const widget = (d.spec as { widget?: unknown }).widget;
      if (widget instanceof TldrawWidget) return;
      const a = doc.lineAt(from).number;
      const b = doc.lineAt(to).number;
      const jumpedOver = forward
        ? fromLine.number < a && toLineNo > b
        : fromLine.number > b && toLineNo < a;
      if (!jumpedOver) return;
      if (widget instanceof TableWidget) {
        const parsed = parseTable(doc.sliceString(from, to));
        const targetRow = forward
          ? HEADER_ROW
          : parsed && parsed.rows.length > 0
            ? parsed.rows.length - 1
            : HEADER_ROW;
        const wrapEl = view.dom.querySelector<HTMLElement>(
          `.cm-live-block--table[data-table-from="${from}"]`,
        );
        const handle = wrapEl ? tableEditorHandles.get(wrapEl) : null;
        if (handle && handle.focusCell(targetRow, 0, 'end')) {
          handled = true;
          return false;
        }
        requestTableCellFocus(from, targetRow, 0);
        const edge = doc.line(forward ? a : b);
        view.dispatch({
          selection: { anchor: edge.from },
          scrollIntoView: true,
          userEvent: 'select',
        });
        handled = true;
        return false;
      }
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
      const widget = (d.spec as { widget?: unknown }).widget;
      if (widget instanceof TldrawWidget || widget instanceof TableWidget) return;
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

  const tableSearchHighlighter = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        this.sync(view, false);
      }
      update(update: ViewUpdate) {
        const queryChanged =
          update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(setSearchQuery) || e.is(setExternalSearchQueryEffect)),
          ) || searchPanelOpen(update.startState) !== searchPanelOpen(update.state);
        if (queryChanged || update.docChanged || update.selectionSet || update.viewportChanged) {
          this.sync(update.view, queryChanged || update.selectionSet);
        }
      }
      sync(view: EditorView, scrollCurrent: boolean) {
        const tables = view.dom.querySelectorAll<HTMLElement>('.cm-live-block--table');
        if (tables.length === 0) return;
        let currentMark: HTMLElement | null = null;
        for (const wrap of Array.from(tables)) {
          const hit = syncTableWidgetSearchMarks(wrap, view.state);
          if (hit) currentMark = hit;
        }
        if (scrollCurrent && currentMark) {
          requestAnimationFrame(() => {
            if (currentMark?.isConnected) {
              try {
                currentMark.scrollIntoView({ block: 'center', behavior: 'auto' });
              } catch {}
            }
          });
        }
      }
    },
  );

  return [
    mermaidFoldState,
    tableFoldState,
    field,
    relayout,
    tableSearchHighlighter,
    blockArrowKeymap,
    vimBlockHop,
  ];
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
  '.cm-live-block--image-inline': {
    display: 'inline-block',
    verticalAlign: 'middle',
    maxWidth: '100%',
    padding: '0.25em 0',
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
    width: '100%',
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
  '.cm-live-block--table': {
    position: 'relative',
  },
  '.cm-table-source-btn': {
    position: 'absolute',
    top: '4px',
    right: '4px',
    padding: '2px 6px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'color-mix(in srgb, var(--bg-elev) 90%, transparent)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    lineHeight: '1.3',
    cursor: 'pointer',
    opacity: '0',
    transition: 'opacity 0.15s, color 0.15s, border-color 0.15s',
    zIndex: '2',
  },
  '.cm-live-block--table:hover .cm-table-source-btn, .cm-table-source-btn:focus-visible': {
    opacity: '1',
  },
  '.cm-table-source-btn:hover': {
    color: 'var(--accent)',
    borderColor: 'var(--accent)',
  },
  '.cm-live-block--table blockquote': {
    margin: '0.2em 0',
    paddingLeft: '1em',
    borderLeft: '3px solid var(--accent)',
    color: 'var(--text-muted)',
  },
  '.cm-live-block--table table': {
    width: '100%',
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
    minWidth: '48px',
  },
  '.cm-live-block--html th::after, .cm-live-block--html td::after, .cm-live-block--table th::after, .cm-live-block--table td::after': {
    content: '"\\00a0"',
    display: 'inline-block',
    width: '0',
    overflow: 'hidden',
    visibility: 'hidden',
  },
  '.cm-live-block--table thead th': {
    background: 'var(--bg-elev)',
    fontWeight: '600',
  },
  '.cm-live-block--table .cm-live-table__cell--editing': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
    background: 'var(--bg)',
    whiteSpace: 'pre-wrap',
    cursor: 'text',
    userSelect: 'text',
    WebkitUserSelect: 'text',
  },
  // v4.3.0 issue #57a — paddings fold in the 0.6em that used to come from the
  // shared margin (see #155 note above) so the visual rhythm is unchanged.
  '.cm-live-block--math': {
    padding: '1em 0',
    overflowX: 'auto',
    textAlign: 'center',
  },
  // #573 — Inline \dfrac / \frac inside consecutive list items or lines
  // overflows a `display: inline` (line-height: 1.2) span and collides
  // vertically. Promoting fraction-bearing inline math to `inline-block`
  // with vertical margin makes the line box expand to fit the fraction.
  '.cm-live-inline-math:has(.mfrac)': {
    display: 'inline-block',
    margin: '0.2em 0',
  },
  // #530 — Left-align Mermaid diagrams like images (instead of centered), and
  // style the `+` / `−` fold toggle button on the opening ` ```mermaid ` line.
  '.cm-live-block--mermaid': {
    padding: '0.8em 0 1.2em 0',
    textAlign: 'left',
  },
  '.cm-live-block--mermaid svg': {
    maxWidth: '100%',
    height: 'auto',
    display: 'block',
    margin: '0',
  },
  '.cm-mermaid-fold-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    marginRight: '6px',
    padding: '0',
    border: '1px solid var(--border)',
    borderRadius: '3px',
    background: 'color-mix(in srgb, var(--bg-elev) 85%, transparent)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    fontWeight: '600',
    lineHeight: '1',
    cursor: 'pointer',
    userSelect: 'none',
    verticalAlign: 'middle',
    transition: 'color 0.15s, border-color 0.15s, background 0.15s',
  },
  '.cm-mermaid-fold-btn:hover': {
    color: 'var(--accent)',
    borderColor: 'var(--accent)',
    background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--bg-elev))',
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

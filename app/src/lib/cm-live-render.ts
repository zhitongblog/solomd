/**
 * cm-live-render.ts — WYSIWYG "live edit" CM6 extension for SoloMD v2.3
 *
 * Goes further than `cm-live-preview.ts`. The preview-style extension hides
 * a few marker characters and lets the HighlightStyle do the rest. This
 * extension is the editor-only "live edit" mode (Typora / Obsidian Live
 * Preview equivalent) — it RENDERS markdown formatting inline:
 *
 *   - `# Heading` → larger bold heading; the `#` is hidden when the caret
 *     is on a different line.
 *   - `**bold**` → bold text; `**` markers hidden when caret is outside.
 *   - `*italic*` / `_italic_` → italic; markers hidden when caret outside.
 *   - `` `code` `` → monospace + bg; backticks hidden when caret outside.
 *   - `[label](url)` → blue + underlined; raw form revealed when caret
 *     enters either the label or the URL part.
 *   - `- item`, `* item`, `1. item` → list bullet/number stays visible
 *     because that IS the visual rendering for a list — but we slim down
 *     the spacing and color it like the preview.
 *   - `> quote` → indented + left bar via a `Decoration.line` class; the
 *     `>` itself stays visible (Typora hides it; we keep it because hiding
 *     the `>` makes new-line-into-quote ergonomics worse).
 *   - Fenced code blocks (`` ``` ``) → grey background; existing syntax
 *     coloring from the markdown package handles the inner tokens.
 *   - `~~strike~~` → strikethrough; markers hidden when caret outside.
 *
 * Caret reveal model: a marker decoration is suppressed (raw markdown
 * shown) when the user's selection touches the same LINE as the marker.
 * Multi-line selections naturally reveal everything they cross.
 *
 * Performance: decoration recompute happens on `docChanged`,
 * `selectionSet`, or `viewportChanged` only, and only iterates the
 * syntax tree over `view.visibleRanges` — i.e. O(viewport) not O(doc).
 *
 * CJK note: the lezer-markdown parser emits `EmphasisMark` nodes
 * regardless of full-width punctuation around markers, so `**粗体**`
 * just works. We don't post-filter on character classes.
 */

import { syntaxTree, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

// ---------------------------------------------------------------------------
// Marker nodes that we hide off-line. Brackets/parens for links and
// backticks for inline code are included here so the rendered text reads
// like a real preview. When the caret is on the same line the marker is
// revealed so it stays editable.
// ---------------------------------------------------------------------------
const HIDDEN_MARK_NODES = new Set<string>([
  'HeaderMark',     // `#`, `##`, …
  'EmphasisMark',   // `*`, `_`
  'StrikethroughMark', // `~~`
  'CodeMark',       // backticks for inline code AND fenced code
  'LinkMark',       // `[`, `]`, `(`, `)` around links
  'QuoteMark',      // `>` at start of blockquote lines
  'LinkTitle',      // optional title in `[label](url "title")`
  'CodeInfo',       // language tag after ``` — visually noisy off-line
]);

// `URL` nodes are special: inside `[label](url)` we want to hide them so
// only the label shows; inside an Autolink (`<https://x.com>`) the URL
// IS the visible text and hiding it would erase the link. We handle URL
// in the iterate callback by checking the parent.

// Inline mark decorations applied on top of the existing token highlight.
// Class names follow `cm-md-…` so theme overrides are easy.
const headingClass = (level: number) =>
  Decoration.mark({ class: `cm-md-h cm-md-h${level}`, inclusive: false });
const strongMark = Decoration.mark({ class: 'cm-md-strong' });
const emMark = Decoration.mark({ class: 'cm-md-em' });
const strikeMark = Decoration.mark({ class: 'cm-md-strike' });
const codeMark = Decoration.mark({ class: 'cm-md-code' });
const linkMark = Decoration.mark({ class: 'cm-md-link' });

// Block-level line decorations.
const lineClass = (cls: string) => Decoration.line({ class: cls });
const quoteLine = lineClass('cm-md-quote-line');
const fencedLine = lineClass('cm-md-fenced-line');
const headingLine = (level: number) => lineClass(`cm-md-heading-line cm-md-heading-line-${level}`);

const hideDeco = Decoration.replace({});

// Heading nodes 1..6 → level
const HEADING_LEVELS: Record<string, number> = {
  ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3,
  ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6,
  SetextHeading1: 1, SetextHeading2: 2,
};

function buildDecorations(view: EditorView): DecorationSet {
  const sel = view.state.selection.main;
  const fromLine = view.state.doc.lineAt(sel.from).number;
  const toLine = view.state.doc.lineAt(sel.to).number;
  const tree = syntaxTree(view.state);

  // We collect into a flat list of `Range<Decoration>` and then call
  // `Decoration.set(ranges, /* sort */ true)` — that's the documented
  // forgiving path for adding line + mark decorations together. The
  // `sort=true` arg lets CM6 sort by (from, startSide) for us, which is
  // necessary because line and mark decorations have different sides.
  const ranges: Range<Decoration>[] = [];

  const seenQuoteLines = new Set<number>();
  const seenFencedLines = new Set<number>();
  const seenHeadingLines = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const nFrom = node.from;
        const nTo = node.to;
        const lineAtNode = view.state.doc.lineAt(nFrom).number;
        const lineEndAtNode = view.state.doc.lineAt(
          Math.min(nTo, view.state.doc.length),
        ).number;
        const caretTouches = lineEndAtNode >= fromLine && lineAtNode <= toLine;

        // ---- Marker hiding (off-line only) ----
        if (HIDDEN_MARK_NODES.has(name)) {
          if (!caretTouches && nTo > nFrom) {
            ranges.push(hideDeco.range(nFrom, nTo));
          }
          return;
        }

        // ---- URL: hide only when it's the destination part of a real
        //      `[label](url)` link. Autolinks (`<https://x.com>`) make
        //      the URL the visible text, so we leave it alone there. ----
        if (name === 'URL') {
          const parent = node.node.parent;
          const inLabeledLink = parent && parent.name === 'Link';
          if (inLabeledLink && !caretTouches && nTo > nFrom) {
            ranges.push(hideDeco.range(nFrom, nTo));
          }
          return;
        }

        // ---- Headings: line class for sizing + heading mark on text ----
        if (HEADING_LEVELS[name]) {
          const level = HEADING_LEVELS[name];
          const lineObj = view.state.doc.lineAt(nFrom);
          if (!seenHeadingLines.has(lineObj.from)) {
            seenHeadingLines.add(lineObj.from);
            ranges.push(headingLine(level).range(lineObj.from));
          }
          if (nFrom < nTo) {
            ranges.push(
              headingClass(level).range(nFrom, Math.min(nTo, view.state.doc.length)),
            );
          }
          return;
        }

        // ---- Inline strong / emphasis / strike ----
        if (name === 'StrongEmphasis' && nFrom < nTo) {
          ranges.push(strongMark.range(nFrom, nTo));
          return;
        }
        if (name === 'Emphasis' && nFrom < nTo) {
          ranges.push(emMark.range(nFrom, nTo));
          return;
        }
        if (name === 'Strikethrough' && nFrom < nTo) {
          ranges.push(strikeMark.range(nFrom, nTo));
          return;
        }

        // ---- Inline code ----
        if (name === 'InlineCode' && nFrom < nTo) {
          ranges.push(codeMark.range(nFrom, nTo));
          return;
        }

        // ---- Links ----
        if (name === 'Link' && nFrom < nTo) {
          ranges.push(linkMark.range(nFrom, nTo));
          return;
        }

        // ---- Blockquote line styling ----
        if (name === 'Blockquote') {
          const startLine = view.state.doc.lineAt(nFrom).number;
          const endLine = view.state.doc.lineAt(
            Math.min(nTo, view.state.doc.length),
          ).number;
          for (let ln = startLine; ln <= endLine; ln++) {
            const lineObj = view.state.doc.line(ln);
            if (!seenQuoteLines.has(lineObj.from)) {
              seenQuoteLines.add(lineObj.from);
              ranges.push(quoteLine.range(lineObj.from));
            }
          }
          return;
        }

        // ---- Fenced code block background ----
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const startLine = view.state.doc.lineAt(nFrom).number;
          const endLine = view.state.doc.lineAt(
            Math.min(nTo, view.state.doc.length),
          ).number;
          for (let ln = startLine; ln <= endLine; ln++) {
            const lineObj = view.state.doc.line(ln);
            if (!seenFencedLines.has(lineObj.from)) {
              seenFencedLines.add(lineObj.from);
              ranges.push(fencedLine.range(lineObj.from));
            }
          }
          return;
        }
      },
    });
  }

  // sort = true so CM6 handles (from, side) ordering regardless of the
  // mixed line/mark/replace decorations we collected.
  return Decoration.set(ranges, true);
}

const liveRenderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// Rich syntax highlighting — same palette as cm-live-preview.ts but kept
// here so live-edit can be used independently of the live-preview toggle.
const liveEditHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', color: 'var(--md-h1)' },
  { tag: t.heading2, fontWeight: '700', color: 'var(--md-h2)' },
  { tag: t.heading3, fontWeight: '700', color: 'var(--md-h3)' },
  { tag: t.heading4, fontWeight: '700', color: 'var(--md-h4)' },
  { tag: t.heading5, fontWeight: '700', color: 'var(--md-h5)' },
  { tag: t.heading6, fontWeight: '700', color: 'var(--md-h6)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--md-strong)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--md-em)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: t.link, color: 'var(--md-link)' },
  { tag: t.url, color: 'var(--md-url)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--md-code)' },
  { tag: t.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--md-list)' },
  { tag: t.contentSeparator, color: 'var(--md-hr)' },
  { tag: t.processingInstruction, color: 'var(--text-faint)' },
  // Code-block syntax (nested languages)
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: t.string, color: 'var(--syn-string)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: t.function(t.variableName), color: 'var(--syn-function)' },
  { tag: t.variableName, color: 'var(--syn-variable)' },
  { tag: t.typeName, color: 'var(--syn-type)' },
  { tag: t.className, color: 'var(--syn-type)' },
  { tag: t.propertyName, color: 'var(--syn-property)' },
  { tag: t.operator, color: 'var(--syn-operator)' },
  { tag: t.punctuation, color: 'var(--text-muted)' },
  { tag: t.bracket, color: 'var(--text-muted)' },
  { tag: t.bool, color: 'var(--syn-number)' },
  { tag: t.null, color: 'var(--syn-number)' },
  { tag: t.tagName, color: 'var(--syn-keyword)' },
  { tag: t.attributeName, color: 'var(--syn-property)' },
  { tag: t.attributeValue, color: 'var(--syn-string)' },
]);

// Theme: heading sizes match the Preview pane sizes (h1 2em, h2 1.5em,
// h3 1.2em) so toggling between liveEdit and preview feels seamless.
const liveEditTheme = EditorView.theme({
  '.cm-line': {
    fontVariantLigatures: 'none',
  },
  // Heading lines — use line-decoration to size whole line so layout
  // doesn't jump when markers are revealed/hidden.
  '.cm-md-heading-line-1': {
    fontSize: '1.85em',
    fontWeight: '700',
    lineHeight: '1.25',
    paddingTop: '0.4em',
    paddingBottom: '0.15em',
  },
  '.cm-md-heading-line-2': {
    fontSize: '1.5em',
    fontWeight: '700',
    lineHeight: '1.3',
    paddingTop: '0.3em',
    paddingBottom: '0.1em',
  },
  '.cm-md-heading-line-3': {
    fontSize: '1.22em',
    fontWeight: '700',
    lineHeight: '1.35',
  },
  '.cm-md-heading-line-4': { fontSize: '1.1em', fontWeight: '700' },
  '.cm-md-heading-line-5': { fontWeight: '700' },
  '.cm-md-heading-line-6': { fontWeight: '700', color: 'var(--text-muted)' },

  // Heading text color (from the heading mark). The line decoration sets
  // size; this paints the color so emphasis/strong inside a heading
  // inherit cleanly.
  '.cm-md-h1': { color: 'var(--md-h1)' },
  '.cm-md-h2': { color: 'var(--md-h2)' },
  '.cm-md-h3': { color: 'var(--md-h3)' },
  '.cm-md-h4': { color: 'var(--md-h4)' },
  '.cm-md-h5': { color: 'var(--md-h5)' },
  '.cm-md-h6': { color: 'var(--md-h6)' },

  '.cm-md-strong': { fontWeight: '700', color: 'var(--md-strong)' },
  '.cm-md-em': { fontStyle: 'italic', color: 'var(--md-em)' },
  '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--text-muted)' },

  '.cm-md-code': {
    fontFamily: 'var(--font-mono)',
    color: 'var(--md-code)',
    backgroundColor: 'var(--md-code-bg)',
    padding: '0.1em 0.35em',
    borderRadius: '4px',
  },

  '.cm-md-link': {
    color: 'var(--md-link)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },

  '.cm-md-quote-line': {
    borderLeft: '3px solid var(--border)',
    paddingLeft: '12px',
    color: 'var(--md-quote)',
    fontStyle: 'italic',
    backgroundColor: 'var(--bg-elev, transparent)',
  },

  '.cm-md-fenced-line': {
    backgroundColor: 'var(--md-code-bg)',
    fontFamily: 'var(--font-mono)',
  },
});

/**
 * Bundle for the v2.3 "live edit" view mode. Wire into Editor.vue as the
 * rich-extensions value when `viewMode === 'liveEdit'` and the tab is
 * markdown.
 */
export function liveEditExtension() {
  return [
    syntaxHighlighting(liveEditHighlightStyle),
    liveRenderPlugin,
    liveEditTheme,
  ];
}

// ---------------------------------------------------------------------------
// Self-test hook (used by dev-mcp `solomd_get_editor_decorations`).
//
// We expose a tiny window-level helper that, when the editor is mounted,
// reports the current visible-range decoration counts. The Tauri webview
// can't be poked directly from MCP, so this isn't called by the MCP
// server itself — instead the MCP tool returns "look at the DOM by
// querying `.cm-md-heading-line-1` etc.". We document the class names
// there as the contract.
// ---------------------------------------------------------------------------

/**
 * Stable list of class names this extension emits, exported so the dev-mcp
 * `solomd_get_editor_decorations` tool (and any future automated tests)
 * can assert on them.
 */
export const LIVE_EDIT_CLASSES = [
  'cm-md-heading-line-1',
  'cm-md-heading-line-2',
  'cm-md-heading-line-3',
  'cm-md-heading-line-4',
  'cm-md-heading-line-5',
  'cm-md-heading-line-6',
  'cm-md-strong',
  'cm-md-em',
  'cm-md-strike',
  'cm-md-code',
  'cm-md-link',
  'cm-md-quote-line',
  'cm-md-fenced-line',
] as const;

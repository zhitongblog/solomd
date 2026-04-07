/**
 * CodeMirror 6 live-preview extensions for Markdown.
 *
 * Two pieces:
 *   1. `markdownRichStyle` — a HighlightStyle that makes headings bigger,
 *      bold actually bold, code monospaced with accent color, etc.
 *   2. `liveMarkdownPlugin` — a ViewPlugin that hides marker characters
 *      (`#`, `**`, `*`, `` ` ``, `[`, `]`, `(`, `)` …) on every line that
 *      does NOT currently contain (or touch) the user selection. Move the
 *      cursor onto a heading line and the `#` re-appears so you can edit it.
 *
 * Combined effect: a Typora / Obsidian Live Preview style experience while
 * keeping the underlying buffer as plain markdown source.
 */

import { syntaxTree, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

// Marker node names (from @lezer/markdown) we want to hide off-line.
const HIDDEN_MARK_NODES = new Set<string>([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'LinkMark',
  'StrikethroughMark',
]);

const hideDeco = Decoration.replace({});

const liveMarkdownPlugin = ViewPlugin.fromClass(
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
      const fromLine = view.state.doc.lineAt(sel.from).number;
      const toLine = view.state.doc.lineAt(sel.to).number;
      const tree = syntaxTree(view.state);

      for (const { from, to } of view.visibleRanges) {
        tree.iterate({
          from,
          to,
          enter: (node) => {
            if (!HIDDEN_MARK_NODES.has(node.name)) return;
            const line = view.state.doc.lineAt(node.from).number;
            // Keep markers visible on the line(s) the cursor / selection touches.
            if (line >= fromLine && line <= toLine) return;
            builder.add(node.from, node.to, hideDeco);
          },
        });
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

// Rich syntax highlighting for markdown tokens. Sizes are in `em` so they
// scale with the user's font-size setting. Heading colors gradient from
// stronger (h1) to softer (h6) for visual hierarchy.
export const markdownRichStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.7em', fontWeight: '700', lineHeight: '1.25', color: 'var(--md-h1)' },
  { tag: t.heading2, fontSize: '1.4em', fontWeight: '700', lineHeight: '1.3', color: 'var(--md-h2)' },
  { tag: t.heading3, fontSize: '1.22em', fontWeight: '700', color: 'var(--md-h3)' },
  { tag: t.heading4, fontSize: '1.1em', fontWeight: '700', color: 'var(--md-h4)' },
  { tag: t.heading5, fontWeight: '700', color: 'var(--md-h5)' },
  { tag: t.heading6, fontWeight: '700', color: 'var(--md-h6)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--md-strong)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--md-em)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: t.link, color: 'var(--md-link)' },
  { tag: t.url, color: 'var(--md-url)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--md-code)', backgroundColor: 'var(--md-code-bg)' },
  { tag: t.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--md-list)' },
  { tag: t.processingInstruction, color: 'var(--text-faint)' },
  { tag: t.contentSeparator, color: 'var(--md-hr)' },
  // Code block syntax highlighting (provided by nested language packages)
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

// Visual polish: dim marker chars when they ARE visible (active line),
// give code blocks a subtle background.
const liveTheme = EditorView.theme({
  '.cm-line': {
    fontVariantLigatures: 'none',
  },
  // Block-level: code fences look like real code blocks
  '.cm-line:has(.tok-monospace)': {
    backgroundColor: 'var(--bg-hover)',
  },
  '.tok-meta, .cm-formatting, .ͼe': {
    color: 'var(--text-faint)',
  },
});

/** Full live-preview extension bundle. Pass `[]` to disable. */
export function livePreviewExtension() {
  return [syntaxHighlighting(markdownRichStyle), liveMarkdownPlugin, liveTheme];
}

/** Just the rich highlight style without hiding markers (raw source mode). */
export function richHighlightOnly() {
  return [syntaxHighlighting(markdownRichStyle)];
}

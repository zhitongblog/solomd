/**
 * Heading folding for the CodeMirror editor.
 *
 * `@codemirror/lang-markdown` already registers a fold service that knows a
 * heading owns everything down to the next heading of the same or a shallower
 * level — but nothing in the app ever turned folding on, so the service was
 * dead code and there was no way to collapse a section. This module supplies
 * the missing half: the fold state, the gutter arrows, the placeholder that
 * says how much is hidden, and the commands (fold to level N, fold/unfold all,
 * toggle the section at the cursor).
 *
 * Fold ranges come from CodeMirror's own `foldable()` wherever it can answer,
 * so a fold made by the gutter and a fold made by "Fold to Level 2" are the
 * same range. `heading-fold.ts` is the fallback and the source of heading
 * levels — it reads the text rather than the syntax tree, which is what the
 * Windows plain-textarea editor needs too.
 */

import { EditorView, keymap } from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';
import {
  codeFolding,
  foldGutter,
  foldKeymap,
  foldEffect,
  unfoldEffect,
  foldedRanges,
  unfoldAll,
  foldable,
  forceParsing,
} from '@codemirror/language';
import { scanHeadings, foldRangeAtLine, type FoldRange } from './heading-fold';

export interface HeadingFoldOptions {
  /** Label for the placeholder that replaces a folded section, e.g.
   *  `(n) => \`⋯ ${n} lines\``. */
  placeholderLabel?: (lines: number) => string;
  /** Show the fold arrows in the gutter. Defaults to true. */
  gutter?: boolean;
}

/** Headings of the current document, cached per `Text` value so the scan runs
 *  once per document version rather than once per command. */
const headingCache = new WeakMap<object, ReturnType<typeof scanHeadings>>();
function headingsOf(state: EditorState) {
  const key = state.doc as unknown as object;
  let cached = headingCache.get(key);
  if (!cached) {
    cached = scanHeadings(state.doc.toString());
    headingCache.set(key, cached);
  }
  return cached;
}

/** The range CodeMirror would fold for the heading on `line0` (0-based), or
 *  null when that heading has nothing under it. */
function rangeForHeadingLine(state: EditorState, line0: number): FoldRange | null {
  if (line0 < 0 || line0 >= state.doc.lines) return null;
  const line = state.doc.line(line0 + 1);
  const canonical = foldable(state, line.from, line.to);
  if (canonical) return canonical;
  // The syntax tree may not reach this far yet (CodeMirror parses lazily), so
  // fall back to the text scan rather than silently skipping the section.
  return foldRangeAtLine(state.doc.toString(), line0);
}

/** Folded ranges that contain `line0`, innermost last. */
function foldsCovering(state: EditorState, line0: number): FoldRange[] {
  const hits: FoldRange[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    const startLine = state.doc.lineAt(from).number - 1;
    const endLine = state.doc.lineAt(to).number - 1;
    if (line0 >= startLine && line0 <= endLine) hits.push({ from, to });
  });
  return hits.sort((a, b) => a.from - b.from);
}

function applyFolds(view: EditorView, ranges: FoldRange[]): boolean {
  const fresh = ranges.filter((r) => r.to > r.from);
  if (!fresh.length) return false;
  view.dispatch({ effects: fresh.map((r) => foldEffect.of(r)) });
  return true;
}

/** Is anything folded right now? */
export function hasFolds(state: EditorState): boolean {
  let any = false;
  foldedRanges(state).between(0, state.doc.length, () => {
    any = true;
    return false;
  });
  return any;
}

/**
 * Fold or unfold the section the cursor is in.
 *
 * The cursor is usually inside a section rather than on its heading, so this
 * walks up to the nearest enclosing heading — pressing the chord in the middle
 * of a paragraph collapses the section that paragraph belongs to, which is
 * what "fold this" means to a reader.
 */
export function toggleHeadingFoldAtCursor(view: EditorView): boolean {
  const state = view.state;
  const cursorLine = state.doc.lineAt(state.selection.main.head).number - 1;

  // An existing fold wins: toggling should undo what the user last did. The
  // innermost one goes first so nested sections peel open one at a time.
  const covering = foldsCovering(state, cursorLine);
  const innermost = covering[covering.length - 1];
  if (innermost) {
    view.dispatch({ effects: unfoldEffect.of(innermost) });
    return true;
  }

  const enclosing = headingsOf(state)
    .filter((h) => h.foldable && h.line <= cursorLine && cursorLine <= h.endLine)
    .pop();
  if (!enclosing) return false;
  const range = rangeForHeadingLine(state, enclosing.line);
  return range ? applyFolds(view, [range]) : false;
}

/** Fold every section in the document. */
export function foldAllHeadings(view: EditorView): boolean {
  forceParsing(view, view.state.doc.length, 300);
  const ranges = headingsOf(view.state)
    .filter((h) => h.foldable)
    .map((h) => rangeForHeadingLine(view.state, h.line))
    .filter((r): r is FoldRange => !!r);
  return applyFolds(view, ranges);
}

/** Unfold everything, including non-heading folds (code blocks, tables). */
export function unfoldAllFolds(view: EditorView): boolean {
  return unfoldAll(view);
}

/**
 * Show the document down to `level`: every heading at that level or deeper is
 * folded, shallower ones stay open. Level 1 collapses the whole outline.
 */
export function foldHeadingsToLevel(view: EditorView, level: number): boolean {
  unfoldAll(view);
  forceParsing(view, view.state.doc.length, 300);
  const ranges = headingsOf(view.state)
    .filter((h) => h.foldable && h.level >= level)
    .map((h) => rangeForHeadingLine(view.state, h.line))
    .filter((r): r is FoldRange => !!r);
  return applyFolds(view, ranges);
}

/** The fold state, gutter and default fold keymap. */
export function headingFoldExtension(opts: HeadingFoldOptions = {}): Extension {
  const label = opts.placeholderLabel ?? ((n: number) => `⋯ ${n} lines`);
  return [
    codeFolding({
      preparePlaceholder: (state, range) => ({
        lines: state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
      }),
      placeholderDOM: (_view, onclick, prepared) => {
        const el = document.createElement('span');
        const text = label(prepared?.lines ?? 0);
        el.className = 'cm-foldPlaceholder cm-heading-fold-placeholder';
        el.textContent = text;
        el.title = text;
        el.setAttribute('role', 'button');
        el.onclick = onclick;
        return el;
      },
    }),
    ...(opts.gutter === false ? [] : [foldGutter({ openText: '⌄', closedText: '›' })]),
    keymap.of(foldKeymap),
    EditorView.baseTheme({
      '.cm-heading-fold-placeholder': {
        padding: '0 6px',
        margin: '0 4px',
        borderRadius: '4px',
        fontSize: '0.85em',
        cursor: 'pointer',
        background: 'rgba(127,127,127,0.18)',
      },
      '.cm-foldGutter .cm-gutterElement': { padding: '0 2px', opacity: '0.55' },
      '.cm-foldGutter .cm-gutterElement:hover': { opacity: '1' },
    }),
  ];
}

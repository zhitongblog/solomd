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
import { hljsFallbackExtension } from './cm-hljs-fallback';

// Minimal structural view of a lezer `SyntaxNode`. `@lezer/common` is only a
// transitive dependency (not in our package.json), so we describe just the
// tree-walk fields we touch rather than importing the real type.
export interface MdSyntaxNode {
  name: string;
  from: number;
  to: number;
  parent: MdSyntaxNode | null;
  firstChild: MdSyntaxNode | null;
  nextSibling: MdSyntaxNode | null;
}
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { frozenDuringComposition, isImeSafeFlushTransaction } from './cm-ime-guard';
import { tags as t } from '@lezer/highlight';
import { isDragging, isDragEndTransaction } from './cm-drag-aware';
import {
  findInlineHtmlSpans,
  findMarkSpans,
  findSupSubSpans,
  maskInlineCode,
  type LiveInlineHtmlKind,
} from './html-live-render';
import { copyPlainText, dedentFenced, dedentIndented } from './code-copy';
import { isStandaloneImageLine } from './md-image-url';

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
const htmlUnderlineMark = Decoration.mark({ class: 'cm-md-html-u' });
const htmlMarkMark = Decoration.mark({ class: 'cm-md-html-mark' });
const htmlSubMark = Decoration.mark({ class: 'cm-md-html-sub' });
const htmlSupMark = Decoration.mark({ class: 'cm-md-html-sup' });
const htmlKbdMark = Decoration.mark({ class: 'cm-md-html-kbd' });

function inlineHtmlMark(kind: LiveInlineHtmlKind, bgColor?: string, textColor?: string): Decoration {
  switch (kind) {
    case 'strong': return strongMark;
    case 'em': return emMark;
    case 'underline': return htmlUnderlineMark;
    case 'strike': return strikeMark;
    case 'mark': {
      if (bgColor || textColor) {
        const styles: string[] = [];
        if (bgColor) styles.push(`background-color: ${bgColor}`);
        if (textColor) styles.push(`color: ${textColor}`);
        return Decoration.mark({
          class: 'cm-md-html-mark',
          attributes: { style: styles.join('; ') },
        });
      }
      return htmlMarkMark;
    }
    case 'sub': return htmlSubMark;
    case 'sup': return htmlSupMark;
    case 'code': return codeMark;
    case 'kbd': return htmlKbdMark;
  }
}

// Block-level line decorations.
const lineClass = (cls: string) => Decoration.line({ class: cls });
const quoteLine = lineClass('cm-md-quote-line');
const fencedLine = lineClass('cm-md-fenced-line');
// 5.0 §5 — quotes and code blocks are rounded cards. Each line paints its own
// background, so the first and last line of a block carry the corners (and
// the card's inner top/bottom padding). Line decorations on the same line
// merge their classes, so these ride alongside quoteLine / fencedLine.
const blockFirstLine = lineClass('cm-md-block-first');
const blockLastLine = lineClass('cm-md-block-last');
const headingLine = (level: number) => lineClass(`cm-md-heading-line cm-md-heading-line-${level}`);

const hideDeco = Decoration.replace({});
// #353 "Always show Markdown markers": the markers stay in the text, dimmed,
// instead of being replaced. Styling (heading size, bold, …) is unchanged.
const markerMark = Decoration.mark({ class: 'cm-md-marker' });

// ---------------------------------------------------------------------------
// List + horizontal-rule rendering (v4.7.1). Off the caret line we render
// the markdown the way a preview would; on the caret line the raw source is
// revealed so it stays editable — same model as the inline marks above.
//   - `- item` / `* item` / `+ item` → the marker becomes a • bullet glyph.
//   - `1. item`                       → number kept (it IS the visual), just
//                                       styled; not replaced.
//   - `- [ ] item`                    → the dash is hidden so the checkbox
//                                       (rendered by cm-task-list.ts) leads.
//   - `---` / `***` / `___`           → a real <hr> rule.
// ---------------------------------------------------------------------------
// Widgets carry their own inline styling so they render correctly under BOTH
// the liveEdit theme (here) and the edit-mode livePreview extension
// (cm-live-preview.ts), which reuses these via the exports below.
const BULLET_SYMBOLS = ['•', '◦', '▪'] as const;

class BulletWidget extends WidgetType {
  readonly widthEm: number;
  readonly depth: number;
  constructor(
    widthEm: number = 0,
    depth: number = 0,
  ) {
    super();
    this.widthEm = widthEm;
    this.depth = depth;
  }
  eq(other: BulletWidget) {
    return this.widthEm === other.widthEm && this.depth === other.depth;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = this.widthEm > 0 ? 'cm-md-bullet cm-md-list-prefix' : 'cm-md-bullet';
    const symbol = BULLET_SYMBOLS[Math.max(0, this.depth) % BULLET_SYMBOLS.length];
    span.textContent = symbol;
    span.style.color = 'var(--md-list)';
    span.style.fontWeight = '700';
    if (this.widthEm > 0) {
      span.style.display = 'inline-block';
      span.style.width = `${this.widthEm.toFixed(2)}em`;
      span.style.textIndent = '0';
      span.style.whiteSpace = 'pre';
    }
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement('hr');
    hr.className = 'cm-md-hr';
    hr.style.display = 'inline-block';
    hr.style.width = '100%';
    hr.style.height = '0';
    hr.style.margin = '0.2em 0';
    hr.style.border = 'none';
    hr.style.borderTop = '1px solid var(--border)';
    hr.style.verticalAlign = 'middle';
    return hr;
  }
}

export const bulletDeco = Decoration.replace({ widget: new BulletWidget() });
const bulletDecoByDepth = [
  bulletDeco,
  Decoration.replace({ widget: new BulletWidget(0, 1) }),
  Decoration.replace({ widget: new BulletWidget(0, 2) }),
] as const;
export function bulletDecoForDepth(depth: number): Decoration {
  return bulletDecoByDepth[Math.max(0, depth) % bulletDecoByDepth.length];
}
export const hrDeco = Decoration.replace({ widget: new HrWidget() });

// Does the `ListMark`'s ListItem hold a GFM TaskMarker (`[ ]` / `[x]`)?
// Those are already rendered as a checkbox by cm-task-list.ts, so we hide the
// leading dash instead of swapping in a bullet.
export function listItemHasTask(listMark: MdSyntaxNode): boolean {
  const item = listMark.parent; // ListItem
  if (!item) return false;
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TaskMarker' || child.name === 'Task') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Code-block copy button (v4.11.18)
//
// Live-edit renders a fenced block like a preview would — the ``` lines are
// hidden — but a drag-select still yields the *source*: the fence lines and,
// for a block nested in a list, the container's leading indentation. Users
// copying a snippet into a terminal had to strip that by hand. So the block
// gets the same one-click copy button the preview pane has had since #195,
// and it copies the code the way a renderer would: fences dropped, the
// block's own indentation removed, code-relative indentation kept.
// ---------------------------------------------------------------------------

/** Label getter, installed by Editor.vue so the button follows the UI
 *  language without this module importing the i18n store. */
let copyLabelGetter: () => string = () => 'Copy';

export function setLiveEditCopyLabel(getter: () => string): void {
  copyLabelGetter = getter;
}

class CodeCopyWidget extends WidgetType {
  readonly doc: { line(n: number): { text: string } };
  readonly isFenced: boolean;
  readonly startLine: number;
  readonly endLine: number;
  constructor(
    doc: { line(n: number): { text: string } },
    isFenced: boolean,
    startLine: number,
    endLine: number,
  ) {
    super();
    this.doc = doc;
    this.isFenced = isFenced;
    this.startLine = startLine;
    this.endLine = endLine;
  }

  eq(other: CodeCopyWidget) {
    return (
      other.doc === this.doc &&
      other.isFenced === this.isFenced &&
      other.startLine === this.startLine &&
      other.endLine === this.endLine
    );
  }

  toDOM() {
    const label = copyLabelGetter();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-md-code-copy';
    btn.textContent = label;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    // Inside `.cm-content` (contenteditable) a plain button still steals the
    // selection on mousedown — cancel that so clicking Copy never moves the
    // caret or scrolls the block.
    btn.contentEditable = 'false';
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const code = codeBlockClipboardText(
          this.doc,
          this.isFenced,
          this.startLine,
          this.endLine,
        );
        await copyPlainText(code);
        btn.textContent = '✓';
        window.setTimeout(() => {
          if (btn.isConnected) btn.textContent = copyLabelGetter();
        }, 1200);
      } catch {
        /* clipboard denied — leave the label alone rather than toast from
           inside a CM widget. */
      }
    });
    return btn;
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * The text a copy button should put on the clipboard for the code block
 * spanning `startLine`..`endLine` (1-indexed, inclusive).
 *
 * Fenced blocks: drop the opening line and the closing fence (an
 * unterminated block at EOF has none), then strip at most the opening
 * fence's own indentation from each body line — CommonMark's rule, so a
 * fence nested in a list loses the list indent while a Python body keeps
 * its own. Indented (4-space) blocks: strip the whitespace prefix common
 * to every line, which is exactly the indentation that made it a block.
 *
 * Exported for the self-test harness.
 */
export function codeBlockClipboardText(
  doc: { line(n: number): { text: string } },
  isFenced: boolean,
  startLine: number,
  endLine: number,
): string {
  let bodyStart = startLine;
  let bodyEnd = endLine;
  if (isFenced) {
    bodyStart = startLine + 1;
    if (endLine > startLine && /^[ \t]*(`{3,}|~{3,})[ \t]*$/.test(doc.line(endLine).text)) {
      bodyEnd = endLine - 1;
    }
  }
  if (bodyEnd < bodyStart) return '';
  const lines: string[] = [];
  for (let n = bodyStart; n <= bodyEnd; n += 1) lines.push(doc.line(n).text);
  const text = lines.join('\n');
  if (!isFenced) return dedentIndented(text);
  const fenceIndent = /^[ \t]*/.exec(doc.line(startLine).text)?.[0] ?? '';
  return dedentFenced(text, fenceIndent);
}

// Heading nodes 1..6 → level
const HEADING_LEVELS: Record<string, number> = {
  ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3,
  ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6,
  SetextHeading1: 1, SetextHeading2: 2,
};

function frontMatterEndPos(doc: { lines: number; line: (n: number) => { text: string; to: number } }): number {
  if (doc.lines < 2) return 0;
  const first = doc.line(1).text.replace(/^\uFEFF/, '').trim();
  if (first !== '---') return 0;
  const maxLines = Math.min(doc.lines, 100);
  for (let n = 2; n <= maxLines; n += 1) {
    const t = doc.line(n).text.trim();
    if (t === '---' || t === '...') {
      return doc.line(n).to;
    }
  }
  return 0;
}

export function buildDecorations(
  view: EditorView,
  showMarkers = false,
  hideActiveLineMarkers = false,
): DecorationSet {
  const sel = view.state.selection.main;
  const dragging = isDragging(view.state);
  const suppressCaretReveal = dragging || hideActiveLineMarkers;
  const realFromLine = dragging ? -1 : view.state.doc.lineAt(sel.from).number;
  const realToLine = dragging ? -1 : view.state.doc.lineAt(sel.to).number;
  const fromLine = suppressCaretReveal ? -1 : realFromLine;
  const toLine = suppressCaretReveal ? -1 : realToLine;
  const tree = syntaxTree(view.state);
  const fmEnd = frontMatterEndPos(view.state.doc);

  // We collect into a flat list of `Range<Decoration>` and then call
  // `Decoration.set(ranges, /* sort */ true)` — that's the documented
  // forgiving path for adding line + mark decorations together. The
  // `sort=true` arg lets CM6 sort by (from, startSide) for us, which is
  // necessary because line and mark decorations have different sides.
  const ranges: Range<Decoration>[] = [];

  const seenQuoteLines = new Set<number>();
  const seenFencedLines = new Set<number>();
  const seenCopyBlocks = new Set<number>();
  const seenHeadingLines = new Set<number>();
  const seenListLines = new Set<number>();
  const seenInlineHtmlLines = new Set<number>();
  const seenDefLines = new Set<number>();

  // Collect line numbers belonging to closed `$$...$$` / `\[...\]` math blocks
  // (skipping fenced code blocks) so we never emit overlapping Markdown
  // decorations (`EmphasisMark` on `_`, `Escape` on `\\`, `^...^` sup/sub)
  // inside a `MathWidget` block replacement.
  const mathBlockLines = new Set<number>();
  {
    const doc = view.state.doc;
    let maxVisLine = 0;
    for (const { to } of view.visibleRanges) {
      const ln = doc.lineAt(Math.min(to, doc.length)).number;
      if (ln > maxVisLine) maxVisLine = ln;
    }
    const scanLimit = Math.min(doc.lines, maxVisLine + 50);
    let inFence: string | null = null;
    for (let ln = 1; ln <= scanLimit; ln += 1) {
      const trimmed = doc.line(ln).text.trim();
      const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
      if (fenceMatch) {
        const ch = fenceMatch[1][0];
        if (!inFence) {
          inFence = ch;
        } else if (inFence === ch && new RegExp(`^${ch}{3,}\\s*$`).test(trimmed)) {
          inFence = null;
        }
        continue;
      }
      if (inFence) continue;
      if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
        const isBracket = trimmed.startsWith('\\[');
        const closeDelim = isBracket ? '\\]' : '$$';
        if (trimmed.endsWith(closeDelim) && trimmed.length > 4) {
          mathBlockLines.add(ln);
          continue;
        }
        let endLn = ln + 1;
        while (endLn <= doc.lines) {
          const nt = doc.line(endLn).text.trim();
          if (
            isBracket
              ? nt.startsWith('\\]') || nt.endsWith('\\]')
              : nt.startsWith('$$') || nt.endsWith('$$')
          ) {
            break;
          }
          endLn += 1;
        }
        if (endLn <= doc.lines) {
          for (let k = ln; k <= endLn; k += 1) mathBlockLines.add(k);
          ln = endLn;
        }
      }
    }
  }

  for (const { from, to } of view.visibleRanges) {
    const firstVisibleLine = view.state.doc.lineAt(from).number;
    const lastVisibleLine = view.state.doc.lineAt(
      Math.min(to, view.state.doc.length),
    ).number;
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const nFrom = node.from;
        const nTo = node.to;
        // Do not misparse leading YAML front-matter (`---\ninbox: true\n---`)
        // as a HorizontalRule (<hr>) on line 1 + a SetextHeading2 on the
        // closing `---` (which hid the opening `---` and left `inbox: true\n---`
        // exposed as an H2 heading).
        if (fmEnd > 0 && nFrom < fmEnd && name !== 'Document') {
          return false;
        }
        const lineAtNode = view.state.doc.lineAt(nFrom).number;
        const lineEndAtNode = view.state.doc.lineAt(
          Math.min(nTo, view.state.doc.length),
        ).number;
        if (
          name !== 'Document' &&
          name !== 'Paragraph' &&
          (mathBlockLines.has(lineAtNode) || mathBlockLines.has(lineEndAtNode))
        ) {
          return false;
        }
        const caretTouches = lineEndAtNode >= fromLine && lineAtNode <= toLine;
        const nodeLineText =
          lineAtNode === lineEndAtNode ? view.state.doc.line(lineAtNode).text : '';
        // #561 / #605 — Standalone image lines keep their Markdown source line
        // visible above the rendered ImageWidget by default, unless Pure WYSIWYG
        // (`hideActiveLineMarkers`) is enabled where all raw syntax stays hidden.
        const onStandaloneImage =
          !hideActiveLineMarkers &&
          nodeLineText !== '' &&
          isStandaloneImageLine(nodeLineText);

        // #506 / #605 — When `showMarkers` is off and the caret does not reveal
        // source (`!caretTouches`), `liveBlocksExtension` replaces the `Image`
        // range with an `ImageWidget`. Skip emitting overlapping `hideDeco`
        // replacements on child nodes inside that `Image`.
        if (name === 'Image' && !onStandaloneImage && !showMarkers && !caretTouches) {
          return false;
        }

        // ---- Marker hiding (off-line only) ----
        if (HIDDEN_MARK_NODES.has(name)) {
          // #530 / #605 — Keep ` ```mermaid ` visible on the opening fence line next
          // to the `+`/`−` fold toggle button unless Pure WYSIWYG is on.
          const isMermaidHeaderMark =
            !hideActiveLineMarkers &&
            (name === 'CodeMark' || name === 'CodeInfo') &&
            /^\s*(`{3,}|~{3,})\s*mermaid\s*$/i.test(
              view.state.doc.lineAt(nFrom).text,
            );
          if (showMarkers || isMermaidHeaderMark || onStandaloneImage) {
            // Dimmed, never removed — so the line looks the same whether or
            // not the caret is on it (#353 / #530 / #561).
            if (nTo > nFrom) ranges.push(markerMark.range(nFrom, nTo));
            return;
          }
          if (!caretTouches && nTo > nFrom) {
            // v4.3.5 #83 — for ATX heading marks (`#`, `##`, …) also hide
            // the single trailing space that separates the marker from
            // the heading text. Without this, the space character remains
            // and renders at the heading line's font-size, so H1 (1.85em
            // space) visibly indents further than H4 (1.1em space) etc.
            // Headings end up looking left-staggered instead of aligned.
            let hideTo = nTo;
            if (name === 'HeaderMark') {
              const line = view.state.doc.lineAt(nFrom);
              // Setext headings put `HeaderMark` on the underline (---/===)
              // line, with no following space to eat. Only widen for ATX.
              if (line.from === nFrom && nTo - nFrom <= 6) {
                const after = view.state.doc.sliceString(nTo, Math.min(nTo + 1, view.state.doc.length));
                if (after === ' ') hideTo = nTo + 1;
              }
            }
            ranges.push(hideDeco.range(nFrom, hideTo));
          }
          return;
        }

        // ---- URL: hide only when it's the destination part of a real
        //      `[label](url)` link. Bare GFM URLs (`https://x.com`) and
        //      autolinks (`<https://x.com>`) make the URL the visible link
        //      text, so they get `linkMark` (#431). ----
        if (name === 'URL') {
          const parent = node.node.parent;
          // GFM also emits a URL node for a URL-valued label (#395).
          // Only the URL immediately following `(` is the destination.
          const previous = node.node.prevSibling;
          const inLabeledLink =
            (parent?.name === 'Link' || parent?.name === 'Image') &&
            previous?.name === 'LinkMark' &&
            view.state.doc.sliceString(previous.from, previous.to) === '(';
          if (inLabeledLink) {
            if (!showMarkers && !onStandaloneImage && !caretTouches && nTo > nFrom) {
              ranges.push(hideDeco.range(nFrom, nTo));
            } else if (nTo > nFrom) {
              ranges.push(markerMark.range(nFrom, nTo));
            }
          } else if (nTo > nFrom) {
            ranges.push(linkMark.range(nFrom, nTo));
          }
          return;
        }

        // ---- Headings: line class for sizing + heading mark on text ----
        if (HEADING_LEVELS[name]) {
          const level = HEADING_LEVELS[name];
          const isSetext = name === 'SetextHeading1' || name === 'SetextHeading2';
          let lastContentLine = lineAtNode;
          if (isSetext) {
            let underlineLine = lineEndAtNode;
            for (let ch = node.node.firstChild; ch; ch = ch.nextSibling) {
              if (ch.name === 'HeaderMark') {
                underlineLine = view.state.doc.lineAt(ch.from).number;
                break;
              }
            }
            lastContentLine = Math.max(lineAtNode, underlineLine - 1);
          }
          for (
            let ln = Math.max(firstVisibleLine, lineAtNode);
            ln <= Math.min(lastVisibleLine, lastContentLine);
            ln += 1
          ) {
            const lineObj = view.state.doc.line(ln);
            if (!seenHeadingLines.has(lineObj.from)) {
              seenHeadingLines.add(lineObj.from);
              ranges.push(headingLine(level).range(lineObj.from));
            }
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
          const loopStart = Math.max(startLine, firstVisibleLine);
          const loopEnd = Math.min(endLine, lastVisibleLine);
          for (let ln = loopStart; ln <= loopEnd; ln++) {
            const lineObj = view.state.doc.line(ln);
            if (!seenQuoteLines.has(lineObj.from)) {
              seenQuoteLines.add(lineObj.from);
              ranges.push(quoteLine.range(lineObj.from));
              if (ln === startLine) ranges.push(blockFirstLine.range(lineObj.from));
              if (ln === endLine) ranges.push(blockLastLine.range(lineObj.from));
            }
          }
          return;
        }

        // ---- Fenced code block background + copy button ----
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const startLine = view.state.doc.lineAt(nFrom).number;
          const endLine = view.state.doc.lineAt(
            Math.min(nTo, view.state.doc.length),
          ).number;
          const isFenced = name === 'FencedCode';
          const firstLineObj = view.state.doc.line(startLine);
          if (
            !isFenced &&
            firstLineObj.text.includes('|') &&
            startLine + 1 <= endLine &&
            /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(
              view.state.doc.line(startLine + 1).text,
            )
          ) {
            return;
          }
          const fenceIndentCols = isFenced ? Math.max(0, nFrom - firstLineObj.from) : 0;
          let fencedMarginLeft = '';
          if (fenceIndentCols > 0) {
            let indentEm = Math.min(8, fenceIndentCols * 0.58);
            let cur = (node.node as unknown as MdSyntaxNode).parent;
            while (cur) {
              if (cur.name === 'ListItem') {
                for (let ch = cur.firstChild; ch; ch = ch.nextSibling) {
                  if (ch.name === 'ListMark') {
                    const markLine = view.state.doc.lineAt(ch.from);
                    const mark = view.state.doc.sliceString(ch.from, ch.to);
                    const isBullet = mark === '-' || mark === '*' || mark === '+';
                    const leadSpaces = ch.from - markLine.from;
                    const markLen = ch.to - ch.from;
                    let listDepth = 0;
                    for (let p = cur.parent; p; p = p.parent) {
                      if (p.name === 'BulletList' || p.name === 'OrderedList') listDepth++;
                    }
                    const depth = Math.max(0, listDepth - 1);
                    const baseIndentEm = 0.75;
                    const markEm = isBullet
                      ? 0.95
                      : markLen <= 2
                        ? 1.15
                        : markLen === 3
                          ? 1.65
                          : Math.min(6, markLen * 0.55 + 0.15);
                    const leadEm =
                      leadSpaces > 0
                        ? Math.min(10, Math.max(depth * 1.4, leadSpaces * 0.55))
                        : 0;
                    indentEm = baseIndentEm + Math.min(12, leadEm + markEm);
                    break;
                  }
                }
                break;
              }
              cur = cur.parent;
            }
            // `.cm-md-fenced-line` sets `font-size: 0.8125em`, so scale `em`
            // by `1 / 0.8125` to match the list item's parent-font `em` indent.
            fencedMarginLeft = `${(indentEm / 0.8125).toFixed(2)}em`;
          }
          const bodyStart = isFenced ? startLine + 1 : startLine;
          const hasClosingFence =
            isFenced &&
            endLine > startLine &&
            /^\s*(`{3,}|~{3,})\s*$/.test(view.state.doc.line(endLine).text);
          const bodyEnd = hasClosingFence ? endLine - 1 : endLine;
          const loopStart = Math.max(startLine, firstVisibleLine);
          const loopEnd = Math.min(endLine, lastVisibleLine);
          for (let ln = loopStart; ln <= loopEnd; ln++) {
            const lineObj = view.state.doc.line(ln);
            if (!seenFencedLines.has(lineObj.from)) {
              seenFencedLines.add(lineObj.from);
              const leadingSpaces = /^[ ]*/.exec(lineObj.text)?.[0].length ?? 0;
              const stripCols = !showMarkers && fenceIndentCols > 0
                ? Math.min(fenceIndentCols, leadingSpaces)
                : 0;
              const styleParts: string[] = [];
              if (fencedMarginLeft) styleParts.push(`margin-left: ${fencedMarginLeft};`);
              if (stripCols > 0) styleParts.push(`text-indent: -${stripCols}ch;`);
              const styleAttr = styleParts.length > 0 ? styleParts.join(' ') : undefined;
              if (ln >= bodyStart && ln <= bodyEnd) {
                const attrs: Record<string, string> = {
                  'data-cb-line': String(ln - bodyStart + 1),
                };
                if (styleAttr) attrs.style = styleAttr;
                ranges.push(
                  Decoration.line({
                    class: 'cm-md-fenced-line cm-md-fenced-body-line',
                    attributes: attrs,
                  }).range(lineObj.from),
                );
              } else if (styleAttr) {
                ranges.push(
                  Decoration.line({
                    class: 'cm-md-fenced-line',
                    attributes: { style: styleAttr },
                  }).range(lineObj.from),
                );
              } else {
                ranges.push(fencedLine.range(lineObj.from));
              }
              if (ln === startLine) ranges.push(blockFirstLine.range(lineObj.from));
              if (ln === endLine) ranges.push(blockLastLine.range(lineObj.from));
            }
          }
          // v4.11.18 — the copy button rides the block's first line and is
          // positioned into its top-right corner by CSS. Only emit it when
          // that line is inside the range we're building decorations for
          // (ViewPlugin decorations must stay within the viewport), and only
          // once per block when a block straddles two visible ranges.
          const firstLine = view.state.doc.line(startLine);
          if (
            firstLine.from >= from
            && firstLine.from <= to
            && !seenCopyBlocks.has(firstLine.from)
          ) {
            seenCopyBlocks.add(firstLine.from);
            let hasNonEmptyBody = false;
            for (let probe = bodyStart; probe <= bodyEnd; probe += 1) {
              if (view.state.doc.line(probe).text.trim().length > 0) {
                hasNonEmptyBody = true;
                break;
              }
            }
            if (hasNonEmptyBody) {
              ranges.push(
                Decoration.widget({
                  widget: new CodeCopyWidget(
                    view.state.doc,
                    isFenced,
                    startLine,
                    endLine,
                  ),
                  side: -1,
                }).range(firstLine.from),
              );
            }
          }
          return;
        }

        // ---- List markers (v4.7.1) + hanging indent (#469) ----
        // Bullets (`-`/`*`/`+`) become a • glyph; ordered numbers stay; a
        // task item's dash is hidden so the checkbox widget leads. Revealed
        // (raw) on the caret line so the marker stays editable.
        // #469: apply a matched `padding-left: X; text-indent: -X` line
        // decoration so soft-wrapped continuation lines hang aligned with the
        // list item body instead of wrapping back under the number/bullet.
        if (name === 'ListMark') {
          const lineObj = view.state.doc.lineAt(nFrom);
          const mark = view.state.doc.sliceString(nFrom, nTo);
          const isBullet = mark === '-' || mark === '*' || mark === '+';
          const isTask = isBullet && listItemHasTask(node.node as unknown as MdSyntaxNode);
          const after = view.state.doc.sliceString(
            nTo,
            Math.min(nTo + 1, view.state.doc.length),
          );
          const prefixTo = after === ' ' ? nTo + 1 : nTo;
          if (!seenListLines.has(lineObj.from)) {
            seenListLines.add(lineObj.from);
            // #678 — When a list item lives inside a blockquote (`> - item`),
            // exclude the leading `> ` quote prefix from `leadSpaces` and add
            // `.cm-md-quote-line`'s 16px left padding so blockquote list markers
            // align with plain blockquote text instead of clobbering padding.
            const quotePrefixMatch = /^(?:[ \t]*>[ \t]?)+/.exec(lineObj.text);
            const inQuote = !!quotePrefixMatch;
            const quotePrefixLen = quotePrefixMatch ? quotePrefixMatch[0].length : 0;
            const leadSpaces = Math.max(0, nFrom - (lineObj.from + quotePrefixLen));
            const markLen = nTo - nFrom;
            // #640 — Compute list nesting depth from ancestor list nodes so:
            //  1. Each nesting level gets a clear ~4-space visual indent (`1.4em`)
            //  2. Bullet markers cycle `•` → `◦` → `▪` across levels
            //  3. Leading indent is placed strictly BEFORE the marker so the gap
            //     between marker and item text is identical at every level.
            let listDepth = 0;
            for (let p = node.node.parent; p; p = p.parent) {
              if (p.name === 'BulletList' || p.name === 'OrderedList') listDepth++;
            }
            const depth = Math.max(0, listDepth - 1);
            // #486 / #617 — Keep list markers tight and natural next to body text
            // while still preserving hanging-indent alignment across wrapped lines:
            // bullets `• ` take 0.95em, 1-digit `1.`..`9.` take 1.15em, 2-digit
            // `10.`..`99.` take 1.65em, and 3+ digits scale smoothly.
            const markEm = isBullet
              ? 0.95
              : markLen <= 2
                ? 1.15
                : markLen === 3
                  ? 1.65
                  : Math.min(6, markLen * 0.55 + 0.15);
            const leadEm =
              leadSpaces > 0
                ? Math.min(10, Math.max(depth * 1.4, leadSpaces * 0.55))
                : 0;
            // Give top-level list lines a base left indentation (`0.75em`) so bullets
            // and ordered markers sit indented relative to headings/paragraphs (matching
            // Preview/Split mode) while preserving hanging-indent alignment on wrapped lines.
            // Inside a blockquote, start flush with the blockquote's 16px text edge.
            const baseIndentEm = inQuote ? 0 : 0.75;
            const indentEm = Math.min(12, leadEm + markEm);
            const padLeftStr = inQuote
              ? `calc(16px + ${indentEm.toFixed(2)}em)`
              : `${(baseIndentEm + indentEm).toFixed(2)}em`;
            const textIndentStr = `-${indentEm.toFixed(2)}em`;
            ranges.push(
              Decoration.line({
                class: 'cm-md-list-line',
                attributes: {
                  style: `padding-left: ${padLeftStr}; text-indent: ${textIndentStr};`,
                },
              }).range(lineObj.from),
            );
            // #486 / #640 — Give leading spaces/tabs their own fixed-width inline-block
            // (`leadEm`) and the marker + trailing space its own fixed-width
            // inline-block (`markEm`) so proportional-font spaces never inflate
            // the gap AFTER the marker on nested levels.
            const leadLimit = lineObj.from + quotePrefixLen;
            let leadFrom = nFrom;
            while (leadFrom > leadLimit) {
              const ch = view.state.doc.sliceString(leadFrom - 1, leadFrom);
              if (ch === ' ' || ch === '\t') leadFrom--;
              else break;
            }
            const spanLeadEm =
              leadFrom === leadLimit
                ? leadEm
                : nFrom > leadFrom
                  ? Math.min(10, Math.max(depth * 1.4, (nFrom - leadFrom) * 0.55))
                  : 0;
            if (nFrom > leadFrom && spanLeadEm > 0) {
              ranges.push(
                Decoration.mark({
                  class: 'cm-md-list-indent',
                  attributes: {
                    style: `display: inline-block; min-width: ${spanLeadEm.toFixed(2)}em; text-indent: 0; white-space: pre;`,
                  },
                }).range(leadFrom, nFrom),
              );
            }
            if (!isTask && (after === ' ' || after === '\t')) {
              if (!showMarkers && !caretTouches && isBullet && nTo > nFrom) {
                ranges.push(
                  Decoration.replace({
                    widget: new BulletWidget(markEm, depth),
                  }).range(nFrom, prefixTo),
                );
                return;
              }
              ranges.push(
                Decoration.mark({
                  class: 'cm-md-list-prefix',
                  attributes: {
                    style: `display: inline-block; width: ${markEm.toFixed(2)}em; text-indent: 0; white-space: pre; font-variant-numeric: tabular-nums;`,
                  },
                }).range(nFrom, prefixTo),
              );
            }
          }
          if (showMarkers || caretTouches || nTo <= nFrom) return;
          if (!isBullet) return; // ordered list ("1.", "2)") keeps its number
          if (isTask) {
            // Hide "- " (dash + trailing space) — the checkbox renders the item.
            ranges.push(hideDeco.range(nFrom, prefixTo));
          } else {
            let listDepth = 0;
            for (let p = node.node.parent; p; p = p.parent) {
              if (p.name === 'BulletList' || p.name === 'OrderedList') listDepth++;
            }
            const depth = Math.max(0, listDepth - 1);
            ranges.push(
              depth > 0
                ? Decoration.replace({ widget: new BulletWidget(0, depth) }).range(nFrom, nTo)
                : bulletDeco.range(nFrom, nTo),
            );
          }
          return;
        }

        // ---- Horizontal rule (v4.7.1): `---` / `***` / `___` → <hr> ----
        if (name === 'HorizontalRule') {
          if (showMarkers || caretTouches || nTo <= nFrom) return;
          ranges.push(hrDeco.range(nFrom, nTo));
          return;
        }

        // ---- Backslash escapes (`\#`, `\*`, `\[`, etc.) ----
        if (name === 'Escape' && nTo - nFrom >= 2) {
          if (showMarkers || caretTouches) {
            ranges.push(markerMark.range(nFrom, nFrom + 1));
          } else {
            ranges.push(hideDeco.range(nFrom, nFrom + 1));
          }
          return;
        }
      },
    });

    // Paired inline HTML is valid Markdown, but CodeMirror's live editor used
    // to leave tags such as `<strong>` and `<sup>` visible; ditto the
    // markdown-it-mark `==highlight==` the preview renders (#199). Hide the
    // paired markers and style their contents while the caret is off the
    // line. Moving the caret onto the line reveals the exact source for
    // editing. Fenced-code lines and inline-code spans are skipped — they
    // must show their source verbatim.
    for (let lineNo = firstVisibleLine; lineNo <= lastVisibleLine; lineNo += 1) {
      if (seenInlineHtmlLines.has(lineNo)) continue;
      seenInlineHtmlLines.add(lineNo);
      if (mathBlockLines.has(lineNo)) continue;
      if (!showMarkers && lineNo >= fromLine && lineNo <= toLine) continue;
      const line = view.state.doc.line(lineNo);
      if (seenFencedLines.has(line.from)) continue;
      const rawText = line.text;
      const hasAngle = rawText.includes('<');
      const hasMarkEq = rawText.includes('==');
      const hasSupSub = rawText.includes('^') || rawText.includes('~');
      if (!hasAngle && !hasMarkEq && !hasSupSub) continue;
      const base = line.from;
      const scanText = rawText.includes('`') ? maskInlineCode(rawText) : rawText;
      const tagDeco = showMarkers ? markerMark : hideDeco;
      if (hasAngle) {
        for (const span of findInlineHtmlSpans(scanText)) {
          ranges.push(tagDeco.range(base + span.openFrom, base + span.openTo));
          if (span.contentTo > span.contentFrom) {
            ranges.push(
              inlineHtmlMark(span.kind, span.bgColor, span.textColor).range(
                base + span.contentFrom,
                base + span.contentTo,
              ),
            );
          }
          ranges.push(tagDeco.range(base + span.closeFrom, base + span.closeTo));
        }
      }
      if (hasMarkEq) {
        for (const span of findMarkSpans(scanText)) {
          ranges.push(tagDeco.range(base + span.openFrom, base + span.openTo));
          ranges.push(
            htmlMarkMark.range(base + span.contentFrom, base + span.contentTo),
          );
          ranges.push(tagDeco.range(base + span.closeFrom, base + span.closeTo));
        }
      }
      if (hasSupSub) {
        for (const span of findSupSubSpans(scanText)) {
          ranges.push(tagDeco.range(base + span.openFrom, base + span.openTo));
          if (span.contentTo > span.contentFrom) {
            ranges.push(
              inlineHtmlMark(span.kind, span.bgColor, span.textColor).range(
                base + span.contentFrom,
                base + span.contentTo,
              ),
            );
          }
          ranges.push(tagDeco.range(base + span.closeFrom, base + span.closeTo));
        }
      }
    }

    // #285 — Definition list (`Term\n: Definition`) styling in Live Edit mode.
    for (let lineNo = firstVisibleLine; lineNo <= lastVisibleLine; lineNo += 1) {
      if (seenDefLines.has(lineNo)) continue;
      if (mathBlockLines.has(lineNo)) continue;
      const line = view.state.doc.line(lineNo);
      if (seenFencedLines.has(line.from)) continue;
      const ddMatch = line.text.match(/^[ ]{0,3}([:~])([ \t]+)(.+)$/);
      if (!ddMatch) continue;
      // Check if preceded by a non-empty term line or another `: def` line
      let prevNo = lineNo - 1;
      if (prevNo >= 1 && view.state.doc.line(prevNo).text.trim() === '') {
        prevNo -= 1;
      }
      if (prevNo < 1) continue;
      const prevLine = view.state.doc.line(prevNo);
      if (seenFencedLines.has(prevLine.from) || prevLine.text.trim() === '') continue;
      const prevIsDd = /^[ ]{0,3}[:~][ \t]+/.test(prevLine.text);
      const prevIsTerm =
        !prevIsDd &&
        !/^\s*(?:#{1,6}[ \t]|`{3,}|~{3,}|>|[-*+][ \t]|\d+[.)][ \t]|\||<(?:!--|[a-zA-Z/]))/.test(
          prevLine.text,
        );
      if (!prevIsDd && !prevIsTerm) continue;
      if (prevIsTerm && !seenDefLines.has(prevNo)) {
        seenDefLines.add(prevNo);
        ranges.push(
          Decoration.line({ class: 'cm-md-dt-line' }).range(prevLine.from),
        );
      }
      seenDefLines.add(lineNo);
      ranges.push(Decoration.line({ class: 'cm-md-dd-line' }).range(line.from));
      const caretOnLine = lineNo >= fromLine && lineNo <= toLine;
      const colonStart = line.from + line.text.indexOf(ddMatch[1]);
      const colonEnd = colonStart + ddMatch[1].length + ddMatch[2].length;
      if (!showMarkers && !caretOnLine) {
        ranges.push(hideDeco.range(line.from, colonEnd));
      } else {
        ranges.push(markerMark.range(colonStart, colonStart + 1));
      }
    }
  }

  // sort = true so CM6 handles (from, side) ordering regardless of the
  // mixed line/mark/replace decorations we collected.
  return Decoration.set(ranges, true);
}

const makeLiveRenderPlugin = (showMarkers: boolean, hideActiveLineMarkers = false) => ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, showMarkers, hideActiveLineMarkers);
    }

    update(u: ViewUpdate) {
      // IME composition guard (#108) — don't rebuild decorations on the
      // composing line while a Windows IME (Sogou) candidate window is open,
      // or the mid-composition DOM swap drops the composition ("吃字").
      const frozen = frozenDuringComposition(u, this.decorations);
      if (frozen) {
        this.decorations = frozen;
        return;
      }
      // See cm-drag-aware.ts — freeze marker toggles during pointer drag
      // so Windows WebView2 doesn't lose pointer capture mid-selection.
      const dragEnded = u.transactions.some(isDragEndTransaction);
      const imeFlush = u.transactions.some(isImeSafeFlushTransaction);
      const treeChanged = syntaxTree(u.state) !== syntaxTree(u.startState);
      if (u.docChanged || u.viewportChanged || dragEnded || imeFlush || treeChanged) {
        this.decorations = buildDecorations(u.view, showMarkers, hideActiveLineMarkers);
        return;
      }
      // With markers always shown nothing depends on the caret, so a
      // selection move keeps the exact same decorations — no rebuild, no jump.
      // Same when `hideActiveLineMarkers` (#303) is enabled and the caret moves
      // between collapsed positions.
      if (!showMarkers && u.selectionSet && !isDragging(u.state)) {
        if (hideActiveLineMarkers) {
          return;
        }
        const prevSel = u.startState.selection.main;
        const nextSel = u.state.selection.main;
        const prevFromLine = u.startState.doc.lineAt(prevSel.from).number;
        const prevToLine = u.startState.doc.lineAt(prevSel.to).number;
        const nextFromLine = u.state.doc.lineAt(nextSel.from).number;
        const nextToLine = u.state.doc.lineAt(nextSel.to).number;
        // Skip full-viewport decoration rebuild when cursor moves within the same line.
        if (prevFromLine === nextFromLine && prevToLine === nextToLine && prevSel.empty === nextSel.empty) {
          return;
        }
        this.decorations = buildDecorations(u.view, showMarkers, hideActiveLineMarkers);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// Rich syntax highlighting — same palette as cm-live-preview.ts but kept
// here so live-edit can be used independently of the live-preview toggle.
const liveEditHighlightStyle = HighlightStyle.define([
  // 5.0 / #588 / #589 — gradual heading scale & 6 distinct heading colours.
  { tag: t.heading1, fontWeight: '700', color: 'var(--md-h1)' },
  { tag: t.heading2, fontWeight: '650', color: 'var(--md-h2)' },
  { tag: t.heading3, fontWeight: '620', color: 'var(--md-h3)' },
  { tag: t.heading4, fontWeight: '600', color: 'var(--md-h4)' },
  { tag: t.heading5, fontWeight: '600', color: 'var(--md-h5)' },
  { tag: t.heading6, fontWeight: '600', color: 'var(--md-h6)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--md-strong)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--md-em)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: t.link, color: 'var(--accent-text)' },
  { tag: t.url, color: 'var(--accent-text)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--text)' },
  { tag: t.quote, color: 'var(--md-quote, var(--text-2))' },
  { tag: t.contentSeparator, color: 'var(--text-3)' },
  { tag: t.processingInstruction, color: 'var(--text-3)' },
  // Code-block syntax (nested Lezer languages)
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: 'var(--syn-string)' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.definition(t.variableName), t.constant(t.variableName), t.variableName], color: 'var(--syn-variable)' },
  { tag: [t.typeName, t.className, t.namespace, t.labelName], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--syn-property)' },
  { tag: t.operator, color: 'var(--syn-operator)' },
  { tag: t.punctuation, color: 'var(--text-muted)' },
  { tag: t.bracket, color: 'var(--text-muted)' },
  { tag: t.tagName, color: 'var(--syn-keyword)' },
  { tag: t.attributeName, color: 'var(--syn-property)' },
  { tag: t.attributeValue, color: 'var(--syn-string)' },
]);

const liveEditTheme = EditorView.theme({
  '.cm-line': {
    fontVariantLigatures: 'none',
  },
  // #353 — markers left visible by "Always show Markdown markers": keep the
  // line's size/weight (so nothing reflows) but mute the colour.
  '.cm-md-marker': {
    color: 'var(--text-faint)',
    fontWeight: 'normal',
    fontStyle: 'normal',
  },
  // Heading lines — use line-decoration to size whole line so layout
  // doesn't jump when markers are revealed/hidden.
  // Note: do NOT set a custom lineHeight here (keeps CodeMirror's posAtCoords accurate).
  '.cm-md-heading-line-1': {
    fontSize: '1.85em',
    fontWeight: '700',
    letterSpacing: '-0.015em',
    paddingTop: '0.2em',
    paddingBottom: '0.1em',
    color: 'var(--md-h1)',
  },
  '.cm-md-heading-line-2': {
    fontSize: '1.52em',
    fontWeight: '650',
    paddingTop: '0.28em',
    color: 'var(--md-h2)',
  },
  '.cm-md-heading-line-3': {
    fontSize: '1.30em',
    fontWeight: '620',
    paddingTop: '0.22em',
    color: 'var(--md-h3)',
  },
  '.cm-md-heading-line-4': {
    fontSize: '1.15em',
    fontWeight: '600',
    paddingTop: '0.16em',
    color: 'var(--md-h4)',
  },
  '.cm-md-heading-line-5': {
    fontSize: '1.04em',
    fontWeight: '600',
    color: 'var(--md-h5)',
  },
  '.cm-md-heading-line-6': {
    fontSize: '0.95em',
    fontWeight: '600',
    color: 'var(--md-h6)',
  },

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
  '.cm-md-html-u': { textDecoration: 'underline' },
  '.cm-md-html-mark': {
    backgroundColor: 'var(--mark-bg, rgba(255, 212, 0, 0.52))',
    padding: '0 0.14em',
    borderRadius: '2px',
  },
  '.cm-md-html-sub': { fontSize: '0.75em', verticalAlign: 'sub' },
  '.cm-md-html-sup': { fontSize: '0.75em', verticalAlign: 'super' },
  '.cm-md-html-kbd': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.82em',
    backgroundColor: 'var(--md-code-bg)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '0.05em 0.3em',
  },

  // 5.0 §5 — inline code: --fill-1 chip, body colour (not red).
  '.cm-md-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    color: 'var(--text)',
    backgroundColor: 'var(--fill-1)',
    padding: '0.12em 0.35em',
    borderRadius: 'var(--r-xs)',
  },

  '.cm-md-link': {
    color: 'var(--accent-text)',
    textDecoration: 'underline',
    textDecorationColor: 'color-mix(in srgb, var(--accent-text) 35%, transparent)',
    textUnderlineOffset: '3px',
    cursor: 'pointer',
  },

  // v4.7.1 — bullet glyph that replaces a `-`/`*`/`+` list marker off-line.
  '.cm-md-bullet': {
    color: 'var(--text-3)',
    fontWeight: '700',
  },
  '.cm-md-list-prefix': {
    whiteSpace: 'pre',
  },

  // v4.7.1 — `---` / `***` / `___` rendered as a real rule off-line. The
  // widget replaces the whole marker run, so make it span the text column.
  '.cm-md-hr': {
    display: 'inline-block',
    width: '100%',
    height: '0',
    margin: '0.2em 0',
    border: 'none',
    borderTop: '1px solid var(--hairline)',
    verticalAlign: 'middle',
  },

  // #588 — quote: distinct `--md-quote-bg` card + left accent bar so quotes and
  // fenced code blocks (`--md-code-bg`) are visually unmistakable.
  '.cm-md-quote-line': {
    padding: '0 16px',
    color: 'var(--md-quote, var(--text-2))',
    backgroundColor: 'var(--md-quote-bg, var(--bg-elev))',
    borderLeft: '3px solid var(--md-quote-border, var(--accent))',
  },
  // #285 — Definition list (`Term\n: Definition`) styling in Live Edit mode.
  '.cm-md-dt-line': {
    fontWeight: '600',
    color: 'var(--text)',
  },
  '.cm-md-dd-line': {
    paddingLeft: '1.65em',
    boxShadow: 'inset 2px 0 0 0 var(--border)',
    color: 'var(--text-2)',
  },

  // #588 — code block: `--md-code-bg` card, 10px corners, 13px mono.
  '.cm-md-fenced-line': {
    padding: '0 16px',
    backgroundColor: 'var(--md-code-bg, var(--bg-elev))',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.8125em',
    // Containing block for the copy button that rides the block's first line.
    position: 'relative',
  },
  '.cm-md-block-first': {
    paddingTop: '10px',
    borderTopLeftRadius: 'var(--r-lg)',
    borderTopRightRadius: 'var(--r-lg)',
  },
  '.cm-md-block-last': {
    paddingBottom: '10px',
    borderBottomLeftRadius: 'var(--r-lg)',
    borderBottomRightRadius: 'var(--r-lg)',
  },
  '.cm-md-quote-line.cm-md-block-first': {
    borderTopLeftRadius: '4px',
  },
  '.cm-md-quote-line.cm-md-block-last': {
    borderBottomLeftRadius: '4px',
  },
  // A code block's first and last lines are its (hidden) fences, which are
  // already a line of air each — the card needs no extra inset there.
  '.cm-md-fenced-line.cm-md-block-first': { paddingTop: '2px' },
  '.cm-md-fenced-line.cm-md-block-last': { paddingBottom: '2px' },
  // #454 — code block line numbers in CodeMirror Live-Edit mode when enabled.
  '.cb-numbered-on & .cm-md-fenced-line.cm-md-fenced-body-line': {
    paddingLeft: '3.6em',
  },
  '.cb-numbered-on & .cm-md-fenced-line.cm-md-fenced-body-line::before': {
    content: 'attr(data-cb-line)',
    position: 'absolute',
    left: '0',
    width: '2.6em',
    paddingRight: '0.6em',
    textAlign: 'right',
    color: 'var(--text-faint)',
    borderRight: '1px solid var(--border)',
    userSelect: 'none',
    pointerEvents: 'none',
  },

  // v4.11.18 — code-block copy button. Same visual language as the preview
  // pane's `.code-copy-button` (styles/main.css), sized down a notch so it
  // fits inside a single editor line.
  '.cm-md-code-copy': {
    position: 'absolute',
    zIndex: '3',
    top: '6px',
    right: '8px',
    minWidth: '42px',
    height: '20px',
    padding: '0 8px',
    border: '1px solid var(--border)',
    borderRadius: '5px',
    background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
    color: 'var(--text-muted)',
    font: '11px/18px var(--font-ui)',
    cursor: 'pointer',
    opacity: '0.55',
    userSelect: 'none',
    transition: 'opacity 0.15s, color 0.15s, border-color 0.15s',
  },
  '.cm-md-code-copy:hover, .cm-md-code-copy:focus-visible': {
    opacity: '1',
    color: 'var(--accent)',
    borderColor: 'var(--accent)',
    outline: 'none',
  },

  // #82 / #44 — selection highlight inside code was invisible in live-edit.
  // Inline `.cm-md-code` and `.cm-md-fenced-line` paint an opaque
  // `--md-code-bg`, and CM6's `layer` extension writes inline
  // `style="z-index: -2"` on `.cm-selectionLayer`, parking the selection
  // BENEATH those backgrounds. `!important` beats the inline style so the
  // selection layer sits above the code bg; 45% alpha keeps the code text
  // readable through the highlight. (The same fix already lives in
  // cm-live-preview.ts — the earlier patches only covered that mode, not
  // this one, which is the WYSIWYG "live edit" the reporters actually use.)
  // #368 — raised above the text, the selection rectangles would intercept
  // clicks inside the selection (CodeMirror never sees the mousedown, so a
  // click can't collapse it — fatal after Select All). Keep it click-through.
  '.cm-selectionLayer': { zIndex: '2 !important', pointerEvents: 'none' },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft) !important',
  },
});

/**
 * Bundle for the v2.3 "live edit" view mode. Wire into Editor.vue as the
 * rich-extensions value when `viewMode === 'liveEdit'` and the tab is
 * markdown.
 *
 * v3.6 (issue #44): pass the optional `blocks` extensions in to add
 * image / table live-render widgets (cm-live-blocks). The caller is
 * responsible for building those with workspace + file-path context;
 * we just splice them into the bundle so they live in the same
 * compartment as the rest of the live-edit machinery.
 */
const liveRenderPlugin = makeLiveRenderPlugin(false, false);
const liveRenderPluginHideActive = makeLiveRenderPlugin(false, true);
const liveRenderPluginShowMarkers = makeLiveRenderPlugin(true, false);

export function liveEditExtension(
  blocks: any[] = [],
  opts: { showMarkers?: boolean; hideActiveLineMarkers?: boolean } = {},
) {
  return [
    syntaxHighlighting(liveEditHighlightStyle),
    hljsFallbackExtension(),
    opts.showMarkers
      ? liveRenderPluginShowMarkers
      : opts.hideActiveLineMarkers
        ? liveRenderPluginHideActive
        : liveRenderPlugin,
    liveEditTheme,
    ...blocks,
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
  'cm-md-html-u',
  'cm-md-html-mark',
  'cm-md-html-sub',
  'cm-md-html-sup',
  'cm-md-html-kbd',
  'cm-md-code',
  'cm-md-link',
  'cm-md-quote-line',
  'cm-md-fenced-line',
  'cm-md-block-first',
  'cm-md-block-last',
  'cm-md-code-copy',
  'cm-md-bullet',
  'cm-md-hr',
  'cm-md-marker',
] as const;

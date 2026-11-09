/**
 * Small HTML recognizers shared by the two live-edit renderers.
 *
 * The full preview delegates HTML parsing to markdown-it/the browser. Live
 * edit cannot do that for the whole document because CodeMirror must retain
 * editable source positions, so it only recognizes safe-to-collapse block
 * containers and paired, single-line formatting tags.
 */

export const LIVE_HTML_BLOCK_TAGS = [
  'table',
  'div',
  'details',
  'figure',
  'iframe',
  'blockquote',
  'pre',
  'section',
  'article',
  'aside',
] as const;

const BLOCK_START_RE = new RegExp(
  `^\\s*<(${LIVE_HTML_BLOCK_TAGS.join('|')})\\b[^>]*>`,
  'i',
);

/**
 * Return the zero-based line containing the matching close tag for a raw HTML
 * block, or null when `startIndex` is not a supported/complete block. Nested
 * containers of the same tag are counted.
 */
export function findHtmlBlockEnd(
  lines: readonly string[],
  startIndex: number,
): number | null {
  const first = lines[startIndex];
  if (first == null) return null;
  const start = BLOCK_START_RE.exec(first);
  if (!start) return null;

  const tag = start[1].toLowerCase();
  const tokenRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  let depth = 0;
  for (let i = startIndex; i < lines.length; i += 1) {
    tokenRe.lastIndex = 0;
    for (const match of lines[i].matchAll(tokenRe)) {
      const token = match[0];
      if (/^<\//.test(token)) depth -= 1;
      else if (!/\/\s*>$/.test(token)) depth += 1;
    }
    if (depth === 0) return i;
  }
  return null;
}

/**
 * Replace inline-code spans with spaces (indices preserved) so the inline
 * scanners never match tags/marks inside `` `code` ``.
 */
export function maskInlineCode(line: string): string {
  return line.replace(/`+[^`]*`+/g, (m) => ' '.repeat(m.length));
}

export interface LiveMarkSpan {
  openFrom: number;
  openTo: number;
  contentFrom: number;
  contentTo: number;
  closeFrom: number;
  closeTo: number;
}

// markdown-it-mark's `==highlight==`: content must not start/end with
// whitespace or `=`. The preview has always rendered it via the plugin; live
// edit hides the markers and styles the span the same way (#199).
const MARK_SPAN_RE = /==([^\s=](?:[^=\n]*?[^\s=])?)==(?!=)/g;

/** Find `==highlight==` spans that begin and end on one line. */
export function findMarkSpans(line: string): LiveMarkSpan[] {
  const spans: LiveMarkSpan[] = [];
  MARK_SPAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARK_SPAN_RE.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    spans.push({
      openFrom: start,
      openTo: start + 2,
      contentFrom: start + 2,
      contentTo: end - 2,
      closeFrom: end - 2,
      closeTo: end,
    });
  }
  return spans;
}

export type LiveInlineHtmlKind =
  | 'strong'
  | 'em'
  | 'underline'
  | 'strike'
  | 'mark'
  | 'sub'
  | 'sup'
  | 'code'
  | 'kbd';

export interface LiveInlineHtmlSpan {
  kind: LiveInlineHtmlKind;
  openFrom: number;
  openTo: number;
  contentFrom: number;
  contentTo: number;
  closeFrom: number;
  closeTo: number;
}

const INLINE_TAG_KIND: Record<string, LiveInlineHtmlKind> = {
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  u: 'underline',
  s: 'strike',
  del: 'strike',
  mark: 'mark',
  sub: 'sub',
  sup: 'sup',
  code: 'code',
  kbd: 'kbd',
};

const INLINE_PAIR_RE =
  /<(strong|b|em|i|u|s|del|mark|sub|sup|code|kbd)\b[^>]*>(.*?)<\/\1\s*>/gi;

/** Find paired inline HTML formatting tags that begin and end on one line. */
export function findInlineHtmlSpans(line: string): LiveInlineHtmlSpan[] {
  const spans: LiveInlineHtmlSpan[] = [];
  INLINE_PAIR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_PAIR_RE.exec(line)) !== null) {
    const whole = match[0];
    const openToInMatch = whole.indexOf('>') + 1;
    const closeFromInMatch = whole.toLowerCase().lastIndexOf('</');
    const openFrom = match.index;
    const openTo = openFrom + openToInMatch;
    const closeFrom = openFrom + closeFromInMatch;
    spans.push({
      kind: INLINE_TAG_KIND[match[1].toLowerCase()],
      openFrom,
      openTo,
      contentFrom: openTo,
      contentTo: closeFrom,
      closeFrom,
      closeTo: openFrom + whole.length,
    });
  }
  return spans;
}

export interface OutlineSegment {
  text: string;
  mark: boolean;
}

/**
 * Split an outline heading into plain and highlighted (`==...==` or
 * `<mark>...</mark>`) segments while keeping inline-code spans untouched.
 */
export function parseOutlineSegments(text: string): OutlineSegment[] {
  if (!text) return [];
  const masked = maskInlineCode(text);
  const spans: Array<{ openFrom: number; contentFrom: number; contentTo: number; closeTo: number }> = [
    ...findMarkSpans(masked),
    ...findInlineHtmlSpans(masked).filter((s) => s.kind === 'mark'),
  ].sort((a, b) => a.openFrom - b.openFrom);

  if (spans.length === 0) {
    return [{ text, mark: false }];
  }

  const out: OutlineSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.openFrom < cursor) continue;
    if (span.openFrom > cursor) {
      out.push({ text: text.slice(cursor, span.openFrom), mark: false });
    }
    const inner = text.slice(span.contentFrom, span.contentTo);
    if (inner) {
      out.push({ text: inner, mark: true });
    }
    cursor = span.closeTo;
  }
  if (cursor < text.length) {
    out.push({ text: text.slice(cursor), mark: false });
  }
  return out;
}

/** Plain-text label for outline tooltips (`==高亮==` / `<mark>高亮</mark>` → `高亮`). */
export function stripOutlineFormatting(text: string): string {
  return parseOutlineSegments(text)
    .map((s) => s.text)
    .join('');
}


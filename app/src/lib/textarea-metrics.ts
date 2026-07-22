/**
 * textarea-metrics.ts — visual-line measurement for the Windows plain
 * <textarea> editor path (no CodeMirror there, so no coordsAtPos()).
 *
 * A hidden "mirror" <div> is given the textarea's exact text metrics
 * (font, line-height, tab-size, white-space, wrap mode, content width), so
 * text laid out in it wraps identically to the textarea. That gives us:
 *
 *  - per-logical-line rendered heights → the line-number gutter (#161)
 *  - which *visual* row the caret sits on → block-boundary arrow-key
 *    navigation that doesn't jump over soft-wrapped rows (#155)
 */

const MIRROR_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'tabSize',
  'textTransform',
  'wordSpacing',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
] as const;

function createMirror(el: HTMLTextAreaElement): HTMLDivElement {
  const mirror = document.createElement('div');
  const cs = getComputedStyle(el);
  for (const prop of MIRROR_PROPS) {
    (mirror.style as unknown as Record<string, string>)[prop] = cs[prop as keyof CSSStyleDeclaration] as string;
  }
  // Content-box width: the textarea's wrap width. (clientWidth excludes
  // borders but includes padding; subtract the horizontal padding.)
  const width =
    el.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
  mirror.style.width = `${Math.max(width, 1)}px`;
  mirror.style.position = 'absolute';
  mirror.style.top = '-99999px';
  mirror.style.left = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.boxSizing = 'content-box';
  mirror.style.padding = '0';
  mirror.style.border = '0';
  document.body.appendChild(mirror);
  return mirror;
}

function lineHeightPx(el: HTMLTextAreaElement): number {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  if (!Number.isNaN(lh)) return lh;
  return parseFloat(cs.fontSize) * 1.2 || 16;
}

/**
 * Rendered height of every logical line of `text` at the textarea's current
 * width/wrap settings. With wrap off this is uniform; with wrap on, wrapped
 * lines report a multiple of the row height.
 */
export function measureLineHeights(el: HTMLTextAreaElement, text: string): number[] {
  const lines = text.split('\n');
  const cs = getComputedStyle(el);
  // Fast path: no soft wrap → every logical line is exactly one row.
  if (cs.whiteSpace === 'pre' || cs.whiteSpace === 'nowrap') {
    const lh = lineHeightPx(el);
    return lines.map(() => lh);
  }
  const mirror = createMirror(el);
  try {
    for (const line of lines) {
      const div = document.createElement('div');
      // A zero-width space keeps empty lines one row tall without adding width.
      div.textContent = line.length ? line : '​';
      mirror.appendChild(div);
    }
    return Array.from(mirror.children).map((c) => (c as HTMLElement).offsetHeight);
  } finally {
    mirror.remove();
  }
}

/** Y offset (px, from content top) of the caret placed at `pos` in `text`. */
function caretTopAt(mirror: HTMLDivElement, text: string, pos: number): number {
  mirror.textContent = '';
  const before = document.createElement('span');
  before.textContent = text.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = '​';
  const after = document.createElement('span');
  after.textContent = text.slice(pos);
  mirror.append(before, marker, after);
  return marker.offsetTop;
}

export interface CaretRowInfo {
  /** Caret is on the first *visual* row of the text. */
  firstRow: boolean;
  /** Caret is on the last *visual* row of the text. */
  lastRow: boolean;
}

/**
 * Whether the caret at `pos` sits on the first / last visual row of the
 * textarea's content, soft wrap included.
 */
export function caretRowInfo(el: HTMLTextAreaElement, text: string, pos: number): CaretRowInfo {
  const lh = lineHeightPx(el);
  const mirror = createMirror(el);
  try {
    const top = caretTopAt(mirror, text, pos);
    const bottom = caretTopAt(mirror, text, text.length);
    return { firstRow: top < lh * 0.5, lastRow: top > bottom - lh * 0.5 };
  } finally {
    mirror.remove();
  }
}

/**
 * Offset where the *last visual row* of `text` starts. For unwrapped text
 * this is just after the last '\n'; for wrapped text it is the start of the
 * final soft-wrapped row. Used to land the caret on the visually adjacent
 * row when arrowing ↑ into the previous block.
 */
export function lastVisualRowStart(el: HTMLTextAreaElement, text: string): number {
  if (!text.length) return 0;
  const mirror = createMirror(el);
  try {
    const endTop = caretTopAt(mirror, text, text.length);
    // caretTopAt is monotonic in pos → binary-search the first offset that
    // already sits on the bottom row.
    let lo = text.lastIndexOf('\n') + 1;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (caretTopAt(mirror, text, mid) >= endTop) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  } finally {
    mirror.remove();
  }
}

/**
 * Offset where the *first visual row* of `text` ends (exclusive). Caps the
 * landing column when arrowing ↓ into the next block.
 */
export function firstVisualRowEnd(el: HTMLTextAreaElement, text: string): number {
  if (!text.length) return 0;
  const firstNl = text.indexOf('\n');
  const hardEnd = firstNl < 0 ? text.length : firstNl;
  const mirror = createMirror(el);
  try {
    if (caretTopAt(mirror, text, hardEnd) === 0) return hardEnd;
    // First logical line wraps → find the last offset still on row 0.
    let lo = 0;
    let hi = hardEnd;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (caretTopAt(mirror, text, mid) === 0) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  } finally {
    mirror.remove();
  }
}

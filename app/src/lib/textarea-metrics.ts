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
    // Fractional heights matter: line-height is usually a non-integer px value
    // (14px × 1.6 = 22.4px), and the integer offsetHeight rounds each row down.
    // The rounding error compounds line by line, so by line ~30 the gutter
    // numbers sit half a row above their text (#203 行号错乱).
    const lh = lineHeightPx(el);
    return Array.from(mirror.children).map((c) => {
      const h = (c as HTMLElement).getBoundingClientRect().height;
      return h > 0 ? h : lh;
    });
  } finally {
    mirror.remove();
  }
}

/** X/Y offset (px, from content top-left) of the caret placed at `pos`. */
function caretPointAt(
  mirror: HTMLDivElement,
  text: string,
  pos: number,
): { left: number; top: number } {
  mirror.textContent = '';
  const before = document.createElement('span');
  before.textContent = text.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = '​';
  const after = document.createElement('span');
  after.textContent = text.slice(pos);
  mirror.append(before, marker, after);
  return { left: marker.offsetLeft, top: marker.offsetTop };
}

/** Y offset (px, from content top) of the caret placed at `pos` in `text`. */
function caretTopAt(mirror: HTMLDivElement, text: string, pos: number): number {
  return caretPointAt(mirror, text, pos).top;
}

/**
 * Caret's top offset in px, measured from the start of the text flow (so it
 * ignores the textarea's scroll position and padding — add those back at the
 * call site). Used to anchor the autocomplete popup to the caret's own row in
 * the flat (non-block) plain editor, where the document is one long textarea
 * and anchoring to the element's top would put the popup nowhere near the
 * caret. Soft wrap is accounted for, since the mirror wraps identically.
 */
export function caretTopPx(el: HTMLTextAreaElement, text: string, pos: number): number {
  const mirror = createMirror(el);
  try {
    return caretTopAt(mirror, text, pos);
  } finally {
    mirror.remove();
  }
}

export interface CaretPoint {
  /** Px from the left edge of the text flow (padding excluded). */
  left: number;
  /** Px from the top of the text flow (padding and scroll excluded). */
  top: number;
  /** Row height at the caret — the drawn caret's height. */
  height: number;
}

/**
 * Where to draw a caret of our own. The native <textarea> caret always
 * blinks — no CSS turns that off — so 实心光标 (#316) hides it and paints a
 * non-blinking bar at these coordinates, the same 2px accent bar that
 * CodeMirror's drawSelection() gives the other editor path.
 *
 * Callers add back the textarea's padding and subtract its scroll offsets.
 * Pass the *current logical line* rather than the whole document when the
 * textarea holds a large one: the mirror lays out every character it is
 * given, and this runs on every keystroke.
 */
export function caretPointPx(el: HTMLTextAreaElement, text: string, pos: number): CaretPoint {
  const mirror = createMirror(el);
  const lh = lineHeightPx(el);
  try {
    const at = Math.max(0, Math.min(pos, text.length));
    mirror.textContent = '';
    const before = document.createElement('span');
    before.textContent = text.slice(0, at);
    const marker = document.createElement('span');
    marker.textContent = '​';
    const after = document.createElement('span');
    after.textContent = text.slice(at);
    mirror.append(before, marker, after);
    // Rects, not offsetTop/offsetLeft: those are integers, and a caret that
    // rounds is a caret that sits half a pixel off its own glyphs. The marker
    // spans the *glyph* box, so lift it by the half-leading to get the top of
    // the line box — where a full-line-height caret starts, same as the
    // CodeMirror one.
    const base = mirror.getBoundingClientRect();
    const rect = marker.getBoundingClientRect();
    return {
      left: rect.left - base.left,
      top: rect.top - base.top - Math.max(0, (lh - rect.height) / 2),
      height: lh,
    };
  } finally {
    mirror.remove();
  }
}

export interface SelectionBoxPx {
  /** All four in px from the top-left of the text flow (padding and scroll excluded). */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The bounding box of `text[from, to)` as the textarea lays it out — what the
 * 5.0 selection bubble centres itself on (the textarea path has no
 * coordsAtPos()). Callers add back the padding and subtract the scroll.
 */
export function selectionBoxPx(el: HTMLTextAreaElement, text: string, from: number, to: number): SelectionBoxPx {
  const mirror = createMirror(el);
  try {
    const a = Math.max(0, Math.min(from, to, text.length));
    const b = Math.max(a, Math.min(Math.max(from, to), text.length));
    const before = document.createElement('span');
    before.textContent = text.slice(0, a);
    const mid = document.createElement('span');
    mid.textContent = text.slice(a, b) || '​';
    const after = document.createElement('span');
    after.textContent = text.slice(b);
    mirror.append(before, mid, after);
    const base = mirror.getBoundingClientRect();
    const rects = Array.from(mid.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    if (!rects.length) rects.push(mid.getBoundingClientRect());
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
    return { left: left - base.left, top: top - base.top, right: right - base.left, bottom: bottom - base.top };
  } finally {
    mirror.remove();
  }
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

/**
 * The text offset under viewport point (x, y) inside `el` — what
 * `caretRangeFromPoint` gives for ordinary text but not for a textarea
 * (Chromium's `caretPositionFromPoint` answers the end of the value for every
 * point). A transparent mirror is laid exactly over the textarea's content box
 * for one hit test. Points outside the text clamp to its start / end.
 */
export function offsetAtPoint(el: HTMLTextAreaElement, text: string, x: number, y: number): number {
  const rect = el.getBoundingClientRect();
  if (y < rect.top) return 0;
  if (y > rect.bottom) return text.length;
  const cs = getComputedStyle(el);
  const mirror = createMirror(el);
  const left = rect.left + el.clientLeft + parseFloat(cs.paddingLeft || '0') - el.scrollLeft;
  const top = rect.top + el.clientTop + parseFloat(cs.paddingTop || '0') - el.scrollTop;
  Object.assign(mirror.style, {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    visibility: 'visible',
    opacity: '0',
    zIndex: '2147483647',
    pointerEvents: 'auto',
  });
  const node = document.createTextNode(text + '​');
  mirror.appendChild(node);
  try {
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const r = doc.caretRangeFromPoint?.(x, y) ?? null;
    if (r && r.startContainer === node) return Math.min(r.startOffset, text.length);
    // Beside the text (left of a row / past the last row): nearest end.
    return y > top + mirror.getBoundingClientRect().height / 2 ? text.length : 0;
  } finally {
    mirror.remove();
  }
}

export const MAX_PREVIEW_MARKS = 1000;

export interface PreviewTextHit {
  start: number;
  end: number;
}

/**
 * Find non-overlapping case-insensitive literal occurrences of `query` inside `text`.
 *
 * Non-overlapping advancement (`pos += step`) is critical: advancing by `1` on
 * repeated-character queries such as `"--"`, `"=="`, `"**"`, or `"11"` yields
 * overlapping ranges inside the same `Text` node, causing `Range.surroundContents`
 * (when walking descending offsets) to shrink the node and throw `IndexSizeError`
 * on the earlier overlapping hit.
 */
export function findPreviewHitsInText(
  text: string,
  query: string,
  remainingLimit = Infinity,
  caseSensitive = false,
): { hits: PreviewTextHit[]; truncated: boolean } {
  const q = query.trim();
  if (!q || !text || remainingLimit <= 0) {
    return { hits: [], truncated: false };
  }
  if (caseSensitive) {
    const step = Math.max(1, q.length);
    const hits: PreviewTextHit[] = [];
    let truncated = false;
    let pos = 0;
    while ((pos = text.indexOf(q, pos)) !== -1) {
      if (hits.length >= remainingLimit) {
        truncated = true;
        break;
      }
      hits.push({ start: pos, end: pos + step });
      pos += step;
    }
    return { hits, truncated };
  }
  const lower = q.toLowerCase();
  if (!lower) {
    return { hits: [], truncated: false };
  }
  const lowerText = text.toLowerCase();
  // Guard rare Unicode case-folding length expansion (e.g. U+0130 `İ` -> `i\u0307`)
  // by falling back to direct slice comparison if lengths diverge.
  if (lowerText.length !== text.length || lower.length !== q.length) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    const hits: PreviewTextHit[] = [];
    let truncated = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (hits.length >= remainingLimit) {
        truncated = true;
        break;
      }
      hits.push({ start: m.index, end: m.index + m[0].length });
    }
    return { hits, truncated };
  }

  const step = Math.max(1, lower.length);
  const hits: PreviewTextHit[] = [];
  let truncated = false;
  let pos = 0;
  while ((pos = lowerText.indexOf(lower, pos)) !== -1) {
    if (hits.length >= remainingLimit) {
      truncated = true;
      break;
    }
    hits.push({ start: pos, end: pos + step });
    pos += step;
  }
  return { hits, truncated };
}

const DEFAULT_SKIP_SELECTOR =
  '.cm-live-table__cell--editing, .cm-table-source-btn, .plain-block-source-btn, button, script, style, textarea, input';

/**
 * Unwrap any `<mark class="ps-mark">` elements inside `container` (except inside
 * an actively edited table cell) and normalize adjacent text nodes.
 */
export function clearSearchMarksIn(container: ParentNode | null | undefined): void {
  if (!container || typeof container.querySelectorAll !== 'function') return;
  const marks = Array.from(container.querySelectorAll<HTMLElement>('mark.ps-mark'));
  if (marks.length === 0) return;
  const dirtyParents = new Set<Node>();
  for (const mark of marks) {
    if (mark.closest?.('.cm-live-table__cell--editing')) continue;
    const parent = mark.parentNode;
    if (!parent) continue;
    dirtyParents.add(parent);
    parent.replaceChild(mark.ownerDocument.createTextNode(mark.textContent || ''), mark);
  }
  for (const parent of dirtyParents) {
    parent.normalize();
  }
}

/**
 * Highlight non-overlapping occurrences of `query` inside `container` with
 * `<mark class="ps-mark">` and return the created mark elements in document order.
 */
export function applySearchMarksIn(
  container: HTMLElement | null | undefined,
  query: string,
  opts?: {
    caseSensitive?: boolean;
    limit?: number;
    skipSelector?: string;
  },
): HTMLElement[] {
  if (!container) return [];
  clearSearchMarksIn(container);
  const q = query.trim();
  const doc = container.ownerDocument;
  if (!q || !doc?.createTreeWalker) return [];

  const skipSelector = opts?.skipSelector ?? DEFAULT_SKIP_SELECTOR;
  const maxMarks = opts?.limit ?? MAX_PREVIEW_MARKS;
  const caseSensitive = opts?.caseSensitive ?? false;

  const walker = doc.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */, null);
  const byNode = new Map<Text, PreviewTextHit[]>();
  let total = 0;
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const parentEl = node.parentElement;
    if (parentEl && skipSelector && parentEl.closest?.(skipSelector)) continue;
    const text = node.textContent || '';
    if (!text) continue;
    const remaining = maxMarks - total;
    if (remaining <= 0) break;
    const res = findPreviewHitsInText(text, q, remaining, caseSensitive);
    if (res.hits.length > 0) {
      byNode.set(node, res.hits);
      total += res.hits.length;
    }
    if (res.truncated) break;
  }

  if (total === 0) return [];
  const createdMarks: HTMLElement[] = [];
  for (const [textNode, hits] of byNode) {
    const nodeMarks: HTMLElement[] = [];
    for (let idx = hits.length - 1; idx >= 0; idx -= 1) {
      const { start, end } = hits[idx];
      const nodeLen = textNode.nodeValue?.length ?? 0;
      if (start < 0 || end > nodeLen || start >= end) continue;
      const range = doc.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const mark = doc.createElement('mark');
      mark.className = 'ps-mark';
      range.surroundContents(mark);
      nodeMarks.push(mark);
    }
    nodeMarks.reverse();
    for (const m of nodeMarks) createdMarks.push(m);
  }
  return createdMarks;
}

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
): { hits: PreviewTextHit[]; truncated: boolean } {
  const q = query.trim();
  if (!q || !text || remainingLimit <= 0) {
    return { hits: [], truncated: false };
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

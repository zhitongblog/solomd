/**
 * 5.0 selection bubble + touch keyboard bar — the pure parts (docs/v5-ui-spec.md §5, §8).
 *
 * Neither surface owns any formatting logic: every button runs a `fmt.*`
 * command through lib/md-format.ts, the same as the shortcut. What lives here
 * is what the two components need to *decide* — is a format already on (so
 * the button shows pressed), which heading level comes next, and where the
 * floating bar goes — kept free of the DOM so it can be unit tested.
 */

import { applyFormat, type FormatKind } from './md-format.ts';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The line(s) a selection touches, as a slice of `doc` plus the offsets
 *  re-based into it. Formatting only ever looks at whole lines, so this is
 *  all `isFormatActive` needs — no full-document copy per selection change. */
export function lineContext(doc: string, from: number, to: number): { text: string; from: number; to: number } {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(doc.length, Math.max(from, to));
  const start = doc.lastIndexOf('\n', a - 1) + 1;
  let end = doc.indexOf('\n', b);
  if (end < 0) end = doc.length;
  return { text: doc.slice(start, end), from: a - start, to: b - start };
}

/**
 * Whether `kind` is already applied to the selection. Every format command is
 * a toggle (md-format.ts), so "on" is exactly "running it again would take
 * text away". Links are not toggles (⌘K always wraps), so they never show as
 * pressed.
 */
export function isFormatActive(doc: string, from: number, to: number, kind: FormatKind): boolean {
  if (kind === 'link' || from === to) return false;
  const e = applyFormat(doc, from, to, kind);
  return e.insert.length < e.to - e.from;
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/;

/** ATX heading level (1–6) of the line `pos` sits on, 0 for none. */
export function headingLevelAt(doc: string, pos: number): number {
  const p = Math.max(0, Math.min(pos, doc.length));
  const start = doc.lastIndexOf('\n', p - 1) + 1;
  let end = doc.indexOf('\n', p);
  if (end < 0) end = doc.length;
  const m = HEADING_RE.exec(doc.slice(start, end));
  return m ? m[1].length : 0;
}

/**
 * The heading button on the touch keyboard bar cycles
 * paragraph → H1 → H2 → H3 → paragraph. Each step is a plain `fmt.hN`:
 * H1 and H2 move to the next level, and `h3` on an H3 line toggles the
 * heading off (an H4–H6 line comes back to H3 first).
 */
export function nextHeadingKind(doc: string, pos: number): 'h1' | 'h2' | 'h3' {
  const level = headingLevelAt(doc, pos);
  if (level === 0) return 'h1';
  if (level === 1) return 'h2';
  return 'h3';
}

export interface Placement {
  left: number;
  top: number;
  /** Placed under the selection (no room above). */
  below: boolean;
}

/**
 * Where the bubble goes: above the selection, centred on it; under it when
 * the space above is too small; always clamped inside `bounds` (the editor
 * pane) with `margin` to spare.
 */
export function placeBubble(
  sel: Box,
  size: { width: number; height: number },
  bounds: Box,
  gap = 8,
  margin = 8,
): Placement {
  let top = sel.top - gap - size.height;
  let below = false;
  if (top < bounds.top + margin) {
    const under = sel.bottom + gap;
    if (under + size.height <= bounds.bottom - margin) {
      top = under;
      below = true;
    } else {
      // Neither fits (a selection taller than the pane): pin to the top edge.
      top = bounds.top + margin;
    }
  }
  const centre = (sel.left + sel.right) / 2;
  const minLeft = bounds.left + margin;
  const maxLeft = bounds.right - margin - size.width;
  let left = centre - size.width / 2;
  if (left > maxLeft) left = maxLeft;
  if (left < minLeft) left = minLeft;
  return { left: Math.round(left), top: Math.round(top), below };
}

/** A selection worth a bubble: non-empty and not only whitespace. */
export function isBubbleSelection(selected: string): boolean {
  return selected.length > 0 && selected.trim().length > 0;
}

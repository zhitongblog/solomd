/**
 * Keep ordered-list numbers consecutive in the source after an edit — delete
 * `2. second` from `1. 2. 3.` and the rest becomes `1. 2.`, as in Typora and
 * MarkText. Rendering never needed this (Markdown numbers from the first
 * item); the source did, and every editor path shares this one rule:
 * CodeMirror through a transaction filter, the Windows textarea editors at
 * their three commit points.
 *
 * Only edits that add or remove a line break trigger it (`structuralEditRange`).
 * Typing inside a marker never does, so changing `10.` to `11.` digit by digit
 * isn't fought over halfway through.
 *
 * Lists written lazily (`1. 1. 1.`) are left alone, and the first item's
 * number is kept as the start.
 */

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * The span of `next` touched by the edit that turned `prev` into it, or null
 * when that edit neither added nor removed a newline.
 */
export function structuralEditRange(prev: string, next: string): { from: number; to: number } | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < max - p &&
    prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)
  ) {
    s++;
  }
  const removed = prev.slice(p, prev.length - s);
  const inserted = next.slice(p, next.length - s);
  if (!removed.includes('\n') && !inserted.includes('\n')) return null;
  return { from: p, to: next.length - s };
}

interface Line {
  start: number;
  end: number;
  /** Number of `>` quote markers in front. */
  quote: number;
  /** Indent width after the quote markers (tab = 4). */
  indent: number;
  blank: boolean;
  /** Any list marker (bullet or ordered) at this line's indent. */
  listMarker: boolean;
  /** ATX heading (`# ...`), which interrupts lists even at 0–3 spaces indent. */
  heading: boolean;
  /** Block construct (fence, heading, hr, table, math, HTML block) that cannot be lazy list continuation. */
  blockBreak: boolean;
  item: { num: number; delim: string; numFrom: number; numTo: number; missingSpace?: boolean } | null;
}

const QUOTE = /^((?:[ \t]*>[ \t]?)*)/;
const ORDERED = /^([ \t]*)(\d{1,9})([.)])(?=[ \t]|$)/;
const ORDERED_CJK_NO_SPACE = /^([ \t]*)(\d{1,3})([.)])(?=[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef“”‘’（【《「『])/;
const BULLET = /^[ \t]*[-*+](?=[ \t]|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^[ \t]{0,3}#{1,6}(?!#)/;
const THEMATIC_BREAK = /^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/;
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/;
const MATH_BLOCK = /^[ \t]*(\$\$|\\\[)/;
const HTML_BLOCK = /^[ \t]{0,3}<(?:\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)\b|!--)/i;

function indentWidth(ws: string): number {
  let w = 0;
  for (const ch of ws) w += ch === '\t' ? 4 - (w % 4) : 1;
  return w;
}

function parseLines(text: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    const raw = text.slice(start, end);
    const quoteStr = raw.match(QUOTE)?.[1] ?? '';
    const rest = raw.slice(quoteStr.length);
    const quote = (quoteStr.match(/>/g) ?? []).length;
    const ws = rest.match(/^[ \t]*/)?.[0] ?? '';
    const line: Line = {
      start,
      end,
      quote,
      indent: indentWidth(ws),
      blank: rest.trim() === '',
      listMarker: false,
      heading: false,
      blockBreak: false,
      item: null,
    };
    const f = rest.match(FENCE);
    if (fence) {
      // Inside a code block nothing is a list item.
      line.blockBreak = true;
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
    } else if (f) {
      fence = f[1];
      line.blockBreak = true;
    } else if (ATX_HEADING.test(rest)) {
      line.heading = true;
      line.blockBreak = true;
    } else {
      const m = rest.match(ORDERED);
      const mNoSpace = !m ? rest.match(ORDERED_CJK_NO_SPACE) : null;
      if (m) {
        const numFrom = start + quoteStr.length + m[1].length;
        line.item = { num: Number(m[2]), delim: m[3], numFrom, numTo: numFrom + m[2].length };
        line.listMarker = true;
      } else if (mNoSpace) {
        const numFrom = start + quoteStr.length + mNoSpace[1].length;
        line.item = {
          num: Number(mNoSpace[2]),
          delim: mNoSpace[3],
          numFrom,
          numTo: numFrom + mNoSpace[2].length,
          missingSpace: true,
        };
        line.listMarker = true;
      } else if (BULLET.test(rest)) {
        line.listMarker = true;
      } else if (
        THEMATIC_BREAK.test(rest) ||
        TABLE_ROW.test(rest) ||
        MATH_BLOCK.test(rest) ||
        HTML_BLOCK.test(rest)
      ) {
        line.blockBreak = true;
      }
    }
    out.push(line);
    if (nl < 0) break;
    start = nl + 1;
  }
  return out;
}

export interface RenumberOptions {
  /** Renumber even if all items currently have the same number (e.g. `1. a\n1. b`). */
  forceConsecutive?: boolean;
  /** Start numbering each touched list at `1` even if its first item has another number. */
  resetFirstToOne?: boolean;
}

/**
 * Renumber every ordered list overlapping `[from, to]` (offsets in `text`,
 * widened by a line on each side — deleting an item joins its neighbours).
 * Returns the changes in ascending order, or an empty array.
 */
export function renumberChanges(
  text: string,
  from: number,
  to: number,
  options?: RenumberOptions,
): TextChange[] {
  const lines = parseLines(text);
  const lineAt = (pos: number) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].start <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const firstLine = Math.max(0, lineAt(from) - 1);
  const toLine = lineAt(to);
  let lastLine = Math.min(lines.length - 1, toLine + 1);
  if (options?.resetFirstToOne) {
    const toIndent = lines[toLine].indent;
    while (
      lastLine + 1 < lines.length &&
      (lines[lastLine].indent > toIndent || lines[lastLine].blank)
    ) {
      lastLine++;
    }
  }

  const assigned = new Set<number>();
  const changes: TextChange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (!head.item || assigned.has(i)) continue;
    const items: number[] = [i];
    let last = i;
    let prevBlank = false;
    let sawLazyText = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.quote !== head.quote) break;
      if (l.heading) break;
      if (l.item && l.indent === head.indent) {
        if (l.item.delim !== head.item.delim) break;
        // If an unindented line or blank line sat between the previous item and
        // a new `1.` item, treat the new `1.` as the start of a separate list.
        if ((sawLazyText || prevBlank) && l.item.num === 1) break;
        items.push(j);
        last = j;
        prevBlank = false;
        sawLazyText = false;
        continue;
      }
      if (l.blank) {
        prevBlank = true;
        continue;
      }
      // Child content (nested lists, continuation paragraphs, code).
      if (l.indent > head.indent) {
        last = j;
        prevBlank = false;
        continue;
      }
      if (l.blockBreak) break;
      // A lazy continuation line right under item text keeps the list going.
      if (!prevBlank && !l.listMarker) {
        last = j;
        sawLazyText = true;
        continue;
      }
      break;
    }
    for (const k of items) assigned.add(k);
    if (last < firstLine || i > lastLine) continue;
    const startNum = options?.resetFirstToOne ? 1 : lines[items[0]].item!.num;
    const anyMissingSpace = items.some((k) => lines[k].item!.missingSpace);
    if (items.length < 2 && lines[items[0]].item!.num === startNum) continue;
    const nums = items.map((k) => lines[k].item!.num);
    if (
      !options?.forceConsecutive &&
      !options?.resetFirstToOne &&
      !anyMissingSpace &&
      nums.every((n) => n === nums[0])
    ) {
      continue;
    }
    nums.forEach((n, idx) => {
      const want = startNum + idx;
      const it = lines[items[idx]].item!;
      if (it.missingSpace) {
        changes.push({
          from: it.numFrom,
          to: it.numTo + it.delim.length,
          insert: `${want}${it.delim} `,
        });
        return;
      }
      if (n === want) return;
      changes.push({ from: it.numFrom, to: it.numTo, insert: String(want) });
    });
  }
  return changes.sort((a, b) => a.from - b.from);
}

/** Apply ascending, non-overlapping changes to `text`. */
export function applyChanges(text: string, changes: TextChange[]): string {
  let out = '';
  let pos = 0;
  for (const c of changes) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}

/** Where `pos` lands after `changes` are applied. */
export function mapPos(pos: number, changes: TextChange[]): number {
  let delta = 0;
  for (const c of changes) {
    if (c.to <= pos) delta += c.insert.length - (c.to - c.from);
    else if (c.from < pos) return c.from + c.insert.length + delta;
  }
  return pos + delta;
}

/**
 * The textarea editors' entry point: given the document before and after an
 * edit, the document to store instead (or null when nothing needs renumbering).
 */
export function renumberAfterEdit(
  prev: string,
  next: string,
): { value: string; changes: TextChange[] } | null {
  const range = structuralEditRange(prev, next);
  if (!range) return null;
  const changes = renumberChanges(next, range.from, range.to);
  if (!changes.length) return null;
  return { value: applyChanges(next, changes), changes };
}

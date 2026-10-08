/**
 * Markdown formatting commands (#296, #274) — bold, italic, headings, lists…
 *
 * Pure text in, one edit out. SoloMD is three editors (CodeMirror, the plain
 * block editor, the plain flat editor — see `onTransformCase` in Editor.vue),
 * and a formatting command written against any one of them is dead in the
 * other two. So *what* changes is decided here, from a string and a
 * selection, and each editor only applies the result.
 *
 * Every command is a toggle: run it on text that already has the format and
 * the format comes off. That is what makes one shortcut enough.
 */

import { applyChanges, renumberChanges } from './list-renumber';

export type FormatKind =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'task'
  | 'codeblock';

export const FORMAT_KINDS: FormatKind[] = [
  'bold', 'italic', 'strike', 'code', 'link',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'quote', 'ul', 'ol', 'task', 'codeblock',
];

export interface FormatEdit {
  /** Replace `doc[from, to)` with `insert`… */
  from: number;
  to: number;
  insert: string;
  /** …then select this range (offsets in the *new* document). */
  selFrom: number;
  selTo: number;
}

const WORD = /[\p{L}\p{N}_]/u;
// Chinese, Japanese and Korean do not put spaces between words, so "the word
// under the caret" would be the whole clause. There a bare caret just opens
// an empty pair of markers to type into.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const isWordChar = (ch: string) => WORD.test(ch) && !UNSPACED.test(ch);

/** Selection, or the word under a bare caret — so ⌘B on a word just works. */
function targetRange(doc: string, from: number, to: number): [number, number] {
  if (from !== to) return [from, to];
  let s = from;
  let e = from;
  while (s > 0 && isWordChar(doc[s - 1])) s--;
  while (e < doc.length && isWordChar(doc[e])) e++;
  return [s, e];
}

function runBefore(doc: string, pos: number, ch: string): number {
  let n = 0;
  while (pos - n - 1 >= 0 && doc[pos - n - 1] === ch) n++;
  return n;
}
function runAfter(doc: string, pos: number, ch: string): number {
  let n = 0;
  while (pos + n < doc.length && doc[pos + n] === ch) n++;
  return n;
}

/**
 * Bold and italic share a character, so "is this italic?" cannot be answered
 * by looking for one `*`: `**word**` has one on each side too. Count the run
 * instead — 2 is bold, 1 is italic, 3 is both — and add or remove exactly the
 * asterisks this command owns.
 */
function toggleStars(doc: string, from: number, to: number, width: 1 | 2): FormatEdit {
  let [s, e] = targetRange(doc, from, to);
  // A selection that *includes* its markers ("**word**") counts as formatted
  // too: pull the markers out of the range and let the run count see them.
  while (s < e && doc[s] === '*' && doc[e - 1] === '*' && e - s >= 2) { s++; e--; }
  const n = Math.min(runBefore(doc, s, '*'), runAfter(doc, e, '*'), 3);
  const has = width === 2 ? n >= 2 : n % 2 === 1;
  const inner = doc.slice(s, e);
  if (has) {
    return { from: s - width, to: e + width, insert: inner, selFrom: s - width, selTo: e - width };
  }
  // A bare caret inside an existing span the word rule cannot see — CJK,
  // where the "word" is empty (这是**粗|体**文字), or a Latin span of several
  // words — takes that span's markers off instead of nesting a new pair.
  if (from === to) {
    const span = enclosingStarSpan(doc, from, width);
    if (span) {
      const [openEnd, closeStart] = span;
      return {
        from: openEnd - width,
        to: closeStart + width,
        insert: doc.slice(openEnd, closeStart),
        selFrom: from - width,
        selTo: from - width,
      };
    }
  }
  const m = '*'.repeat(width);
  return { from: s, to: e, insert: m + inner + m, selFrom: s + width, selTo: e + width };
}

/**
 * The `**…**` (width 2) or `*…*` (width 1) span on the caret's line that
 * contains `pos`, as [end of the opening run, start of the closing run].
 * Runs pair up left to right — the second run of a kind closes the first —
 * so a caret *between* two spans is in neither. A run of 3 counts for both.
 */
function enclosingStarSpan(doc: string, pos: number, width: 1 | 2): [number, number] | null {
  const ls = pos > 0 ? doc.lastIndexOf('\n', pos - 1) + 1 : 0;
  let le = doc.indexOf('\n', pos);
  if (le < 0) le = doc.length;
  const runs: [number, number][] = [];
  for (let i = ls; i < le; ) {
    if (doc[i] !== '*') { i++; continue; }
    let j = i;
    while (j < le && doc[j] === '*') j++;
    const n = j - i;
    if (width === 2 ? n >= 2 : n % 2 === 1) runs.push([i, j]);
    i = j;
  }
  for (let k = 0; k + 1 < runs.length; k += 2) {
    const openEnd = runs[k][1];
    const closeStart = runs[k + 1][0];
    if (closeStart > openEnd && pos >= openEnd && pos <= closeStart) return [openEnd, closeStart];
  }
  return null;
}

function toggleWrap(doc: string, from: number, to: number, marker: string): FormatEdit {
  let [s, e] = targetRange(doc, from, to);
  const w = marker.length;
  if (e - s >= 2 * w && doc.slice(s, s + w) === marker && doc.slice(e - w, e) === marker) {
    s += w;
    e -= w;
  }
  const inner = doc.slice(s, e);
  if (doc.slice(s - w, s) === marker && doc.slice(e, e + w) === marker) {
    return { from: s - w, to: e + w, insert: inner, selFrom: s - w, selTo: e - w };
  }
  return { from: s, to: e, insert: marker + inner + marker, selFrom: s + w, selTo: e + w };
}

function makeLink(doc: string, from: number, to: number): FormatEdit {
  const [s, e] = targetRange(doc, from, to);
  const inner = doc.slice(s, e);
  // A selected URL is the destination, not the label.
  if (/^(https?:\/\/|www\.)\S+$/i.test(inner)) {
    return { from: s, to: e, insert: `[](${inner})`, selFrom: s + 1, selTo: s + 1 };
  }
  const insert = `[${inner}](url)`;
  const urlAt = s + inner.length + 3;
  // No label yet: put the caret where the label goes.
  if (!inner) return { from: s, to: e, insert, selFrom: s + 1, selTo: s + 1 };
  return { from: s, to: e, insert, selFrom: urlAt, selTo: urlAt + 3 };
}

/** The whole lines the selection touches. */
function lineSpan(doc: string, from: number, to: number): [number, number] {
  // #360 — `lastIndexOf('\n', -1)` searches from index 0, not "nowhere": with
  // the caret at offset 0 of a document that starts with an empty line it
  // found that newline, so the span became [1, 0] and the edit was rejected —
  // Ctrl+1 on an empty first line did nothing.
  const s = from > 0 ? doc.lastIndexOf('\n', from - 1) + 1 : 0;
  // A selection ending right after a newline does not include the next line.
  const endAnchor = to > from && doc[to - 1] === '\n' ? to - 1 : to;
  let e = doc.indexOf('\n', endAnchor);
  if (e < 0) e = doc.length;
  return [s, e];
}

const HEADING = /^(\s{0,3})#{1,6}\s+/;
const QUOTE = /^(\s*)>\s?/;
const TASK = /^(\s*)(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/;
const UL = /^(\s*)[-*+]\s+(?!\[[ xX]\]\s)/;
const OL = /^(\s*)\d+[.)]\s+(?!\[[ xX]\]\s)/;
const ANY_LIST = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;

function mapLines(
  doc: string,
  from: number,
  to: number,
  fn: (lines: string[]) => string[],
): FormatEdit {
  const [s, e] = lineSpan(doc, from, to);
  const insert = fn(doc.slice(s, e).split('\n')).join('\n');
  // A bare caret stays a caret at the end of its line (you are about to type
  // the heading); a selection stays a selection over the rewritten lines.
  if (from === to) return { from: s, to: e, insert, selFrom: s + insert.length, selTo: s + insert.length };
  return { from: s, to: e, insert, selFrom: s, selTo: s + insert.length };
}

function toggleHeading(doc: string, from: number, to: number, level: number): FormatEdit {
  const prefix = '#'.repeat(level) + ' ';
  return mapLines(doc, from, to, (lines) => {
    const live = lines.filter((l) => l.trim() !== '');
    const already = live.length > 0 && live.every((l) => new RegExp(`^\\s{0,3}#{${level}}\\s+`).test(l));
    return lines.map((l) => {
      if (l.trim() === '' && lines.length > 1) return l;
      const bare = l.replace(HEADING, '$1');
      return already ? bare : bare.replace(/^(\s{0,3})/, `$1${prefix}`);
    });
  });
}

function togglePrefix(
  doc: string,
  from: number,
  to: number,
  test: RegExp,
  make: (indent: string, rest: string, index: number) => string,
  strip: RegExp,
): FormatEdit {
  return mapLines(doc, from, to, (lines) => {
    const live = lines.filter((l) => l.trim() !== '');
    const already = live.length > 0 && live.every((l) => test.test(l));
    let i = 0;
    return lines.map((l) => {
      if (l.trim() === '' && lines.length > 1) return l;
      if (already) return l.replace(test, '$1');
      // Switching list type replaces the old marker rather than stacking
      // "1. - item".
      const indent = /^\s*/.exec(l)![0];
      const rest = l.replace(strip, '').replace(/^\s*/, '');
      return make(indent, rest, i++);
    });
  });
}

/**
 * The closed fenced block (``` or ~~~) whose lines contain [from, to], as
 * offsets: opening line start, inner start, inner end, closing line end.
 * Fences are tracked from the top of the document, so a ``` line is known to
 * open or close.
 */
function enclosingFence(doc: string, from: number, to: number): [number, number, number, number] | null {
  let open: { start: number; end: number; ch: string; len: number } | null = null;
  let at = 0;
  while (at <= doc.length) {
    let end = doc.indexOf('\n', at);
    if (end < 0) end = doc.length;
    const line = doc.slice(at, end);
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      if (!open) {
        if (m[1][0] === '~' || !m[2].includes('`')) open = { start: at, end, ch: m[1][0], len: m[1].length };
      } else if (m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === '') {
        if (from >= open.start && to <= end) {
          const innerStart = Math.min(open.end + 1, at);
          return [open.start, innerStart, Math.max(innerStart, at - 1), end];
        }
        open = null;
      }
    }
    if (open === null && at > to) return null;
    at = end + 1;
  }
  return null;
}

function toggleCodeBlock(doc: string, from: number, to: number): FormatEdit {
  // Inside a block — the caret on either fence line too, which is where the
  // wrap below leaves it — the command takes the fences off.
  const fence = enclosingFence(doc, from, to);
  if (fence) {
    const [blockStart, innerStart, innerEnd, blockEnd] = fence;
    const inner = doc.slice(innerStart, innerEnd);
    const map = (p: number) => Math.max(blockStart, Math.min(blockStart + inner.length, p - (innerStart - blockStart)));
    return from === to
      ? { from: blockStart, to: blockEnd, insert: inner, selFrom: map(from), selTo: map(from) }
      : { from: blockStart, to: blockEnd, insert: inner, selFrom: blockStart, selTo: blockStart + inner.length };
  }
  const [s, e] = lineSpan(doc, from, to);
  const body = doc.slice(s, e);
  const lines = body.split('\n');
  if (lines.length >= 2 && /^\s*```/.test(lines[0]) && /^\s*```\s*$/.test(lines[lines.length - 1])) {
    const inner = lines.slice(1, -1).join('\n');
    return { from: s, to: e, insert: inner, selFrom: s, selTo: s + inner.length };
  }
  const insert = '```\n' + body + '\n```';
  // Caret after the opening fence: the language is the next thing to type.
  return { from: s, to: e, insert, selFrom: s + 3, selTo: s + 3 };
}

const INLINE_MARKERS: Partial<Record<FormatKind, string>> = { bold: '**', italic: '*', strike: '~~', code: '`' };
// What a line may start with that is structure, not content: indent, quote
// markers, then a heading, bullet, number or task box.
const LINE_PREFIX = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;

/**
 * Bold / italic / strike / code over a selection spanning lines. Emphasis
 * cannot cross a line break in Markdown, so one pair around the whole range
 * renders as literal asterisks — each line's content is wrapped on its own,
 * as Typora does. Blank lines and line prefixes (`- `, `## `, `> `) stay
 * outside the markers. Still a toggle: when every line already has the
 * format it comes off all of them.
 */
function toggleInlineLines(doc: string, from: number, to: number, marker: string): FormatEdit {
  const w = marker.length;
  const segs = doc.slice(from, to).split('\n');
  const atLineStart = from === 0 || doc[from - 1] === '\n';
  const parts = segs.map((seg, i) => {
    const lineStart = i > 0 || atLineStart;
    const pre = lineStart ? seg.match(LINE_PREFIX)?.[0] ?? '' : '';
    const rest = seg.slice(pre.length);
    const core = rest.replace(/\s+$/, '');
    return { pre, core, post: rest.slice(core.length) };
  });
  const has = (c: string) =>
    c.length >= 2 * w && c.startsWith(marker) && c.endsWith(marker) &&
    // `**x**` is bold, not italic: a single-star check must not match a double.
    (w !== 1 || !(c.startsWith('**') && c.endsWith('**')) || (c.startsWith('***') && c.endsWith('***')));
  const filled = parts.filter((p) => p.core);
  const remove = filled.length > 0 && filled.every((p) => has(p.core));
  const insert = parts
    .map(({ pre, core, post }) => {
      if (!core) return pre + post;
      if (remove) return pre + core.slice(w, core.length - w) + post;
      return pre + (has(core) ? core : marker + core + marker) + post;
    })
    .join('\n');
  return { from, to, insert, selFrom: from, selTo: from + insert.length };
}

/** The edit that applies (or removes) `kind` at the given selection. */
export function applyFormat(doc: string, from: number, to: number, kind: FormatKind): FormatEdit {
  const a = Math.max(0, Math.min(from, to, doc.length));
  const b = Math.max(0, Math.min(Math.max(from, to), doc.length));
  const inline = INLINE_MARKERS[kind];
  if (inline && doc.slice(a, b).includes('\n')) return toggleInlineLines(doc, a, b, inline);
  switch (kind) {
    case 'bold': return toggleStars(doc, a, b, 2);
    case 'italic': return toggleStars(doc, a, b, 1);
    case 'strike': return toggleWrap(doc, a, b, '~~');
    case 'code': return toggleWrap(doc, a, b, '`');
    case 'link': return makeLink(doc, a, b);
    case 'quote':
      return togglePrefix(doc, a, b, QUOTE, (ind, rest) => `${ind}> ${rest}`, /^(\s*)(?=\S)/);
    case 'ul':
      return togglePrefix(doc, a, b, UL, (ind, rest) => `${ind}- ${rest}`, ANY_LIST);
    case 'ol':
      return togglePrefix(doc, a, b, OL, (ind, rest, i) => `${ind}${i + 1}. ${rest}`, ANY_LIST);
    case 'task':
      return togglePrefix(doc, a, b, TASK, (ind, rest) => `${ind}- [ ] ${rest}`, ANY_LIST);
    case 'codeblock': return toggleCodeBlock(doc, a, b);
    default:
      return toggleHeading(doc, a, b, Number(kind.slice(1)));
  }
}

// ---- Tab / Shift+Tab on list items ----

/** indent, marker (`-`, `2.`, `10)`), the spaces after it. */
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const ORDERED_NUM = /^( *)(\d{1,9})([.)])/;

interface DocLine {
  start: number;
  end: number;
  text: string;
}

function linesOf(doc: string): DocLine[] {
  const out: DocLine[] = [];
  let at = 0;
  for (;;) {
    const nl = doc.indexOf('\n', at);
    const end = nl < 0 ? doc.length : nl;
    out.push({ start: at, end, text: doc.slice(at, end) });
    if (nl < 0) return out;
    at = nl + 1;
  }
}

const leadingSpaces = (t: string) => /^ */.exec(t)![0].length;

/**
 * Tab / Shift+Tab with the caret (or selection) on list items: nest the
 * items under the one above, or lift them back out — or null when the first
 * line is not a list item (or there is nothing to nest under), so the editor
 * indents as it always did.
 *
 * Markdown only nests an item indented to its parent's *content* column:
 * two spaces under `- `, but three under `2. ` and four under `10. `. A flat
 * two-space indent under a number is a lazy continuation line, so Tab on
 * "2. two" turned it into a second line of "1. one" (5.0 regression run,
 * F-7). Ordered numbers follow on both levels: the nested item starts a new
 * list at 1 (or continues the one it joins) and the outer list closes the
 * gap; Shift+Tab does the reverse.
 */
export function listIndentEdit(doc: string, from: number, to: number, outdent: boolean): FormatEdit | null {
  const lines = linesOf(doc);
  const a = Math.max(0, Math.min(from, to, doc.length));
  const b = Math.max(0, Math.min(Math.max(from, to), doc.length));
  const first = lines.findIndex((l) => a <= l.end);
  let last = lines.findIndex((l) => b <= l.end);
  // A selection ending right after a newline does not include the next line.
  if (b > a && last > first && b === lines[last].start) last--;
  const head = LIST_ITEM.exec(lines[first].text);
  if (!head || /^[ ]*\t/.test(lines[first].text)) return null;
  const indent = head[1].length;

  // Tab nests under the nearest item above at the same indent; Shift+Tab
  // lifts out to the nearest item above at a smaller one.
  let target = -1;
  let parent = -1;
  for (let i = first - 1; i >= 0; i--) {
    const t = lines[i].text;
    if (t.trim() === '') continue;
    const m = LIST_ITEM.exec(t);
    const ind = leadingSpaces(t);
    if (!outdent && m && ind === indent) {
      target = indent + m[2].length + Math.max(1, m[3].length);
      parent = i;
      break;
    }
    if (outdent && m && ind < indent) {
      target = ind;
      parent = i;
      break;
    }
    // Shallower text ends the list; so does same-level text that is no item.
    if (ind < indent || (!outdent && ind === indent && !m)) break;
  }
  if (target < 0) return null;
  const delta = target - indent;

  // Every touched line moves by the same amount, so a selected sub-list
  // keeps its shape.
  const touched = lines.slice(first, last + 1).map((l) => {
    if (l.text.trim() === '') return l.text;
    if (delta > 0) return ' '.repeat(delta) + l.text;
    return l.text.slice(Math.min(leadingSpaces(l.text), -delta));
  });

  // The moved item's number at its new level: one past the sibling it now
  // follows, or 1 when it starts a list there.
  const num = ORDERED_NUM.exec(touched[0]);
  if (num) {
    let want = 1;
    if (outdent) {
      const pm = ORDERED_NUM.exec(lines[parent].text);
      if (pm) want = Number(pm[2]) + 1;
    } else {
      for (let i = first - 1; i > parent; i--) {
        const t = lines[i].text;
        if (t.trim() === '') continue;
        const ind = leadingSpaces(t);
        if (ind < target) break;
        const sm = ORDERED_NUM.exec(t);
        if (ind === target && sm) {
          want = Number(sm[2]) + 1;
          break;
        }
      }
    }
    touched[0] = num[1] + want + num[3] + touched[0].slice(num[0].length);
  }

  const spanStart = lines[first].start;
  const body = touched.join('\n');
  let next = doc.slice(0, spanStart) + body + doc.slice(lines[last].end);
  const spanEnd = spanStart + body.length;

  // Lifting an item out of a nested list leaves the items after it as a list
  // of their own under it, which starts at 1 again.
  let renumberTo = spanEnd;
  if (outdent) {
    const after = linesOf(next).find((l) => l.start > spanEnd && l.text.trim() !== '');
    const am = after && ORDERED_NUM.exec(after.text);
    if (after && am && am[1].length === indent && am[2] !== '1') {
      const numFrom = after.start + am[1].length;
      next = next.slice(0, numFrom) + '1' + next.slice(numFrom + am[2].length);
      renumberTo = after.end - (am[2].length - 1);
    }
  }
  const renum = renumberChanges(next, spanStart, renumberTo);
  const final = applyChanges(next, renum);

  // The selection keeps its place in the text of each line.
  const map = (p: number) => {
    let lineStart = spanStart;
    for (let i = first; i <= last; i++) {
      const grow = touched[i - first].length - lines[i].text.length;
      if (p <= lines[i].end) return lineStart + Math.max(0, p - lines[i].start + grow);
      lineStart += touched[i - first].length + 1;
    }
    return p;
  };
  const after = (p: number) => {
    for (const c of renum) if (c.to <= p) p += c.insert.length - (c.to - c.from);
    return p;
  };
  const selFrom = after(map(a));
  const selTo = after(map(b));
  // One edit over the part that changed, so every editor applies it the same way.
  let p = 0;
  while (p < doc.length && p < final.length && doc[p] === final[p]) p++;
  let q = 0;
  while (q < doc.length - p && q < final.length - p && doc[doc.length - 1 - q] === final[final.length - 1 - q]) q++;
  return { from: p, to: doc.length - q, insert: final.slice(p, final.length - q), selFrom, selTo };
}

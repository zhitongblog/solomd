/**
 * Typora-style editing commands (bug/B4 section 七): select word, delete
 * word, select line, and heading level up / down / back to a paragraph.
 *
 * Same contract as lib/md-format.ts: pure text in, one edit (or one range)
 * out. SoloMD runs three editors — CodeMirror, and on Windows the plain block
 * editor and the plain flat editor — and a command written against one of
 * them is silently dead in the other two (IK6JCC, #316). So *what* changes is
 * decided here, and Editor.vue only reads the selection and applies the
 * result on each path.
 */

export type EditorCommand =
  | 'selectWord'
  | 'deleteWord'
  | 'selectLine'
  | 'jumpToSelection'
  | 'headingPromote'
  | 'headingDemote'
  | 'headingParagraph'
  | 'headingAutoNumber';

export const EDITOR_COMMANDS: EditorCommand[] = [
  'selectWord',
  'deleteWord',
  'selectLine',
  'jumpToSelection',
  'headingPromote',
  'headingDemote',
  'headingParagraph',
  'headingAutoNumber',
];

/** Commands that change the text (the rest only move the selection). */
export const EDITING_COMMANDS = new Set<EditorCommand>([
  'deleteWord',
  'headingPromote',
  'headingDemote',
  'headingParagraph',
  'headingAutoNumber',
]);

/** Commands that only make sense in a Markdown document. */
export const MARKDOWN_ONLY_COMMANDS = new Set<EditorCommand>([
  'headingPromote',
  'headingDemote',
  'headingParagraph',
  'headingAutoNumber',
]);

export interface Range {
  from: number;
  to: number;
}

export interface TextEdit {
  /** Replace `doc[from, to)` with `insert`… */
  from: number;
  to: number;
  insert: string;
  /** …then select this range (offsets in the *new* document). */
  selFrom: number;
  selTo: number;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

interface Segment {
  from: number;
  to: number;
  word: boolean;
}

/**
 * Word segments of one line. `Intl.Segmenter` knows where Chinese and
 * Japanese words end (there are no spaces to go by), so ⌘D on 中文输入法
 * selects 输入法 rather than the whole clause. Engines without it fall back
 * to runs of letters/digits.
 */
function segmentLine(line: string): Segment[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => {
    segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
  } }).Segmenter;
  if (Seg) {
    const out: Segment[] = [];
    for (const s of new Seg(undefined, { granularity: 'word' }).segment(line)) {
      out.push({ from: s.index, to: s.index + s.segment.length, word: !!s.isWordLike });
    }
    return out;
  }
  const out: Segment[] = [];
  let i = 0;
  while (i < line.length) {
    const word = WORD_CHAR.test(line[i]);
    let j = i + 1;
    while (j < line.length && WORD_CHAR.test(line[j]) === word) j++;
    out.push({ from: i, to: j, word });
    i = j;
  }
  return out;
}

function lineBounds(doc: string, pos: number): Range {
  const from = doc.lastIndexOf('\n', pos - 1) + 1;
  let to = doc.indexOf('\n', pos);
  if (to < 0) to = doc.length;
  return { from, to };
}

/**
 * The word under the caret (or the words a selection touches). A caret right
 * after a word — the usual place after typing it — takes that word; a caret
 * between two non-word characters has no word and returns null.
 */
export function wordRangeAt(doc: string, from: number, to: number = from): Range | null {
  const line = lineBounds(doc, from);
  const segs = segmentLine(doc.slice(line.from, line.to)).map((s) => ({
    from: s.from + line.from,
    to: s.to + line.from,
    word: s.word,
  }));
  const words = segs.filter((s) => s.word);
  if (!words.length) return null;
  if (from !== to) {
    const end = Math.min(to, line.to);
    const touched = words.filter((w) => w.to > from && w.from < end);
    if (!touched.length) return null;
    return { from: Math.min(from, touched[0].from), to: Math.max(end, touched[touched.length - 1].to) };
  }
  const inside = words.find((w) => from > w.from && from < w.to);
  if (inside) return { from: inside.from, to: inside.to };
  const after = words.find((w) => w.from === from);
  if (after) return { from: after.from, to: after.to };
  const before = words.find((w) => w.to === from);
  if (before) return { from: before.from, to: before.to };
  return null;
}

/** Select the word under the caret. Null when there is none. */
export function selectWord(doc: string, from: number, to: number = from): Range | null {
  return wordRangeAt(doc, from, to);
}

/**
 * Delete the word under the caret (or the words the selection touches). One
 * of the spaces around it goes too, so "a word here" becomes "a here", not
 * "a  here". Null when there is no word to delete.
 */
export function deleteWord(doc: string, from: number, to: number = from): TextEdit | null {
  const r = wordRangeAt(doc, from, to);
  if (!r) return null;
  let { from: s, to: e } = r;
  if (doc[e] === ' ' && (s === 0 || doc[s - 1] === ' ' || doc[s - 1] === '\n')) e += 1;
  else if (doc[s - 1] === ' ' && (e === doc.length || doc[e] === '\n' || /[\s.,;:!?)\]]/.test(doc[e]))) s -= 1;
  return { from: s, to: e, insert: '', selFrom: s, selTo: s };
}

/**
 * Select the line the caret is on (without its line break). Pressed again on
 * a selection that already spans whole lines, it takes the next line too —
 * so holding the chord grows the selection line by line, as in Typora.
 */
export function selectLine(doc: string, from: number, to: number = from): Range {
  const first = lineBounds(doc, from);
  const last = lineBounds(doc, Math.max(from, to));
  const wholeLines = from === first.from && to === last.to && to > from;
  if (wholeLines && last.to < doc.length) {
    const next = lineBounds(doc, last.to + 1);
    return { from: first.from, to: next.to };
  }
  return { from: first.from, to: last.to };
}

const HEADING = /^( {0,3})(#{1,6})([ \t]+|$)/;
const NOT_PARAGRAPH = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\||```|~~~|<|\$\$|---\s*$|\*\*\*\s*$|___\s*$)/;
const FENCE_LINE = /^([ \t]*)(?:>[ \t]?)*(`{3,}|~{3,})(.*)$/;

function commonIndentPrefixLen(line: string, indent: string): number {
  let k = 0;
  const max = Math.min(line.length, indent.length);
  while (k < max && line[k] === indent[k]) k++;
  return k;
}

/**
 * When the caret or selection sits inside a fenced code block, return the
 * character range of the block's inner body (excluding the opening and closing
 * fence lines, and starting after the first body line's fence alignment indent)
 * so `Ctrl/Cmd+A` selects just the code block first.
 *
 * Returns `null` when the selection is outside any fenced block, when the code
 * block has no body lines, or when the selection already covers the entire
 * code block body (so pressing `Ctrl/Cmd+A` a second time selects the whole
 * document).
 */
export function selectCodeBlockBody(doc: string, from: number, to: number = from): Range | null {
  const selFrom = Math.max(0, Math.min(from, to));
  const selTo = Math.min(doc.length, Math.max(from, to));
  const lines = doc.split('\n');

  let offset = 0;
  let openFence: {
    indent: string;
    ch: string;
    len: number;
    openStart: number;
    bodyStart: number;
    firstBodyLine: string;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const m = FENCE_LINE.exec(line);

    if (!openFence) {
      if (m && (m[2][0] === '~' || !m[3].includes('`'))) {
        openFence = {
          indent: m[1],
          ch: m[2][0],
          len: m[2].length,
          openStart: lineStart,
          bodyStart: Math.min(doc.length, lineEnd + 1),
          firstBodyLine: lines[i + 1] ?? '',
        };
      }
    } else if (m && m[2][0] === openFence.ch && m[2].length >= openFence.len && m[3].trim() === '') {
      const closeStart = lineStart;
      const closeEnd = lineEnd;
      if (selFrom >= openFence.openStart && selTo <= closeEnd) {
        const rawBodyFrom = Math.min(openFence.bodyStart, closeStart);
        const bodyTo = Math.max(rawBodyFrom, closeStart > openFence.bodyStart ? closeStart - 1 : closeStart);
        if (bodyTo <= rawBodyFrom) return null;
        const firstStrip = commonIndentPrefixLen(openFence.firstBodyLine, openFence.indent);
        const bodyFrom = rawBodyFrom + firstStrip <= bodyTo ? rawBodyFrom + firstStrip : rawBodyFrom;
        if (selFrom >= rawBodyFrom && selFrom <= bodyFrom && selTo === bodyTo) return null;
        return { from: bodyFrom, to: bodyTo };
      }
      openFence = null;
    }

    offset = lineEnd + 1;
  }

  if (openFence && selFrom >= openFence.openStart && selTo <= doc.length) {
    const rawBodyFrom = openFence.bodyStart;
    const bodyTo = doc.length;
    if (bodyTo <= rawBodyFrom) return null;
    const firstStrip = commonIndentPrefixLen(openFence.firstBodyLine, openFence.indent);
    const bodyFrom = rawBodyFrom + firstStrip <= bodyTo ? rawBodyFrom + firstStrip : rawBodyFrom;
    if (selFrom >= rawBodyFrom && selFrom <= bodyFrom && selTo === bodyTo) return null;
    return { from: bodyFrom, to: bodyTo };
  }

  return null;
}

/**
 * Strip the enclosing code fence's alignment indentation from a selection
 * inside a fenced code block (whether selected by dragging with the mouse or
 * via `Ctrl/Cmd+A`), while preserving relative code indentation inside the block.
 */
export function dedentCodeBlockSelection(
  doc: string,
  from: number,
  to: number,
  rawText?: string,
): string {
  const selFrom = Math.max(0, Math.min(from, to, doc.length));
  const selTo = Math.max(0, Math.min(Math.max(from, to), doc.length));
  const text = rawText ?? doc.slice(selFrom, selTo);
  if (!text || selFrom === selTo) return text;

  const lines = doc.split('\n');
  let offset = 0;
  let openFence: {
    indent: string;
    ch: string;
    len: number;
    openStart: number;
    bodyStart: number;
  } | null = null;
  let matchedIndent: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const m = FENCE_LINE.exec(line);

    if (!openFence) {
      if (m && (m[2][0] === '~' || !m[3].includes('`'))) {
        openFence = {
          indent: m[1],
          ch: m[2][0],
          len: m[2].length,
          openStart: lineStart,
          bodyStart: Math.min(doc.length, lineEnd + 1),
        };
      }
    } else if (m && m[2][0] === openFence.ch && m[2].length >= openFence.len && m[3].trim() === '') {
      const closeStart = lineStart;
      const bodyEnd = closeStart > openFence.bodyStart ? closeStart - 1 : closeStart;
      if (selFrom >= openFence.bodyStart && selTo <= bodyEnd) {
        matchedIndent = openFence.indent;
        break;
      }
      openFence = null;
    }

    offset = lineEnd + 1;
  }

  if (matchedIndent === null && openFence && selFrom >= openFence.bodyStart && selTo <= doc.length) {
    matchedIndent = openFence.indent;
  }

  if (!matchedIndent) return text;

  const firstLineStart = selFrom > 0 ? doc.lastIndexOf('\n', selFrom - 1) + 1 : 0;
  let firstLineEnd = doc.indexOf('\n', firstLineStart);
  if (firstLineEnd < 0) firstLineEnd = doc.length;
  const firstLine = doc.slice(firstLineStart, firstLineEnd);
  const fromCol = selFrom - firstLineStart;
  const firstLineFenceIndent = commonIndentPrefixLen(firstLine, matchedIndent);
  const stripFirst = Math.max(0, firstLineFenceIndent - fromCol);

  const selLines = text.split('\n');
  return selLines
    .map((line, idx) => {
      if (idx === 0) {
        const drop = Math.min(stripFirst, commonIndentPrefixLen(line, matchedIndent.slice(fromCol)));
        return line.slice(drop);
      }
      return line.slice(commonIndentPrefixLen(line, matchedIndent));
    })
    .join('\n');
}

/**
 * Align pasted text to the enclosing fenced code block's opening-fence
 * indentation (`fenceIndent`), while preserving each pasted line's relative
 * code indentation.
 */
export function indentCodeBlockPaste(
  doc: string,
  from: number,
  to: number,
  rawText: string,
): string {
  if (!rawText) return rawText;
  const selFrom = Math.max(0, Math.min(from, to, doc.length));
  const selTo = Math.max(0, Math.min(Math.max(from, to), doc.length));

  const lines = doc.split('\n');
  let offset = 0;
  let openFence: {
    indent: string;
    ch: string;
    len: number;
    openStart: number;
    bodyStart: number;
  } | null = null;
  let matchedIndent: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const m = FENCE_LINE.exec(line);

    if (!openFence) {
      if (m && (m[2][0] === '~' || !m[3].includes('`'))) {
        openFence = {
          indent: m[1],
          ch: m[2][0],
          len: m[2].length,
          openStart: lineStart,
          bodyStart: Math.min(doc.length, lineEnd + 1),
        };
      }
    } else if (m && m[2][0] === openFence.ch && m[2].length >= openFence.len && m[3].trim() === '') {
      const closeStart = lineStart;
      const bodyEnd = closeStart > openFence.bodyStart ? closeStart - 1 : closeStart;
      if (selFrom >= openFence.bodyStart && selTo <= bodyEnd) {
        matchedIndent = openFence.indent;
        break;
      }
      openFence = null;
    }

    offset = lineEnd + 1;
  }

  if (matchedIndent === null && openFence && selFrom >= openFence.bodyStart && selTo <= doc.length) {
    matchedIndent = openFence.indent;
  }

  if (!matchedIndent) return rawText;

  const firstLineStart = selFrom > 0 ? doc.lastIndexOf('\n', selFrom - 1) + 1 : 0;
  const prefixBefore = doc.slice(firstLineStart, selFrom);
  let missingFirst = '';
  if (
    /^[ \t]*$/.test(prefixBefore) &&
    prefixBefore.length < matchedIndent.length &&
    matchedIndent.startsWith(prefixBefore)
  ) {
    missingFirst = matchedIndent.slice(prefixBefore.length);
  }

  const normalized = rawText.replace(/\r\n?/g, '\n');
  const pasteLines = normalized.split('\n');
  return pasteLines
    .map((line, idx) => {
      if (idx === 0) {
        return missingFirst ? `${missingFirst}${line}` : line;
      }
      if (line.length === 0 && idx < pasteLines.length - 1) {
        return '';
      }
      return `${matchedIndent}${line}`;
    })
    .join('\n');
}

/** Which lines sit inside a fenced code block (so ⌘= there does nothing). */
function fencedLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(true);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length).trim()) {
        fence = null;
      }
    } else if (m) {
      out.push(true);
      fence = m[1];
    } else {
      out.push(false);
    }
  }
  return out;
}

/**
 * Change the heading level of every line the selection touches.
 *
 * - `promote` (Typora ⌘=): H3 → H2 … H1 stays; a plain paragraph becomes H6.
 * - `demote`  (Typora ⌘-): H2 → H3 … H6 becomes a paragraph again.
 * - `paragraph` (Typora ⌘0): drop the heading marker.
 *
 * Promote and demote are inverses, so one key undoes the other. Lists,
 * quotes, tables, fences and blank lines are left alone — turning a list item
 * into a heading is never what the chord meant. Null when nothing changes.
 */
export function shiftHeading(
  doc: string,
  from: number,
  to: number,
  mode: 'promote' | 'demote' | 'paragraph',
): TextEdit | null {
  const start = lineBounds(doc, from).from;
  const end = lineBounds(doc, Math.max(from, to)).to;
  const allLines = doc.split('\n');
  const fenced = fencedLines(allLines);
  // Index of the first touched line.
  let firstIdx = 0;
  for (let i = 0, off = 0; i < allLines.length; i++) {
    if (off === start) { firstIdx = i; break; }
    off += allLines[i].length + 1;
  }
  const touched = doc.slice(start, end).split('\n');
  let changed = false;
  const out = touched.map((line, k) => {
    if (fenced[firstIdx + k]) return line;
    const m = HEADING.exec(line);
    let next = line;
    if (m) {
      const level = m[2].length;
      const rest = line.slice(m[0].length);
      if (mode === 'paragraph' || (mode === 'demote' && level === 6)) next = m[1] + rest;
      else if (mode === 'promote') next = level > 1 ? `${m[1]}${'#'.repeat(level - 1)} ${rest}` : line;
      else next = `${m[1]}${'#'.repeat(level + 1)} ${rest}`;
    } else if (mode === 'promote' && line.trim() && !NOT_PARAGRAPH.test(line)) {
      next = `###### ${line.replace(/^ {0,3}/, '')}`;
    }
    if (next !== line) changed = true;
    return next;
  });
  if (!changed) return null;
  return { from: start, to: end, insert: out.join('\n'), ...mapSelection(touched, out, start, from, to) };
}

/** Map selection ends through per-line marker rewrites (line count is fixed). */
function mapSelection(
  before: string[],
  after: string[],
  start: number,
  from: number,
  to: number,
): { selFrom: number; selTo: number } {
  const map = (p: number): number => {
    let oldOff = start;
    let newOff = start;
    for (let i = 0; i < before.length; i++) {
      const a = before[i];
      const b = after[i];
      if (p <= oldOff + a.length) {
        const col = p - oldOff;
        // The line start stays the line start (a selection of whole lines
        // keeps covering them).
        if (a === b || col === 0) return newOff + col;
        // Content after the marker keeps its place relative to the line end.
        const fromEnd = a.length - col;
        return newOff + Math.max(contentStart(b), b.length - fromEnd);
      }
      oldOff += a.length + 1;
      newOff += b.length + 1;
    }
    return newOff + (p - oldOff);
  };
  return { selFrom: map(from), selTo: map(to) };
}

function contentStart(line: string): number {
  const m = HEADING.exec(line);
  return m ? m[0].length : line.length - line.trimStart().length;
}

const HEADING_NUM_PREFIX = /^(\d+(?:\.\d+)*\.?[ \t]+)/;

/**
 * #474 — Automatically number (or renumber / unnumber) multi-level ATX
 * headings (`# 1. Title`, `## 1.1 Section`, `### 1.1.1 Subsection`).
 *
 * - Skips YAML front matter and fenced code blocks.
 * - Normalizes the top-most heading level present in the document to depth 0
 *   (so documents starting at `##` still begin at `1.`, `1.1`, etc.).
 * - If every heading in the document already carries the exact up-to-date
 *   hierarchical number prefix, running `toggle` strips the numbers cleanly;
 *   otherwise it adds or updates all heading numbers.
 */
export function autoNumberHeadings(
  doc: string,
  from: number,
  to: number,
  mode: 'toggle' | 'add' | 'remove' = 'toggle',
): TextEdit | null {
  const lines = doc.split('\n');
  const fenced = fencedLines(lines);

  // Skip leading YAML front matter if present on line 0.
  let bodyStartIdx = 0;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---' || lines[i].trim() === '...') {
        bodyStartIdx = i + 1;
        break;
      }
    }
  }

  const numberedLines = [...lines];
  const unnumberedLines = [...lines];
  let hasOrphanNumber = false;
  const headingIndices: Array<{ idx: number; indent: string; hashes: string; level: number; rest: string; cleanRest: string }> = [];
  for (let i = bodyStartIdx; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    const rest = lines[i].slice(m[0].length);
    if (!rest.trim()) continue;
    const numMatch = HEADING_NUM_PREFIX.exec(rest);
    const cleanRest = numMatch ? rest.slice(numMatch[0].length) : rest;
    if (!cleanRest.trim()) {
      if (numMatch) {
        numberedLines[i] = `${m[1]}${m[2]} ${cleanRest}`;
        unnumberedLines[i] = `${m[1]}${m[2]} ${cleanRest}`;
        hasOrphanNumber = true;
      }
      continue;
    }
    headingIndices.push({
      idx: i,
      indent: m[1],
      hashes: m[2],
      level: m[2].length,
      rest,
      cleanRest,
    });
  }

  if (headingIndices.length === 0 && !hasOrphanNumber) return null;

  const minLevel = headingIndices.length > 0 ? Math.min(...headingIndices.map((h) => h.level)) : 1;
  const counters = [0, 0, 0, 0, 0, 0];
  let allAlreadyMatchNumbered = !hasOrphanNumber;

  for (const h of headingIndices) {
    const depth = Math.max(0, Math.min(5, h.level - minLevel));
    for (let d = 0; d < depth; d++) {
      if (counters[d] === 0) counters[d] = 1;
    }
    counters[depth] += 1;
    for (let d = depth + 1; d < 6; d++) {
      counters[d] = 0;
    }
    const prefix =
      depth === 0
        ? `${counters[0]}. `
        : `${counters.slice(0, depth + 1).join('.')} `;
    const numbered = `${h.indent}${h.hashes} ${prefix}${h.cleanRest}`;
    const unnumbered = `${h.indent}${h.hashes} ${h.cleanRest}`;
    numberedLines[h.idx] = numbered;
    unnumberedLines[h.idx] = unnumbered;
    if (lines[h.idx] !== numbered) {
      allAlreadyMatchNumbered = false;
    }
  }

  const targetLines =
    mode === 'remove' || (mode === 'toggle' && allAlreadyMatchNumbered)
      ? unnumberedLines
      : numberedLines;

  const nextDoc = targetLines.join('\n');
  if (nextDoc === doc) return null;
  // #489 — compute the minimal changed span rather than replacing 0..doc.length
  // so CodeMirror does not tear down and re-measure every line/widget in the
  // document (which caused the viewport to jump when typing headings).
  let diffStart = 0;
  const minLen = Math.min(doc.length, nextDoc.length);
  while (diffStart < minLen && doc.charCodeAt(diffStart) === nextDoc.charCodeAt(diffStart)) {
    diffStart++;
  }
  let oldEnd = doc.length;
  let newEnd = nextDoc.length;
  while (
    oldEnd > diffStart &&
    newEnd > diffStart &&
    doc.charCodeAt(oldEnd - 1) === nextDoc.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  return {
    from: diffStart,
    to: oldEnd,
    insert: nextDoc.slice(diffStart, newEnd),
    ...mapSelection(lines, targetLines, 0, from, to),
  };
}


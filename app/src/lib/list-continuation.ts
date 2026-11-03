/**
 * Markdown list / quote continuation on Enter for the plain-textarea editors
 * (Windows, #341). CodeMirror gets the same behaviour from
 * `insertNewlineContinueMarkup`; this is the textarea equivalent, kept pure so
 * both plain paths (flat textarea and live-edit blocks) share one rule.
 *
 *   - `- item|`        → `- item\n- |`
 *   - `3. item|`       → `3. item\n4. |`   (`)` delimiters kept)
 *   - `- [x] done|`    → `- [x] done\n- [ ] |`
 *   - `> > quote|`     → `> > quote\n> > |`
 *   - `> - item|`      → `> - item\n> - |`
 *   - Enter on an empty item removes that item's marker (ends the list /
 *     quote), leaving the line empty — the second Enter of "Enter, Enter".
 *
 * Returns null whenever a plain newline is the right answer: a selection, the
 * caret inside the marker itself, a line that is not a list/quote, or a line
 * inside a fenced code block.
 */

export interface ContinuationEdit {
  value: string;
  caret: number;
}

// Leading indent + any number of `>` quote markers (each with optional space).
const QUOTE_PREFIX = /^([ \t]*(?:>[ \t]?)*)/;
// A list marker right after the quote prefix: bullet or ordered, then an
// optional task box.
const LIST_MARKER = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;
// Ordered list marker missing its trailing space before CJK text (e.g. `1.当前...`).
const NO_SPACE_CJK_ORDERED = /^([ \t]*)(\d{1,3})([.)])(?=[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef“”‘’（【《「『])/;
const FENCE_LINE = /^([ \t]*(?:>[ \t]?)*)(`{3,}|~{3,})(.*)$/;

/**
 * If `lineStart` sits inside an open ``` / ~~~ fence of `text`, returns the
 * leading indent/quote prefix of that opening fence line (e.g. `""` or `"   "`);
 * otherwise returns `null`.
 */
export function enclosingFenceIndent(text: string, lineStart: number): string | null {
  let open: { indent: string; ch: string; len: number } | null = null;
  const before = text.slice(0, lineStart);
  for (const line of before.split('\n')) {
    const m = line.match(FENCE_LINE);
    if (!m) continue;
    const indent = m[1];
    const ch = m[2][0];
    const len = m[2].length;
    const rest = m[3];
    if (!open) {
      // A backtick opener's info string may not contain backticks.
      if (ch === '`' && rest.includes('`')) continue;
      open = { indent, ch, len };
    } else if (ch === open.ch && len >= open.len && rest.trim() === '') {
      open = null;
    }
  }
  return open ? open.indent : null;
}

/** True when `lineStart` sits inside an open ``` / ~~~ fence of `text`. */
export function insideFence(text: string, lineStart: number): boolean {
  return enclosingFenceIndent(text, lineStart) !== null;
}

/**
 * Find the content-column indentation of the list item enclosing `lineStart`
 * (scanning upward through non-blank lines), or `null` if not in a list item.
 */
export function enclosingListContentIndent(text: string, lineStart: number): string | null {
  const before = text.slice(0, lineStart);
  const lines = before.split('\n');
  // Note: `before` ends at `lineStart` (right after `\n`), so the last element
  // of `before.split('\n')` is `""` when `lineStart > 0`.
  const startIdx = lineStart > 0 && before.endsWith('\n') ? lines.length - 2 : lines.length - 1;
  for (let i = startIdx; i >= 0; i--) {
    const ln = lines[i];
    if (ln.trim() === '') return null;
    const q = ln.match(QUOTE_PREFIX)?.[1] ?? '';
    const r = ln.slice(q.length);
    const m = r.match(LIST_MARKER);
    if (m) {
      const [, ind, bullet, num, delim, gap] = m;
      const sep = gap.includes('\t') ? gap : gap.length > 4 ? ' ' : gap;
      const head = bullet ?? `${num}${delim}`;
      return `${q}${ind}${' '.repeat(head.length + sep.length)}`;
    }
    // An indented continuation line keeps scanning up to find the list item.
    if (!/^[ \t]{2,}\S/.test(r)) return null;
  }
  return null;
}

export function computeListContinuation(
  text: string,
  selStart: number,
  selEnd: number,
): ContinuationEdit | null {
  if (selStart !== selEnd) return null;
  const caret = selStart;
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const nl = text.indexOf('\n', caret);
  const lineEnd = nl < 0 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);

  const fenceIndent = enclosingFenceIndent(text, lineStart);
  if (fenceIndent !== null) {
    // Inside an indented fenced code block (e.g. nested in a list item), keep
    // at least the opening fence's indentation on Enter so the new line does
    // not drop to column 0 and break the CommonMark fence/list.
    const lineIndent = /^[ \t]*/.exec(line)?.[0] ?? '';
    const keepIndent = lineIndent.length >= fenceIndent.length ? lineIndent : fenceIndent;
    if (!keepIndent) return null;
    const insert = `\n${keepIndent}`;
    return { value: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }

  // Pressing Enter at the end of an opening fence line (e.g. `   ```js|`):
  // - If the next line is already a whitespace-only body line followed by a
  //   closing fence (created by Ctrl+Alt+K / toolbar codeblock), step onto it
  //   at the fence's indentation instead of inserting a duplicate blank line.
  // - Otherwise, if the opening fence is indented, carry its indentation onto
  //   the new inner line.
  const openFence = line.match(FENCE_LINE);
  if (openFence && !(openFence[2][0] === '`' && openFence[3].includes('`'))) {
    const openerIndent = openFence[1];
    const fenceMarker = openFence[2];
    if (caret === lineEnd && nl >= 0) {
      const nextLineStart = nl + 1;
      const nextNl = text.indexOf('\n', nextLineStart);
      const nextLineEnd = nextNl < 0 ? text.length : nextNl;
      const nextLine = text.slice(nextLineStart, nextLineEnd);
      if (/^[ \t]*$/.test(nextLine) && nextNl >= 0) {
        const afterNextStart = nextNl + 1;
        const afterNextNl = text.indexOf('\n', afterNextStart);
        const afterNextLine = text.slice(afterNextStart, afterNextNl < 0 ? text.length : afterNextNl);
        const closeRe = new RegExp(`^[ \\t]*${fenceMarker[0]}{${fenceMarker.length},}[ \\t]*$`);
        if (closeRe.test(afterNextLine)) {
          const patched =
            text.slice(0, nextLineStart) + openerIndent + text.slice(nextLineEnd);
          return { value: patched, caret: nextLineStart + openerIndent.length };
        }
      }
    }
    if (openerIndent.length > 0 && caret >= lineStart + openerIndent.length + fenceMarker.length) {
      const insert = `\n${openerIndent}`;
      return { value: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
    }
    return null;
  }

  const quote = line.match(QUOTE_PREFIX)?.[1] ?? '';
  const hasQuote = quote.includes('>');
  const rest = line.slice(quote.length);
  const list = rest.match(LIST_MARKER);
  const noSpaceList = !list ? rest.match(NO_SPACE_CJK_ORDERED) : null;

  let markerLen: number; // length of the whole marker on this line
  let nextMarker: string; // marker for the new line
  if (list) {
    const [whole, indent, bullet, num, delim, gap, task] = list;
    markerLen = quote.length + whole.length;
    // Normalise the gap after the marker to one space unless it was a
    // deliberate multi-space alignment (keep it then — it is the item's
    // content column).
    const sep = gap.includes('\t') ? gap : gap.length > 4 ? ' ' : gap;
    const head = bullet ?? `${Number(num) + 1}${delim}`;
    nextMarker = `${quote}${indent}${head}${sep}${task ? '[ ] ' : ''}`;
  } else if (noSpaceList) {
    const [whole, indent, num, delim] = noSpaceList;
    markerLen = quote.length + whole.length;
    if (caret - lineStart < markerLen) return null;
    const spacePos = lineStart + markerLen;
    const insert = `\n${quote}${indent}${Number(num) + 1}${delim} `;
    const value =
      text.slice(0, spacePos) + ' ' + text.slice(spacePos, caret) + insert + text.slice(caret);
    return { value, caret: caret + 1 + insert.length };
  } else if (hasQuote) {
    markerLen = quote.length;
    // `>` without a trailing space still continues as `> `.
    nextMarker = /[ \t]$/.test(quote) ? quote : `${quote} `;
  } else {
    // Check if this is an indented continuation line of a list item above it
    // (e.g. created by Shift+Enter).
    const listIndent = enclosingListContentIndent(text, lineStart);
    const leadWs = /^[ \t]+/.exec(line)?.[0] ?? '';
    if (listIndent && leadWs.length >= listIndent.length) {
      if (line.trim() === '' && caret === lineEnd) {
        // Enter on an empty list-continuation line drops the indentation.
        return { value: text.slice(0, lineStart) + text.slice(lineEnd), caret: lineStart };
      }
      if (caret >= lineStart + leadWs.length) {
        const insert = `\n${leadWs}`;
        return { value: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
      }
    }
    return null;
  }

  // Caret inside (or before) the marker: splitting there would duplicate it.
  if (caret - lineStart < markerLen) return null;

  const content = line.slice(markerLen);
  if (content.trim() === '' && caret === lineEnd) {
    // Empty item → drop the marker and end the list here. For a list inside a
    // quote, keep the quote (`> - ` → `> `); a bare quote line ends the quote.
    const keep = list && hasQuote ? (/[ \t]$/.test(quote) ? quote : `${quote} `) : '';
    const value = text.slice(0, lineStart) + keep + text.slice(lineEnd);
    return { value, caret: lineStart + keep.length };
  }

  const insert = `\n${nextMarker}`;
  return { value: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
}

/**
 * Markdown list / quote soft line break on `Shift + Enter`:
 * Instead of starting a new list item (`2. ` / `- `), inserts a newline
 * indented to the current list item's content column (e.g. 3 spaces under
 * `1. item`, 2 spaces under `- item` or `- [ ] item`) so subsequent text or
 * a fenced code block stays nested inside the list item.
 */
export function computeListSoftBreak(
  text: string,
  selStart: number,
  selEnd: number,
): ContinuationEdit | null {
  if (selStart !== selEnd) return null;
  const caret = selStart;
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const nl = text.indexOf('\n', caret);
  const lineEnd = nl < 0 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);

  const fenceIndent = enclosingFenceIndent(text, lineStart);
  if (fenceIndent !== null) {
    const lineIndent = /^[ \t]*/.exec(line)?.[0] ?? '';
    const keepIndent = lineIndent.length >= fenceIndent.length ? lineIndent : fenceIndent;
    if (!keepIndent) return null;
    const insert = `\n${keepIndent}`;
    return { value: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }

  const openFence = line.match(FENCE_LINE);
  if (openFence && !(openFence[2][0] === '`' && openFence[3].includes('`'))) {
    const openerIndent = openFence[1];
    if (openerIndent.length > 0 && caret >= lineStart + openerIndent.length + openFence[2].length) {
      const insert = `\n${openerIndent}`;
      return { value: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
    }
    return null;
  }

  const quote = line.match(QUOTE_PREFIX)?.[1] ?? '';
  const hasQuote = quote.includes('>');
  const rest = line.slice(quote.length);
  const list = rest.match(LIST_MARKER);

  if (list) {
    const [whole, indent, bullet, num, delim, gap] = list;
    const markerLen = quote.length + whole.length;
    if (caret - lineStart < markerLen) return null;
    const sep = gap.includes('\t') ? gap : gap.length > 4 ? ' ' : gap;
    const head = bullet ?? `${num}${delim}`;
    const contentIndent = `${quote}${indent}${' '.repeat(head.length + sep.length)}`;
    const insert = `\n${contentIndent}`;
    return { value: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }

  if (hasQuote) {
    if (caret - lineStart < quote.length) return null;
    const leadWs = /^[ \t]*/.exec(rest)?.[0] ?? '';
    const baseQuote = /[ \t]$/.test(quote) ? quote : `${quote} `;
    const insert = `\n${baseQuote}${leadWs}`;
    return { value: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }

  const listIndent = enclosingListContentIndent(text, lineStart);
  const leadWs = /^[ \t]+/.exec(line)?.[0] ?? '';
  if (listIndent && leadWs.length >= listIndent.length && caret >= lineStart + leadWs.length) {
    const insert = `\n${leadWs}`;
    return { value: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }

  return null;
}

/**
 * When a user types or pastes on a line inside an indented fenced code block
 * (e.g. `   ``` ...    ``` ` inside a list item) whose leading whitespace is
 * shorter than the opening fence's indentation (such as an empty line `""`
 * after manually indenting the fences or deleting the code body), prepend the
 * missing fence indentation so the line does not start at column 0 and break
 * the CommonMark fenced code block.
 */
export function repairIndentedFenceEdit(
  doc: string,
  editFrom: number,
  editTo: number,
  caret: number,
): { value: string; caret: number; changes: Array<{ from: number; to: number; insert: string }> } | null {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let pos = 0;
  for (;;) {
    const nl = doc.indexOf('\n', pos);
    const end = nl < 0 ? doc.length : nl;
    lines.push({ start: pos, end, text: doc.slice(pos, end) });
    if (nl < 0) break;
    pos = nl + 1;
  }

  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let open: { lineIdx: number; indent: string; ch: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(t);
    if (m) {
      const lead = /^[ \t]*/.exec(t)![0];
      const ch = m[1][0];
      const len = m[1].length;
      const rest = m[2];
      if (!open) {
        if (ch === '~' || !rest.includes('`')) {
          open = { lineIdx: i, indent: lead, ch, len };
        }
      } else if (ch === open.ch && len >= open.len && rest.trim() === '') {
        if (open.indent.length > 0) {
          for (let j = open.lineIdx + 1; j < i; j++) {
            const ln = lines[j];
            if (ln.end < editFrom || ln.start > editTo) continue;
            // Only repair non-empty lines (or the caret line when text was just inserted)
            if (ln.text.length === 0) continue;
            const curLead = /^[ \t]*/.exec(ln.text)![0];
            if (curLead.length < open.indent.length && open.indent.startsWith(curLead)) {
              const missing = open.indent.slice(curLead.length);
              changes.push({ from: ln.start, to: ln.start, insert: missing });
            }
          }
        }
        open = null;
      }
    }
  }

  if (changes.length === 0) return null;
  let value = doc;
  let nextCaret = caret;
  for (let k = changes.length - 1; k >= 0; k--) {
    const c = changes[k];
    value = value.slice(0, c.from) + c.insert + value.slice(c.to);
    if (c.from <= nextCaret) {
      nextCaret += c.insert.length - (c.to - c.from);
    }
  }
  return { value, caret: nextCaret, changes };
}

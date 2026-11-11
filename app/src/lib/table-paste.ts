/**
 * #460 — Convert spreadsheet / HTML / TSV clipboard data (Excel, WPS,
 * Numbers, Google Sheets, web tables) into a GFM Markdown table on paste.
 *
 * Excel and WPS place a bitmap preview (`image/png`) on the clipboard alongside
 * `text/html` (`<table>…</table>`) and `text/plain` (tab-separated values).
 * Checking for tabular clipboard content before the image-paste handler runs
 * turns spreadsheet pastes into editable Markdown tables instead of images.
 */

export type ColumnAlign = 'left' | 'center' | 'right' | null;

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    });
}

function cleanCellHtml(rawHtml: string): string {
  // Strip comments, style, and script blocks (Excel/WPS embed `<style>` and
  // `<!--StartFragment-->` comments inside fragments).
  let text = rawHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:style|script|meta|link|xml)\b[^>]*>[\s\S]*?<\/(?:style|script|xml)>/gi, '')
    .replace(/<(?:style|script|meta|link)\b[^>]*\/?>/gi, '');

  // Newlines in HTML source are plain whitespace (Outlook / Word hard-wrap
  // paragraphs inside cells), not line breaks. Only `<br>` and block
  // boundaries below are real breaks.
  text = text.replace(/\s*[\r\n]+\s*/g, ' ');

  // Turn explicit line breaks (`<br>`, adjacent block closes/opens) into `\n`
  // first, then collapse multi-line cell content into `<br>`.
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr)\s*>\s*<(?:p|div|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  text = decodeHtmlEntities(text).replace(/\r\n?/g, '\n');

  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && idx < arr.length - 1));

  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('<br>');
}

function escapeMarkdownCell(cell: string): string {
  return cell
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s, i, a) => s.length > 0 || (i > 0 && i < a.length - 1))
    .join('<br>')
    .replace(/\|/g, '\\|');
}

function parseCellAlign(attrs: string): ColumnAlign {
  const alignAttr = /\balign\s*=\s*["']?\s*(left|center|right)\b/i.exec(attrs);
  if (alignAttr) return alignAttr[1].toLowerCase() as ColumnAlign;
  const styleAlign = /\btext-align\s*:\s*(left|center|right)\b/i.exec(attrs);
  if (styleAlign) return styleAlign[1].toLowerCase() as ColumnAlign;
  return null;
}

/**
 * Format a 2D array of cell strings into a GFM Markdown table.
 */
export function formatMarkdownTable(
  rows: string[][],
  aligns?: ColumnAlign[],
): string | null {
  if (rows.length === 0) return null;
  const colCount = Math.max(0, ...rows.map((r) => r.length));
  if (colCount === 0) return null;
  // A single 1×1 cell is prose, not a table.
  if (rows.length === 1 && colCount < 2) return null;
  // Require at least one non-empty cell.
  const hasContent = rows.some((r) => r.some((c) => c.trim().length > 0));
  if (!hasContent) return null;

  const normRows = rows.map((row) => {
    const out: string[] = [];
    for (let c = 0; c < colCount; c++) {
      out.push(escapeMarkdownCell(row[c] ?? ''));
    }
    return out;
  });

  // If the table has only 1 row (e.g. a single horizontal row of ≥2 cells
  // copied from Excel), add an empty body row so GFM parsers recognize it as a
  // valid table.
  if (normRows.length === 1) {
    normRows.push(new Array(colCount).fill(''));
  }

  const header = normRows[0];
  const sep = new Array(colCount).fill(0).map((_, idx) => {
    const a = aligns?.[idx] ?? null;
    if (a === 'center') return ':---:';
    if (a === 'right') return '---:';
    if (a === 'left') return ':---';
    return '---';
  });

  const lines: string[] = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${sep.join(' | ')} |`);
  for (let r = 1; r < normRows.length; r++) {
    lines.push(`| ${normRows[r].join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * Extract the first `<table>` from clipboard HTML and convert it to a GFM
 * Markdown table, or return `null` if no meaningful table is present.
 */
export function htmlTableToMarkdown(html: string): string | null {
  if (!html || !/<table[\s>]/i.test(html)) return null;
  const tableMatch = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!tableMatch) return null;
  const tableInner = tableMatch[1];
  // Skip nested layout tables if the table contains another `<table` inside it.
  if (/<table[\s>]/i.test(tableInner)) return null;

  const rows: string[][] = [];
  const aligns: ColumnAlign[] = [];
  // Track pending rowspans: colIndex -> { remainingRows, text }
  const activeRowspans = new Map<number, { remaining: number; text: string }>();

  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(tableInner)) !== null) {
    const trInner = trMatch[1];
    const row: string[] = [];
    let colIdx = 0;

    const flushRowspansAt = () => {
      while (activeRowspans.has(colIdx)) {
        const span = activeRowspans.get(colIdx)!;
        row.push('');
        span.remaining -= 1;
        if (span.remaining <= 0) activeRowspans.delete(colIdx);
        colIdx += 1;
      }
    };

    const cellRegex = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(trInner)) !== null) {
      flushRowspansAt();
      const attrs = cellMatch[2] || '';
      const cellContent = cleanCellHtml(cellMatch[3] || '');
      const colspanMatch = /\bcolspan\s*=\s*["']?(\d+)/i.exec(attrs);
      const rowspanMatch = /\browspan\s*=\s*["']?(\d+)/i.exec(attrs);
      const colspan = Math.min(32, Math.max(1, colspanMatch ? Number.parseInt(colspanMatch[1], 10) : 1));
      const rowspan = Math.min(128, Math.max(1, rowspanMatch ? Number.parseInt(rowspanMatch[1], 10) : 1));
      const align = parseCellAlign(attrs);

      for (let c = 0; c < colspan; c++) {
        const targetCol = colIdx + c;
        if (aligns[targetCol] === undefined && align) {
          aligns[targetCol] = align;
        }
        row.push(c === 0 ? cellContent : '');
        if (rowspan > 1) {
          activeRowspans.set(targetCol, { remaining: rowspan - 1, text: '' });
        }
      }
      colIdx += colspan;
    }
    flushRowspansAt();
    if (row.length > 0) {
      rows.push(row);
    }
  }

  return formatMarkdownTable(rows, aligns);
}

/**
 * Convert tab-separated plain text (TSV) into a GFM Markdown table when it
 * clearly represents a multi-row, multi-column spreadsheet selection.
 */
export function tsvToMarkdown(plainText: string): string | null {
  if (!plainText || !plainText.includes('\t')) return null;
  const trimmed = plainText.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const rawLines = trimmed.split('\n');
  if (rawLines.length < 2) return null;

  // Reject indented code where tabs only appear at the beginning of lines.
  const hasInteriorTab = rawLines.some((l) => /\S\t/.test(l) || /\t\S/.test(l.replace(/^\t+/, '')));
  if (!hasInteriorTab) return null;

  // Every line in a TSV selection from Excel/WPS/Sheets has at least one tab.
  if (!rawLines.every((l) => l.includes('\t'))) return null;

  const rows = rawLines.map((line) => line.split('\t'));
  const colCounts = rows.map((r) => r.length);
  const firstCols = colCounts[0] ?? 0;
  if (firstCols < 2) return null;
  // All rows must have the same number of tab-separated columns.
  if (!colCounts.every((c) => c === firstCols)) return null;

  return formatMarkdownTable(rows);
}

/**
 * Inspect `text/html` and `text/plain` from a paste event and return a GFM
 * Markdown table if the clipboard holds spreadsheet cells or an HTML table.
 */
/**
 * True when the clipboard HTML is essentially just one table (what Excel / WPS
 * / Sheets put on the clipboard): nothing but whitespace or `&nbsp;` outside
 * the `<table>`. A table embedded in a larger document (an Outlook / Word /
 * web-page selection with paragraphs, headings, lists) must be left to the
 * general HTML-to-Markdown converter so the surrounding content is not dropped.
 */
export function isTableOnlyHtml(html: string): boolean {
  const withoutTable = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:style|script|head|xml)\b[^>]*>[\s\S]*?<\/(?:style|script|head|xml)\s*>/gi, '')
    .replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, '');
  if (/<img\b/i.test(withoutTable)) return false;
  const text = decodeHtmlEntities(withoutTable.replace(/<[^>]+>/g, ''));
  return text.replace(/[\s ]+/g, '').length === 0;
}

export function clipboardTableToMarkdown(
  html: string | null | undefined,
  plainText: string | null | undefined,
): string | null {
  if (html && /<table[\s>]/i.test(html)) {
    // A table inside a larger rich-text document is not ours to convert alone.
    if (!isTableOnlyHtml(html)) return null;
    const fromHtml = htmlTableToMarkdown(html);
    if (fromHtml) return fromHtml;
  }
  if (plainText) {
    const fromTsv = tsvToMarkdown(plainText);
    if (fromTsv) return fromTsv;
  }
  return null;
}

/**
 * Editing one table cell in place, inside the rendered (Live mode) table.
 *
 * The live table widget renders Markdown through markdown-it, so what sits in
 * the DOM is formatted HTML — not something you can write back as Markdown
 * without a full HTML→Markdown conversion, which would quietly drop or mangle
 * whatever the cell held (`**bold**`, a link, inline code, an escaped pipe).
 *
 * So editing works the other way round: while a cell has focus its formatted
 * content is swapped for the cell's *Markdown source*, and on commit that text
 * goes back through the table model. Nothing is ever parsed back out of HTML.
 *
 * The pure half lives here — the widget only owns focus, the caret and the
 * write-back transaction — which keeps the fiddly part testable under
 * `node --test` without a DOM.
 */
import {
  emptyTable,
  insertRow,
  parseTable,
  serializeTable,
  setCell,
  type TableAlign,
  type TableModel,
} from './markdown-table.ts';

/** Row index used for the header line, matching `setCell`'s convention. */
export const HEADER_ROW = -1;

/** The Markdown source of one cell, or '' when the coordinates are outside. */
export function cellText(model: TableModel, row: number, col: number): string {
  if (col < 0 || col >= model.header.length) return '';
  if (row === HEADER_ROW) return model.header[col] ?? '';
  return model.rows[row]?.[col] ?? '';
}

/**
 * A cell is one line of Markdown: a newline would end the row and split the
 * table in two, so pasted line breaks collapse to spaces.
 */
export function normalizeCellInput(raw: string): string {
  return raw.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Leading whitespace shared by every non-empty line.
 *
 * A table is often indented — nested under a list item, for instance. The
 * serialiser writes `| a | b |` flush left, so the indent has to be taken off
 * before and put back after, or committing a cell would yank the table out of
 * the list it lives in.
 */
export function commonIndent(source: string): string {
  let indent: string | null = null;
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (indent === null) {
      indent = lead;
      continue;
    }
    let i = 0;
    while (i < indent.length && i < lead.length && indent[i] === lead[i]) i++;
    indent = indent.slice(0, i);
  }
  return indent ?? '';
}

/**
 * Apply a cell edit to the table source.
 *
 * Returns the new table Markdown, or null when nothing changed — the caller
 * uses that to skip the transaction, so clicking into a cell and back out
 * without typing does not push an empty undo step.
 */
export function applyCellEdit(
  source: string,
  row: number,
  col: number,
  raw: string,
): string | null {
  const model = parseTable(source);
  if (!model) return null;
  if (col < 0 || col >= model.header.length) return null;
  if (row !== HEADER_ROW && (row < 0 || row >= model.rows.length)) return null;

  const next = normalizeCellInput(raw);
  if (next === normalizeCellInput(cellText(model, row, col))) return null;

  const markdown = serializeTable(setCell(model, row, col, next));
  const indent = commonIndent(source);
  return indent ? markdown.split('\n').map((line) => indent + line).join('\n') : markdown;
}

/**
 * Apply an optional cell edit on (row, col) and append a new empty row at the
 * bottom of the table — used when pressing Tab on the last cell of the last
 * row (Excel / Typora / NoteGen style).
 */
export function applyCellEditAndAppendRow(
  source: string,
  row: number,
  col: number,
  raw: string,
): { markdown: string; nextRow: number; nextCol: number } | null {
  const model = parseTable(source);
  if (!model) return null;
  const nextText = normalizeCellInput(raw);
  const updated =
    col >= 0 &&
    col < model.header.length &&
    (row === HEADER_ROW || (row >= 0 && row < model.rows.length))
      ? setCell(model, row, col, nextText)
      : model;
  const nextRow = updated.rows.length;
  const withRow = insertRow(updated, nextRow);
  const markdown = serializeTable(withRow);
  const indent = commonIndent(source);
  return {
    markdown: indent ? markdown.split('\n').map((line) => indent + line).join('\n') : markdown,
    nextRow,
    nextCol: 0,
  };
}

/**
 * Where Tab / Shift+Tab land: reading order, header cells first, then body
 * rows. Returns null past either end — the caller leaves the table instead of
 * wrapping around, which would trap the keyboard inside the widget.
 */
export function stepCell(
  model: TableModel,
  row: number,
  col: number,
  delta: 1 | -1,
): { row: number; col: number } | null {
  const cols = model.header.length;
  if (cols === 0) return null;
  // Header is row -1, so the flat index is (row + 1).
  const flat = (row + 1) * cols + col + delta;
  const total = (model.rows.length + 1) * cols;
  if (flat < 0 || flat >= total) return null;
  return { row: Math.floor(flat / cols) - 1, col: flat % cols };
}

/**
 * Where ArrowUp / ArrowDown / Enter / Shift+Enter land within the same column.
 * Header row is -1, body rows are 0..rows.length-1. Returns null when stepping
 * above the header or below the last body row.
 */
export function stepCellVertical(
  model: TableModel,
  row: number,
  col: number,
  delta: 1 | -1,
): { row: number; col: number } | null {
  const cols = model.header.length;
  if (cols === 0 || col < 0 || col >= cols) return null;
  const nextRow = row + delta;
  if (nextRow < HEADER_ROW || nextRow >= model.rows.length) return null;
  return { row: nextRow, col };
}

/**
 * Build a Markdown table snippet with `totalRows` total rows (1 header row +
 * `max(1, totalRows - 1)` body rows) and `cols` columns, with `$|$` caret
 * marker placed in the first header cell.
 */
export function buildInsertTableSnippet(
  totalRows: number,
  cols: number,
  align: TableAlign = null,
): string {
  const safeCols = Math.max(1, Math.min(20, Math.round(cols) || 3));
  const safeTotalRows = Math.max(2, Math.min(100, Math.round(totalRows) || 3));
  const bodyRows = Math.max(1, safeTotalRows - 1);
  const model = emptyTable(safeCols, bodyRows);
  if (align) {
    model.aligns = new Array(safeCols).fill(align);
  }
  const raw = serializeTable(model);
  // Place the `$|$` caret marker inside the first header cell so both raw and
  // live-rendered editors focus cell (-1, 0) immediately after insertion.
  const firstPipe = raw.indexOf('|');
  if (firstPipe >= 0) {
    return `\n| $|$${raw.slice(firstPipe + 2)}\n`;
  }
  return `\n${raw}\n`;
}

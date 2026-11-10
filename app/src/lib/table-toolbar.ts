/**
 * The floating table toolbar's pure parts.
 *
 * The grid dialog is gone: editing a table now happens where the table is,
 * from a bar that follows the caret. That bar needs three things from the
 * document — which table the caret is in, which cell it is on, and where that
 * cell lands after an operation — and none of them belong in a component, so
 * they live here where they can be unit tested against plain strings.
 *
 * The structural operations themselves are `markdown-table.ts`'s; this module
 * only decides *which* one a button means and *where* the caret should end up,
 * so the two never disagree about what "add row below" is.
 */

import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  isDelimiterRow,
  moveColumn,
  moveRow,
  parseTable,
  setAlign,
  setAlignMany,
  type TableModel,
} from './markdown-table.ts';
import { insideFence } from './list-continuation.ts';

/** Everything the toolbar can do to the table under the caret. */
export type TableAction =
  | 'row-above'
  | 'row-below'
  | 'row-delete'
  | 'row-up'
  | 'row-down'
  | 'col-left'
  | 'col-right'
  | 'col-delete'
  | 'col-move-left'
  | 'col-move-right'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-all-left'
  | 'align-all-center'
  | 'align-all-right';

/** A table the caret is inside, plus the cell it is on. */
export interface TableHit {
  /** Document offsets of the table's first and last character — the range a
   *  rewrite replaces. */
  from: number;
  to: number;
  model: TableModel;
  /** 0-based body row the caret is on. -1 on the header or delimiter row,
   *  which is still a column but not a row the user can move or delete. */
  row: number;
  /** 0-based column the caret is on. */
  col: number;
}

/** What the toolbar renders from: the model and the caret's cell. */
export interface TableToolbarState {
  model: TableModel;
  row: number;
  col: number;
  /** Identifies the caret position, so a re-render that did not move it does
   *  not count as a change (see TableToolbar.vue's dismissal). */
  key: string;
}

/** A line that could be part of a pipe table — same test as
 *  `markdown-table.ts`'s internal one. */
function looksLikeRow(line: string): boolean {
  const t = line.trim();
  return t !== '' && t.includes('|');
}

/** Start offset of the line before the one starting at `start`, or -1. */
function prevLineStart(text: string, start: number): number {
  if (start <= 0) return -1;
  return text.lastIndexOf('\n', start - 2) + 1;
}

/** End offset (exclusive) of the line containing `pos`. */
function lineEndAt(text: string, pos: number): number {
  const i = text.indexOf('\n', pos);
  return i < 0 ? text.length : i;
}

/** Whether the `|` at `index` is escaped (`\|`) and so not a cell boundary. */
function isEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

/**
 * The column a character offset within one table line falls in.
 *
 * Counting separators rather than measuring widths: the caret is in the cell
 * whose opening `|` is behind it, and a leading border pipe opens the first
 * cell instead of ending one.
 */
export function columnAt(line: string, indexInLine: number): number {
  const limit = Math.max(0, Math.min(indexInLine, line.length));
  let pipes = 0;
  for (let i = 0; i < limit; i++) {
    if (line[i] === '|' && !isEscaped(line, i)) pipes++;
  }
  const lead = line.trimStart().startsWith('|') ? 1 : 0;
  return Math.max(0, pipes - lead);
}

/**
 * The table the caret is in, or null — the one entry point the editor needs.
 *
 * Works off the plain document text and an offset, so CodeMirror and the
 * Windows textarea editor get identical behaviour from one implementation.
 *
 * Reads only the table's own lines rather than splitting the whole document:
 * this runs on every caret move, and a 1 MB note should not be re-split twice
 * per keystroke just to find out the caret is not in a table.
 */
export function tableAt(text: string, caret: number): TableHit | null {
  if (!text) return null;
  const pos = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = lineEndAt(text, pos);
  if (!looksLikeRow(text.slice(lineStart, lineEnd))) return null;

  let start = lineStart;
  for (;;) {
    const prev = prevLineStart(text, start);
    if (prev < 0 || !looksLikeRow(text.slice(prev, start - 1))) break;
    start = prev;
  }
  let end = lineEnd;
  for (;;) {
    if (end >= text.length) break;
    const nextEnd = lineEndAt(text, end + 1);
    if (!looksLikeRow(text.slice(end + 1, nextEnd))) break;
    end = nextEnd;
  }

  const block = text.slice(start, end);
  const lines = block.split('\n');
  // The second line has to be the delimiter row; anything else is a run of
  // lines that merely contain pipes (same rule as findTableSpan).
  if (lines.length < 2 || !isDelimiterRow(lines[1])) return null;
  // Pipes inside a fenced code block are code, not a table.
  if (insideFence(text, start)) return null;
  const model = parseTable(block);
  if (!model) return null;

  // header, delimiter, then body rows.
  const rel = block.slice(0, lineStart - start).split('\n').length - 1;
  const row = rel >= 2 ? Math.min(rel - 2, model.rows.length - 1) : -1;
  // A caret after the closing border pipe counts as "still in the last cell":
  // every button wants a column that exists, and out of range is not one.
  const col = Math.min(columnAt(lines[rel], pos - lineStart), model.header.length - 1);
  return { from: start, to: end, model, row, col };
}

/** The body row a row operation acts on: the caret's own row, or the first
 *  one when the caret is up in the header. */
function bodyRow(row: number, model: TableModel): number {
  const first = Math.min(0, model.rows.length - 1);
  return row < 0 ? Math.max(0, first) : Math.min(row, Math.max(0, model.rows.length - 1));
}

/** Apply one toolbar action. Returns the model unchanged when the action is
 *  not available on this cell (see `tableActionEnabled`). */
export function applyTableAction(
  model: TableModel,
  action: TableAction,
  row: number,
  col: number,
): TableModel {
  const at = bodyRow(row, model);
  switch (action) {
    case 'row-above':
      return insertRow(model, at);
    case 'row-below':
      return insertRow(model, at + 1);
    case 'row-delete':
      // The header is not a row the user can delete: there is no reasonable
      // answer to "which one", so the button is off there rather than guessing.
      return row < 0 ? model : deleteRow(model, row);
    case 'row-up':
      return row < 0 ? model : moveRow(model, row, row - 1);
    case 'row-down':
      return row < 0 ? model : moveRow(model, row, row + 1);
    case 'col-left':
      return insertColumn(model, col);
    case 'col-right':
      return insertColumn(model, col + 1);
    case 'col-delete':
      return deleteColumn(model, col);
    case 'col-move-left':
      return moveColumn(model, col, col - 1);
    case 'col-move-right':
      return moveColumn(model, col, col + 1);
    case 'align-left':
      return setAlign(model, col, 'left');
    case 'align-center':
      return setAlign(model, col, 'center');
    case 'align-right':
      return setAlign(model, col, 'right');
    case 'align-all-left':
      return setAlignMany(model, model.header.map((_, i) => i), 'left');
    case 'align-all-center':
      return setAlignMany(model, model.header.map((_, i) => i), 'center');
    case 'align-all-right':
      return setAlignMany(model, model.header.map((_, i) => i), 'right');
  }
}

/** Whether an action can do anything here — the difference between a button
 *  that is greyed out and one that silently rewrites the table unchanged. */
export function tableActionEnabled(
  model: TableModel,
  action: TableAction,
  row: number,
  col: number,
): boolean {
  const rows = model.rows.length;
  const cols = model.header.length;
  switch (action) {
    case 'row-delete':
      return row >= 0 && rows > 0;
    case 'row-up':
      return row > 0;
    case 'row-down':
      return row >= 0 && row < rows - 1;
    case 'col-delete':
      return cols > 1;
    case 'col-move-left':
      return col > 0;
    case 'col-move-right':
      return col >= 0 && col < cols - 1;
    case 'align-left':
    case 'align-center':
    case 'align-right':
      return col >= 0 && col < cols;
    case 'align-all-left':
    case 'align-all-center':
    case 'align-all-right':
      return cols > 0;
    default:
      return true;
  }
}

/** The body row the caret belongs to after `action`, so typing continues in
 *  the row the user just made instead of wherever mapping happened to land. */
export function rowAfterAction(action: TableAction, row: number, model: TableModel): number {
  const at = bodyRow(row, model);
  switch (action) {
    case 'row-above':
      return at;
    case 'row-below':
      return row < 0 ? 0 : at + 1;
    case 'row-delete':
      return model.rows.length > 0 ? Math.max(0, Math.min(at, model.rows.length - 1)) : -1;
    case 'row-up':
      return Math.max(0, row - 1);
    case 'row-down':
      return Math.min(model.rows.length - 1, row + 1);
    default:
      return row;
  }
}

/** The column the caret belongs to after `action` (e.g. moves into a newly
 *  inserted column or follows a moved column). */
export function colAfterAction(action: TableAction, col: number, model: TableModel): number {
  const maxCol = Math.max(0, model.header.length - 1);
  switch (action) {
    case 'col-left':
      return Math.max(0, Math.min(col, maxCol));
    case 'col-right':
      return Math.max(0, Math.min(col + 1, maxCol));
    case 'col-move-left':
      return Math.max(0, col - 1);
    case 'col-move-right':
      return Math.min(maxCol, col + 1);
    default:
      return Math.max(0, Math.min(col, maxCol));
  }
}

/**
 * Offset of cell (`row`, `col`)'s content within `markdown`.
 *
 * Whole-document offsets are the caller's business; this is relative to the
 * string it is given, which is exactly the serialized table. `row` -1 is the
 * header line, 0 and up are body rows — the delimiter row is never a target.
 */
export function cellStart(markdown: string, row: number, col: number): number {
  const lines = markdown.split('\n');
  const li = Math.max(0, Math.min(row < 0 ? 0 : row + 2, lines.length - 1));
  let base = 0;
  for (let i = 0; i < li; i++) base += lines[i].length + 1;
  const line = lines[li];
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (line[i] === '|') i++;
  for (let cell = 0; cell < col; cell++) {
    while (i < line.length && !(line[i] === '|' && !isEscaped(line, i))) i++;
    if (i < line.length) i++;
  }
  while (i < line.length && line[i] === ' ') i++;
  return base + Math.min(i, line.length);
}

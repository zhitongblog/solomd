/**
 * The numbers behind "Insert table" (#387 / #500).
 *
 * Until now the Insert menu dropped a fixed 2×2 table into the document and
 * left the writer to add the rows and columns they actually wanted — five
 * extra trips through the grid editor for a 5×8 table. The dialog that
 * consumes this module asks for the two numbers up front, Word's way.
 *
 * Word's dialog also offers "AutoFit to window" and "Remember this size for
 * new tables". Both are deliberately absent, and this module is where that
 * decision lives: a Markdown table has no width to fit — it is laid out by
 * the reader, not the file — and a remembered size is a modal default that
 * surprises the second table more often than it helps the first.
 *
 * Kept free of Vue so `node --test` can reach it (see the note on imports in
 * `markdown-table.test.ts`).
 */
import { CARET_MARKER } from './insert-snippet.ts';

/** Columns: 1..20. Past that a Markdown table is unreadable as source, and
 *  the dialog's spinner is the only way back down. */
export const INSERT_TABLE_MIN_COLS = 1;
export const INSERT_TABLE_MAX_COLS = 20;
/** Body rows, not counting the header line — see `tableMarkdown`. */
export const INSERT_TABLE_MIN_ROWS = 1;
export const INSERT_TABLE_MAX_ROWS = 100;

export const INSERT_TABLE_DEFAULT_COLS = 3;
export const INSERT_TABLE_DEFAULT_ROWS = 2;

export interface TableSize {
  cols: number;
  rows: number;
}

/**
 * A usable size from whatever the dialog's fields hold.
 *
 * Those fields are `type="number"`, so they hand back strings — and an empty
 * or half-typed one (`''`, `'-'`, `'1e'`) parses to NaN. A NaN must not reach
 * `Array.from({ length })`, which throws; it falls back to the default.
 */
export function clampTableSize(cols: unknown, rows: unknown): TableSize {
  return {
    cols: clampOne(cols, INSERT_TABLE_MIN_COLS, INSERT_TABLE_MAX_COLS, INSERT_TABLE_DEFAULT_COLS),
    rows: clampOne(rows, INSERT_TABLE_MIN_ROWS, INSERT_TABLE_MAX_ROWS, INSERT_TABLE_DEFAULT_ROWS),
  };
}

function clampOne(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/**
 * The Markdown for a fresh table, ready for the `solomd:insert-markdown`
 * channel.
 *
 * `rows` counts body rows; the header row is implicit, because in Markdown the
 * header is not optional and is not one of the rows a writer is choosing. The
 * leading `\n` puts the table on a line of its own, and `$|$` puts the caret
 * in the first header cell — the cell a writer fills first.
 */
export type InsertTableAlign = 'left' | 'center' | 'right' | null;

export function tableMarkdown(cols: number, rows: number, align: InsertTableAlign = null): string {
  const size = clampTableSize(cols, rows);
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  const filled = (value: string): string[] => Array.from({ length: size.cols }, () => value);
  const header = filled('');
  header[0] = CARET_MARKER;
  const delimToken =
    align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---';
  const body = line(filled(''));
  return ['', line(header), line(filled(delimToken)), ...Array.from({ length: size.rows }, () => body), ''].join('\n');
}

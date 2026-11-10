/**
 * Unit tests for the "Insert table" numbers (#387 / #500).
 *
 * Run from `app/`:
 *   node --experimental-strip-types --test src/lib/insert-table.test.ts
 *
 * The assertions run against `parseInsertSnippet(...).text` — the text that
 * actually lands in the document — not against the raw template. The `$|$`
 * caret marker contains a `|`, so the raw template is not a parseable table
 * by construction; stripping the marker is exactly what insertion does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INSERT_TABLE_DEFAULT_COLS,
  INSERT_TABLE_DEFAULT_ROWS,
  INSERT_TABLE_MAX_COLS,
  INSERT_TABLE_MAX_ROWS,
  INSERT_TABLE_MIN_COLS,
  INSERT_TABLE_MIN_ROWS,
  clampTableSize,
  tableMarkdown,
} from './insert-table.ts';
import { parseInsertSnippet } from './insert-snippet.ts';
import { parseTable, type TableModel } from './markdown-table.ts';
import { buildInsertTableSnippet } from './table-cell-edit.ts';

/** The table as it enters the note: marker stripped, leading blank line gone. */
function inserted(cols: number, rows: number): string {
  return parseInsertSnippet(tableMarkdown(cols, rows)).text.replace(/^\n/, '');
}

function insertedTable(cols: number, rows: number): TableModel {
  const parsed = parseTable(inserted(cols, rows));
  assert.ok(parsed, 'the inserted text must parse as a table');
  return parsed;
}

test('#387 an untouched dialog asks for the default size', () => {
  assert.deepEqual(clampTableSize(INSERT_TABLE_DEFAULT_COLS, INSERT_TABLE_DEFAULT_ROWS), {
    cols: 3,
    rows: 2,
  });
});

test('#387 sizes are clamped into range', () => {
  assert.deepEqual(clampTableSize(0, 0), { cols: INSERT_TABLE_MIN_COLS, rows: INSERT_TABLE_MIN_ROWS });
  assert.deepEqual(clampTableSize(-4, -9), { cols: INSERT_TABLE_MIN_COLS, rows: INSERT_TABLE_MIN_ROWS });
  assert.deepEqual(clampTableSize(999, 9999), { cols: INSERT_TABLE_MAX_COLS, rows: INSERT_TABLE_MAX_ROWS });
  assert.deepEqual(clampTableSize(5, 8), { cols: 5, rows: 8 });
});

test('#387 what the number fields hand back is not always a number', () => {
  assert.deepEqual(clampTableSize('', ''), { cols: INSERT_TABLE_DEFAULT_COLS, rows: INSERT_TABLE_DEFAULT_ROWS });
  assert.deepEqual(clampTableSize('-', 'e'), { cols: INSERT_TABLE_DEFAULT_COLS, rows: INSERT_TABLE_DEFAULT_ROWS });
  assert.deepEqual(clampTableSize(null, undefined), { cols: INSERT_TABLE_DEFAULT_COLS, rows: INSERT_TABLE_DEFAULT_ROWS });
  assert.deepEqual(clampTableSize('6', '4'), { cols: 6, rows: 4 });
  assert.deepEqual(clampTableSize('4.7', '3.2'), { cols: 4, rows: 3 });
  assert.deepEqual(clampTableSize('12abc', 2), { cols: 12, rows: 2 });
});

test('#387 the inserted Markdown is a real table of the requested shape', () => {
  const parsed = insertedTable(4, 3);
  assert.equal(parsed.header.length, 4);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.aligns, [null, null, null, null]);
  assert.deepEqual(parsed.header, ['', '', '', '']);
  assert.deepEqual(parsed.rows[2], ['', '', '', '']);
});

test('#387 the caret lands in the first header cell, with the marker stripped', () => {
  const md = tableMarkdown(2, 2);
  const { text, anchor, head } = parseInsertSnippet(md);
  assert.ok(!text.includes('$|$'), 'the marker must not survive into the document');
  assert.equal(anchor, head);
  const firstPipe = text.indexOf('|');
  const secondPipe = text.indexOf('|', firstPipe + 1);
  assert.ok(anchor > firstPipe && anchor < secondPipe, 'caret inside the first header cell');
});

test('#387 a one-column table is still a table', () => {
  const parsed = insertedTable(1, 1);
  assert.equal(parsed.header.length, 1);
  assert.equal(parsed.rows.length, 1);
  assert.equal(inserted(1, 1).trimEnd(), '|  |\n| --- |\n|  |');
});

test('#387 the generator clamps too — it does not trust its caller', () => {
  const parsed = insertedTable(500, 5000);
  assert.equal(parsed.header.length, INSERT_TABLE_MAX_COLS);
  assert.equal(parsed.rows.length, INSERT_TABLE_MAX_ROWS);
});

test('#387 every row has the same number of cells as the header', () => {
  const parsed = insertedTable(6, 2);
  for (const row of parsed.rows) assert.equal(row.length, 6);
});

test('#526 tableMarkdown and buildInsertTableSnippet apply initial column alignment', () => {
  const centerMd = parseInsertSnippet(tableMarkdown(3, 2, 'center')).text.replace(/^\n/, '');
  const centerParsed = parseTable(centerMd);
  assert.ok(centerParsed);
  assert.deepEqual(centerParsed.aligns, ['center', 'center', 'center']);

  const rightSnippet = parseInsertSnippet(buildInsertTableSnippet(4, 3, 'right')).text.replace(/^\n/, '');
  const rightParsed = parseTable(rightSnippet);
  assert.ok(rightParsed);
  assert.deepEqual(rightParsed.aligns, ['right', 'right', 'right']);
  assert.equal(rightParsed.rows.length, 3);
});

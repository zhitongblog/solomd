/**
 * Unit tests for in-place cell editing (the pure half).
 *
 * Run from `app/`:
 *   node --experimental-strip-types --test src/lib/table-cell-edit.test.ts
 *
 * The widget itself needs a DOM and a CodeMirror view, but everything that can
 * silently corrupt a table — coordinate mapping, newline collapsing, the
 * no-op case that would otherwise push an empty undo step — is here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEADER_ROW,
  applyCellEdit,
  applyCellEditAndAppendRow,
  buildInsertTableSnippet,
  cellText,
  normalizeCellInput,
  stepCell,
  stepCellVertical,
} from './table-cell-edit.ts';
import { parseTable } from './markdown-table.ts';

const SOURCE = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');

test('cellText reads the header and body cells', () => {
  const model = parseTable(SOURCE);
  assert.ok(model);
  assert.equal(cellText(model, HEADER_ROW, 1), 'b');
  assert.equal(cellText(model, 0, 0), '1');
  assert.equal(cellText(model, 1, 1), '4');
  // Out of range never throws — the widget calls this on every keystroke.
  assert.equal(cellText(model, 0, 9), '');
  assert.equal(cellText(model, 9, 0), '');
});

test('newlines and runs of spaces collapse into one line', () => {
  assert.equal(normalizeCellInput('one\r\ntwo'), 'one two');
  assert.equal(normalizeCellInput('  a   b  '), 'a b');
});

test('editing a body cell rewrites only that cell', () => {
  const next = applyCellEdit(SOURCE, 0, 1, 'two');
  assert.ok(next);
  // Columns are padded to the widest cell, so the untouched cells grow too.
  assert.equal(
    next,
    ['| a   | b   |', '| --- | --- |', '| 1   | two |', '| 3   | 4   |'].join('\n'),
  );
});

test('editing the header goes through row -1', () => {
  const next = applyCellEdit(SOURCE, HEADER_ROW, 0, 'name');
  assert.ok(next);
  const after = parseTable(next);
  assert.ok(after);
  assert.deepEqual(after.header, ['name', 'b']);
  // Body rows are untouched, only re-padded to the new column width.
  assert.deepEqual(after.rows, [['1', '2'], ['3', '4']]);
});

test('an unchanged cell is a no-op, so it makes no undo step', () => {
  assert.equal(applyCellEdit(SOURCE, 0, 1, '2'), null);
  // Padding is not content: ' 2 ' must compare equal to the parsed '2'.
  assert.equal(applyCellEdit(SOURCE, 0, 1, ' 2 '), null);
});

test('a piped value is escaped rather than splitting the row', () => {
  const next = applyCellEdit(SOURCE, 0, 0, 'a|b');
  assert.ok(next);
  assert.match(next.split('\n')[2], /a\\\|b/);
  // `parseTable` is the ground truth: the row still has two cells.
  const after = parseTable(next);
  assert.ok(after);
  assert.deepEqual(after.rows[0], ['a|b', '2']);
});

test('markdown in a cell survives the round trip', () => {
  const next = applyCellEdit(SOURCE, 1, 0, '**bold** and `code`');
  assert.ok(next);
  assert.match(next, /\*\*bold\*\* and `code`/);
});

test('an indented table keeps its indent', () => {
  const indented = SOURCE.split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  const next = applyCellEdit(indented, 0, 0, 'x');
  assert.ok(next);
  assert.equal(
    next,
    ['  | a   | b   |', '  | --- | --- |', '  | x   | 2   |', '  | 3   | 4   |'].join('\n'),
  );
});

test('coordinates outside the table change nothing', () => {
  assert.equal(applyCellEdit(SOURCE, 5, 0, 'x'), null);
  assert.equal(applyCellEdit(SOURCE, 0, 5, 'x'), null);
  assert.equal(applyCellEdit('not a table', 0, 0, 'x'), null);
});

test('Tab walks header then body cells and stops at the ends', () => {
  const model = parseTable(SOURCE);
  assert.ok(model);
  assert.deepEqual(stepCell(model, HEADER_ROW, 0, 1), { row: HEADER_ROW, col: 1 });
  assert.deepEqual(stepCell(model, HEADER_ROW, 1, 1), { row: 0, col: 0 });
  assert.deepEqual(stepCell(model, 1, 1, 1), null);
  // Shift+Tab mirrors it, and the first cell exits instead of wrapping.
  assert.deepEqual(stepCell(model, 0, 0, -1), { row: HEADER_ROW, col: 1 });
  assert.deepEqual(stepCell(model, HEADER_ROW, 0, -1), null);
});

test('stepCellVertical moves within the same column and stops at top/bottom', () => {
  const model = parseTable(SOURCE);
  assert.ok(model);
  assert.deepEqual(stepCellVertical(model, HEADER_ROW, 1, 1), { row: 0, col: 1 });
  assert.deepEqual(stepCellVertical(model, 0, 1, 1), { row: 1, col: 1 });
  assert.equal(stepCellVertical(model, 1, 1, 1), null);
  assert.deepEqual(stepCellVertical(model, 1, 1, -1), { row: 0, col: 1 });
  assert.deepEqual(stepCellVertical(model, 0, 1, -1), { row: HEADER_ROW, col: 1 });
  assert.equal(stepCellVertical(model, HEADER_ROW, 1, -1), null);
});

test('applyCellEditAndAppendRow commits the active cell and appends a blank row', () => {
  const res = applyCellEditAndAppendRow(SOURCE, 1, 1, 'four');
  assert.ok(res);
  assert.equal(res.nextRow, 2);
  assert.equal(res.nextCol, 0);
  const after = parseTable(res.markdown);
  assert.ok(after);
  assert.deepEqual(after.rows, [
    ['1', '2'],
    ['3', 'four'],
    ['', ''],
  ]);
});

test('buildInsertTableSnippet generates a custom rows × cols GFM table with $|$ in first header cell', () => {
  const snippet = buildInsertTableSnippet(4, 3);
  const clean = snippet.replace('$|$', '');
  const parsed = parseTable(clean.trim());
  assert.ok(parsed);
  assert.equal(parsed.header.length, 3);
  assert.equal(parsed.rows.length, 3); // 4 total rows = 1 header + 3 body rows
  assert.ok(snippet.includes('| $|$'));
});

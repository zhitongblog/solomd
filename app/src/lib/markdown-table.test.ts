/**
 * Unit tests for the table model behind the grid editor.
 *
 * Run from `app/`:  node src/lib/markdown-table.selftest.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTable,
  serializeTable,
  findTableSpan,
  splitRow,
  isDelimiterRow,
  displayWidth,
  insertRow,
  deleteRow,
  moveRow,
  insertColumn,
  deleteColumn,
  moveColumn,
  setAlign,
  setCell,
  emptyTable,
} from './markdown-table';

const SRC = ['| a | b |', '|---|---:|', '| 1 | 2 |', '| 3 | 4 |'].join('\n');

test('parse reads header, alignment and rows', () => {
  const t = parseTable(SRC)!;
  assert.deepEqual(t.header, ['a', 'b']);
  assert.deepEqual(t.aligns, [null, 'right']);
  assert.deepEqual(t.rows, [['1', '2'], ['3', '4']]);
});

test('a block without a delimiter row is not a table', () => {
  assert.equal(parseTable('| a | b |\n| 1 | 2 |'), null);
});

test('alignment markers round-trip', () => {
  const src = ['| l | c | r |', '|:--|:-:|--:|', '| 1 | 2 | 3 |'].join('\n');
  const t = parseTable(src)!;
  assert.deepEqual(t.aligns, ['left', 'center', 'right']);
  const out = parseTable(serializeTable(t))!;
  assert.deepEqual(out.aligns, ['left', 'center', 'right']);
});

test('escaped pipes stay inside their cell', () => {
  assert.deepEqual(splitRow('| a \\| b | c |'), ['a | b', 'c']);
  const t = parseTable('| x | y |\n|---|---|\n| a \\| b | c |')!;
  assert.deepEqual(t.rows[0], ['a | b', 'c']);
  // …and are escaped again on the way out, or the column count changes.
  assert.match(serializeTable(t), /a \\\| b/);
});

test('ragged rows are padded, not rejected', () => {
  const t = parseTable('| a | b | c |\n|---|---|---|\n| 1 |')!;
  assert.deepEqual(t.rows[0], ['1', '', '']);
});

test('columns are padded to a common width', () => {
  const t = parseTable('|a|bbbb|\n|---|---|\n|1|2|')!;
  const lines = serializeTable(t).split('\n');
  assert.equal(lines[0], '| a   | bbbb |');
  assert.equal(lines[1], '| --- | ---- |');
  assert.equal(lines[2], '| 1   | 2    |');
});

test('CJK characters count as two columns so the source stays aligned', () => {
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('ab'), 2);
  const t = parseTable('| 名称 | n |\n|---|---|\n| ab | 1 |')!;
  const lines = serializeTable(t).split('\n');
  // Header cell "名称" is 4 wide; the body cell must be padded to match.
  assert.equal(lines[0], '| 名称 | n   |');
  assert.equal(lines[2], '| ab   | 1   |');
});

test('finding the table under the cursor', () => {
  const lines = ['text', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'after'].join('\n').split('\n');
  assert.deepEqual(findTableSpan(lines, 3), { startLine: 2, endLine: 4 });
  assert.deepEqual(findTableSpan(lines, 2), { startLine: 2, endLine: 4 });
  assert.deepEqual(findTableSpan(lines, 4), { startLine: 2, endLine: 4 });
  assert.equal(findTableSpan(lines, 0), null);
  assert.equal(findTableSpan(lines, 6), null);
});

test('a run of pipe-containing lines without a delimiter is not a table', () => {
  const lines = ['a | b', 'c | d'];
  assert.equal(findTableSpan(lines, 0), null);
});

test('delimiter row recognition', () => {
  assert.equal(isDelimiterRow('|---|---|'), true);
  assert.equal(isDelimiterRow('| :-: | --: |'), true);
  assert.equal(isDelimiterRow('| a | b |'), false);
  assert.equal(isDelimiterRow('| - x | --- |'), false);
});

test('row operations', () => {
  const t = parseTable(SRC)!;
  assert.deepEqual(insertRow(t, 1).rows, [['1', '2'], ['', ''], ['3', '4']]);
  assert.deepEqual(deleteRow(t, 0).rows, [['3', '4']]);
  assert.deepEqual(moveRow(t, 0, 1).rows, [['3', '4'], ['1', '2']]);
  // out-of-range operations are no-ops rather than corruption
  assert.deepEqual(deleteRow(t, 9).rows, t.rows);
  assert.deepEqual(moveRow(t, 9, 0).rows, t.rows);
});

test('column operations keep header, aligns and every row in step', () => {
  const t = parseTable(SRC)!;
  const wider = insertColumn(t, 1);
  assert.deepEqual(wider.header, ['a', '', 'b']);
  assert.deepEqual(wider.aligns, [null, null, 'right']);
  assert.deepEqual(wider.rows[0], ['1', '', '2']);

  const narrower = deleteColumn(t, 0);
  assert.deepEqual(narrower.header, ['b']);
  assert.deepEqual(narrower.aligns, ['right']);
  assert.deepEqual(narrower.rows, [['2'], ['4']]);

  const moved = moveColumn(t, 0, 1);
  assert.deepEqual(moved.header, ['b', 'a']);
  assert.deepEqual(moved.aligns, ['right', null]);
  assert.deepEqual(moved.rows[0], ['2', '1']);
});

test('the last column cannot be deleted — that is not a table any more', () => {
  const t = parseTable('| a |\n|---|\n| 1 |')!;
  assert.deepEqual(deleteColumn(t, 0), t);
});

test('setting alignment and cells', () => {
  const t = parseTable(SRC)!;
  assert.deepEqual(setAlign(t, 0, 'center').aligns, ['center', 'right']);
  assert.equal(setCell(t, 0, 0, 'x').rows[0][0], 'x');
  assert.equal(setCell(t, -1, 1, 'H').header[1], 'H');
  // the original is untouched
  assert.equal(t.rows[0][0], '1');
});

test('a newline pasted into a cell cannot split the table', () => {
  const t = parseTable(SRC)!;
  const edited = setCell(t, 0, 0, 'one\ntwo');
  assert.equal(edited.rows[0][0], 'one two');
  assert.equal(serializeTable(edited).split('\n').length, 4);
});

test('an empty table is a valid table', () => {
  const t = emptyTable(2, 1);
  const out = serializeTable(t);
  assert.deepEqual(parseTable(out)!.header, ['', '']);
  assert.equal(out.split('\n').length, 3);
});

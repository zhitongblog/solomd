/**
 * Unit tests for the floating table toolbar's pure parts.
 *
 * Run from `app/`:  node --experimental-strip-types --test src/lib/table-toolbar.test.ts
 *
 * What matters here is that the bar acts on the cell the caret is *in* — the
 * dialogs it replaces asked the user to click a cell first, and a floating bar
 * has no way to ask, so the caret has to be read correctly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cellStart, colAfterAction, columnAt, tableAt, applyTableAction, tableActionEnabled, rowAfterAction } from './table-toolbar.ts';
import { parseTable, serializeTable } from './markdown-table.ts';

const DOC = ['# Doc', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |', '', 'after'].join('\n');

/** Document offset of the first character of a given line (0-based). */
function lineOffset(text: string, line0: number): number {
  let off = 0;
  const lines = text.split('\n');
  for (let i = 0; i < line0; i++) off += lines[i].length + 1;
  return off;
}

test('tableAt finds the table the caret is in and its cell', () => {
  // Line 4 is "| 1 | 2 |" — the first body row.
  const caret = lineOffset(DOC, 4) + 4; // on "1"
  const hit = tableAt(DOC, caret);
  assert.ok(hit);
  assert.equal(hit.row, 0);
  assert.equal(hit.col, 0);
  assert.equal(hit.from, lineOffset(DOC, 2));
  assert.equal(hit.to, lineOffset(DOC, 5) + '| 3 | 4 |'.length);
  assert.deepEqual(hit.model.header, ['a', 'b']);
  assert.equal(hit.model.rows.length, 2);
});

test('a table fenced as code is not a table to edit', () => {
  const doc = ['```', '| a | b |', '| --- | --- |', '| 1 | 2 |', '```', ''].join('\n');
  assert.equal(tableAt(doc, lineOffset(doc, 3) + 2), null);
});

test('a table at the end of the document needs no trailing newline', () => {
  const doc = '# t\n| a | b |\n| --- | --- |\n| 1 | 2 |';
  const hit = tableAt(doc, doc.length);
  assert.ok(hit);
  assert.equal(hit.to, doc.length);
  assert.equal(hit.row, 0);
  assert.equal(hit.col, 1);
});

test('a table without border pipes still parses', () => {
  const doc = 'a | b\n--- | ---\n1 | 2';
  const hit = tableAt(doc, 2);
  assert.ok(hit);
  assert.equal(hit.row, -1);
  assert.equal(hit.col, 0);
  assert.equal(hit.from, 0);
});

test('a caret on a blank line after the table finds nothing', () => {
  assert.equal(tableAt('| a |\n| --- |\n| 1 |\n\n', 20), null);
});

test('tableAt reads the second cell of the second body row', () => {
  const caret = lineOffset(DOC, 5) + '| 3 | '.length + 1; // on "4"
  const hit = tableAt(DOC, caret);
  assert.ok(hit);
  assert.equal(hit.row, 1);
  assert.equal(hit.col, 1);
});

test('tableAt reports the header row as -1', () => {
  const hit = tableAt(DOC, lineOffset(DOC, 2) + 3);
  assert.ok(hit);
  assert.equal(hit.row, -1);
  assert.equal(hit.col, 0);
});

test('tableAt is null outside a table', () => {
  assert.equal(tableAt(DOC, 2), null);
  assert.equal(tableAt(DOC, lineOffset(DOC, 7)), null);
  // A caret on the blank line between the table and the paragraph.
  assert.equal(tableAt(DOC, lineOffset(DOC, 6)), null);
  // A run of pipe lines with no delimiter row is not a table (findTableSpan).
  assert.equal(tableAt('| a | b |\n| c | d |', 2), null);
});

test('columnAt ignores escaped pipes and the leading border', () => {
  assert.equal(columnAt('| a | b |', 0), 0);
  assert.equal(columnAt('| a | b |', 2), 0);
  assert.equal(columnAt('| a | b |', 6), 1);
  // "a \| b" is one cell.
  assert.equal(columnAt('| a \\| b | c |', 9), 0);
  assert.equal(columnAt('| a \\| b | c |', 12), 1);
  // No leading border pipe.
  assert.equal(columnAt('a | b', 0), 0);
  assert.equal(columnAt('a | b', 4), 1);
});

test('row operations act on the caret row', () => {
  const model = parseTable('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
  assert.ok(model);
  const below = applyTableAction(model, 'row-below', 0, 0);
  assert.deepEqual(below.rows, [['1', '2'], ['', ''], ['3', '4']]);
  const above = applyTableAction(model, 'row-above', 1, 0);
  assert.deepEqual(above.rows, [['1', '2'], ['', ''], ['3', '4']]);
  assert.deepEqual(applyTableAction(model, 'row-delete', 1, 0).rows, [['1', '2']]);
  assert.deepEqual(applyTableAction(model, 'row-down', 0, 0).rows, [['3', '4'], ['1', '2']]);
  // The header is not a row: only insert can happen there, and it lands first.
  assert.deepEqual(applyTableAction(model, 'row-above', -1, 0).rows[0], ['', '']);
  assert.equal(applyTableAction(model, 'row-delete', -1, 0), model);
});

test('column operations act on the caret column', () => {
  const model = parseTable('| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(model);
  assert.deepEqual(applyTableAction(model, 'col-right', 0, 0).header, ['a', '', 'b']);
  assert.deepEqual(applyTableAction(model, 'col-left', 0, 1).header, ['a', '', 'b']);
  assert.deepEqual(applyTableAction(model, 'col-delete', 0, 1).header, ['a']);
  assert.deepEqual(applyTableAction(model, 'col-move-left', 0, 1).header, ['b', 'a']);
});

test('align acts on the caret column only, while align-all-* aligns every column (#382)', () => {
  const model = parseTable('| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(model);
  assert.deepEqual(applyTableAction(model, 'align-right', 0, 1).aligns, [null, 'right']);
  assert.deepEqual(applyTableAction(model, 'align-all-center', 0, 0).aligns, ['center', 'center']);
  assert.deepEqual(applyTableAction(model, 'align-all-right', 0, 0).aligns, ['right', 'right']);
  // And the marker actually reaches the source, in the right column.
  const md = serializeTable(applyTableAction(model, 'align-center', 0, 0));
  const round = parseTable(md);
  assert.ok(round);
  assert.deepEqual(round.aligns, ['center', null]);
});

test('impossible actions are reported as disabled and leave the model alone', () => {
  const model = parseTable('| a |\n| --- |\n| 1 |');
  assert.ok(model);
  assert.equal(tableActionEnabled(model, 'col-delete', 0, 0), false);
  assert.equal(tableActionEnabled(model, 'col-move-right', 0, 0), false);
  assert.equal(tableActionEnabled(model, 'row-up', 0, 0), false);
  assert.equal(tableActionEnabled(model, 'row-down', 0, 0), false);
  assert.equal(tableActionEnabled(model, 'row-delete', -1, 0), false);
  assert.equal(tableActionEnabled(model, 'row-below', 0, 0), true);
  assert.equal(applyTableAction(model, 'col-delete', 0, 0), model);
});

test('rowAfterAction follows the row the user just made', () => {
  const model = parseTable('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
  assert.ok(model);
  assert.equal(rowAfterAction('row-below', 0, model), 1);
  assert.equal(rowAfterAction('row-below', -1, model), 0);
  assert.equal(rowAfterAction('row-above', 1, model), 1);
  assert.equal(rowAfterAction('row-delete', 1, model), 1);
  assert.equal(rowAfterAction('align-right', 0, model), 0);
  assert.equal(colAfterAction('col-left', 1, model), 1);
  assert.equal(colAfterAction('col-right', 0, model), 1);
  assert.equal(colAfterAction('col-move-left', 1, model), 0);
  assert.equal(colAfterAction('col-move-right', 0, model), 1);
});

test('cellStart points at the cell content, not the pipe', () => {
  const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  assert.equal(md.slice(cellStart(md, -1, 0)).startsWith('a'), true);
  assert.equal(md.slice(cellStart(md, -1, 1)).startsWith('b'), true);
  assert.equal(md.slice(cellStart(md, 0, 0)).startsWith('1'), true);
  assert.equal(md.slice(cellStart(md, 0, 1)).startsWith('2'), true);
  // Ragged source (no padding): still the content.
  const tight = '|a|b|\n|-|-|\n|1|2|';
  assert.equal(tight.slice(cellStart(tight, 0, 1)).startsWith('2'), true);
});

test('an action on a parsed table round-trips through serialize', () => {
  const model = parseTable('| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(model);
  const next = applyTableAction(model, 'row-below', 0, 0);
  const md = serializeTable(next);
  const caret = cellStart(md, 1, 0);
  const hit = tableAt(md, caret);
  assert.ok(hit);
  assert.equal(hit.row, 1);
  assert.equal(hit.col, 0);
});

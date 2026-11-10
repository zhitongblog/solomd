/**
 * The table picker's grid: cell → size. The pointer drives it, so the two
 * things worth pinning are the 1-based offset and that an overshooting or
 * jittery pointer can never ask for a size the grid does not have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TABLE_GRID_COLS,
  TABLE_GRID_ROWS,
  gridSizeAt,
  inGridSelection,
} from './table-grid.ts';

test('the corner cells are the ends of the range', () => {
  assert.deepEqual(gridSizeAt(0, 0), { cols: 1, rows: 1 });
  assert.deepEqual(gridSizeAt(TABLE_GRID_ROWS - 1, TABLE_GRID_COLS - 1), { cols: 6, rows: 4 });
  assert.equal(TABLE_GRID_COLS, 6);
  assert.equal(TABLE_GRID_ROWS, 4);
});

test('a pointer that overshoots the grid is clamped to it', () => {
  assert.deepEqual(gridSizeAt(99, 99), { cols: 6, rows: 4 });
  assert.deepEqual(gridSizeAt(-3, -3), { cols: 1, rows: 1 });
  assert.deepEqual(gridSizeAt(-1, 2), { cols: 3, rows: 1 });
});

test('fractional cell coordinates truncate toward the cell they are in', () => {
  assert.deepEqual(gridSizeAt(0.9, 2.4), { cols: 3, rows: 1 });
  assert.deepEqual(gridSizeAt(2.5, 5.9), { cols: 6, rows: 3 });
});

test('the highlight covers the rectangle the pointer has swept', () => {
  const size = gridSizeAt(1, 2); // 3 × 2
  assert.equal(inGridSelection(0, 0, size), true);
  assert.equal(inGridSelection(1, 2, size), true);
  assert.equal(inGridSelection(2, 0, size), false);
  assert.equal(inGridSelection(0, 3, size), false);
  assert.equal(inGridSelection(0, 0, null), false);
});

test('every cell the picker renders maps to a size inside the grid', () => {
  for (let index = 0; index < TABLE_GRID_COLS * TABLE_GRID_ROWS; index++) {
    const size = gridSizeAt(Math.floor(index / TABLE_GRID_COLS), index % TABLE_GRID_COLS);
    assert.ok(size.cols >= 1 && size.cols <= TABLE_GRID_COLS, `cols ${size.cols} at ${index}`);
    assert.ok(size.rows >= 1 && size.rows <= TABLE_GRID_ROWS, `rows ${size.rows} at ${index}`);
  }
});

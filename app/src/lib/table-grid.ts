/**
 * The table picker's grid — the panel behind the toolbar's table button.
 *
 * A fixed field of cells; sliding the pointer across it picks the size the
 * table will be inserted at. Sizes past the grid are the visual editor's job
 * (`InsertTableDialog`: 1–20 columns × 1–100 rows), which the panel links to
 * — so the grid only has to answer "which size is the cell under the pointer".
 */

export const TABLE_GRID_COLS = 6;
export const TABLE_GRID_ROWS = 4;

/** Cells in reading order — the picker renders one button per entry. */
export const TABLE_GRID_CELLS = TABLE_GRID_COLS * TABLE_GRID_ROWS;

export interface GridSize {
  cols: number;
  rows: number;
}

/**
 * Cell (0-based) → the table size it stands for, clamped to the grid. The
 * clamping is what makes the readout safe to drive straight from a pointer
 * that has overshot the last cell.
 */
export function gridSizeAt(row: number, col: number): GridSize {
  return {
    cols: Math.min(Math.max(Math.trunc(col) + 1, 1), TABLE_GRID_COLS),
    rows: Math.min(Math.max(Math.trunc(row) + 1, 1), TABLE_GRID_ROWS),
  };
}

/** Whether the cell at (row, col) is inside the highlighted size. */
export function inGridSelection(row: number, col: number, size: GridSize | null): boolean {
  if (!size) return false;
  return row < size.rows && col < size.cols;
}

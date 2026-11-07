/**
 * Vector icons for the floating table toolbar (#500 follow-up).
 *
 * The row/column six are rebuilds of the spreadsheet context-menu glyphs the
 * user supplied: a 3x3 table whose *middle* row/column is the accent-blue band,
 * with an arrow leaving the table in the direction the new row/column grows;
 * and for delete, a detached bracket with the blue row/column arrow pulled out
 * of it and a red X at the tip. Geometry lives in a 30x30 box — the same grid
 * the reference bitmaps were measured on — so the proportions, band thickness
 * and arrow overhang match them instead of being approximated at 16 units.
 *
 * Colours are palette slots, not hardcoded values: `--tbl-ic-*` in
 * TableToolbar.vue swaps the light set (light-blue band, dark-blue edge, dark
 * grid) for the dark set (dark-blue band, light-blue edge, light grid). The
 * red X is a thin stroked cross on both.
 *
 * Alignment and the "more" menu stay monochrome `currentColor` — they have no
 * object to point at, and colouring them would compete with the six that do.
 *
 * Path order is paint order: band first, then grid and outline, then the arrow
 * (drawn last, with a background-coloured halo that cuts the lines it crosses)
 * and the cross.
 */
export type TableIconTone = 'line' | 'grid' | 'band' | 'arrow' | 'cross';

export interface TableIconPath {
  d: string;
  /** Palette slot; omitted means `currentColor` (align / move glyphs). */
  tone?: TableIconTone;
}

const line = (d: string): TableIconPath => ({ d, tone: 'line' });
const grid = (d: string): TableIconPath => ({ d, tone: 'grid' });
const band = (d: string): TableIconPath => ({ d, tone: 'band' });
const arrow = (d: string): TableIconPath => ({ d, tone: 'arrow' });
const cross = (d: string): TableIconPath => ({ d, tone: 'cross' });
const s = (d: string): TableIconPath => ({ d });

/** 3x3 table shared by the four insert glyphs. */
const TABLE = [
  band('M2 10.5h26v9h-26z'),
  grid('M10.5 2v26'), grid('M19.5 2v26'),
  grid('M2 10.5h26'), grid('M2 19.5h26'),
  line('M2 2h26v26h-26z'),
];

export type TableIcon =
  | 'row-above'
  | 'row-below'
  | 'row-delete'
  | 'col-left'
  | 'col-right'
  | 'col-delete'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'move-row-up'
  | 'move-row-down'
  | 'move-col-left'
  | 'move-col-right';

export const TABLE_ICON_PATHS: Record<TableIcon, TableIconPath[]> = {
  // ── insert rows ──────────────────────────────────────────────────────────
  // Arrow rises out of the blue middle row, through the top edge.
  'row-above': [
    ...TABLE,
    arrow('M12.5 17V9H8L15 0.8 22 9h-4.5v8z'),
  ],
  'row-below': [
    ...TABLE,
    arrow('M12.5 13v8H8l7 8.2 7-8.2h-4.5v-8z'),
  ],
  // ── insert columns ───────────────────────────────────────────────────────
  // Band is the middle column; the arrow leaves sideways through that edge.
  'col-left': [
    band('M10.5 2h9v26h-9z'),
    grid('M2 10.5h26'), grid('M2 19.5h26'),
    grid('M10.5 2v26'), grid('M19.5 2v26'),
    line('M2 2h26v26h-26z'),
    arrow('M17 12.5H9V8L0.8 15 9 22v-4.5h8z'),
  ],
  'col-right': [
    band('M10.5 2h9v26h-9z'),
    grid('M2 10.5h26'), grid('M2 19.5h26'),
    grid('M10.5 2v26'), grid('M19.5 2v26'),
    line('M2 2h26v26h-26z'),
    arrow('M13 12.5h8V8l8.2 7-8.2 7v-4.5h-8z'),
  ],
  // ── delete ───────────────────────────────────────────────────────────────
  // A bracket with a gap where the row/column leaves, the blue arrow itself,
  // and a thin red X at its tip (not a filled star).
  'row-delete': [
    line('M1.5 1.5h13v7'), line('M1.5 28.5h13v-7'),
    band('M1.5 10h12l6.5 5-6.5 5h-12z'),
    cross('M21 9.5 28.5 19.5'), cross('M21 19.5 28.5 9.5'),
  ],
  'col-delete': [
    line('M1.5 1.5v12h7'), line('M28.5 1.5v12h-7'),
    band('M10 1.5h10v12l-5 6.5-5-6.5z'),
    cross('M10 21 20 29'), cross('M20 21 10 29'),
  ],
  // ── alignment ───────────────────────────────────────────────────────────
  // Four ragged rules whose short rule moves left/centre/right.
  'align-left': [
    s('M3 6h24'), s('M3 12h15'), s('M3 18h21'), s('M3 24h12'),
  ],
  'align-center': [
    s('M3 6h24'), s('M7.5 12h15'), s('M4.5 18h21'), s('M9 24h12'),
  ],
  'align-right': [
    s('M3 6h24'), s('M12 12h15'), s('M6 18h21'), s('M15 24h12'),
  ],
  // ── move (in the “more” menu) ───────────────────────────────────────────
  'move-row-up': [s('M15 25V5'), s('M8 12 15 5l7 7')],
  'move-row-down': [s('M15 5v20'), s('M8 18l7 7 7-7')],
  'move-col-left': [s('M25 15H5'), s('M12 8l-7 7 7 7')],
  'move-col-right': [s('M5 15h20'), s('M18 8l7 7-7 7')],
};

/** Paths for one icon; unknown names render an empty glyph rather than throw. */
export function tableIconPaths(name: TableIcon): TableIconPath[] {
  return TABLE_ICON_PATHS[name] ?? [];
}

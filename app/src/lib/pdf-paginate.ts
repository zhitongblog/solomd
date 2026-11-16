/**
 * Page assembly for the built-in PDF export ("导出为 PDF（图片）").
 *
 * `html2pdf.js` rasterises the whole document with html2canvas and hands that
 * one tall image to jsPDF, which slices it at a fixed page height. Those slice
 * lines know nothing about text: a paragraph or a code line that happens to sit
 * on a boundary gets sheared in half. The pagebreak plugin's `avoid` list is
 * meant to prevent that, but it works in *CSS* pixels while jsPDF slices
 * *raster* pixels — the two grids only agree while the rendered container
 * measures exactly what the plugin assumed, and they drift apart the moment
 * anything about the page size, the margins or the capture scale is off. A
 * long document then collects that drift page after page, and lines start
 * getting cut deeper in the document.
 *
 * So the export paginates the raster itself: for every nominal boundary, look
 * for a *clean* cut line — a row with no ink in it, i.e. the leading between
 * two lines of text — and rebuild the image as whole pages, each exactly
 * `pageHeightPx` tall with its content pinned to the top of the page. jsPDF
 * still does the slicing, but every slice now lands on a row we picked, so no
 * glyph can be cut in half. A page that had to give up a few rows to reach a
 * clean line simply ends with a little more white (and a long document may
 * need one more page than a blind slice would).
 *
 * Tables need a second rule: their column borders put ink on every row, so no
 * row inside a table is ever clean. There the cut goes between two table rows
 * instead (#337) — see `isStructuralRowData`.
 *
 * Everything here is deliberately free of app state so it can be unit tested
 * (see `pdf-paginate.test.ts`) and driven from the browser harness
 * (`pdf-harness.html`).
 */

/** Per-channel slack (0-255) when deciding a row carries no ink. */
const ROW_TOLERANCE = 8;

/** Never spend more than this share of a page hunting for a clean cut line. */
const MAX_SEARCH_SHARE = 0.08;

/**
 * Inside a table a page may give up this much to end between two rows rather
 * than through one — a table row with a few wrapped lines is far taller than
 * the 1.5 lines a text cut searches.
 */
export const MAX_TABLE_SEARCH_SHARE = 0.3;

/** A run of one colour at least this wide is background, not a glyph. */
const LONG_RUN_PX = 16;

/** Long runs darker than this are ink (text strokes, dark slabs), not paper. */
const MIN_BACKGROUND_LUMA = 150;

/** Decides whether raster row `y` is free of ink. */
export type CleanRowProbe = (y: number) => boolean;

/**
 * True when an RGBA row carries no ink — every pixel within `tolerance` of the
 * row's first pixel. Comparing against the row's own colour (rather than
 * against white) is what makes this work inside a code block or a table
 * header: their backgrounds are beige, not white, but the leading between two
 * of their lines is still one flat colour top to bottom.
 *
 * `data` is a single row of RGBA bytes.
 */
export function isCleanRowData(data: Uint8ClampedArray, tolerance = ROW_TOLERANCE): boolean {
  if (data.length < 4) return true;
  const r0 = data[0];
  const g0 = data[1];
  const b0 = data[2];
  for (let i = 4; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - r0) > tolerance ||
      Math.abs(data[i + 1] - g0) > tolerance ||
      Math.abs(data[i + 2] - b0) > tolerance
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The raster row a page should end on for a nominal boundary at `nominalY`.
 *
 * Scans *up* from the boundary for the first row that carries no ink. That is
 * the largest cut which cannot shear a glyph: ink bands are contiguous, so any
 * line of text straddling the cut necessarily has ink *on* the cut row — while
 * a cut one row below such a line (its last inked row) is already fine and must
 * not be given up, or every boundary that lands exactly on a baseline would
 * push a whole extra line to the next page.
 *
 * Scanning up (never down) is what keeps the page from overflowing.
 *
 * Falls back to the nominal boundary when the window is solid ink (a photo, a
 * full-bleed block): that is the old, shearing behaviour, but there is nothing
 * better to do — some row has to be cut.
 */
export function findCleanCut(
  nominalY: number,
  searchUpPx: number,
  isCleanRow: CleanRowProbe,
): number {
  const nominal = Math.floor(nominalY);
  const stop = Math.max(0, nominal - Math.max(0, Math.floor(searchUpPx)));
  for (let y = nominal; y >= stop; y--) {
    if (isCleanRow(y)) return y;
  }
  return nominal;
}

/**
 * True when row `y` of a raster can be cut although it is not one flat colour:
 * everything on it is either background / rule (a long run of one light
 * colour) or a thin vertical line that runs on unchanged `reachPx` rows above
 * and below — a table's column border.
 *
 * This is the case `isCleanRowData` cannot handle and #337 hit: every row of a
 * table carries its vertical borders, so no row inside a table is ever "clean",
 * the search fell back to the nominal boundary and cut straight through a line
 * of cell text. Glyphs fail both tests — text is dark, and even a straight
 * stem ("1", "丨") ends within one line, well short of `reachPx`, which the
 * caller sets to a full line pitch.
 *
 * `row`, `above` and `below` are single RGBA rows of the same width.
 */
export function isStructuralRowData(
  row: Uint8ClampedArray,
  above: Uint8ClampedArray,
  below: Uint8ClampedArray,
  tolerance = ROW_TOLERANCE,
): boolean {
  const px = row.length / 4;
  if (px === 0) return true;
  if (above.length !== row.length || below.length !== row.length) return false;
  const same = (a: Uint8ClampedArray, i: number, b: Uint8ClampedArray, j: number) =>
    Math.abs(a[i] - b[j]) <= tolerance &&
    Math.abs(a[i + 1] - b[j + 1]) <= tolerance &&
    Math.abs(a[i + 2] - b[j + 2]) <= tolerance;
  let start = 0;
  while (start < px) {
    let end = start + 1;
    while (end < px && same(row, start * 4, row, end * 4)) end++;
    const i = start * 4;
    if (end - start >= LONG_RUN_PX) {
      // Background, a zebra stripe, a horizontal rule. Dark long runs are
      // text strokes (a CJK "一") or a dark code slab, never safe to assume.
      const luma = 0.299 * row[i] + 0.587 * row[i + 1] + 0.114 * row[i + 2];
      if (luma < MIN_BACKGROUND_LUMA) return false;
    } else {
      // A short run is only a border if the same pixels carry on far above
      // and below; a glyph's pixels do not.
      for (let x = start; x < end; x++) {
        if (!same(row, x * 4, above, x * 4) || !same(row, x * 4, below, x * 4)) return false;
      }
    }
    start = end;
  }
  return true;
}

/**
 * Ascending raster rows at which to split a `contentHeightPx`-tall raster into
 * pages of `pageHeightPx`. Empty when the document fits on a single page (then
 * there is nothing to shear and the caller can leave the raster alone).
 *
 * Each page starts where the previous one ended, so no page is ever taller
 * than `pageHeightPx`. (Cutting on the fixed grid `k × pageHeightPx` did not
 * guarantee that: after a cut climbed, the next page ran past its slot and its
 * last rows were painted over by the page after it.)
 *
 * A cut first looks for a clean row within `searchUpPx`; failing that — inside
 * a table, where no row is clean — for a structural row (see
 * `isStructuralRowData`) within `tableSearchPx`, i.e. the gap between two table
 * rows. `reachPx` is how far a border must run on to count as one; 0 turns the
 * structural rule off.
 *
 * `readBand(top, rows)` returns `rows` RGBA rows of a `width`-wide raster
 * starting at `top`. It is injected so the caller can fetch exactly one band
 * per boundary — `getImageData` is a GPU readback — and so the tests can feed
 * a synthetic line grid instead of a real canvas.
 */
export function findPageBreaks(
  width: number,
  contentHeightPx: number,
  pageHeightPx: number,
  searchUpPx: number,
  readBand: (top: number, rows: number) => Uint8ClampedArray,
  tableSearchPx = 0,
  reachPx = 0,
): number[] {
  if (!(width > 0) || !(pageHeightPx > 0) || !(contentHeightPx > 0)) return [];
  const pageH = Math.floor(pageHeightPx);
  const cleanUp = Math.max(0, Math.floor(searchUpPx));
  const tableUp = Math.max(cleanUp, Math.floor(tableSearchPx));
  const reach = Math.max(0, Math.floor(reachPx));
  const rowBytes = width * 4;
  const breaks: number[] = [];
  let from = 0;
  while (contentHeightPx - from > pageH) {
    const nominal = from + pageH;
    // Never search above the page's own start: a cut there is no progress.
    const stop = Math.max(from + 1, nominal - tableUp);
    const top = Math.max(0, stop - reach);
    const bottom = Math.min(contentHeightPx - 1, nominal + reach);
    const rows = bottom - top + 1;
    const band = readBand(top, rows);
    // Rows we did not read back must never be assumed blank, or a band that
    // came out too short would silently hand back a cut we know nothing about.
    const rowAt = (y: number) =>
      y < top || y > bottom || (y - top + 1) * rowBytes > band.length
        ? null
        : band.subarray((y - top) * rowBytes, (y - top + 1) * rowBytes);
    let cut = nominal;
    for (let y = nominal; y >= stop; y--) {
      const row = rowAt(y);
      if (!row) continue;
      if (y >= nominal - cleanUp && isCleanRowData(row)) {
        cut = y;
        break;
      }
      if (reach > 0) {
        const above = rowAt(y - reach);
        const below = rowAt(y + reach);
        if (above && below && isStructuralRowData(row, above, below)) {
          cut = y;
          break;
        }
      }
    }
    breaks.push(cut);
    from = cut;
  }
  return breaks;
}

/**
 * How far above a nominal boundary to look, in raster pixels.
 *
 * One and a half body lines is enough to reach the leading above the line that
 * straddles the boundary from anywhere inside it, while staying small enough
 * that a page never visibly loses space. Clamped as a share of the page so a
 * gigantic font size can't carve a hole in the middle of a page.
 */
export function searchWindowPx(
  lineHeightPx: number,
  rasterPerCssPx: number,
  pageHeightPx: number,
): number {
  const wanted = Math.round(lineHeightPx * rasterPerCssPx * 1.5);
  const cap = Math.round(pageHeightPx * MAX_SEARCH_SHARE);
  return Math.max(8, Math.min(wanted, cap));
}

/** A raster re-laid as whole pages, plus the rows each page ends on. */
export interface PagedRaster {
  canvas: HTMLCanvasElement;
  /** Ascending raster rows the pages end on (`breaks.length + 1` pages). */
  breaks: number[];
}

/**
 * Re-lay `source` as whole pages: page N's rows are copied to the top of page
 * N's slot in a taller canvas whose height is an exact multiple of
 * `pageHeightPx`. Slicing that canvas at `pageHeightPx` therefore reproduces
 * our page boundaries instead of guessing its own.
 *
 * `lineHeightPx` is one body line in raster pixels; it turns on the
 * between-table-rows cut (see `findPageBreaks`). 0 leaves text-only cutting.
 *
 * Returns `null` when the raster already fits one page (nothing to fix) or
 * when the canvas can't be read back.
 */
export function buildPagedCanvas(
  source: HTMLCanvasElement,
  pageHeightPx: number,
  searchUpPx: number,
  lineHeightPx = 0,
): PagedRaster | null {
  if (!(pageHeightPx > 0) || source.width <= 0 || source.height <= 0) return null;
  if (source.height <= pageHeightPx) return null;

  const srcCtx = source.getContext('2d');
  if (!srcCtx) return null;

  const width = source.width;
  const breaks = findPageBreaks(
    width,
    source.height,
    pageHeightPx,
    searchUpPx,
    (top, rows) => srcCtx.getImageData(0, top, width, rows).data,
    Math.round(pageHeightPx * MAX_TABLE_SEARCH_SHARE),
    Math.round(lineHeightPx),
  );
  if (!breaks.length) return null;

  const pagedHeight = (breaks.length + 1) * pageHeightPx;
  // Guard Chromium / WebView2's 32,767px <canvas> height limit on huge merged books.
  if (pagedHeight > 32_500) return null;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = pagedHeight;
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;

  // Undrawn rows have to be paper, not transparent: the export keeps CORS
  // images and a PDF viewer would show black behind anything unpainted.
  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, out.width, out.height);

  let from = 0;
  for (let page = 0; page < breaks.length; page++) {
    const to = breaks[page];
    if (to > from) {
      outCtx.drawImage(source, 0, from, width, to - from, 0, page * pageHeightPx, width, to - from);
    }
    from = to;
  }
  // Last page: whatever is left, which is at most one page tall.
  if (source.height > from) {
    outCtx.drawImage(
      source,
      0,
      from,
      width,
      source.height - from,
      0,
      breaks.length * pageHeightPx,
      width,
      source.height - from,
    );
  }
  return { canvas: out, breaks };
}

/**
 * Direct PDF export for SoloMD using html2pdf.js (jsPDF + html2canvas).
 *
 * Strategy: render the markdown into an off-screen DOM container with the
 * same look as the Preview pane, run any Mermaid blocks through the
 * mermaid renderer to inject SVGs, then capture the container with
 * html2canvas and emit a multi-page PDF.
 *
 * Quality is raster (high-DPI) which means: text is not searchable but
 * Chinese / KaTeX / Mermaid all "just work" because we capture whatever
 * the browser actually renders.
 */

// @ts-ignore — html2pdf.js ships no types
import { renderMermaidCached } from './mermaid-lazy';
import { sanitizeModernColors } from './export-colors';
import { renderMarkdown, extractImageRoot } from './markdown';
import { loadRenderDeps } from './render-deps';
import type { ResolvedPdfOptions } from './pdf-options';
import { inlineLocalImages, rewriteImageUrls, rewriteLinkUrls } from './image-resolve';
import { blobToPng, loadImageBlob } from './image-clipboard';
import { renderPlantumlForExport } from './plantuml';
import { buildPagedCanvas, searchWindowPx } from './pdf-paginate';
import { buildExportCustomCss, getActiveCustomCss } from './custom-theme';

const EXPORT_TIMEOUT_MS = 30_000;

const PDF_CSS = `
  body { margin: 0; }
  .html2pdf__overlay, iframe.html2canvas-container { pointer-events: none !important; }
  :where(.pdf-page) {
    box-sizing: border-box;
    /* The container html2pdf hands us is exactly the printable width of the
       chosen page size (190mm → 718px for A4 with 10mm margins), so the page
       column has to fill it. A hard 760px column overflowed every narrower
       setup — A5 with the default margins is 118mm, "Wide" (25mm) margins on A4
       are 160mm — and the capture then cut the right edge off every line.
       760px stays as a cap so wide paper (landscape) doesn't stretch the
       measure, and the padding is proportional for the same reason: a fixed
       64px inset eats an A5 text column alive. */
    width: 100%;
    max-width: 760px;
    padding: 7.5% 8.5% 10%;
    color: var(--text, #1f2328);
    background: var(--bg, #ffffff);
    font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto,
      "Helvetica Neue", Arial,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
      "Noto Sans CJK SC", "WenQuanYi Micro Hei",
      system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    /* #293 — paper cannot scroll, so anything the layout engine refuses to
       break is lost off the right edge. Text carrying NO-BREAK SPACE between
       its words (a Word / web / chat paste) is exactly that: one unbreakable
       run as far as wrapping is concerned. Same reasoning as the pre rule
       below, applied to prose. */
    overflow-wrap: break-word;
  }
  :where(.pdf-page) h1, :where(.pdf-page) h2, :where(.pdf-page) h3,
  :where(.pdf-page) h4, :where(.pdf-page) h5, :where(.pdf-page) h6 {
    line-height: 1.25;
    font-weight: 700;
    color: var(--text, #1f2328);
    margin: 1.8em 0 0.55em;
    page-break-after: avoid;
    break-after: avoid-page;
  }
  :where(.pdf-page) h1:first-child,
  :where(.pdf-page) h2:first-child,
  :where(.pdf-page) h3:first-child { margin-top: 0; }
  :where(.pdf-page) h1 {
    font-size: 2em;
    color: var(--md-h1, var(--text, #1f2328));
    border-bottom: 2px solid var(--md-h1, #3d444d);
    padding-bottom: .32em;
    letter-spacing: -0.01em;
  }
  /* #566 — On the TOC page, center the document title H1 and omit its bottom
     border (while preserving H1/H2 borders on all body pages). */
  :where(.pdf-page) > h1:first-child:has(+ .md-toc),
  :where(.pdf-page) h1.pdf-doc-title {
    text-align: center;
    border-bottom: none !important;
    padding-bottom: 0;
  }
  :where(.pdf-page) .md-toc {
    background: transparent !important;
    border: none !important;
    border-radius: 0 !important;
    padding: 0 !important;
    box-shadow: none !important;
  }
  :where(.pdf-page) .md-toc .md-toc__link {
    display: flex;
    align-items: baseline;
    gap: 0.4em;
    color: inherit;
    border-bottom: none;
  }
  :where(.pdf-page) .md-toc__leader {
    flex: 1 1 auto;
    min-width: 1em;
    border-bottom: 1px dotted currentColor;
    opacity: 0.45;
  }
  :where(.pdf-page) .md-toc__page {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  :where(.pdf-page) .md-toc__link:not(.md-toc__link--paged) .md-toc__leader {
    display: none;
  }
  :where(.pdf-page) > .md-toc:first-child,
  :where(.pdf-page) > h1:first-child + .md-toc,
  :where(.pdf-page) .md-toc.md-toc--lead {
    break-after: page;
    page-break-after: always;
  }
  :where(.pdf-page) > .md-toc:first-child + hr,
  :where(.pdf-page) > h1:first-child + .md-toc + hr,
  :where(.pdf-page) hr.pdf-toc-hr {
    display: none !important;
  }
  :where(.pdf-page) h2 {
    font-size: 1.5em;
    color: var(--md-h2, var(--text, #1f2328));
    border-bottom: 1px solid var(--border, #e4e6e9);
    padding-bottom: .25em;
  }
  :where(.pdf-page) h3 { font-size: 1.2em; color: var(--md-h3, var(--text, #1f2328)); }
  :where(.pdf-page) h4 { font-size: 1.05em; color: var(--md-h4, var(--text, #1f2328)); }
  :where(.pdf-page) h5, :where(.pdf-page) h6 { font-size: 1em; color: var(--md-h5, #59636e); }
  :where(.pdf-page) p { margin: .85em 0; }
  :where(.pdf-page) a {
    color: var(--accent-text, var(--md-link, #0b5cad));
    text-decoration: none;
    border-bottom: 1px solid #c9dcf0;
  }
  :where(.pdf-page) code {
    font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    font-size: .88em;
    background: var(--fill-1, var(--md-code-bg, #f6f8fa));
    padding: .15em .45em;
    border-radius: 4px;
    color: var(--md-code, #1f2328);
  }
  :where(.pdf-page) pre {
    background: var(--fill-1, var(--md-code-bg, #f6f8fa));
    padding: 14px 18px;
    border-radius: 8px;
    /* #211 — paper can't scroll, so long code lines MUST wrap or they get
     * clipped at the page edge (reported as "过长的代码块被截断"). Always
     * soft-wrap in PDF regardless of the on-screen code-block-wrap setting. */
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: break-word;
    margin: 1.1em 0;
    line-height: 1.55;
    border: 1px solid var(--border, #e4e6e9);
    page-break-inside: avoid;
    break-inside: avoid;
  }
  :where(.pdf-page) pre code {
    background: transparent;
    padding: 0;
    font-size: .86em;
    color: var(--md-code, #1f2328);
  }
  :where(.pdf-page) pre code .hljs-keyword,
  :where(.pdf-page) pre code .hljs-built_in,
  :where(.pdf-page) pre code .hljs-tag { color: var(--syn-keyword, #116329); }
  /* #454 — code block line numbers in PDF export when enabled */
  .pdf-page.cb-numbered-on pre.cb-numbered {
    counter-reset: cb-line;
    padding-left: 0;
  }
  .pdf-page.cb-numbered-on pre.cb-numbered code {
    display: block;
    white-space: normal;
  }
  .pdf-page.cb-numbered-on pre.cb-numbered code .cb-line {
    counter-increment: cb-line;
    display: block;
    padding-left: 3.4em;
    position: relative;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: break-word;
  }
  .pdf-page.cb-numbered-on pre.cb-numbered code .cb-line::before {
    content: counter(cb-line);
    position: absolute;
    left: 0;
    width: 2.6em;
    padding-right: 0.6em;
    text-align: right;
    color: var(--text-faint, #59636e);
    border-right: 1px solid var(--border, #e4e6e9);
    user-select: none;
    -webkit-user-select: none;
  }
  :where(.pdf-page) blockquote {
    border-left: 4px solid var(--accent, #3d444d);
    margin: 1.3em 0;
    padding: .5em 1.1em;
    color: var(--md-quote, #59636e);
    font-style: italic;
    background: #f9fafb;
    border-radius: 0 4px 4px 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  :where(.pdf-page) blockquote p { margin: .35em 0; }
  :where(.pdf-page) ul, :where(.pdf-page) ol { padding-left: 1.8em; margin: .9em 0; }
  :where(.pdf-page) li { margin: .3em 0; }
  :where(.pdf-page) table {
    border-collapse: collapse;
    margin: 1.3em 0;
    width: 100%;
    font-size: .95em;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  :where(.pdf-page) th, :where(.pdf-page) td {
    border: 1px solid var(--border, #e4e6e9);
    padding: 7px 13px;
    text-align: left;
    /* #370 — a long unbreakable run (number, identifier, URL) widened the
       table past the page and html2canvas cut the right side off. Let it
       break inside the cell instead (see main.css @media print). */
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  :where(.pdf-page) th::after, :where(.pdf-page) td::after {
    content: '\\00a0';
    display: inline-block;
    width: 0;
    overflow: hidden;
    visibility: hidden;
  }
  /* #271 — short cells stay on one line (see markdown.ts table_short_cells). */
  :where(.pdf-page) .cell-nowrap { white-space: nowrap; }
  :where(.pdf-page) thead th {
    background: #f3f4f6;
    color: var(--text, #1f2328);
    font-weight: 700;
    border-bottom: 2px solid #3d444d;
  }
  .pdf-page tbody tr:nth-child(even) { background: #f9fafb; }
  .pdf-page hr {
    border: none;
    border-top: 1px solid #e4e6e9;
    margin: 2.2em 0;
  }
  .pdf-page img {
    max-width: 100%;
    border-radius: 6px;
    margin: 1.1em 0;
  }
  .pdf-page .mermaid-block {
    display: flex;
    justify-content: center;
    margin: 1.5em 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pdf-page .mermaid-block svg { max-width: 100%; height: auto; }
  .pdf-page .katex-display {
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0.5em 0;
    margin: 0.5em 0;
  }
`;

async function processMermaidBlocks(container: HTMLElement) {
  const blocks = container.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return;   // no diagrams: never pay for the renderer
  // #522 — share the preview's serial queue and theme+source cache. Export
  // containers are detached, so no isConnected guard here.
  for (const block of Array.from(blocks)) {
    const pre = block.parentElement as HTMLElement | null;
    if (!pre) continue;
    const code = (block.textContent || '').trim();
    const result = await renderMermaidCached('default', code);
    if (result.svg) {
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-block';
      wrap.innerHTML = result.svg;
      pre.replaceWith(wrap);
    } else {
      const err = document.createElement('pre');
      err.textContent = `Mermaid error: ${result.error ?? 'unknown error'}`;
      pre.replaceWith(err);
    }
  }
}

/**
 * #115 — html2pdf.js renders into a full-screen `div.html2pdf__overlay`
 * (position:fixed; z-index:1000; visible) and html2canvas clones into an
 * `iframe.html2canvas-container`. On a thrown or hung export these are left
 * mounted: the overlay swallows EVERY mouse click (the UI feels frozen, Cmd-Q
 * only) and the orphan iframe surfaces as a zoomable "nested page" that
 * survives a restart. Sweep them so no export, success or failure, can wedge
 * the app.
 */
function sweepExportLeftovers(): void {
  document
    .querySelectorAll('.html2pdf__overlay, iframe.html2canvas-container')
    .forEach((n) => n.remove());
}

export interface PdfRasterCapture {
  /** The raster html2pdf captured, still unsliced. */
  canvas: HTMLCanvasElement | null;
  /**
   * Height of one page in raster pixels — jsPDF's own slice height, derived
   * the same way `toPdf()` derives it so a re-paginated raster lines up with
   * the slicer exactly. `0` when html2pdf's internals are not reachable, which
   * switches pagination off and leaves the old behaviour in place.
   */
  pageHeightPx: number;
  /** How far above a boundary a page cut may look, in raster pixels. */
  searchUpPx: number;
  /** One body line in raster pixels (drives the between-table-rows cut). */
  lineHeightPx: number;
  /** Hand back a re-paginated raster for `finish()` to slice. */
  useCanvas(canvas: HTMLCanvasElement, breaks?: number[]): void;
  /** Slice the raster into pages and assemble the PDF. */
  finish(): Promise<Blob>;
  /** Drop the off-screen page and sweep any html2pdf leftovers (#115). */
  dispose(): void;
}

export interface PdfOutlineHeading {
  level: number;
  text: string;
  pageNumber: number;
}

export interface JsPdfOutlineLike {
  add(parent: unknown, title: string, options: { pageNumber: number }): unknown;
  makeString?: (val: string) => string;
}

export interface JsPdfLinkTargetOptions {
  url?: string;
  pageNumber?: number;
  top?: number;
  left?: number;
  zoom?: number;
  magFactor?: 'Fit' | 'FitH' | 'FitV' | 'XYZ';
}

export interface JsPdfLinkLike {
  setPage(page: number): unknown;
  link(x: number, y: number, w: number, h: number, options: JsPdfLinkTargetOptions): unknown;
  internal?: { getNumberOfPages?: () => number };
}

export interface PdfMeasuredLink {
  kind: 'internal' | 'external';
  rectRaster: { x: number; y: number; width: number; height: number };
  targetRasterY?: number;
  url?: string;
}

const HEX_OUTLINE_PATCHED = Symbol.for('solomd.pdfHexOutlineString');

/**
 * #563 — Encode a PDF `/Title` string safely for jsPDF's outline dictionary.
 *
 * jsPDF's default `outline.makeString(val)` writes a literal string
 * `(` + `pdfEscape(to8bitStream(val))` + `)`. For non-ASCII text, `to8bitStream`
 * emits UTF-16BE bytes (`\xfe\xff...`), and `pdfEscape` only escapes `\`, `(`, `)`.
 * Any UTF-16 code unit whose high or low byte is `0x0D` (CR) — e.g. `名`
 * (`U+540D`), `不` (`U+4E0D`), `－` (`U+FF0D`) — leaves a bare `0x0D` byte inside
 * the literal string. Per ISO 32000-1 §7.3.4.2, PDF readers normalize bare CR
 * in literal strings to `0x0A` (LF), shifting the code point by −3 (`名` → `吊`,
 * `不` → `上`).
 *
 * Encoding non-ASCII titles as a UTF-16BE hexadecimal string `<FEFF...>` (§7.3.4.3)
 * avoids literal-string EOL normalization and delimiter escaping altogether.
 */
export function encodePdfOutlineString(
  val: string,
  fallbackMakeString?: (s: string) => string,
): string {
  const str = String(val ?? '');
  if (/^[\x20-\x7E]*$/.test(str)) {
    if (fallbackMakeString) return fallbackMakeString(str);
    return `(${str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
  }
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return `<${hex}>`;
}

/**
 * #515 / #567 — Map a source raster Y coordinate to its 1-based PDF page number
 * and vertical pixel offset within that page after `buildPagedCanvas` slicing.
 */
export function rasterRowToPageLocation(
  rasterY: number,
  pageHeightPx: number,
  breaks?: number[] | null,
): { pageNumber: number; offsetInPagePx: number } {
  const y = Math.max(0, rasterY);
  if (breaks && breaks.length > 0) {
    let pageStart = 0;
    for (let i = 0; i < breaks.length; i++) {
      if (y < breaks[i]) {
        return {
          pageNumber: i + 1,
          offsetInPagePx: Math.max(0, y - pageStart),
        };
      }
      pageStart = breaks[i];
    }
    return {
      pageNumber: breaks.length + 1,
      offsetInPagePx: Math.max(0, y - pageStart),
    };
  }
  if (pageHeightPx > 0) {
    const pageIndex = Math.max(0, Math.floor(y / pageHeightPx));
    return {
      pageNumber: pageIndex + 1,
      offsetInPagePx: Math.max(0, y - pageIndex * pageHeightPx),
    };
  }
  return { pageNumber: 1, offsetInPagePx: 0 };
}

/**
 * #515 — Map a heading's raster Y coordinate to a 1-based PDF page number.
 * When `buildPagedCanvas` re-paginated the raster, `breaks` holds the ascending
 * raster rows where each page ends (`breaks.length + 1` pages total).
 */
export function rasterRowToPageNumber(
  rasterY: number,
  pageHeightPx: number,
  breaks?: number[] | null,
): number {
  return rasterRowToPageLocation(rasterY, pageHeightPx, breaks).pageNumber;
}

/**
 * #566 — Decorate `<nav class="md-toc">` for PDF export:
 * 1. Marks a leading document title `H1` before `.md-toc` with `.pdf-doc-title`
 *    (centered, no bottom border line), while keeping borders on body headings.
 * 2. Marks the leading `.md-toc` with `.md-toc--lead` + `.html2pdf__page-break`
 *    and hides any `<hr>` immediately after `.md-toc`.
 * 3. Wraps each `.md-toc__link` label in `.md-toc__text` and appends
 *    `.md-toc__leader` + `.md-toc__page` slots so page numbers can be filled.
 */
export function decoratePdfToc(root: HTMLElement): HTMLElement | null {
  const navs = Array.from(root.querySelectorAll<HTMLElement>('nav.md-toc'));
  if (!navs.length) return null;
  for (const nav of navs) {
    if (nav.dataset.pdfDecorated === '1') continue;
    nav.dataset.pdfDecorated = '1';
    const prev = nav.previousElementSibling as HTMLElement | null;
    const isLeading =
      nav === root.firstElementChild ||
      (prev === root.firstElementChild && prev?.tagName === 'H1');
    if (isLeading) {
      nav.classList.add('md-toc--lead', 'html2pdf__page-break');
      if (prev?.tagName === 'H1') {
        prev.classList.add('pdf-doc-title');
      }
      const next = nav.nextElementSibling as HTMLElement | null;
      if (next?.tagName === 'HR') {
        next.classList.add('pdf-toc-hr');
      }
    }
    for (const link of Array.from(nav.querySelectorAll<HTMLAnchorElement>('a.md-toc__link'))) {
      if (link.querySelector('.md-toc__page')) continue;
      const text = root.ownerDocument.createElement('span');
      text.className = 'md-toc__text';
      while (link.firstChild) text.appendChild(link.firstChild);
      const leader = root.ownerDocument.createElement('span');
      leader.className = 'md-toc__leader';
      const pageSlot = root.ownerDocument.createElement('span');
      pageSlot.className = 'md-toc__page';
      pageSlot.textContent = '1';
      link.append(text, leader, pageSlot);
      link.classList.add('md-toc__link--paged');
    }
  }
  return navs[0];
}

/**
 * #567 / #562 — Resolve an in-page `#anchor` href inside `root`.
 * Synthetic folder headings (`data-toc-folder="1"`) that immediately precede a
 * child heading advance to that child heading so folder TOC entries jump to the
 * exact start of the first note under them.
 */
export function resolvePdfAnchorTarget(
  root: ParentNode,
  href: string,
): HTMLElement | null {
  const trimmed = String(href ?? '').trim();
  if (!trimmed.startsWith('#') || trimmed.length <= 1) return null;
  const rawId = trimmed.slice(1);
  let decodedId = rawId;
  try {
    decodedId = decodeURIComponent(rawId);
  } catch {
    // Keep rawId when not valid percent-encoding.
  }
  let target: HTMLElement | null = null;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[id]'))) {
    if (el.id === decodedId || el.id === rawId) {
      target = el;
      break;
    }
  }
  while (
    target &&
    target.getAttribute('data-toc-folder') === '1' &&
    target.nextElementSibling instanceof HTMLElement &&
    /^H[1-6]$/.test(target.nextElementSibling.tagName)
  ) {
    target = target.nextElementSibling;
  }
  return target;
}

/**
 * #566 — Fill each `.md-toc__page` slot inside `root` with the 1-based page
 * number of its target heading.
 */
export function fillPdfTocPageNumbers(
  root: ParentNode,
  pageOfEl: (el: HTMLElement) => number,
): Array<{ pageEl: HTMLElement; targetEl: HTMLElement; pageNumber: number }> {
  const filled: Array<{ pageEl: HTMLElement; targetEl: HTMLElement; pageNumber: number }> = [];
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a.md-toc__link'))) {
    const slot = link.querySelector<HTMLElement>('.md-toc__page');
    if (!slot) continue;
    const target = resolvePdfAnchorTarget(root, link.getAttribute('href') || '');
    const pageNumber = target ? Math.max(1, Math.round(pageOfEl(target) || 1)) : 0;
    slot.textContent = pageNumber > 0 ? String(pageNumber) : '';
    link.classList.toggle('md-toc__link--paged', pageNumber > 0);
    if (target && pageNumber > 0) {
      filled.push({ pageEl: slot, targetEl: target, pageNumber });
    }
  }
  return filled;
}

/**
 * #567 — Inject internal (`/Dest` page jump) and external (`/URI`) link
 * annotations into jsPDF using the re-paginated page break boundaries.
 *
 * Replaces html2pdf.js's built-in `hyperlinks` plugin, which:
 * 1) Passed `link.href` (`http://tauri.localhost/#...`) as an external `/URI`
 *    for in-document `#anchor` links, causing PDF viewers to show an external
 *    URL warning and open a browser instead of jumping inside the PDF (#567);
 * 2) Computed link coordinates before `buildPagedCanvas` re-paginated the raster.
 */
export function populatePdfLinks(
  pdf: JsPdfLinkLike | null | undefined,
  links: PdfMeasuredLink[],
  geometry: {
    canvasWidth: number;
    pageHeightPx: number;
    innerWidthMm: number;
    marginTopMm: number;
    marginLeftMm: number;
  },
  pageBreaks?: number[] | null,
): void {
  if (
    !pdf ||
    typeof pdf.setPage !== 'function' ||
    typeof pdf.link !== 'function' ||
    !links.length ||
    !(geometry.canvasWidth > 0) ||
    !(geometry.innerWidthMm > 0)
  ) {
    return;
  }
  const totalPages =
    typeof pdf.internal?.getNumberOfPages === 'function'
      ? Math.max(1, pdf.internal.getNumberOfPages())
      : Infinity;
  const mmPerRasterPx = geometry.innerWidthMm / geometry.canvasWidth;

  for (const item of links) {
    const { x, y, width, height } = item.rectRaster;
    if (!(width > 0) || !(height > 0)) continue;
    const loc = rasterRowToPageLocation(y, geometry.pageHeightPx, pageBreaks);
    const linkPage = Math.min(totalPages, Math.max(1, loc.pageNumber));
    const xMm = geometry.marginLeftMm + Math.max(0, x) * mmPerRasterPx;
    const yMm = geometry.marginTopMm + loc.offsetInPagePx * mmPerRasterPx;
    const wMm = width * mmPerRasterPx;
    const hMm = height * mmPerRasterPx;

    pdf.setPage(linkPage);
    if (item.kind === 'internal' && typeof item.targetRasterY === 'number') {
      const targetLoc = rasterRowToPageLocation(
        item.targetRasterY,
        geometry.pageHeightPx,
        pageBreaks,
      );
      const targetPageNumber = Math.min(totalPages, Math.max(1, targetLoc.pageNumber));
      const targetTopMm = Math.max(
        0,
        geometry.marginTopMm + targetLoc.offsetInPagePx * mmPerRasterPx - 2,
      );
      pdf.link(xMm, yMm, wMm, hMm, {
        pageNumber: targetPageNumber,
        top: targetTopMm,
      });
    } else if (item.kind === 'external' && item.url) {
      pdf.link(xMm, yMm, wMm, hMm, { url: item.url });
    }
  }

  if (Number.isFinite(totalPages)) {
    pdf.setPage(totalPages);
  }
}

/**
 * #515 — Populate jsPDF's document outline (PDF left-sidebar bookmarks) with a
 * properly nested H1–H6 hierarchy so PDF readers show a collapsible TOC tree.
 */
export function populatePdfOutline(
  outline: JsPdfOutlineLike | null | undefined,
  headings: PdfOutlineHeading[],
): void {
  if (!outline || typeof outline.add !== 'function' || !headings.length) return;
  const patchedObj = outline as JsPdfOutlineLike & Record<symbol, boolean>;
  if (typeof outline.makeString === 'function' && !patchedObj[HEX_OUTLINE_PATCHED]) {
    const origMakeString = outline.makeString.bind(outline);
    outline.makeString = (val: string) => encodePdfOutlineString(val, origMakeString);
    patchedObj[HEX_OUTLINE_PATCHED] = true;
  }
  const stack: Array<{ level: number; node: unknown }> = [];
  for (const h of headings) {
    const title = h.text.replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const level = Math.max(1, Math.min(6, Math.round(h.level || 1)));
    const pageNumber = Math.max(1, Math.round(h.pageNumber || 1));
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1].node : null;
    const node = outline.add(parent, title, { pageNumber });
    stack.push({ level, node });
  }
}

/**
 * The parts of html2pdf's worker we reach into to re-paginate its raster. Not
 * in the published types and not part of its API — hence the cast — but it is
 * the only way to keep jsPDF's slicing from shearing a line of text (see
 * `pdf-paginate.ts`). Every use is optional-chained: if a future version
 * reshapes `prop`, `markdownToPdfBlob` simply behaves as it did before.
 */
interface Html2PdfWorkerInternals {
  prop?: {
    container?: HTMLElement;
    canvas?: HTMLCanvasElement;
    pageSize?: {
      inner?: {
        width: number;
        height: number;
        px?: { width: number; height: number };
      };
    };
    pdf?: JsPdfLinkLike & {
      outline?: JsPdfOutlineLike;
      internal?: { getNumberOfPages?: () => number };
    };
  };
}

/** CSS pixels per millimetre at the 96dpi the layout engine uses. */
const CSS_PX_PER_MM = 96 / 25.4;

/** Fallback body line height (px) when the computed style can't be read. */
const FALLBACK_LINE_HEIGHT_PX = 26;

/**
 * Render `source` into an off-screen page and rasterise it, without slicing it
 * into pages yet.
 *
 * The raster is handed back so it can be re-paginated (see `pdf-paginate.ts`)
 * before `finish()` lets jsPDF slice it. Exported for the pagination harness
 * (`app/pdf-harness.html`), which measures exactly what the export measures.
 */
/** Swap every cross-origin <img> for a data: URL of the same bytes (fetched
 *  by the page when CORS allows, by Rust otherwise) and wait for it to load.
 *  SVGs — remote or local — are rasterized to PNG on the way: html2canvas
 *  crops an SVG that has a viewBox but no width/height (most icons/logos)
 *  instead of scaling it into its box. */
async function inlineRemoteImages(container: HTMLElement): Promise<void> {
  const imgs = Array.from(container.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') || '';
      const isSvg = /\.svg(?:[?#]|$)/i.test(src) || /^data:image\/svg/i.test(src);
      let crossOrigin = false;
      if (/^https?:/i.test(src)) {
        try {
          crossOrigin = new URL(src, location.href).origin !== location.origin;
        } catch {
          return;
        }
      }
      if (!crossOrigin && !isSvg) return;
      try {
        let blob = await loadImageBlob(src);
        if (isSvg || blob.type === 'image/svg+xml') blob = await blobToPng(blob);
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        });
        await new Promise<void>((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = dataUrl;
        });
      } catch (e) {
        console.warn('[pdf] remote image not inlined', src, e);
      }
    }),
  );
}

export async function capturePdfRaster(
  source: string,
  title: string,
  pdfOpts?: ResolvedPdfOptions,
  filePath?: string,
  plantumlServer?: string | null,
  codeBlockLineNumbers?: boolean,
): Promise<PdfRasterCapture> {
  await loadRenderDeps(); // rendered once — no placeholder math / plain code
  const rawHtml = renderMarkdown(source || '');
  // v4.3.0 issue #77 — also rewrite link hrefs so local-file links
  // don't bake in `http://tauri.localhost/...` URLs.
  const imageRoot = extractImageRoot(source || '');
  const withLocalImages = await inlineLocalImages(rawHtml, imageRoot, filePath);
  const html = rewriteLinkUrls(
    rewriteImageUrls(withLocalImages, imageRoot, filePath),
    imageRoot,
    filePath,
  );

  // Build an off-screen container that mimics the preview look.
  const styleEl = document.createElement('style');
  styleEl.textContent = PDF_CSS;

  // v2.5 F3: derived font / size CSS overlay (only when caller passed
  // options that the user actually customized). Empty string when the user
  // hasn't touched Settings *and* the doc has no `pdf:` block.
  let extraStyle: HTMLStyleElement | null = null;
  if (pdfOpts && pdfOpts.pageSizeMm && pdfOpts.marginMm) {
    extraStyle = document.createElement('style');
    const fontDecl = pdfOpts.fontFamily.trim()
      ? `font-family: ${quoteFontFamily(pdfOpts.fontFamily)}, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif !important;`
      : '';
    const codeOverride =
      pdfOpts.codeTheme === 'light'
        ? `.pdf-page pre, .pdf-page code { background: #f6f8fa !important; color: #1f2328 !important; }`
        : pdfOpts.codeTheme === 'dark'
        ? `.pdf-page pre, .pdf-page code { background: #1f2328 !important; color: #eee !important; }`
        : '';
    extraStyle.textContent = `
      .pdf-page {
        ${fontDecl}
        font-size: ${pdfOpts.fontSizePt}pt !important;
      }
      ${codeOverride}
    `;
  }

  const root = document.createElement('div');
  root.style.position = 'fixed';
  root.style.left = '-10000px';
  root.style.top = '0';
  root.style.zIndex = '-1';

  const page = document.createElement('article');
  page.className = ['pdf-page', 'preview-content', codeBlockLineNumbers ? 'cb-numbered-on' : '']
    .filter(Boolean)
    .join(' ');
  page.innerHTML = html;

  root.appendChild(styleEl);
  if (extraStyle) root.appendChild(extraStyle);
  const customCss = buildExportCustomCss(getActiveCustomCss(), '.pdf-page');
  if (customCss) {
    const customStyleEl = document.createElement('style');
    customStyleEl.textContent = customCss;
    root.appendChild(customStyleEl);
  }
  root.appendChild(page);
  document.body.appendChild(root);

  let cleaned = false;
  const dispose = () => {
    if (cleaned) return;
    cleaned = true;
    root.remove();
    sweepExportLeftovers();
  };
  try {
    // Render any Mermaid blocks before capture.
    await processMermaidBlocks(page);
    // PlantUML diagrams (#163) — before inlining, so their server SVGs get
    // the same treatment as any other remote image.
    await renderPlantumlForExport(page, plantumlServer);
    // Remote images come out blank otherwise: html2canvas can only draw a
    // cross-origin image when the host sends CORS headers, and most image
    // hosts don't — "导出为 pdf 图片，部分信息也丢失了".
    await inlineRemoteImages(page);
    // #566 — Decorate any `[TOC]` block with dotted leaders, page-number slots,
    // centered borderless document title H1, and a page break after a leading TOC.
    decoratePdfToc(page);
    // Give the browser a tick to lay everything out (KaTeX fonts especially).
    await new Promise((r) => setTimeout(r, 60));
    // #115 — convert any modern CSS color functions (color()/oklch()/…) that
    // html2canvas can't parse into resolved sRGB rgba(), now that Mermaid SVGs
    // and KaTeX are in the tree. Runs on the live (offscreen) node so
    // getComputedStyle sees the cascade.
    sanitizeModernColors(page);

    const opts = buildHtml2PdfOptions(title, pdfOpts);
    // html2pdf drags in jsPDF + html2canvas (~1 MB). Load it when an
    // export actually happens, not on every cold start.
    const html2pdf = (await import('html2pdf.js')).default;
    const worker = html2pdf().set(opts).from(page);
    // Materialize html2pdf's container + pagebreak spacers first so we can
    // fill TOC page numbers and measure heading/link rects on the exact DOM
    // tree that html2canvas is about to capture (#566, #567).
    if (typeof worker.toContainer === 'function') {
      await worker.toContainer();
    }
    const prop = (worker as unknown as Html2PdfWorkerInternals).prop;
    const containerEl = prop?.container ?? page;
    const measurePage =
      prop?.container?.querySelector<HTMLElement>('.pdf-page') ?? containerEl;
    const innerPre = prop?.pageSize?.inner;
    const containerRectPre = containerEl.getBoundingClientRect();
    const containerWidthPre =
      containerEl.offsetWidth || containerRectPre.width || page.offsetWidth || 1;
    const singlePageHeightCss =
      innerPre && innerPre.width > 0 && innerPre.height > 0
        ? containerWidthPre * (innerPre.height / innerPre.width)
        : prop?.pageSize?.inner?.px?.height || 1000;

    // Ensure a leading TOC page breaks cleanly onto the next page boundary.
    const leadToc = measurePage.querySelector<HTMLElement>('nav.md-toc.md-toc--lead');
    if (leadToc && singlePageHeightCss > 0) {
      const tocBottomRel = Math.max(
        0,
        leadToc.getBoundingClientRect().bottom - containerRectPre.top,
      );
      const nextPageTopCss =
        Math.ceil((tocBottomRel + 1) / singlePageHeightCss) * singlePageHeightCss + 4;
      const neededPad = Math.max(0, Math.round(nextPageTopCss - tocBottomRel));
      const nextSibling = leadToc.nextElementSibling as HTMLElement | null;
      if (nextSibling && !nextSibling.id && nextSibling.tagName === 'DIV' && !nextSibling.children.length) {
        const currentH = parseFloat(nextSibling.style.height || '0') || 0;
        if (currentH < neededPad) {
          nextSibling.style.height = `${neededPad}px`;
        }
      } else if (neededPad > 0) {
        const pad = measurePage.ownerDocument.createElement('div');
        pad.style.display = 'block';
        pad.style.height = `${neededPad}px`;
        leadToc.parentNode?.insertBefore(pad, leadToc.nextSibling);
      }
    }

    const containerRect = containerEl.getBoundingClientRect();
    const containerWidthCss =
      containerEl.offsetWidth || containerRect.width || page.offsetWidth || 1;
    const filledToc = fillPdfTocPageNumbers(measurePage, (targetEl) => {
      const relTop = Math.max(0, targetEl.getBoundingClientRect().top - containerRect.top);
      return Math.max(1, Math.floor(relTop / singlePageHeightCss) + 1);
    });

    const containerHeightCss =
      containerEl.offsetHeight || containerRect.height || page.offsetHeight || 1;

    const tocSlotsCss = filledToc.map((entry) => {
      const r = entry.pageEl.getBoundingClientRect();
      const targetRect = entry.targetEl.getBoundingClientRect();
      const cs = getComputedStyle(entry.pageEl);
      return {
        relLeftCss: Math.max(0, r.left - containerRect.left),
        relTopCss: Math.max(0, r.top - containerRect.top),
        widthCss: Math.max(1, r.width),
        heightCss: Math.max(1, r.height),
        targetRelTopCss: Math.max(0, targetRect.top - containerRect.top),
        initialPageNumber: entry.pageNumber,
        fontFamily: cs.fontFamily || 'sans-serif',
        fontSizePx: parseFloat(cs.fontSize) || 14,
        color: cs.color || '#1f2328',
      };
    });

    // #515 — Measure heading positions on the live container before `toCanvas()`
    // removes the overlay, so `finish()` can inject a navigable PDF outline.
    const rawHeadingsCss = Array.from(
      measurePage.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
    )
      .filter((el) => !el.closest('.md-toc'))
      .map((el) => {
        const customLevel = Number(el.getAttribute('data-toc-level'));
        const level =
          Number.isFinite(customLevel) && customLevel >= 1
            ? customLevel
            : Number(el.tagName.slice(1)) || 1;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const elRect = el.getBoundingClientRect();
        const relTopCss = Math.max(0, elRect.top - containerRect.top);
        return { el, level, text, relTopCss };
      })
      .filter((h) => h.text.length > 0);
    // #562 — Folder headings immediately preceding their first note's first
    // heading jump to that first note heading's exact position/page.
    for (let k = rawHeadingsCss.length - 2; k >= 0; k--) {
      if (
        rawHeadingsCss[k].el.getAttribute('data-toc-folder') === '1' &&
        rawHeadingsCss[k].el.nextElementSibling === rawHeadingsCss[k + 1].el &&
        rawHeadingsCss[k + 1].level > rawHeadingsCss[k].level
      ) {
        rawHeadingsCss[k].relTopCss = rawHeadingsCss[k + 1].relTopCss;
      }
    }

    // #567 — Measure all internal (`#anchor`) and external links on the live
    // container so `finish()` can attach PDF link annotations aligned with
    // `buildPagedCanvas` page breaks.
    const rawLinksCss: Array<{
      kind: 'internal' | 'external';
      relLeftCss: number;
      relTopCss: number;
      widthCss: number;
      heightCss: number;
      targetRelTopCss?: number;
      url?: string;
    }> = [];
    for (const a of Array.from(measurePage.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const rawHref = (a.getAttribute('href') || '').trim();
      if (!rawHref) continue;
      const isTocLink = a.classList.contains('md-toc__link');
      const clientRects = isTocLink ? [] : Array.from(a.getClientRects());
      const rects = clientRects.length > 0 ? clientRects : [a.getBoundingClientRect()];
      if (rawHref.startsWith('#')) {
        const targetEl = resolvePdfAnchorTarget(measurePage, rawHref);
        if (!targetEl) continue;
        const targetRelTopCss = Math.max(
          0,
          targetEl.getBoundingClientRect().top - containerRect.top,
        );
        for (const r of rects) {
          if (!(r.width > 0) || !(r.height > 0)) continue;
          rawLinksCss.push({
            kind: 'internal',
            relLeftCss: Math.max(0, r.left - containerRect.left),
            relTopCss: Math.max(0, r.top - containerRect.top),
            widthCss: r.width,
            heightCss: r.height,
            targetRelTopCss,
          });
        }
      } else if (
        /^(https?|mailto|tel|file):/i.test(rawHref) &&
        !/^https?:\/\/tauri\.localhost\b/i.test(rawHref)
      ) {
        for (const r of rects) {
          if (!(r.width > 0) || !(r.height > 0)) continue;
          rawLinksCss.push({
            kind: 'external',
            relLeftCss: Math.max(0, r.left - containerRect.left),
            relTopCss: Math.max(0, r.top - containerRect.top),
            widthCss: r.width,
            heightCss: r.height,
            url: rawHref,
          });
        }
      }
    }

    // Capture here rather than letting `outputPdf()` do it, so the raster can
    // be re-paginated first.
    await worker.toCanvas();
    const canvas = prop?.canvas ?? null;
    const inner = prop?.pageSize?.inner;
    const geometry = pdfPaginationGeometry(canvas, inner, page);

    const scaleX = canvas ? canvas.width / containerWidthCss : 0;
    const scaleY = canvas ? canvas.height / containerHeightCss : 0;

    const rawHeadings = rawHeadingsCss.map((h) => ({
      level: h.level,
      text: h.text,
      rasterY: canvas ? Math.round(h.relTopCss * scaleY) : 0,
    }));

    const measuredLinks: PdfMeasuredLink[] = rawLinksCss.map((l) => ({
      kind: l.kind,
      rectRaster: {
        x: Math.round(l.relLeftCss * scaleX),
        y: Math.round(l.relTopCss * scaleY),
        width: Math.max(1, Math.round(l.widthCss * scaleX)),
        height: Math.max(1, Math.round(l.heightCss * scaleY)),
      },
      targetRasterY:
        typeof l.targetRelTopCss === 'number' ? Math.round(l.targetRelTopCss * scaleY) : undefined,
      url: l.url,
    }));

    let pageBreaks: number[] | null = null;

    return {
      canvas,
      pageHeightPx: geometry.pageHeightPx,
      searchUpPx: geometry.searchUpPx,
      lineHeightPx: geometry.lineHeightPx,
      useCanvas(replacement: HTMLCanvasElement, breaks?: number[]) {
        if (prop) prop.canvas = replacement;
        if (breaks) {
          pageBreaks = breaks;
          // If re-pagination shifted any heading's page number relative to the
          // pre-capture estimate, repaint that TOC entry's page slot on the
          // paged raster so the visible TOC number matches the link target.
          const ctx = replacement.getContext('2d');
          if (ctx && tocSlotsCss.length > 0 && geometry.pageHeightPx > 0) {
            for (const slot of tocSlotsCss) {
              const targetRasterY = Math.round(slot.targetRelTopCss * scaleY);
              const actualPage = rasterRowToPageNumber(
                targetRasterY,
                geometry.pageHeightPx,
                breaks,
              );
              if (actualPage === slot.initialPageNumber) continue;
              const slotRasterY = Math.round(slot.relTopCss * scaleY);
              const slotLoc = rasterRowToPageLocation(
                slotRasterY,
                geometry.pageHeightPx,
                breaks,
              );
              const slotX = Math.round(slot.relLeftCss * scaleX);
              const slotW = Math.max(8, Math.round(slot.widthCss * scaleX));
              const slotH = Math.max(8, Math.round(slot.heightCss * scaleY));
              const drawY =
                (slotLoc.pageNumber - 1) * geometry.pageHeightPx + slotLoc.offsetInPagePx;
              ctx.save();
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(Math.max(0, slotX - 4), Math.max(0, drawY - 1), slotW + 8, slotH + 2);
              ctx.fillStyle = slot.color;
              ctx.font = `${Math.round(slot.fontSizePx * scaleY)}px ${slot.fontFamily}`;
              ctx.textAlign = 'right';
              ctx.textBaseline = 'top';
              ctx.fillText(String(actualPage), slotX + slotW, drawY);
              ctx.restore();
            }
          }
        }
      },
      async finish(): Promise<Blob> {
        await worker.toPdf();
        const pdf = prop?.pdf;
        const totalPages =
          typeof pdf?.internal?.getNumberOfPages === 'function'
            ? pdf.internal.getNumberOfPages()
            : Infinity;
        if (pdf?.outline && rawHeadings.length > 0) {
          const outlineHeadings: PdfOutlineHeading[] = rawHeadings.map((h) => ({
            level: h.level,
            text: h.text,
            pageNumber: Math.min(
              totalPages,
              rasterRowToPageNumber(h.rasterY, geometry.pageHeightPx, pageBreaks),
            ),
          }));
          try {
            populatePdfOutline(pdf.outline, outlineHeadings);
          } catch (err) {
            console.warn('[pdf] outline generation skipped', err);
          }
        }
        if (pdf && measuredLinks.length > 0 && canvas && inner) {
          try {
            const marginArr = Array.isArray(opts.margin) ? opts.margin : [10, 10, 12, 10];
            populatePdfLinks(
              pdf,
              measuredLinks,
              {
                canvasWidth: canvas.width,
                pageHeightPx: geometry.pageHeightPx,
                innerWidthMm: inner.width,
                marginTopMm: Number(marginArr[0]) || 0,
                marginLeftMm: Number(marginArr[1]) || 0,
              },
              pageBreaks,
            );
          } catch (err) {
            console.warn('[pdf] link annotation generation skipped', err);
          }
        }
        return await worker.outputPdf('blob');
      },
      dispose,
    };
  } catch (e) {
    dispose();
    throw e;
  }
}

/**
 * jsPDF slice height + how far a cut may climb, both in raster pixels.
 *
 * `pageHeightPx` repeats html2pdf's own arithmetic (`toPdf()` does
 * `Math.floor(canvas.width * pageSize.inner.ratio)`), because the re-paginated
 * raster is only safe if the slicer's grid and ours are the same grid.
 */
function pdfPaginationGeometry(
  canvas: HTMLCanvasElement | null,
  inner: { width: number; height: number } | undefined,
  page: HTMLElement,
): { pageHeightPx: number; searchUpPx: number; lineHeightPx: number } {
  if (!canvas || !inner || !(inner.width > 0) || !(inner.height > 0)) {
    return { pageHeightPx: 0, searchUpPx: 0, lineHeightPx: 0 };
  }
  const pageHeightPx = Math.floor(canvas.width * (inner.height / inner.width));
  // html2pdf's container is exactly the printable width, declared in mm, so
  // this converts raster pixels back to CSS pixels for the line-height cap.
  const rasterPerCssPx = canvas.width / (inner.width * CSS_PX_PER_MM);
  const measured = parseFloat(getComputedStyle(page).lineHeight);
  const lineHeightPx = Number.isFinite(measured) ? measured : FALLBACK_LINE_HEIGHT_PX;
  return {
    pageHeightPx,
    searchUpPx: searchWindowPx(lineHeightPx, rasterPerCssPx, pageHeightPx),
    lineHeightPx: Math.round(lineHeightPx * rasterPerCssPx),
  };
}

/**
 * @param source — markdown source (may include YAML front matter; rendering
 *   strips the block so it doesn't bleed into the PDF body).
 * @param title — used for the `filename` field on the html2pdf builder.
 * @param pdfOpts — v2.5 resolved options (Settings + frontmatter merged).
 *   Pass `undefined` to preserve pre-v2.5 hardcoded A4 / 10mm behavior.
 * @param filePath — used to resolve relative image paths in the markdown.
 */
export async function markdownToPdfBlob(
  source: string,
  title: string,
  pdfOpts?: ResolvedPdfOptions,
  filePath?: string,
  plantumlServer?: string | null,
  codeBlockLineNumbers?: boolean,
): Promise<Blob> {
  // Timeout guard — prevents the export from hanging the UI indefinitely
  // if html2pdf.js or Mermaid gets stuck. It sweeps html2pdf's leftovers on
  // the way out: a hung capture can leave its invisible full-screen overlay
  // mounted, which swallows every click in the app.
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      sweepExportLeftovers();
      reject(new Error('PDF export timed out'));
    }, EXPORT_TIMEOUT_MS),
  );

  const render = async (): Promise<Blob> => {
    const capture = await capturePdfRaster(
      source,
      title,
      pdfOpts,
      filePath,
      plantumlServer,
      codeBlockLineNumbers,
    );
    try {
      // jsPDF slices the raster at a fixed page height, which shears whatever
      // line of text sits on the boundary. Re-lay the raster as whole pages
      // first, so every slice lands on a row with no ink in it.
      if (capture.canvas) {
        try {
          const paged = buildPagedCanvas(
            capture.canvas,
            capture.pageHeightPx,
            capture.searchUpPx,
            capture.lineHeightPx,
          );
          if (paged) capture.useCanvas(paged.canvas, paged.breaks);
        } catch (e) {
          console.warn('[pdf] pagination skipped', e);
        }
      }
      return await capture.finish();
    } finally {
      capture.dispose();
    }
  };

  return await Promise.race([render(), timeout]);
}

/** The html2pdf option object, shared by the export and the test harness. */
export function buildHtml2PdfOptions(title: string, pdfOpts?: ResolvedPdfOptions): any {
  // v2.5 F3: derive jsPDF / margin args from the resolved opts. When
  // the caller didn't customize anything, fall back to the legacy
  // hardcoded values so old users see exactly the same output as v2.4.
  let margins: [number, number, number, number] = [10, 10, 12, 10];
  let jsPdfFormat: string | [number, number] = 'a4';
  let orientation: 'portrait' | 'landscape' = 'portrait';
  if (pdfOpts && pdfOpts.pageSizeMm && pdfOpts.marginMm) {
    margins = [
      pdfOpts.marginMm.top,
      pdfOpts.marginMm.right,
      pdfOpts.marginMm.bottom,
      pdfOpts.marginMm.left,
    ];
    const named = pageSizeLabelToJsPdf(pdfOpts.pageSizeLabel);
    if (named) {
      jsPdfFormat = named;
    } else {
      jsPdfFormat = [pdfOpts.pageSizeMm.width, pdfOpts.pageSizeMm.height];
    }
    orientation =
      pdfOpts.pageSizeMm.width > pdfOpts.pageSizeMm.height ? 'landscape' : 'portrait';
  }

  return {
    margin: margins,
    filename: `${title || 'document'}.pdf`,
    enableLinks: false,
    image: { type: 'jpeg', quality: 0.96 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      letterRendering: true,
      logging: false,
    },
    jsPDF: {
      unit: 'mm',
      format: jsPdfFormat,
      orientation,
    },
    pagebreak: {
      mode: ['css', 'legacy'],
      // html2canvas rasterises the whole document and jsPDF slices it by
      // page height, so a page break can shear a line of body text in
      // half. `avoid` makes html2pdf's element-level pass push these whole
      // elements onto the next page instead. Body paragraphs (`p`), list
      // items (`li`) and images (`img`) were missing — that left running
      // text getting cut across the page boundary. (We deliberately keep
      // `ul`/`ol` OUT: avoiding those would treat a whole multi-page list
      // as one unsplittable block; we break between `li`s instead.)
      //
      // This pass works in CSS pixels while jsPDF slices raster pixels, so it
      // can only ever be a hint — see `pdf-paginate.ts` for the pass that
      // actually guarantees no glyph is cut.
      avoid: [
        'pre', '.mermaid-block', 'table', 'blockquote',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'li', 'img',
      ],
    },
  };
}

function pageSizeLabelToJsPdf(label: string): string | null {
  switch (label) {
    case 'A4':
      return 'a4';
    case 'A5':
      return 'a5';
    case 'Letter':
      return 'letter';
    case 'Legal':
      return 'legal';
    default:
      return null;
  }
}

function quoteFontFamily(family: string): string {
  const trimmed = family.trim();
  if (trimmed.includes(',')) return trimmed;
  if (/^["']/.test(trimmed)) return trimmed;
  if (/\s/.test(trimmed)) return `"${trimmed}"`;
  return trimmed;
}

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
import { initMermaid } from './mermaid-lazy';
import { sanitizeModernColors } from './export-colors';
import { renderMarkdown, extractImageRoot } from './markdown';
import { loadRenderDeps } from './render-deps';
import type { ResolvedPdfOptions } from './pdf-options';
import { rewriteImageUrls, rewriteLinkUrls } from './image-resolve';
import { blobToPng, loadImageBlob } from './image-clipboard';
import { renderPlantumlForExport } from './plantuml';
import { buildPagedCanvas, searchWindowPx } from './pdf-paginate';

const EXPORT_TIMEOUT_MS = 30_000;

const PDF_CSS = `
  body { margin: 0; }
  .pdf-page {
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
    color: #1f2328;
    background: #ffffff;
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
  .pdf-page h1, .pdf-page h2, .pdf-page h3,
  .pdf-page h4, .pdf-page h5, .pdf-page h6 {
    line-height: 1.25;
    font-weight: 700;
    color: #1f2328;
    margin: 1.8em 0 0.55em;
    page-break-after: avoid;
    break-after: avoid-page;
  }
  .pdf-page h1:first-child,
  .pdf-page h2:first-child,
  .pdf-page h3:first-child { margin-top: 0; }
  .pdf-page h1 {
    font-size: 2em;
    border-bottom: 2px solid #3d444d;
    padding-bottom: .32em;
    letter-spacing: -0.01em;
  }
  .pdf-page h2 {
    font-size: 1.5em;
    border-bottom: 1px solid #e4e6e9;
    padding-bottom: .25em;
  }
  .pdf-page h3 { font-size: 1.2em; }
  .pdf-page h4 { font-size: 1.05em; }
  .pdf-page h5, .pdf-page h6 { font-size: 1em; color: #59636e; }
  .pdf-page p { margin: .85em 0; }
  .pdf-page a {
    color: #0b5cad;
    text-decoration: none;
    border-bottom: 1px solid #c9dcf0;
  }
  .pdf-page code {
    font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    font-size: .88em;
    background: #f6f8fa;
    padding: .15em .45em;
    border-radius: 4px;
    color: #1f2328;
  }
  .pdf-page pre {
    background: #f6f8fa;
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
    border: 1px solid #e4e6e9;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pdf-page pre code {
    background: transparent;
    padding: 0;
    font-size: .86em;
    color: #1f2328;
  }
  .pdf-page pre code .hljs-keyword,
  .pdf-page pre code .hljs-built_in,
  .pdf-page pre code .hljs-tag { color: #116329; }
  .pdf-page blockquote {
    border-left: 4px solid #3d444d;
    margin: 1.3em 0;
    padding: .5em 1.1em;
    color: #59636e;
    font-style: italic;
    background: #f9fafb;
    border-radius: 0 4px 4px 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pdf-page blockquote p { margin: .35em 0; }
  .pdf-page ul, .pdf-page ol { padding-left: 1.8em; margin: .9em 0; }
  .pdf-page li { margin: .3em 0; }
  .pdf-page table {
    border-collapse: collapse;
    margin: 1.3em 0;
    width: 100%;
    font-size: .95em;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pdf-page th, .pdf-page td {
    border: 1px solid #e4e6e9;
    padding: 7px 13px;
    text-align: left;
    /* #370 — a long unbreakable run (number, identifier, URL) widened the
       table past the page and html2canvas cut the right side off. Let it
       break inside the cell instead (see main.css @media print). */
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  /* #271 — short cells stay on one line (see markdown.ts table_short_cells). */
  .pdf-page .cell-nowrap { white-space: nowrap; }
  .pdf-page thead th {
    background: #f3f4f6;
    color: #1f2328;
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

let mermaidId = 0;

async function processMermaidBlocks(container: HTMLElement) {
  const blocks = container.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return;   // no diagrams: never pay for the renderer
  const mermaid = await initMermaid({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'default',
  });
  for (const block of Array.from(blocks)) {
    const pre = block.parentElement as HTMLElement | null;
    if (!pre) continue;
    const code = (block.textContent || '').trim();
    const id = `pdf-mmd-${++mermaidId}`;
    try {
      const { svg } = await mermaid.render(id, code);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-block';
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch (e) {
      const err = document.createElement('pre');
      err.textContent = `Mermaid error: ${(e as Error).message}`;
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
  useCanvas(canvas: HTMLCanvasElement): void;
  /** Slice the raster into pages and assemble the PDF. */
  finish(): Promise<Blob>;
  /** Drop the off-screen page and sweep any html2pdf leftovers (#115). */
  dispose(): void;
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
    canvas?: HTMLCanvasElement;
    pageSize?: { inner?: { width: number; height: number } };
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
): Promise<PdfRasterCapture> {
  await loadRenderDeps(); // rendered once — no placeholder math / plain code
  const rawHtml = renderMarkdown(source || '');
  // v4.3.0 issue #77 — also rewrite link hrefs so local-file links
  // don't bake in `http://tauri.localhost/...` URLs.
  const imageRoot = extractImageRoot(source || '');
  const html = rewriteLinkUrls(
    rewriteImageUrls(rawHtml, imageRoot, filePath),
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
  page.className = 'pdf-page';
  page.innerHTML = html;

  root.appendChild(styleEl);
  if (extraStyle) root.appendChild(extraStyle);
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
    // Capture here rather than letting `outputPdf()` do it, so the raster can
    // be re-paginated first.
    await worker.toCanvas();
    const prop = (worker as unknown as Html2PdfWorkerInternals).prop;
    const canvas = prop?.canvas ?? null;
    const inner = prop?.pageSize?.inner;
    const geometry = pdfPaginationGeometry(canvas, inner, page);

    return {
      canvas,
      pageHeightPx: geometry.pageHeightPx,
      searchUpPx: geometry.searchUpPx,
      lineHeightPx: geometry.lineHeightPx,
      useCanvas(replacement: HTMLCanvasElement) {
        if (prop) prop.canvas = replacement;
      },
      async finish(): Promise<Blob> {
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
    const capture = await capturePdfRaster(source, title, pdfOpts, filePath, plantumlServer);
    try {
      // jsPDF slices the raster at a fixed page height, which shears whatever
      // line of text sits on the boundary. Re-lay the raster as whole pages
      // first, so every slice lands on a row with no ink in it.
      const paged = capture.canvas
        ? buildPagedCanvas(
            capture.canvas,
            capture.pageHeightPx,
            capture.searchUpPx,
            capture.lineHeightPx,
          )
        : null;
      if (paged) capture.useCanvas(paged.canvas);
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

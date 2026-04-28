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
import html2pdf from 'html2pdf.js';
import mermaid from 'mermaid';
import { renderMarkdown, extractImageRoot } from './markdown';
import type { ResolvedPdfOptions } from './pdf-options';
import { rewriteImageUrls } from './image-resolve';

const PDF_CSS = `
  body { margin: 0; }
  .pdf-page {
    box-sizing: border-box;
    width: 760px;
    padding: 56px 64px 72px;
    color: #1f1d1a;
    background: #ffffff;
    font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto,
      "Helvetica Neue", Arial,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
      "Noto Sans CJK SC", "WenQuanYi Micro Hei",
      system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .pdf-page h1, .pdf-page h2, .pdf-page h3,
  .pdf-page h4, .pdf-page h5, .pdf-page h6 {
    line-height: 1.25;
    font-weight: 700;
    color: #1f1d1a;
    margin: 1.8em 0 0.55em;
    page-break-after: avoid;
    break-after: avoid-page;
  }
  .pdf-page h1:first-child,
  .pdf-page h2:first-child,
  .pdf-page h3:first-child { margin-top: 0; }
  .pdf-page h1 {
    font-size: 2em;
    border-bottom: 2px solid #ff9f40;
    padding-bottom: .32em;
    letter-spacing: -0.01em;
  }
  .pdf-page h2 {
    font-size: 1.5em;
    border-bottom: 1px solid #e6e2d8;
    padding-bottom: .25em;
  }
  .pdf-page h3 { font-size: 1.2em; }
  .pdf-page h4 { font-size: 1.05em; }
  .pdf-page h5, .pdf-page h6 { font-size: 1em; color: #6a6560; }
  .pdf-page p { margin: .85em 0; }
  .pdf-page a {
    color: #ff9f40;
    text-decoration: none;
    border-bottom: 1px solid #ffe7cc;
  }
  .pdf-page code {
    font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    font-size: .88em;
    background: #f3efe7;
    padding: .15em .45em;
    border-radius: 4px;
    color: #8a4a00;
  }
  .pdf-page pre {
    background: #f3efe7;
    padding: 14px 18px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 1.1em 0;
    line-height: 1.55;
    border: 1px solid #e6e2d8;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pdf-page pre code {
    background: transparent;
    padding: 0;
    font-size: .86em;
    color: #1f1d1a;
  }
  .pdf-page pre code .hljs-keyword,
  .pdf-page pre code .hljs-built_in,
  .pdf-page pre code .hljs-tag { color: #ff9f40; }
  .pdf-page blockquote {
    border-left: 4px solid #ff9f40;
    margin: 1.3em 0;
    padding: .5em 1.1em;
    color: #6a6560;
    font-style: italic;
    background: #fff7ec;
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
    border: 1px solid #e6e2d8;
    padding: 7px 13px;
    text-align: left;
  }
  .pdf-page thead th {
    background: #ffe7cc;
    color: #1f1d1a;
    font-weight: 700;
    border-bottom: 2px solid #ff9f40;
  }
  .pdf-page tbody tr:nth-child(even) { background: #f7f4ec; }
  .pdf-page hr {
    border: none;
    border-top: 1px solid #e6e2d8;
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
    margin: 1em 0;
  }
`;

let mermaidId = 0;

async function processMermaidBlocks(container: HTMLElement) {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
  const blocks = container.querySelectorAll('pre > code.language-mermaid');
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
): Promise<Blob> {
  const rawHtml = renderMarkdown(source || '');
  const html = rewriteImageUrls(rawHtml, extractImageRoot(source || ''), filePath);

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
        ? `.pdf-page pre, .pdf-page code { background: #f3efe7 !important; color: #1f1d1a !important; }`
        : pdfOpts.codeTheme === 'dark'
        ? `.pdf-page pre, .pdf-page code { background: #1f1d1a !important; color: #eee !important; }`
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

  try {
    // Render any Mermaid blocks before capture.
    await processMermaidBlocks(page);
    // Give the browser a tick to lay everything out (KaTeX fonts especially).
    await new Promise((r) => setTimeout(r, 60));

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
      // jsPDF accepts named formats ('a4' / 'letter' / 'legal') or [w, h].
      const named = pageSizeLabelToJsPdf(pdfOpts.pageSizeLabel);
      if (named) {
        jsPdfFormat = named;
        // 'a5' is portrait by default; same orientation logic as the
        // others. We always emit portrait — landscape isn't a v2.5 feature.
      } else {
        jsPdfFormat = [pdfOpts.pageSizeMm.width, pdfOpts.pageSizeMm.height];
      }
      orientation =
        pdfOpts.pageSizeMm.width > pdfOpts.pageSizeMm.height ? 'landscape' : 'portrait';
    }

    const opts: any = {
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
        avoid: ['pre', '.mermaid-block', 'table', 'blockquote', 'h1', 'h2', 'h3'],
      },
    };
    const worker = html2pdf().set(opts).from(page);

    const blob: Blob = await worker.outputPdf('blob');
    return blob;
  } finally {
    document.body.removeChild(root);
  }
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

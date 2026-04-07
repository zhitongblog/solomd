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
import { renderMarkdown } from './markdown';

const PDF_CSS = `
  body { margin: 0; }
  .pdf-page {
    box-sizing: border-box;
    width: 760px;
    padding: 40px 56px 56px;
    color: #1a1a1a;
    background: #ffffff;
    font: 15px/1.7 -apple-system, "Segoe UI", "Inter", Roboto,
      "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei",
      "WenQuanYi Micro Hei", system-ui, sans-serif;
  }
  .pdf-page h1, .pdf-page h2, .pdf-page h3, .pdf-page h4 {
    line-height: 1.25;
    font-weight: 700;
    margin: 1.6em 0 0.5em;
  }
  .pdf-page h1 {
    font-size: 2em;
    border-bottom: 1px solid #e5e3dc;
    padding-bottom: .3em;
  }
  .pdf-page h2 {
    font-size: 1.5em;
    border-bottom: 1px solid #e5e3dc;
    padding-bottom: .25em;
  }
  .pdf-page h3 { font-size: 1.2em; }
  .pdf-page p { margin: .8em 0; }
  .pdf-page a { color: #ff9f40; text-decoration: none; }
  .pdf-page code {
    font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    font-size: .9em;
    background: #f3efe7;
    padding: .15em .4em;
    border-radius: 4px;
  }
  .pdf-page pre {
    background: #f3efe7;
    padding: 14px 16px;
    border-radius: 6px;
    overflow-x: auto;
    page-break-inside: avoid;
  }
  .pdf-page pre code {
    background: transparent;
    padding: 0;
    font-size: .85em;
  }
  .pdf-page blockquote {
    border-left: 3px solid #ff9f40;
    margin: 1em 0;
    padding: .2em 1em;
    color: #6a6a6a;
  }
  .pdf-page ul, .pdf-page ol { padding-left: 1.6em; }
  .pdf-page table { border-collapse: collapse; margin: 1em 0; }
  .pdf-page th, .pdf-page td {
    border: 1px solid #e5e3dc;
    padding: 6px 12px;
  }
  .pdf-page hr {
    border: none;
    border-top: 1px solid #e5e3dc;
    margin: 2em 0;
  }
  .pdf-page img { max-width: 100%; }
  .pdf-page .mermaid-block {
    display: flex;
    justify-content: center;
    margin: 1.5em 0;
    page-break-inside: avoid;
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

export async function markdownToPdfBlob(source: string, title: string): Promise<Blob> {
  const html = renderMarkdown(source || '');

  // Build an off-screen container that mimics the preview look.
  const styleEl = document.createElement('style');
  styleEl.textContent = PDF_CSS;

  const root = document.createElement('div');
  root.style.position = 'fixed';
  root.style.left = '-10000px';
  root.style.top = '0';
  root.style.zIndex = '-1';

  const page = document.createElement('article');
  page.className = 'pdf-page';
  page.innerHTML = html;

  root.appendChild(styleEl);
  root.appendChild(page);
  document.body.appendChild(root);

  try {
    // Render any Mermaid blocks before capture.
    await processMermaidBlocks(page);
    // Give the browser a tick to lay everything out (KaTeX fonts especially).
    await new Promise((r) => setTimeout(r, 60));

    const opts: any = {
      margin: [10, 10, 12, 10],
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
        format: 'a4',
        orientation: 'portrait',
      },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['pre', '.mermaid-block', 'table'] },
    };
    const worker = html2pdf().set(opts).from(page);

    const blob: Blob = await worker.outputPdf('blob');
    return blob;
  } finally {
    document.body.removeChild(root);
  }
}

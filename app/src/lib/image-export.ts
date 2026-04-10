/**
 * Export markdown as a PNG image by rendering it off-screen and capturing
 * with html2canvas. Reuses the same CSS as the PDF export for consistency.
 *
 * Two functions:
 *   - markdownToImageBlob(source, title) → Blob (PNG)
 *   - markdownToImageCanvas(source, title) → HTMLCanvasElement
 */

// html2pdf.js bundles html2canvas; we import it directly for image-only use.
// @ts-ignore — no types
import html2canvas from 'html2canvas';
import mermaid from 'mermaid';
import { renderMarkdown } from './markdown';

const IMAGE_CSS = `
  body { margin: 0; }
  .img-page {
    box-sizing: border-box;
    width: 800px;
    padding: 48px 56px 56px;
    color: #1f1d1a;
    background: #ffffff;
    font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto,
      "Helvetica Neue", Arial,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
      "Noto Sans CJK SC", "WenQuanYi Micro Hei",
      system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .img-page h1, .img-page h2, .img-page h3,
  .img-page h4, .img-page h5, .img-page h6 {
    line-height: 1.25; font-weight: 700; color: #1f1d1a;
    margin: 1.6em 0 0.5em;
  }
  .img-page h1:first-child, .img-page h2:first-child { margin-top: 0; }
  .img-page h1 { font-size: 2em; border-bottom: 2px solid #ff9f40; padding-bottom: .3em; }
  .img-page h2 { font-size: 1.5em; border-bottom: 1px solid #e6e2d8; padding-bottom: .25em; }
  .img-page h3 { font-size: 1.2em; }
  .img-page p { margin: .85em 0; }
  .img-page a { color: #ff9f40; text-decoration: none; }
  .img-page code {
    font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    font-size: .88em; background: #f3efe7; padding: .15em .45em; border-radius: 4px;
    color: #8a4a00;
  }
  .img-page pre {
    background: #f3efe7; padding: 14px 18px; border-radius: 8px;
    overflow-x: auto; margin: 1.1em 0; line-height: 1.55;
    border: 1px solid #e6e2d8;
  }
  .img-page pre code { background: transparent; padding: 0; color: #1f1d1a; }
  .img-page blockquote {
    border-left: 4px solid #ff9f40; margin: 1.3em 0; padding: .5em 1.1em;
    color: #6a6560; font-style: italic; background: #fff7ec;
    border-radius: 0 4px 4px 0;
  }
  .img-page ul, .img-page ol { padding-left: 1.8em; margin: .9em 0; }
  .img-page table { border-collapse: collapse; margin: 1.3em 0; width: 100%; font-size: .95em; }
  .img-page th, .img-page td { border: 1px solid #e6e2d8; padding: 7px 13px; text-align: left; }
  .img-page thead th { background: #ffe7cc; font-weight: 700; border-bottom: 2px solid #ff9f40; }
  .img-page hr { border: none; border-top: 1px solid #e6e2d8; margin: 2em 0; }
  .img-page img { max-width: 100%; border-radius: 6px; margin: 1em 0; }
  .img-page .mermaid-block { display: flex; justify-content: center; margin: 1.5em 0; }
  .img-page .mermaid-block svg { max-width: 100%; height: auto; }
  .img-page .katex-display { overflow-x: auto; margin: 1em 0; }

  /* Watermark / branding */
  .img-footer {
    margin-top: 28px;
    padding-top: 14px;
    border-top: 1px solid #e6e2d8;
    font-size: 11px;
    color: #b8b6ad;
    text-align: center;
    font-family: -apple-system, sans-serif;
  }
  .img-footer .brand { color: #ff9f40; font-weight: 600; }
`;

let mermaidId = 0;

async function processMermaidBlocks(container: HTMLElement) {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
  const blocks = container.querySelectorAll('pre > code.language-mermaid');
  for (const block of Array.from(blocks)) {
    const pre = block.parentElement as HTMLElement | null;
    if (!pre) continue;
    const code = (block.textContent || '').trim();
    const id = `img-mmd-${++mermaidId}`;
    try {
      const { svg } = await mermaid.render(id, code);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-block';
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch {
      // silently skip broken mermaid
    }
  }
}

export async function markdownToImageBlob(source: string, _title?: string): Promise<Blob> {
  const html = renderMarkdown(source || '');

  const styleEl = document.createElement('style');
  styleEl.textContent = IMAGE_CSS;

  const root = document.createElement('div');
  root.style.position = 'fixed';
  root.style.left = '-10000px';
  root.style.top = '0';
  root.style.zIndex = '-1';

  const page = document.createElement('article');
  page.className = 'img-page';
  page.innerHTML = html;

  // Add a small branded footer
  const footer = document.createElement('div');
  footer.className = 'img-footer';
  footer.innerHTML = `Created with <span class="brand">SoloMD</span> · solomd.app`;
  page.appendChild(footer);

  root.appendChild(styleEl);
  root.appendChild(page);
  document.body.appendChild(root);

  try {
    await processMermaidBlocks(page);
    await new Promise((r) => setTimeout(r, 60));

    const canvas = await html2canvas(page, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
    });

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob: Blob | null) => {
          if (blob) resolve(blob);
          else reject(new Error('canvas.toBlob returned null'));
        },
        'image/png',
        1.0
      );
    });
  } finally {
    document.body.removeChild(root);
  }
}

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
import { renderMarkdown, extractImageRoot } from './markdown';
import { rewriteImageUrls } from './image-resolve';

export interface ImageExportOptions {
  /** When true, append a "Created with SoloMD · solomd.app" footer.
   *  Default true (mirroring the settings store default); pass false
   *  to opt out per-call. */
  branding?: boolean;
}

const IMAGE_CSS = `
  body { margin: 0; }
  .img-page {
    box-sizing: border-box;
    /* Width adapts to content: shrink for short notes, cap at 800px
       so long prose still wraps cleanly. min-width keeps the card
       from collapsing to a sliver on a single-word note. v3.6.x
       used a fixed 800px which made every export the same width
       regardless of content. */
    width: fit-content;
    max-width: 800px;
    min-width: 480px;
    /* Bottom padding is set per-export based on whether the SoloMD
       footer is rendered. With the footer, 56px gives the watermark
       breathing room from the content above. Without it, 36px keeps
       short notes from looking like they have a void underneath. */
    padding: 48px 56px 36px;
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

  /* Watermark / branding — rendered when settings.imageExportBranding
     is on (default ON in v3.6). Toggleable in Settings → Export so
     users who'd rather not have a watermark on shared screenshots can
     opt out cleanly, without us having forced "no brand" on everyone. */
  .img-page--branded { padding-bottom: 56px; }
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

export async function markdownToImageBlob(
  source: string,
  _title?: string,
  filePath?: string,
  opts: ImageExportOptions = {},
): Promise<Blob> {
  const rawHtml = renderMarkdown(source || '');
  const html = rewriteImageUrls(rawHtml, extractImageRoot(source || ''), filePath);

  const styleEl = document.createElement('style');
  styleEl.textContent = IMAGE_CSS;

  const root = document.createElement('div');
  root.style.position = 'fixed';
  root.style.left = '-10000px';
  root.style.top = '0';
  root.style.zIndex = '-1';

  const page = document.createElement('article');
  page.className = opts.branding ? 'img-page img-page--branded' : 'img-page';
  page.innerHTML = html;

  // Branded footer default ON — settings.imageExportBranding controls
  // it (Settings → Export). When the user disables it, we tighten the
  // bottom padding via `.img-page--branded` not being applied so short
  // notes export tight.
  if (opts.branding) {
    const footer = document.createElement('div');
    footer.className = 'img-footer';
    footer.innerHTML = `Created with <span class="brand">SoloMD</span> · solomd.app`;
    page.appendChild(footer);
  }

  root.appendChild(styleEl);
  root.appendChild(page);
  document.body.appendChild(root);

  try {
    await processMermaidBlocks(page);
    await new Promise((r) => setTimeout(r, 60));

    // Let html2canvas auto-size to the element's natural bounding box.
    // v3.6 originally passed explicit width/height/windowWidth/windowHeight
    // here, which broke export entirely on every platform: the page sits
    // at `left: -10000px` (off-screen render trick), and telling
    // html2canvas the window was only 800px wide put the element
    // *outside* the captured viewport — output came back blank. The
    // crop-to-content concern that change tried to address turned out
    // to be the forced footer + extra bottom padding, both of which are
    // already handled by the `imageExportBranding` toggle above.
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

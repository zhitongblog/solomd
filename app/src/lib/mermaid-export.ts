/**
 * mermaid-export.ts — rasterize a rendered Mermaid <svg> to a PNG blob (#162).
 *
 * The WebView's native "save image" on a Mermaid block yields HTML (the
 * diagram is inline SVG, not an <img>), so we serialize the SVG and draw it
 * onto a canvas ourselves. Mermaid embeds its theme CSS inside the SVG, so
 * an <img> render keeps the styling without any external fetches.
 */

export interface SvgPngOptions {
  /** Rasterization scale over the SVG's intrinsic size (default 2×). */
  scale?: number;
  /** Canvas background; pass 'transparent' to keep alpha. */
  background?: string;
}

function svgIntrinsicSize(svg: SVGElement): { width: number; height: number } {
  const vb = (svg as SVGSVGElement).viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
  const rect = svg.getBoundingClientRect();
  return { width: rect.width || 800, height: rect.height || 600 };
}

export async function svgToPngBlob(svg: SVGElement, opts: SvgPngOptions = {}): Promise<Blob> {
  const scale = opts.scale ?? 2;
  const { width, height } = svgIntrinsicSize(svg);

  // Mermaid 11 emits width="100%" + a max-width style; pin the clone to its
  // intrinsic size so the <img> renders at a deterministic resolution.
  const clone = svg.cloneNode(true) as SVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.style.maxWidth = 'none';

  const markup = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

  const img = new Image();
  img.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to render diagram SVG'));
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  if (opts.background && opts.background !== 'transparent') {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG encode failed'));
    }, 'image/png');
  });
}

/** Theme-matched export background: dark diagrams get a dark canvas. */
export function diagramBackground(): string {
  const isDark =
    document.documentElement.getAttribute('data-theme') === 'dark' ||
    document.documentElement.classList.contains('dark');
  return isDark ? '#1e1e1e' : '#ffffff';
}

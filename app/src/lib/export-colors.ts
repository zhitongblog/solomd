/**
 * Shared by the two html2canvas exports (raster PDF, PNG image): html2canvas
 * 1.4.1 throws on any computed color it cannot parse, and WebKit hands those
 * out — e.g. WebKitGTK's UA style gives a disabled task-list checkbox
 * `color: color(srgb 0.34 0.34 0.34)`, which made Export to Image / Copy as
 * Image fail on every note with a `- [x]` item.
 */

// #115 — html2canvas (bundled by html2pdf.js) can't parse modern CSS color
// functions: `color(display-p3 …)`, `oklch()`, `oklab()`, `lab()`, `lch()`,
// `hwb()`, `color-mix()`. When a theme or inline span resolves to one of these,
// the whole export throws "Attempting to parse an unsupported color function"
// and leaves the user staring at a half-dead UI. WebKit's getComputedStyle
// returns these functions verbatim (e.g. "color(display-p3 1 0 0)"), so we walk
// the off-screen render tree, resolve every offending color to a concrete sRGB
// rgba() via a 1×1 canvas (canvas defaults to the sRGB colorspace and
// gamut-maps for us), and pin it inline. html2canvas then only ever sees rgba().
const MODERN_COLOR_FN = /\b(?:color|oklch|oklab|lab|lch|hwb|color-mix)\(/i;
const COLOR_PROPS = [
  'color',
  'backgroundColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'outlineColor',
  'textDecorationColor',
  'columnRuleColor',
  'caretColor',
  // html2canvas parses this one too; WebKitGTK reports it as color(srgb …)
  // on form controls.
  'webkitTextStrokeColor',
  'fill',
  'stroke',
] as const;

function makeSrgbResolver(): (value: string) => string | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cache = new Map<string, string | null>();
  return (value: string): string | null => {
    if (cache.has(value)) return cache.get(value)!;
    let out: string | null = null;
    try {
      if (ctx) {
        // A sentinel fill first: if the browser can't parse `value`, fillStyle
        // silently keeps the previous value, so we'd read the sentinel back and
        // know the conversion is unsafe — better to leave the original alone.
        ctx.fillStyle = '#abcdef';
        ctx.fillStyle = value;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        out = `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
      }
    } catch {
      out = null;
    }
    cache.set(value, out);
    return out;
  };
}

/**
 * Replace unsupported modern color functions in `root` (and all descendants)
 * with resolved sRGB rgba(), set inline so html2canvas reads only colors it
 * understands. Best-effort and fully guarded — sanitization must never be the
 * reason an export fails. (#115)
 */
export function sanitizeModernColors(root: HTMLElement): void {
  try {
    const resolve = makeSrgbResolver();
    const els = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
    for (const el of els) {
      const cs = getComputedStyle(el);
      for (const prop of COLOR_PROPS) {
        const v = (cs as unknown as Record<string, string>)[prop];
        if (v && MODERN_COLOR_FN.test(v)) {
          const rgba = resolve(v);
          if (rgba) el.style.setProperty(camelToKebab(prop), rgba, 'important');
        }
      }
    }
  } catch {
    /* never let color sanitization break the export */
  }
}

export function camelToKebab(s: string): string {
  const kebab = s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  // Vendor-prefixed properties keep their leading dash: -webkit-…
  return /^webkit-/.test(kebab) ? `-${kebab}` : kebab;
}

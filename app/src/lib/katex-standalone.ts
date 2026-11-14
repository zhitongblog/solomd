/**
 * KaTeX styles for the standalone HTML export (#313, #332).
 *
 * Math is rendered to HTML by `renderMarkdown()`, so the exported page only
 * needs KaTeX's stylesheet and fonts. It used to `<link>` them from jsDelivr:
 * a render-blocking request on every open (seconds where jsDelivr is slow —
 * the "HTML takes several seconds to open" half of #332), unstyled math with
 * no connection, and a stylesheet pinned to 0.16.9 while the markup came from
 * whatever KaTeX the app bundles.
 *
 * Now the bundled stylesheet is written into the page with its woff2 fonts as
 * `data:` URLs (woff/ttf fallbacks dropped — every browser that can open the
 * file reads woff2). Only called for documents that contain math, and the
 * fonts are fetched from the app's own bundle at export time.
 */
import katexCss from 'katex/dist/katex.min.css?raw';

// Eager: these are only URL strings (the fonts are in the bundle already,
// `main.ts` imports katex.min.css); the bytes are fetched on export.
const fontUrls = (
  typeof import.meta.glob === 'function'
    ? import.meta.glob('/node_modules/katex/dist/fonts/*.woff2', {
        query: '?url',
        import: 'default',
        eager: true,
      })
    : {}
) as Record<string, string>;

let cached: Promise<string> | null = null;

async function toDataUrl(url: string): Promise<string> {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return `data:font/woff2;base64,${btoa(bin)}`;
}

/** KaTeX CSS with every font embedded; no external URL left in it. */
export function standaloneKatexCss(): Promise<string> {
  if (!cached) {
    cached = (async () => {
      const byName = new Map<string, string>();
      await Promise.all(
        Object.entries(fontUrls).map(async ([path, url]) => {
          const name = path.slice(path.lastIndexOf('/') + 1);
          byName.set(name, await toDataUrl(url));
        }),
      );
      return katexCss.replace(/src:([^;}]*)/g, (whole, list: string) => {
        const m = /url\(fonts\/([^)]+\.woff2)\)/.exec(list);
        const data = m && byName.get(m[1]);
        return data ? `src:url(${data}) format("woff2")` : whole;
      });
    })().catch((e) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}

/** Does rendered HTML contain KaTeX output? */
export function hasKatex(html: string): boolean {
  return html.includes('class="katex');
}

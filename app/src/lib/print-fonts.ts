/**
 * Make sure the web fonts the text PDF needs are actually loaded before the
 * native print snapshots the page.
 *
 * Why this exists: KaTeX draws math letters (E, m, c, x, dx …) with
 * `.mathnormal { font-family: KaTeX_Math; font-style: italic }`, and its
 * stylesheet declares no `font-display`, so while a face is still loading
 * WebKit draws the text *invisibly* (the "block" period). The print path
 * used to wait with `document.fonts.load('16px KaTeX_Math')`. That shorthand
 * means `font-style: normal`, and KaTeX_Math has only italic faces. WKWebView
 * on macOS falls back to the italic face, but WebKitGTK (2.52, measured)
 * matches no face at all: nothing was loaded, `document.fonts.ready` was
 * already settled, and the PDF went out while every italic math glyph was
 * still invisible — `pdffonts` listed KaTeX_Main and KaTeX_Size2 but no
 * KaTeX_Math. The same trap covered KaTeX_Main's italic/bold faces and the
 * KaTeX_SansSerif/Script/… families nothing ever asked for.
 *
 * So instead of guessing descriptors, load the FontFace objects themselves:
 * every `KaTeX_*` face the stylesheet declares, whatever its style/weight.
 * They are local bundle assets, so this costs nothing on the network.
 */

/** Families whose faces we load explicitly before printing. */
function isPrintCritical(family: string): boolean {
  return /^KaTeX_/.test(family.replace(/["']/g, '').trim());
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/**
 * Load every KaTeX face (when `root` holds math), then wait for the font set
 * to settle and for layout to pick the fonts up. Never rejects and never
 * waits longer than `timeoutMs`: a slow or broken font must not stop the
 * print, it just prints with whatever loaded.
 */
export async function waitForPrintFonts(root: ParentNode | null, timeoutMs = 5000): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts) return;
  const work = (async () => {
    if (root?.querySelector('.katex')) {
      const faces: FontFace[] = [];
      fonts.forEach((face) => {
        if (isPrintCritical(face.family)) faces.push(face);
      });
      await Promise.allSettled(faces.map((f) => f.load()));
    }
    await fonts.ready;
    // Two frames: one for style/layout to switch from the invisible
    // block-period fallback to the loaded face, one for paint.
    await nextFrame();
    await nextFrame();
  })();
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** Exposed for tests. */
export const __test = { isPrintCritical };

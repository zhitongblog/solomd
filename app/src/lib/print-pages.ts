/**
 * Where the text PDF's pages will break, worked out before printing (#347).
 *
 * The print path hands the page to the webview's native print, and nothing in
 * it reports page numbers back: CSS `target-counter()` (page numbers in a
 * table of contents) is not implemented in Chromium or WebKit, and on Windows
 * `counter(page)` in an `@page` margin box is off the table too, because the
 * page margin is zeroed there to keep Chromium's own date/title header out
 * (see `buildWindowsPrintFrameStyle`).
 *
 * So the pagination is simulated on screen. The print overlay is laid out in
 * a multi-column box whose column is exactly one printable page (page size
 * minus margins), with the `@media print` rules that shape it copied into a
 * temporary screen stylesheet and their page breaks turned into column
 * breaks. Column fragmentation is the same engine as page fragmentation, so an
 * element's column index is the page it lands on. Checked against real
 * Chromium print-to-PDF output in `print-harness.html` (`?pages=1`).
 *
 * It needs a known page: without an explicit page size and margins (Settings
 * → PDF, or `pdf:` front matter) the paper is whatever the print dialog picks,
 * and there is nothing to measure against. Callers get `null` then and show
 * no numbers rather than wrong ones.
 */

export interface PrintableBox {
  /** Printable width and height of one page, in CSS px. */
  width: number;
  height: number;
}

const MM_TO_PX = 96 / 25.4;
const GAP = 48;

export function printableBox(
  pageSizeMm: { width: number; height: number } | null | undefined,
  marginMm: { top: number; right: number; bottom: number; left: number } | null | undefined,
): PrintableBox | null {
  if (!pageSizeMm || !marginMm) return null;
  const width = (pageSizeMm.width - marginMm.left - marginMm.right) * MM_TO_PX;
  const height = (pageSizeMm.height - marginMm.top - marginMm.bottom) * MM_TO_PX;
  if (!(width > 50 && height > 50)) return null;
  return { width, height };
}

/** Scope one selector to the print overlay, or drop it (null) if it would
 *  touch the app itself while we measure. */
function scopeSelector(sel: string): string | null {
  const s = sel.trim();
  if (!s) return null;
  if (/#solomd-print-overlay|\.solomd-print-content/.test(s)) return s;
  if (/\.preview-content|\.md-toc/.test(s)) return `#solomd-print-overlay ${s}`;
  return null;
}

function toColumnBreaks(css: string): string {
  return css
    .replace(/break-(before|after)\s*:\s*page/g, 'break-$1: column')
    .replace(/break-inside\s*:\s*avoid-page/g, 'break-inside: avoid-column')
    .replace(/page-break-(before|after)\s*:\s*always/g, 'break-$1: column')
    .replace(/page-break-inside\s*:\s*avoid/g, 'break-inside: avoid-column');
}

/** The `@media print` style rules that apply to the overlay, as screen CSS. */
function printRulesAsScreenCss(): string {
  const out: string[] = [];
  const visit = (rules: CSSRuleList, inPrint: boolean) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        const media = rule.media.mediaText;
        visit(rule.cssRules, inPrint || /\bprint\b/.test(media));
      } else if (inPrint && rule instanceof CSSStyleRule) {
        const scoped = rule.selectorText
          .split(',')
          .map(scopeSelector)
          .filter((x): x is string => !!x);
        if (scoped.length) out.push(`${scoped.join(', ')} { ${toColumnBreaks(rule.style.cssText)} }`);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet
    }
    visit(rules, false);
  }
  return out.join('\n');
}

/**
 * Give the print TOC (#347) a title, and a dotted leader plus page slot per
 * entry. Slots are filled with a placeholder wide enough for two digits so
 * the pagination is measured with them in place; `fillTocPageNumbers` writes
 * the real numbers. Returns the TOC, or null if the document has none.
 */
export function decoratePrintToc(content: HTMLElement, title: string): HTMLElement | null {
  const nav = content.querySelector<HTMLElement>('nav.md-toc');
  if (!nav || nav.dataset.printDecorated) return nav;
  nav.dataset.printDecorated = '1';
  const heading = document.createElement('div');
  heading.className = 'md-toc__title';
  heading.textContent = title;
  nav.prepend(heading);
  for (const link of Array.from(nav.querySelectorAll<HTMLAnchorElement>('a.md-toc__link'))) {
    const text = document.createElement('span');
    text.className = 'md-toc__text';
    while (link.firstChild) text.appendChild(link.firstChild);
    const leader = document.createElement('span');
    leader.className = 'md-toc__leader';
    const page = document.createElement('span');
    page.className = 'md-toc__page';
    page.textContent = '00';
    link.append(text, leader, page);
  }
  return nav;
}

/** Write each TOC entry's page, or clear the slot when it can't be known. */
export function fillTocPageNumbers(
  nav: HTMLElement,
  content: HTMLElement,
  pageOf: ((el: Element) => number) | null,
) {
  for (const link of Array.from(nav.querySelectorAll<HTMLAnchorElement>('a.md-toc__link'))) {
    const slot = link.querySelector<HTMLElement>('.md-toc__page');
    if (!slot) continue;
    const href = link.getAttribute('href') || '';
    let target: Element | null = null;
    if (href.startsWith('#') && pageOf) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        /* keep the raw id */
      }
      // Scoped to the print content: the app's own preview renders the same
      // note with the same heading ids, and would be found first.
      target = content.querySelector(`[id="${CSS.escape(id)}"]`);
    }
    slot.textContent = target && pageOf ? String(pageOf(target)) : '';
    link.classList.toggle('md-toc__link--paged', !!slot.textContent);
  }
}

/**
 * #515 — Collect heading entries `[level, title, pageNumber]` from the print
 * overlay so native PDF generation can attach a PDF document outline (bookmarks).
 */
export function collectPrintOutline(
  content: HTMLElement,
  pageOf: ((el: Element) => number) | null,
): Array<[number, string, number]> {
  const headings = Array.from(
    content.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
  ).filter((el) => !el.closest('.md-toc'));
  const entries: Array<[number, string, number]> = [];
  for (const el of headings) {
    const level = Math.max(1, Math.min(6, Number(el.tagName.slice(1)) || 1));
    const title = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const page = pageOf ? Math.max(1, pageOf(el)) : 1;
    entries.push([level, title, page]);
  }
  return entries;
}

export interface PrintPagination {
  /** 1-based page an element starts on. */
  pageOf(el: Element): number;
  /** Total number of pages. */
  pages: number;
}

/**
 * Lay the mounted print overlay out as pages of `box` and hand back a way to
 * ask which page an element falls on. The overlay is restored before this
 * returns, so read every page number you need through the returned object
 * *inside* `use`.
 */
export function withPrintPagination<T>(
  overlay: HTMLElement,
  content: HTMLElement,
  box: PrintableBox,
  use: (p: PrintPagination) => T,
): T {
  const style = document.createElement('style');
  style.id = 'solomd-print-measure';
  style.textContent = printRulesAsScreenCss();
  document.head.appendChild(style);

  const savedOverlay = overlay.getAttribute('style');
  const savedContent = content.getAttribute('style');
  const set = (el: HTMLElement, props: Record<string, string>) => {
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important');
  };
  set(overlay, {
    display: 'block',
    position: 'absolute',
    left: '-100000px',
    top: '0',
    padding: '0',
    margin: '0',
    width: `${box.width}px`,
    height: 'auto',
    visibility: 'hidden',
    overflow: 'visible',
  });
  set(content, {
    width: `${box.width}px`,
    height: `${box.height}px`,
    'column-width': `${box.width}px`,
    'column-gap': `${GAP}px`,
    'column-fill': 'auto',
    overflow: 'visible',
  });

  const spacers: HTMLElement[] = [];
  try {
    const origin = content.getBoundingClientRect().left;
    const stride = box.width + GAP;
    const pageOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return Math.max(1, Math.floor((r.left - origin + 1) / stride) + 1);
    };
    // Print repeats a table's header row at the top of every page the table
    // continues onto (#337); column fragmentation does not. Left alone, the
    // simulation fits one more row per page than paper does and drifts a page
    // every couple of dozen. So wherever a table crosses into a new column,
    // put a copy of its header row there — one break at a time, re-reading
    // the layout after each, because every copy pushes the later breaks.
    for (const table of Array.from(content.querySelectorAll('table'))) {
      const head = table.tHead?.rows[0];
      if (!head) continue;
      let guard = 0;
      for (;;) {
        const rows = Array.from(table.tBodies).flatMap((b) => Array.from(b.rows));
        let broke: HTMLTableRowElement | null = null;
        for (let i = 1; i < rows.length; i++) {
          if (rows[i].dataset.printSpacer || rows[i - 1].dataset.printSpacer) continue;
          if (pageOf(rows[i]) > pageOf(rows[i - 1])) {
            broke = rows[i];
            break;
          }
        }
        if (!broke || ++guard > 2000) break;
        const copy = head.cloneNode(true) as HTMLTableRowElement;
        copy.dataset.printSpacer = '1';
        broke.parentElement!.insertBefore(copy, broke);
        spacers.push(copy);
      }
    }
    let last = 1;
    for (const el of Array.from(content.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      last = Math.max(last, Math.floor((r.right - origin - 1) / stride) + 1);
    }
    return use({ pageOf, pages: last });
  } finally {
    for (const s of spacers) s.remove();
    style.remove();
    if (savedOverlay === null) overlay.removeAttribute('style');
    else overlay.setAttribute('style', savedOverlay);
    if (savedContent === null) content.removeAttribute('style');
    else content.setAttribute('style', savedContent);
  }
}

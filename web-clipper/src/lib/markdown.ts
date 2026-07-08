/**
 * HTML → Markdown conversion preset for the SoloMD clipper.
 *
 * Bias: be a faithful round-trip for the things we care about (headings,
 * lists, code, tables, blockquotes, links, images) and aggressively drop
 * the things we don't (script/style, ad iframes, cookie banners).
 *
 * Pure function — no DOM access. The caller (content script) is
 * responsible for picking the source HTML (Readability article vs.
 * full document.body).
 */
import TurndownService from 'turndown';

export interface MarkdownOptions {
  /** Used to resolve relative URLs (image src, anchor href). */
  baseUri: string;
}

/** Tags we always strip before turndown sees them. */
const STRIP_TAGS = ['script', 'style', 'noscript', 'template', 'svg'];

/**
 * Selector heuristics for cookie/CMP banners and obvious ad chrome. Only
 * applied to the *non-Readability* code path (whole-page fallback) — we
 * trust Readability to have already pruned these for the article path.
 */
const BANNER_SELECTORS = [
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[id*="banner" i]',
  '[class*="banner" i][role="dialog"]',
  '[class*="cmp" i]',
  '[aria-label*="cookie" i]',
  'iframe[src*="googletagmanager"]',
  'iframe[src*="doubleclick"]',
  'iframe[src*="adservice"]',
];

/**
 * Build an absolute URL from a maybe-relative one, using `baseUri`. Returns
 * the original string on failure (data:, javascript:, or already-absolute).
 */
function absolutize(maybeUrl: string | null | undefined, baseUri: string): string {
  if (!maybeUrl) return '';
  const u = maybeUrl.trim();
  if (!u || u.startsWith('javascript:') || u.startsWith('data:') || u.startsWith('#')) return u;
  try {
    return new URL(u, baseUri).toString();
  } catch {
    return u;
  }
}

/**
 * Pre-clean an HTML root in place: strip noisy tags, drop obvious banners,
 * and rewrite relative URLs to absolute. The same root is then handed to
 * turndown.
 *
 * `aggressive` controls whether we also remove cookie-banner / ad nodes —
 * true for full-page mode, false when Readability has already filtered.
 */
function preclean(root: HTMLElement, baseUri: string, aggressive: boolean): void {
  for (const tag of STRIP_TAGS) {
    for (const el of Array.from(root.querySelectorAll(tag))) {
      el.remove();
    }
  }
  if (aggressive) {
    for (const sel of BANNER_SELECTORS) {
      for (const el of Array.from(root.querySelectorAll(sel))) {
        // Only drop nodes that are not part of the document root chain, so
        // we never accidentally nuke the whole article when a CMS wraps
        // everything in <body class="banner">.
        if (el !== root && el.contains(root) === false) {
          el.remove();
        }
      }
    }
  }
  // Absolutize <a href>, <img src>, <source src>, <video src>.
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const href = (a as HTMLAnchorElement).getAttribute('href');
    if (href) (a as HTMLAnchorElement).setAttribute('href', absolutize(href, baseUri));
  }
  for (const img of Array.from(root.querySelectorAll('img[src]'))) {
    const src = (img as HTMLImageElement).getAttribute('src');
    if (src) (img as HTMLImageElement).setAttribute('src', absolutize(src, baseUri));
    // Drop tracking pixels / 1x1 images that turndown would otherwise
    // turn into ![](url) noise.
    const w = (img as HTMLImageElement).getAttribute('width');
    const h = (img as HTMLImageElement).getAttribute('height');
    if (w === '1' && h === '1') img.remove();
  }
}

/**
 * Build a TurndownService configured for SoloMD-style markdown:
 *   - ATX headings (`# foo`)
 *   - Hyphenated bullets
 *   - Fenced code blocks with language hint preserved from `<pre class="language-*">`
 *   - Tables and strikethrough via custom rules (turndown-plugin-gfm pulled in
 *     inline so we don't add a runtime dep)
 */
function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    hr: '---',
  });

  // Code blocks: pull language from <pre class="language-foo">,
  // <pre><code class="language-foo">…</code></pre>, or <pre data-lang="foo">.
  td.addRule('fencedCodeBlockWithLang', {
    filter(node): boolean {
      return (
        node.nodeName === 'PRE' &&
        node.firstChild != null &&
        (node.firstChild as HTMLElement).nodeName === 'CODE'
      );
    },
    replacement(_content, node): string {
      const pre = node as HTMLElement;
      const code = pre.firstChild as HTMLElement;
      const lang = pickLanguage(pre, code);
      const text = code.textContent ?? '';
      const fence = '```';
      return `\n\n${fence}${lang}\n${text.replace(/\n+$/, '')}\n${fence}\n\n`;
    },
  });

  // Strikethrough — common, GFM-style.
  td.addRule('strikethrough', {
    filter: ['del', 's', 'strike'] as TurndownService.Filter,
    replacement: (content) => `~~${content}~~`,
  });

  // Tables — minimum-viable GFM. We don't try to handle colspan/rowspan;
  // they'd produce broken pipe tables anyway.
  td.addRule('table', {
    filter: 'table',
    replacement(_content, node): string {
      const table = node as HTMLTableElement;
      const rows = Array.from(table.rows);
      if (rows.length === 0) return '';
      const header = rows[0];
      const headerCells = Array.from(header.cells).map((c) => sanitizeCell(c.textContent ?? ''));
      const sep = headerCells.map(() => '---');
      const bodyRows = rows.slice(1).map((r) =>
        Array.from(r.cells).map((c) => sanitizeCell(c.textContent ?? '')),
      );
      const lines: string[] = [];
      lines.push(`| ${headerCells.join(' | ')} |`);
      lines.push(`| ${sep.join(' | ')} |`);
      for (const r of bodyRows) {
        lines.push(`| ${r.join(' | ')} |`);
      }
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });

  // Skip nodes we already pre-cleaned but turndown might still emit junk for
  // (e.g. comments).
  td.addRule('dropEmptyAnchors', {
    filter(node): boolean {
      return node.nodeName === 'A' && (node as HTMLAnchorElement).getAttribute('href') === '';
    },
    replacement: (content) => content,
  });

  return td;
}

function sanitizeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

function pickLanguage(pre: HTMLElement, code: HTMLElement): string {
  const sources: (string | null | undefined)[] = [
    pre.getAttribute('data-lang'),
    code.getAttribute('data-lang'),
    pre.className,
    code.className,
  ];
  for (const raw of sources) {
    if (!raw) continue;
    const m = /(?:^|\s)language-([\w+-]+)/.exec(raw);
    if (m) return m[1];
    // hljs convention: <code class="hljs typescript">
    const m2 = /(?:^|\s)hljs\s+([\w+-]+)/.exec(raw);
    if (m2) return m2[1];
    // bare class — `<pre class="ts">`
    if (/^[a-z]{1,12}$/.test(raw.trim())) return raw.trim();
  }
  return '';
}

/** Convert an HTML *string* to markdown. Used by smoke tests + the content script. */
export function htmlToMarkdown(html: string, opts: MarkdownOptions, mode: 'article' | 'full' = 'article'): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;
  preclean(root, opts.baseUri, mode === 'full');
  const td = makeTurndown();
  return td.turndown(root.innerHTML).trim();
}

/** Convert an *element* (e.g. Readability `article.content` rooted in DOMParser) to markdown. */
export function elementToMarkdown(
  root: HTMLElement,
  opts: MarkdownOptions,
  mode: 'article' | 'full' = 'article',
): string {
  preclean(root, opts.baseUri, mode === 'full');
  const td = makeTurndown();
  return td.turndown(root.innerHTML).trim();
}

/**
 * Standalone HTML export generator for SoloMD (#313).
 *
 * Resolves #313: Standalone HTML export previously pulled katex.min.css from
 * jsDelivr on every export, requiring a network round-trip and leaking telemetry
 * to a third party.
 *
 * This module generates offline-correct standalone HTML documents:
 * - When math is present in the body (`.katex`), inlines self-contained KaTeX CSS
 *   with embedded woff2 font data URIs so equations render pixel-perfect without network.
 * - When math is absent, pays 0 bytes of KaTeX CSS and makes 0 network requests.
 */

let inlinedCssPromise: Promise<string> | null = null;

export async function getInlinedKatexCss(): Promise<string> {
  if (!inlinedCssPromise) {
    inlinedCssPromise = import('./katex-inlined-css').then((m) => m.KATEX_INLINED_CSS);
  }
  return inlinedCssPromise;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

export const HTML_TEMPLATE = (title: string, body: string, extraHead: string = ''): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
${extraHead ? `${extraHead}\n` : ''}<style>
  :root {
    --brand: #ff9f40;
    --brand-soft: #ffe7cc;
    --ink: #1f1d1a;
    --ink-muted: #6a6560;
    --rule: #e6e2d8;
    --paper: #fbfaf6;
    --code-bg: #f3efe7;
    --code-key: #ff9f40;
    --row-alt: #f7f4ec;
  }
  html, body { background: var(--paper); }
  body {
    max-width: 760px;
    margin: 56px auto;
    padding: 0 56px 96px;
    font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto,
      "Helvetica Neue", Arial,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
      "Noto Sans CJK SC", "WenQuanYi Micro Hei",
      system-ui, sans-serif;
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    /* #293 — words joined by NO-BREAK SPACE (Word / web / chat pastes) form a
       single unbreakable run; without this the exported page overflows its
       760px column exactly the way the preview used to. */
    overflow-wrap: break-word;
  }
  h1, h2, h3, h4, h5, h6 {
    line-height: 1.25;
    font-weight: 700;
    color: var(--ink);
    margin: 2em 0 0.6em;
  }
  h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
  h1 {
    font-size: 2.15em;
    border-bottom: 2px solid var(--brand);
    padding-bottom: .35em;
    letter-spacing: -0.01em;
  }
  h2 {
    font-size: 1.55em;
    border-bottom: 1px solid var(--rule);
    padding-bottom: .25em;
  }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1.05em; }
  h5, h6 { font-size: 1em; color: var(--ink-muted); }
  p { margin: .9em 0; }
  a {
    color: var(--brand);
    text-decoration: none;
    border-bottom: 1px solid var(--brand-soft);
  }
  a:hover { border-bottom-color: var(--brand); }
  strong { color: var(--ink); }
  em { color: var(--ink); }
  code {
    font-family: "JetBrains Mono", "SF Mono", "Menlo", "Consolas",
      "Liberation Mono", monospace;
    font-size: .9em;
    background: var(--code-bg);
    padding: .15em .45em;
    border-radius: 4px;
    color: #8a4a00;
  }
  pre {
    background: var(--code-bg);
    padding: 16px 20px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 1.2em 0;
    line-height: 1.55;
    border: 1px solid var(--rule);
  }
  pre code {
    background: transparent;
    padding: 0;
    color: var(--ink);
    font-size: .88em;
  }
  pre code .hljs-keyword,
  pre code .hljs-built_in,
  pre code .hljs-tag { color: var(--code-key); }
  blockquote {
    border-left: 4px solid var(--brand);
    background: linear-gradient(to right, var(--brand-soft) 0%, transparent 40%);
    margin: 1.4em 0;
    padding: .5em 1.2em;
    color: var(--ink-muted);
    font-style: italic;
    border-radius: 0 4px 4px 0;
  }
  blockquote p { margin: .4em 0; }
  ul, ol { padding-left: 1.8em; margin: .9em 0; }
  li { margin: .3em 0; }
  li > p { margin: .3em 0; }
  table {
    border-collapse: collapse;
    margin: 1.4em 0;
    width: 100%;
    font-size: .95em;
  }
  th, td {
    border: 1px solid var(--rule);
    padding: 8px 14px;
    text-align: left;
  }
  /* #271 — short cells stay on one line (see markdown.ts table_short_cells). */
  .cell-nowrap { white-space: nowrap; }
  thead th {
    background: var(--brand-soft);
    color: var(--ink);
    font-weight: 700;
    border-bottom: 2px solid var(--brand);
  }
  tbody tr:nth-child(even) { background: var(--row-alt); }
  hr {
    border: none;
    border-top: 1px solid var(--rule);
    margin: 2.4em 0;
  }
  img {
    max-width: 100%;
    border-radius: 6px;
    margin: 1.2em 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .08);
  }
  .katex-display { overflow-x: auto; overflow-y: hidden; margin: 1.2em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;

export async function buildStandaloneHtml(title: string, body: string): Promise<string> {
  let extraHead = '';
  if (body.includes('class="katex')) {
    const katexCss = await getInlinedKatexCss();
    extraHead = `<style id="katex-styles">\n${katexCss}\n</style>`;
  }
  return HTML_TEMPLATE(title, body, extraHead);
}

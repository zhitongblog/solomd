/**
 * The standalone HTML export: template + pipeline, outside the composable so
 * the dev harness (`/html-harness.html`) runs exactly what the app writes.
 *
 * The file must open anywhere, offline: local images are embedded as `data:`
 * URLs, mermaid/PlantUML fences become inline SVG (#332), and KaTeX's styles
 * and fonts are written in only when the note has math (#313). Nothing in the
 * page points at a CDN.
 */
import { renderMarkdown, extractImageRoot } from './markdown';
import { inlineLocalImages, rewriteLinkUrls, rewriteImageUrls, type BinaryReader } from './image-resolve';
import { inlineDiagramsInHtml } from './diagram-export';
import { hasKatex, standaloneKatexCss } from './katex-standalone';
import { loadRenderDeps } from './render-deps';

export const HTML_TEMPLATE = (title: string, body: string, headCss = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
${headCss ? `<style>${headCss}</style>\n` : ''}<style>
  /* White paper (#332 follow-up): the warm off-white page, beige code blocks
     and orange table headers read as "yellow" on screen and looked
     unprofessional in a file people hand to others. Backgrounds are neutral,
     and so are the accents: the orange h1 rule and quote bar still read as
     unserious on paper (second #332 follow-up), so rules and bars are dark
     gray and links a sober blue. Deliberately no dark-mode variant: the file
     is a document, and mermaid diagrams are rendered for a light page. */
  :root {
    --accent-rule: #3d444d;
    --link: #0b5cad;
    --link-soft: #c9dcf0;
    --ink: #1f2328;
    --ink-muted: #59636e;
    --rule: #e4e6e9;
    --paper: #ffffff;
    --code-bg: #f6f8fa;
    --code-key: #cf222e;
    --row-alt: #f9fafb;
    --thead-bg: #f3f4f6;
    --quote-bg: #f9fafb;
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
    border-bottom: 2px solid var(--accent-rule);
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
    color: var(--link);
    text-decoration: none;
    border-bottom: 1px solid var(--link-soft);
  }
  a:hover { border-bottom-color: var(--link); }
  strong { color: var(--ink); }
  em { color: var(--ink); }
  code {
    font-family: "JetBrains Mono", "SF Mono", "Menlo", "Consolas",
      "Liberation Mono", monospace;
    font-size: .9em;
    background: var(--code-bg);
    padding: .15em .45em;
    border-radius: 4px;
    color: var(--ink);
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
    border-left: 4px solid var(--accent-rule);
    background: var(--quote-bg);
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
    /* #370 — a long unbreakable run breaks inside its cell instead of pushing
       the table past the page (and off the paper when printed). */
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  /* #271 — short cells stay on one line (see markdown.ts table_short_cells). */
  .cell-nowrap { white-space: nowrap; }
  thead th {
    background: var(--thead-bg);
    color: var(--ink);
    font-weight: 700;
    border-bottom: 2px solid var(--rule);
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
  .katex-display { overflow-x: auto; overflow-y: hidden; padding: 0.5em 0; margin: 0.7em 0; }
  .mermaid-block, .plantuml-block { display: flex; justify-content: center; margin: 1.5em 0; }
  .mermaid-block svg, .plantuml-block svg { max-width: 100%; height: auto; }
  .plantuml-block img { box-shadow: none; border-radius: 0; margin: 0; }
  pre.mermaid-error { color: #b42318; white-space: pre-wrap; }
</style>
</head>
<body>
${body}
</body>
</html>`;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );
}


export interface StandaloneHtmlInput {
  content: string;
  title: string;
  filePath?: string;
  /** PlantUML server — only when the user has PlantUML turned on. */
  plantumlServer?: string | null;
  /** Byte reader for local images (tests/harness); defaults to the Tauri one. */
  readBytes?: BinaryReader;
}

export async function buildStandaloneHtml(input: StandaloneHtmlInput): Promise<string> {
  // An export is rendered once: never with placeholder math / plain code.
  await loadRenderDeps();
  const imageRoot = extractImageRoot(input.content);
  // Local images are embedded as `data:` URLs first: a standalone .html has
  // no way to reach the app's `asset.localhost` protocol, so rewriting the
  // src into one — which is what makes images load inside the webview — left
  // every figure broken in the exported file.
  const withImages = await inlineLocalImages(
    renderMarkdown(input.content),
    imageRoot,
    input.filePath,
    input.readBytes,
  );
  // #332 — diagrams become inline SVG, so the page shows them offline
  // instead of the fence source.
  const withDiagrams = await inlineDiagramsInHtml(withImages, {
    plantumlServer: input.plantumlServer,
  });
  // v4.3.0 issue #77 — local-file `href` / `src` URLs become absolute
  // `file://` paths so the export doesn't bake in `http://tauri.localhost/...`.
  const body = rewriteLinkUrls(
    rewriteImageUrls(withDiagrams, imageRoot, input.filePath),
    imageRoot,
    input.filePath,
  );
  // #313 / #332 — KaTeX's stylesheet and fonts go into the file, and only
  // when there is math. This was a render-blocking jsDelivr <link>.
  const headCss = hasKatex(body) ? await standaloneKatexCss() : '';
  return HTML_TEMPLATE(input.title, body, headCss);
}

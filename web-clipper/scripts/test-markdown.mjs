#!/usr/bin/env node
/**
 * Node-side test for the markdown layer.
 *
 * The browser code path uses DOMParser + the page's live `document.baseURI`.
 * For a deterministic regression test we run the same `htmlToMarkdown` /
 * `elementToMarkdown` functions inside JSDOM, against a hand-rolled fixture
 * page, and assert on the resulting markdown.
 *
 * Usage:
 *     pnpm -C web-clipper test:markdown
 *
 * Exits 0 on success, non-zero with a unified diff on failure.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Bundle src/lib/markdown.ts into a single CJS string we can `eval` in this
// process. We can't `import` it directly because it uses TS syntax.
// esbuild gives us a tiny self-contained bundle — same code that ships
// inside the extension, no shims.
// ---------------------------------------------------------------------------
const result = await esbuild({
  entryPoints: [join(ROOT, 'src/lib/markdown.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: [],
});
const code = result.outputFiles[0].text;

// Provide DOMParser to the bundle. JSDOM gives us one.
globalThis.DOMParser = new JSDOM().window.DOMParser;

const moduleScope = { exports: {} };
new Function('module', 'exports', code)(moduleScope, moduleScope.exports);
const { htmlToMarkdown, elementToMarkdown } = moduleScope.exports;

// ---------------------------------------------------------------------------
// Run htmlToMarkdown against the fixture article in two modes.
// ---------------------------------------------------------------------------
const fixture = readFileSync(join(ROOT, 'test/fixtures/article.html'), 'utf8');

// Mode 1: full-document (no Readability), expects banner-stripping to apply.
const mdFull = htmlToMarkdown(fixture, { baseUri: 'https://example.com/articles/' }, 'full');

// Mode 2: hand a Readability article through (same path the content script takes).
const dom = new JSDOM(fixture, { url: 'https://example.com/articles/' });
const reader = new Readability(dom.window.document.cloneNode(true), {
  charThreshold: 200,
  keepClasses: true,
});
const article = reader.parse();
if (!article) {
  console.error('FAIL: Readability returned null on the fixture');
  process.exit(1);
}
const articleDom = new JSDOM(article.content, { url: 'https://example.com/articles/' });
const mdArticle = elementToMarkdown(
  articleDom.window.document.body,
  { baseUri: 'https://example.com/articles/' },
  'article',
);

// ---------------------------------------------------------------------------
// Assertions. We check structural properties rather than exact strings —
// turndown formatting can drift across patch versions and we want to catch
// real regressions, not whitespace.
// ---------------------------------------------------------------------------
let failed = 0;
function check(label, ok, hint) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${hint ? ` — ${hint}` : ''}`);
    failed += 1;
  }
}

console.log('test-markdown: full-document mode');
check('drops <script>',                !/this should be stripped/.test(mdFull));
check('drops cookie banner div',       !/Cookie consent/.test(mdFull) && !/Accept[\]\)\s]/.test(mdFull));
check('keeps H1',                      /^#\s+How browsers parse HTML/m.test(mdFull));
check('keeps ordered list',            /1\.\s+Decode bytes/.test(mdFull));
check('keeps fenced code w/ lang',     /```ts\n[^`]*function parse/.test(mdFull));
check('keeps blockquote',              /^>\s+.*Browsers are the most complex/m.test(mdFull));
check('rewrites relative <a> to abs',  /https:\/\/example\.com\/articles\/byte-stream/.test(mdFull));
check('rewrites relative <img> to abs',/https:\/\/example\.com\/articles\/diagram\.png/.test(mdFull));
check('renders table',                 /\|\s+Phase\s+\|\s+Output\s+\|/.test(mdFull));
check('renders strong',                /\*\*Jane Doe\*\*/.test(mdFull));
check('renders italic',                /_three big phases_/.test(mdFull));

console.log('\ntest-markdown: Readability article mode');
// Readability stores the article title separately in `article.title` — the
// content script renders it in the YAML front matter, not the markdown body.
check('article title extracted',       (article.title ?? '').includes('How browsers parse HTML'));
check('keeps fenced code with lang',   /```ts\n[^`]*function parse/.test(mdArticle));
check('article body absolute links',   /https:\/\/example\.com\/articles\//.test(mdArticle));
check('article drops <script>',        !/this should be stripped/.test(mdArticle));
check('article drops nav',             !/^.*Home.*Blog/m.test(mdArticle.split('\n')[0] ?? ''));
check('article keeps blockquote',      /^>\s+.*Browsers are the most complex/m.test(mdArticle));
check('article keeps table',           /\|\s+Phase\s+\|\s+Output\s+\|/.test(mdArticle));
check('article keeps strong',          /\*\*Jane Doe\*\*/.test(mdArticle));

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  console.error('--- full-mode markdown ---');
  console.error(mdFull);
  console.error('--- article-mode markdown ---');
  console.error(mdArticle);
  process.exit(1);
}
console.log(`\nALL OK — markdown layer produced ${mdFull.length}-char full / ${mdArticle.length}-char article output.`);

/**
 * Unit tests for standalone HTML export KaTeX inlining (#313).
 *
 * Verifies that HTML exports:
 * 1. Never pull katex.min.css from jsDelivr (no third-party telemetry / round-trips).
 * 2. Omit KaTeX styles entirely when the document contains no math.
 * 3. Inline self-contained KaTeX CSS and woff2 font URIs when math is present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HTML_TEMPLATE, buildStandaloneHtml, getInlinedKatexCss } from './html-export';

test('HTML export for notes without math contains no KaTeX link or styles', () => {
  const title = 'Plain Note';
  const body = '<p>This is a regular note without math.</p>';
  const html = HTML_TEMPLATE(title, body);

  assert.ok(!html.includes('cdn.jsdelivr.net'), 'must not reference jsDelivr CDN');
  assert.ok(!html.includes('katex.min.css'), 'must not link katex.min.css');
  assert.ok(!html.includes('katex-styles'), 'must not inject katex style block');
  assert.ok(html.includes('<title>Plain Note</title>'), 'must include title');
  assert.ok(html.includes(body), 'must include body content');
});

test('HTML export for notes with math inlines self-contained KaTeX CSS with font data URIs', async () => {
  const title = 'Math Note';
  const body = '<p>Formula: <span class="katex"><span class="katex-mathml">E = mc^2</span></span></p>';
  const katexCss = await getInlinedKatexCss();
  const extraHead = `<style id="katex-styles">\n${katexCss}\n</style>`;
  const html = HTML_TEMPLATE(title, body, extraHead);

  assert.ok(!html.includes('cdn.jsdelivr.net'), 'must not reference jsDelivr CDN');
  assert.ok(!html.includes('href="https://'), 'must not contain external stylesheet hrefs');
  assert.ok(html.includes('<style id="katex-styles">'), 'must include inlined katex style tag');
  assert.ok(html.includes('data:font/woff2;base64,'), 'must inline woff2 webfonts as data URIs');
  assert.ok(!html.includes('url(fonts/'), 'must not contain relative font URLs that 404 offline');
  assert.ok(html.includes(body), 'must include body content');
});

test('buildStandaloneHtml automatically detects math and inlines self-contained KaTeX CSS', async () => {
  const plainHtml = await buildStandaloneHtml('Plain', '<p>no equations</p>');
  assert.ok(!plainHtml.includes('katex-styles'), 'plain document must not have katex styles');
  assert.ok(!plainHtml.includes('cdn.jsdelivr.net'), 'plain document must not have CDN link');

  const mathHtml = await buildStandaloneHtml('Math', '<p>with <span class="katex">...</span></p>');
  assert.ok(mathHtml.includes('<style id="katex-styles">'), 'math document must have inlined katex styles');
  assert.ok(!mathHtml.includes('cdn.jsdelivr.net'), 'math document must not have CDN link');
  assert.ok(mathHtml.includes('data:font/woff2;base64,'), 'math document must have inlined font data URIs');
});

test('getInlinedKatexCss returns valid self-contained CSS', async () => {
  const css = await getInlinedKatexCss();
  assert.ok(typeof css === 'string' && css.length > 20000, 'inlined CSS should be populated');
  assert.ok(css.includes('.katex'), 'must define .katex class selectors');
  assert.ok(css.includes('font-family:KaTeX_Main'), 'must define KaTeX_Main font family');
  assert.ok(css.includes('data:font/woff2;base64,'), 'must contain embedded base64 fonts');
});

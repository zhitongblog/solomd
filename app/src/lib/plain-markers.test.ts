import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPlainInlineWithMarkers,
  renderPlainVisibleMarkers,
  renderPlainMirror,
} from './plain-markers.ts';

/**
 * The plain-block editor's "pure WYSIWYG" surface (#698): the active block's
 * <textarea> keeps the raw source for input/caret/selection while a render
 * with the same box metrics sits beneath it. Every Markdown marker token must
 * land inside a `plain-md-marker` span so CSS (`visibility: hidden`) can hide
 * it while preserving each glyph's position — any marker left outside a span
 * shows through as raw source.
 *
 * This strips the marker spans the way the pure-mode stylesheet does and
 * asserts only the visible content remains.
 */
function visibleText(html: string): string {
  return html
    .replace(/<span class="plain-md-marker">[\s\S]*?<\/span>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

test('renderPlainMirror hides the ATX heading marker', () => {
  const html = renderPlainMirror('# Title **bold**');
  assert.match(html, /plain-block__markers/);
  assert.equal(visibleText(html), 'Title bold');
});

test('renderPlainMirror hides inline markers', () => {
  const src = 'a **b** c *i* d ~~s~~ e ==m== f `x` g';
  assert.equal(visibleText(renderPlainMirror(src)), 'a b c i d s e m f x g');
});

test('renderPlainMirror hides link and wikilink markers but keeps the text', () => {
  assert.equal(visibleText(renderPlainMirror('see [text](https://a.b/c)')), 'see text');
  assert.equal(visibleText(renderPlainMirror('see [[Note Name]]')), 'see Note Name');
});

test('renderPlainMirror hides the image marker bang (#698)', () => {
  // `!` used to stay outside the marker span and leak through as `!alt`.
  assert.equal(visibleText(renderPlainMirror('![alt](img.png)')), 'alt');
  assert.equal(visibleText(renderPlainMirror('pic ![a](u) end')), 'pic a end');
});

test('renderPlainMirror hides list, task and quote prefixes', () => {
  assert.equal(visibleText(renderPlainMirror('- item')), 'item');
  assert.equal(visibleText(renderPlainMirror('1. item')), 'item');
  assert.equal(visibleText(renderPlainMirror('- [x] done')), 'done');
  assert.equal(visibleText(renderPlainMirror('> quoted')), 'quoted');
  assert.equal(visibleText(renderPlainMirror('>> nested')), 'nested');
});

test('renderPlainMirror hides thematic breaks and setext underlines', () => {
  assert.equal(visibleText(renderPlainMirror('---')), '');
  assert.equal(visibleText(renderPlainMirror('***')), '');
  assert.equal(visibleText(renderPlainMirror('===')), '');
});

test('renderPlainMirror hides code fences but keeps the code body', () => {
  // Hidden marker lines keep their newlines: each line of the source still
  // occupies exactly one line in the mirror, so caret rows stay aligned.
  const src = '```bash\necho hi\n```';
  assert.equal(visibleText(renderPlainMirror(src)), '\necho hi\n');
  const tildes = '~~~js\nlet x = 1\n~~~';
  assert.equal(visibleText(renderPlainMirror(tildes)), '\nlet x = 1\n');
});

test('renderPlainMirror hides math fences and container fences', () => {
  assert.equal(visibleText(renderPlainMirror('$$\nE=mc^2\n$$')), '\nE=mc^2\n');
  assert.equal(visibleText(renderPlainMirror('$$E=mc^2$$')), 'E=mc^2');
  assert.equal(visibleText(renderPlainMirror('::: alert tip\nbody\n:::')), '\nbody\n');
});

test('renderPlainMirror keeps table pipes as content (documented residual)', () => {
  // Pipes are source *content* to the inline tokenizer; the merged select-all
  // view shows them. Not asserted as hidden — only that nothing crashes.
  const html = renderPlainMirror('| a | b |\n| - | - |\n| 1 | 2 |');
  assert.ok(html.includes('plain-block__markers'));
});

test('renderPlainMirror multi-line block hides every line prefix', () => {
  const src = '# h1\n\n- a\n- b\n\n```\ncode\n```';
  assert.equal(visibleText(renderPlainMirror(src)), 'h1\n\na\nb\n\n\ncode\n');
});

test('renderPlainVisibleMarkers wraps markers in marker spans (unchanged)', () => {
  const html = renderPlainVisibleMarkers('# T');
  assert.match(html, /^<h1 class="plain-block__markers">/);
  assert.ok(html.includes('<span class="plain-md-marker"># </span>'));
  const inline = renderPlainVisibleMarkers('a **b**');
  assert.ok(inline.includes('<span class="plain-md-marker">**</span>'));
});

test('formatPlainInlineWithMarkers puts the image bang inside the marker span', () => {
  const html = formatPlainInlineWithMarkers('![a](u)');
  assert.ok(html.includes('<span class="plain-md-marker">![</span>'));
});

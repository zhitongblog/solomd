/**
 * Regression tests for #457: the block-decoration scans (raw HTML blocks,
 * <img> lines, tables, math) must stay inert INSIDE fenced code.
 *
 * The scans are line-based; a ```vue fence whose template holds
 * `<div>…</div>` had its middle replaced by an HtmlBlockWidget and rendered
 * as real HTML in live edit (the preview was always fine — markdown-it keeps
 * fence content literal). Same reveal model as ever: cursor inside the block
 * reveals source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

import { findTableCellOffsetInLine, liveBlocksExtension } from './cm-live-blocks.ts';
import { dragAwareExtension, dragStartEffect, dragEndEffect } from './cm-drag-aware.ts';
import { extractImageReferenceDefinitions, findMarkdownImagesInLine } from './md-image-url.ts';

interface Found {
  from: number;
  to: number;
  widgetName: string;
  widget: any;
}

/** All block-widget decorations with cursor parked on `cursorLine` (1-based). */
function widgets(doc: string, cursorLine = 1): Found[] {
  const anchor = doc.split('\n').slice(0, cursorLine - 1).join('\n').length + (cursorLine > 1 ? 1 : 0);
  const state = EditorState.create({
    doc,
    // The fence guard reads the lezer tree (FencedCode nodes), so the state
    // needs the same markdown language the editor runs.
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension(),
    ],
    selection: { anchor },
  });
  const found: Found[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    set.between(0, doc.length, (from, to, deco) => {
      const widget = (deco.spec as { widget?: { constructor: { name: string } } }).widget;
      if (widget) found.push({ from, to, widgetName: widget.constructor.name, widget });
    });
  }
  return found;
}

const lineOf = (doc: string, pos: number) => doc.slice(0, pos).split('\n').length;

test('a <div> pair inside a ```vue fence is left alone (#457)', () => {
  const doc = [
    '```vue',
    '<script setup>',
    'const a = 1;',
    '</script>',
    '',
    '<template>',
    '  <div class="app">',
    '    <p>hi</p>',
    '  </div>',
    '</template>',
    '```',
  ].join('\n');
  // line 10 = "  </div>" (last line of the fenced div pair)
  const lastFenceLine = 10;
  const hits = widgets(doc).filter((w) => lineOf(doc, w.from) <= lastFenceLine);
  assert.deepEqual(hits, [], `fence interior was replaced: ${JSON.stringify(hits)}`);
});

test('the same <div> pair outside a fence still collapses to HtmlBlockWidget', () => {
  const doc = ['intro', '', '<div class="app">', '  <p>hi</p>', '</div>', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'HtmlBlockWidget');
  assert.equal(hits.length, 1, 'raw HTML block should still collapse');
  assert.equal(lineOf(doc, hits[0].from), 3);
  assert.equal(lineOf(doc, hits[0].to), 5);
});

test('cursor inside the raw HTML block still reveals its source', () => {
  const doc = ['<div class="app">', '  <p>hi</p>', '</div>', ''].join('\n');
  const hits = widgets(doc, 2).filter((w) => w.widgetName === 'HtmlBlockWidget');
  assert.deepEqual(hits, []);
});

test('a GFM table inside a fence is not replaced by TableWidget', () => {
  const doc = [
    '```text',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '```',
  ].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'TableWidget');
  assert.deepEqual(hits, []);
});

test('a table outside a fence still collapses to TableWidget', () => {
  const doc = ['intro', '', '| a | b |', '|---|---|', '| 1 | 2 |', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'TableWidget');
  assert.equal(hits.length, 1);
});

test('a table inside a blockquote collapses to TableWidget in live edit (#480)', () => {
  const doc = [
    'intro',
    '',
    '> | Header | Header |',
    '> | --- | --- |',
    '> | cell | cell |',
    '',
  ].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'TableWidget');
  assert.equal(hits.length, 1);
  assert.equal(lineOf(doc, hits[0].from), 3);
  assert.equal(lineOf(doc, hits[0].to), 5);
});

test('block math inside a fence is not replaced by MathWidget', () => {
  const doc = ['```text', '$$', 'E=mc^2', '$$', '```', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'MathWidget');
  assert.deepEqual(hits, []);
});

test('a ```mermaid fence outside other fences still renders', () => {
  const doc = ['intro', '', '```mermaid', 'graph TD; A-->B;', '```', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'MermaidWidget');
  assert.equal(hits.length, 1);
});

test('an unclosed fence keeps everything after it inert', () => {
  const doc = ['```html', '<div class="app">', '  <p>hi</p>', '</div>', ''].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'HtmlBlockWidget');
  assert.deepEqual(hits, []);
});

test('a fence indented inside list items is still a fence to the scans', () => {
  const doc = [
    '- outer:',
    '    - inner:',
    '        ```vue',
    '        <div class="app">',
    '        </div>',
    '        ```',
  ].join('\n');
  const hits = widgets(doc).filter((w) => w.widgetName === 'HtmlBlockWidget');
  assert.deepEqual(hits, []);
});

test('#506: Live mode renders standalone, list-item, blockquote, linked, bracket-alt, and reference images', () => {
  const doc = [
    'intro',
    '',
    '![plain](https://pics0.baidu.com/feed/1.jpeg?token=abc&amp;s=def)',
    '- ![in-list](https://example.com/2.png)',
    '1. ![[图1] bracket-alt](https://example.com/3(a).png)',
    '> ![in-quote](<https://example.com/4 b.png>)',
    '[![badge](https://bj.bcebos.com/v1/wenxin/5.svg?x=1&amp;y=2)](https://yiyan.baidu.com)',
    '![ref-img][id1]',
    '',
    '[id1]: https://example.com/6.png?a=1&amp;b=2',
  ].join('\n');
  const hits = widgets(doc, 1).filter((w) => w.widgetName === 'ImageWidget');
  assert.equal(hits.length, 6, `expected 6 ImageWidgets, got ${JSON.stringify(hits)}`);
  assert.deepEqual(
    hits.map((h) => lineOf(doc, h.from)),
    [3, 4, 5, 6, 7, 8],
  );
  // Verify HTML-escaped `&amp;` in Baidu Wenxin URLs is decoded to `&` just like markdown-it in Preview mode
  assert.equal(hits[0].widget.src, 'https://pics0.baidu.com/feed/1.jpeg?token=abc&s=def');
  assert.equal(hits[4].widget.src, 'https://bj.bcebos.com/v1/wenxin/5.svg?x=1&y=2');
  assert.equal(hits[5].widget.src, 'https://example.com/6.png?a=1&b=2');
});

test('#506: findMarkdownImagesInLine handles escaped URLs, spaces in image paths, and preserves Windows paths', () => {
  const escaped = findMarkdownImagesInLine('![文心图](https://example.com/a\\_b\\&c\\(1\\).png?k=1&amp;v=2)');
  assert.equal(escaped.length, 1);
  assert.equal(escaped[0].src, 'https://example.com/a_b&c(1).png?k=1&v=2');

  const spaced = findMarkdownImagesInLine('![空格路径](https://example.com/my folder/pic 1.png)');
  assert.equal(spaced.length, 1);
  assert.equal(spaced[0].src, 'https://example.com/my folder/pic 1.png');

  const winLocal = findMarkdownImagesInLine('![本地图片](D:\\notes\\assets\\pic.png)');
  assert.equal(winLocal.length, 1);
  assert.equal(winLocal[0].src, 'D:\\notes\\assets\\pic.png');

  const refs = extractImageReferenceDefinitions([
    '  [wenxin-1]: <https://pics0.baidu.com/feed/a.jpg?token=1&amp;s=2> "百度配图"',
  ]);
  const refResolved = findMarkdownImagesInLine('段落中的配图 ![配图][WENXIN-1] 结束', refs);
  assert.equal(refResolved.length, 1);
  assert.equal(refResolved[0].src, 'https://pics0.baidu.com/feed/a.jpg?token=1&s=2');
});

test('#506: ImageWidget.toDOM sets referrerpolicy="no-referrer" BEFORE assigning img.src', () => {
  const doc = 'intro\n\n![baidu](https://pics0.baidu.com/feed/test.jpg)';
  const hits = widgets(doc, 1).filter((w) => w.widgetName === 'ImageWidget');
  assert.equal(hits.length, 1);

  const ops: string[] = [];
  const prevDoc = (globalThis as any).document;
  (globalThis as any).document = {
    createElement(tag: string) {
      const attrs: Record<string, string> = {};
      let _src = '';
      let _refPolicy = '';
      return {
        tagName: tag.toUpperCase(),
        style: {},
        dataset: {},
        classList: { add() {} },
        children: [] as any[],
        setAttribute(k: string, v: string) {
          attrs[k] = v;
          if (k === 'referrerpolicy') ops.push(`attr:referrerpolicy=${v}`);
        },
        getAttribute(k: string) {
          return attrs[k] ?? null;
        },
        set referrerPolicy(v: string) {
          _refPolicy = v;
          ops.push(`prop:referrerPolicy=${v}`);
        },
        get referrerPolicy() {
          return _refPolicy;
        },
        set src(v: string) {
          _src = v;
          ops.push(`prop:src=${v}`);
        },
        get src() {
          return _src;
        },
        appendChild(child: any) {
          this.children.push(child);
        },
        querySelectorAll() {
          return [];
        },
      };
    },
  };
  try {
    hits[0].widget.toDOM();
  } finally {
    (globalThis as any).document = prevDoc;
  }
  const attrIdx = ops.indexOf('attr:referrerpolicy=no-referrer');
  const propIdx = ops.indexOf('prop:referrerPolicy=no-referrer');
  const srcIdx = ops.indexOf('prop:src=https://pics0.baidu.com/feed/test.jpg');
  assert.ok(attrIdx >= 0 && propIdx >= 0 && srcIdx >= 0, `unexpected ops: ${JSON.stringify(ops)}`);
  assert.ok(attrIdx < srcIdx && propIdx < srcIdx, `referrerpolicy must be set before src: ${JSON.stringify(ops)}`);
});

test('#504: findTableCellOffsetInLine locates exact column offsets in Markdown table rows', () => {
  const line = '| Name | Description | `a | b` | Value |';
  // col 0 ("Name"): start (clickRatio=0) vs end (clickRatio=1)
  assert.equal(findTableCellOffsetInLine(line, 0, 0), line.indexOf('Name'));
  assert.equal(findTableCellOffsetInLine(line, 0, 1), line.indexOf('Name') + 'Name'.length);
  // col 1 ("Description")
  assert.equal(findTableCellOffsetInLine(line, 1, 0), line.indexOf('Description'));
  assert.equal(findTableCellOffsetInLine(line, 1, 1), line.indexOf('Description') + 'Description'.length);
  // col 2 ("`a | b`" — inner pipe inside backticks is ignored!)
  assert.equal(findTableCellOffsetInLine(line, 2, 0), line.indexOf('`a | b`'));
  // col 3 ("Value")
  assert.equal(findTableCellOffsetInLine(line, 3, 0), line.indexOf('Value'));
  assert.equal(findTableCellOffsetInLine(line, 3, 1), line.indexOf('Value') + 'Value'.length);

  // Empty cells, escaped pipes, and blockquote prefixes
  const edgeLine = '> | A\\|B |  | 第三列 |';
  assert.equal(findTableCellOffsetInLine(edgeLine, 0, 0), edgeLine.indexOf('A\\|B'));
  // Empty cell (col 1) lands between the two pipes
  const secondPipe = edgeLine.indexOf('|', edgeLine.indexOf('A\\|B') + 4);
  const thirdPipe = edgeLine.indexOf('|', secondPipe + 1);
  const emptyCellPos = findTableCellOffsetInLine(edgeLine, 1, 0.5);
  assert.ok(emptyCellPos > secondPipe && emptyCellPos <= thirdPipe);
  assert.equal(findTableCellOffsetInLine(edgeLine, 2, 0), edgeLine.indexOf('第三列'));
});

test('liveBlocksExtension stays frozen while dragging and flushes on dragEndEffect', () => {
  const doc = ['intro', '', '![img](https://example.com/a.png)', '', 'outro'].join('\n');
  let state = EditorState.create({
    doc,
    extensions: [
      dragAwareExtension(),
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension(),
    ],
    selection: { anchor: 0 },
  });

  const countImageWidgets = (s: EditorState) => {
    let n = 0;
    for (const set of s.facet(EditorView.decorations)) {
      set.between(0, s.doc.length, (_from, _to, deco) => {
        const w = (deco.spec as { widget?: { constructor: { name: string } } }).widget;
        if (w?.constructor.name === 'ImageWidget') n++;
      });
    }
    return n;
  };

  assert.equal(countImageWidgets(state), 1);

  // Start dragging and select across the entire document (covering line 3)
  state = state.update({ effects: dragStartEffect.of(null) }).state;
  state = state.update({ selection: { anchor: 0, head: doc.length } }).state;
  // While dragging, the image widget must NOT unmount mid-drag
  assert.equal(countImageWidgets(state), 1);

  // Releasing the pointer dispatches dragEndEffect and reveals the selected block source
  state = state.update({ effects: dragEndEffect.of(null) }).state;
  assert.equal(countImageWidgets(state), 0);
});

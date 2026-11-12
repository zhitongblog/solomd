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

import {
  findTableCellOffsetInLine,
  liveBlocksExtension,
  toggleMermaidFoldEffect,
  toggleTableFoldEffect,
} from './cm-live-blocks.ts';
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

  // Outer-pipeless GFM table row (T08-6)
  const noOuterPipe = '无首尾管道 | 2 | 3';
  assert.equal(findTableCellOffsetInLine(noOuterPipe, 0, 0), 0);
  assert.equal(findTableCellOffsetInLine(noOuterPipe, 1, 0), noOuterPipe.indexOf('2'));
  assert.equal(findTableCellOffsetInLine(noOuterPipe, 2, 0), noOuterPipe.indexOf('3'));
});

test('#500: liveBlocksExtension renders outer-pipeless tables, header-only tables, 1-2 dash delimiters, and splits adjacent tables', () => {
  const doc = [
    'cursor line',
    '',
    'A | B | C',
    '--- | :---: | ---',
    '无首尾管道 | 2 | 3',
    '',
    '| 空表 | 只有表头 |',
    '| :--- | ---: |',
    '',
    '| 变体A | 变体B | 变体C |',
    '| :-- | --: | :-: |',
    '| 1 | 2 | 3 |',
    '',
    '| 表一 | 列 |',
    '| --- | --- |',
    '| A | 1 |',
    '| 表二 | 列 |',
    '| --- | --- |',
    '| B | 2 |',
  ].join('\n');
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension(),
    ],
    selection: { anchor: 0 },
  });
  const tableRanges: Array<[number, number]> = [];
  for (const set of state.facet(EditorView.decorations)) {
    set.between(0, state.doc.length, (from, to, deco) => {
      const w = (deco.spec as { widget?: { constructor: { name: string } } }).widget;
      if (w?.constructor.name === 'TableWidget') {
        tableRanges.push([state.doc.lineAt(from).number, state.doc.lineAt(to).number]);
      }
    });
  }
  assert.deepEqual(tableRanges, [
    [3, 5],   // T08-6 outer-pipeless table
    [7, 8],   // T08-5 header-only table
    [10, 12], // T08-7 2-dash delimiter table
    [14, 16], // T09-5 adjacent table 1
    [17, 19], // T09-5 adjacent table 2
  ]);
});

test('#500: liveBlocksExtension ignores tables inside fenced code blocks past 4KB and dedents 4-space list tables', () => {
  const padding = Array.from({ length: 120 }, (_, i) => `Paragraph line ${i + 1} with filler text to exceed 4KB initial Lezer parse budget.`).join('\n\n');
  const doc = [
    'cursor line',
    '',
    '- 列表项二',
    '',
    '    | 列A | 列B |',
    '    | --- | --- |',
    '    | 缩进 | 4 空格 |',
    '',
    padding,
    '',
    '```markdown',
    '| 假表格 | 列 |',
    '| --- | --- |',
    '| 应保持 | 源码文本 |',
    '```',
  ].join('\n');
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension(),
    ],
    selection: { anchor: 0 },
  });
  const tableWidgets: Array<{ fromLine: number; source: string }> = [];
  for (const set of state.facet(EditorView.decorations)) {
    set.between(0, state.doc.length, (from, _to, deco) => {
      const w = (deco.spec as { widget?: { constructor: { name: string }; source?: string } }).widget;
      if (w?.constructor.name === 'TableWidget') {
        tableWidgets.push({ fromLine: state.doc.lineAt(from).number, source: w.source ?? '' });
      }
    });
  }
  // Only the list-indented table at line 5 should become a TableWidget; the fenced table past 4KB must stay code.
  assert.equal(tableWidgets.length, 1);
  assert.equal(tableWidgets[0].fromLine, 5);
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

test('#500: liveBlocksExtension keeps GFM tables rendered when cursor is inside unless keepSource is enabled', () => {
  const doc = ['| 列A | 列B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  const countTableWidgets = (s: EditorState) => {
    let n = 0;
    for (const set of s.facet(EditorView.decorations)) {
      set.between(0, s.doc.length, (_from, _to, deco) => {
        const w = (deco.spec as { widget?: { constructor: { name: string } } }).widget;
        if (w?.constructor.name === 'TableWidget') n++;
      });
    }
    return n;
  };

  let keepSource = false;
  const stateInside = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension({ keepSource: () => keepSource }),
    ],
    selection: { anchor: 2 }, // Cursor right inside header row!
  });
  assert.equal(countTableWidgets(stateInside), 1);

  keepSource = true;
  const stateKeepSource = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension({ keepSource: () => keepSource }),
    ],
    selection: { anchor: 2 },
  });
  assert.equal(countTableWidgets(stateKeepSource), 0);
});

test('#372: liveBlocksExtension renders MermaidWidget below the fence when cursor is inside or keepSource is enabled', () => {
  const doc = ['```mermaid', 'graph TD', '  A --> B', '```'].join('\n');
  const getMermaidRanges = (s: EditorState) => {
    const out: Array<{ from: number; to: number }> = [];
    for (const set of s.facet(EditorView.decorations)) {
      set.between(0, s.doc.length, (from, to, deco) => {
        const w = (deco.spec as { widget?: { constructor: { name: string } } }).widget;
        if (w?.constructor.name === 'MermaidWidget') out.push({ from, to });
      });
    }
    return out;
  };

  // Cursor inside the mermaid fence: renders as a block widget right below the closing fence (from === to === doc.length)
  const stateInside = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension({ keepSource: () => false }),
    ],
    selection: { anchor: 12 },
  });
  assert.deepEqual(getMermaidRanges(stateInside), [{ from: doc.length, to: doc.length }]);

  // keepSource = true: also renders as a block widget below the closing fence
  const stateKeepSource = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension({ keepSource: () => true }),
    ],
    selection: { anchor: 0 },
  });
  assert.deepEqual(getMermaidRanges(stateKeepSource), [{ from: doc.length, to: doc.length }]);

  // #530: toggling fold collapses lines 2..4 while keeping line 1 (` ```mermaid `) visible
  const collapsedState = stateKeepSource.update({
    effects: toggleMermaidFoldEffect.of({ line: 1, collapsed: true }),
  }).state;
  assert.deepEqual(getMermaidRanges(collapsedState), [
    { from: collapsedState.doc.line(2).from, to: doc.length },
  ]);

  const expandedState = collapsedState.update({
    effects: toggleMermaidFoldEffect.of({ line: 1, collapsed: false }),
  }).state;
  assert.deepEqual(getMermaidRanges(expandedState), [{ from: doc.length, to: doc.length }]);
});

test('Windows 10 CRLF and all 8 table forms render as <table> in Preview, CodeMirror Live Edit, and parseTable', async () => {
  const { renderMarkdown } = await import('./markdown.ts');
  const { parseTable } = await import('./markdown-table.ts');

  const lfDoc = [
    '# Windows 10 表格渲染全场景测试文档',
    '',
    '## 1. 标准 GFM 表格（左/中/右对齐）',
    '| 功能模块 | 支持状态 | 快捷键 |',
    '| :--- | :---: | ---: |',
    '| 实时表格渲染 | 已支持 | `Ctrl+E` |',
    '| 单元格内联编辑 | 已支持 | `Tab` / `Enter` |',
    '',
    '## 2. 无首尾管道符表格',
    '字段名 | 类型 | 说明',
    '--- | :---: | ---',
    'id | number | 主键 ID',
    'title | string | 笔记标题',
    '',
    '## 3. 紧跟段落文字无空行的表格',
    '下方表格紧跟在本段文字后（中间无空行）：',
    '| 平台 | 默认引擎 | 推荐设置 |',
    '| --- | --- | --- |',
    '| Windows 10 | Auto / CodeMirror | 设置 → 书写 → 编辑器引擎 |',
    '',
    '## 4. 列表项内嵌套的 4 空格缩进表格（含连续两个缩进表格）',
    '- 列表项说明：',
    '',
    '    | 阶段 | 负责人 |',
    '    | --- | --- |',
    '    | 开发 | 张三 |',
    '',
    '    | 阶段 | 负责人 |',
    '    | --- | --- |',
    '    | 测试 | 李四 |',
    '',
    '## 5. 有序列表下紧跟的无缩进表格',
    '1. 第一季度汇总：',
    '| 月份 | 完成率 |',
    '| --- | --- |',
    '| 1月 | 100% |',
    '',
    '## 6. 顶层 4 空格缩进表格',
    '    | 缩进列A | 缩进列B |',
    '    | --- | --- |',
    '    | 顶层4空格 | 正常渲染为表格 |',
    '',
    '## 7. 引用块内表格',
    '> | 引用列1 | 引用列2 |',
    '> | --- | --- |',
    '> | 引用内容A | 引用内容B |',
    '',
    '## 8. 含转义管道符、行内代码与列数容错的表格',
    '| 表达式 | 含义 | 示例 |',
    '| --- | --- | --- | --- |',
    '| `a \\| b` | 按位或 \\| 管道 | **通过** |',
  ].join('\n');

  // Simulate Windows 10 CRLF line endings
  const crlfDoc = lfDoc.replace(/\n/g, '\r\n');

  // 1) Preview / Reading mode (renderMarkdown) on CRLF document:
  // All 9 tables (including the 2 consecutive 4-space tables in section 4) must render as <table>, NEVER <pre><code>
  const html = renderMarkdown(crlfDoc);
  const tableCount = (html.match(/<table\b/g) || []).length;
  assert.equal(tableCount, 9, `expected all 9 tables to render as <table> in Preview, got ${tableCount}`);
  assert.equal(html.includes('<pre><code>'), false, 'no table should fall back to an indented <pre><code> block');

  // 2) CodeMirror Live Edit mode (liveBlocksExtension) on document:
  const state = EditorState.create({
    doc: lfDoc,
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension({ keepSource: () => false }),
    ],
    selection: { anchor: 0 },
  });
  const cmTableWidgets: number[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    set.between(0, state.doc.length, (from, _to, deco) => {
      const w = (deco.spec as { widget?: { constructor: { name: string } } }).widget;
      if (w?.constructor.name === 'TableWidget') {
        cmTableWidgets.push(state.doc.lineAt(from).number);
      }
    });
  }
  assert.equal(
    cmTableWidgets.length,
    9,
    `expected all 9 tables to collapse to TableWidget in CodeMirror Live Edit, got ${cmTableWidgets.length} at lines ${JSON.stringify(cmTableWidgets)}`,
  );

  // 3) parseTable on CRLF and indented tables:
  assert.notEqual(parseTable('    | 缩进列A | 缩进列B |\r\n    | --- | --- |\r\n    | 1 | 2 |'), null);
  assert.notEqual(parseTable('> | 引用列1 | 引用列2 |\r\n> | --- | --- |\r\n> | 1 | 2 |'), null);
});

test('toggleTableFoldEffect expands and folds table source code independently of alwaysShowMarkers', () => {
  const doc = ['# 标题', '- 列表项', '', '| 列A | 列B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  const getWidgets = (s: EditorState) => {
    const names: string[] = [];
    for (const set of s.facet(EditorView.decorations)) {
      set.between(0, s.doc.length, (_from, _to, deco) => {
        const w = (deco.spec as { widget?: { constructor: { name: string } } }).widget;
        if (w) names.push(w.constructor.name);
      });
    }
    return names;
  };

  // Default (collapseBlockSource = true -> keepSource = false): table is folded into TableWidget
  const initial = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension({ keepSource: () => false }),
    ],
    selection: { anchor: 0 },
  });
  assert.deepEqual(getWidgets(initial), ['TableWidget']);

  // Click "</> 源码" on the table (line 4): expands table source and mounts TableFoldToggleWidget
  const expanded = initial.update({
    effects: toggleTableFoldEffect.of({ line: 4, collapsed: false }),
  }).state;
  assert.deepEqual(getWidgets(expanded), ['TableFoldToggleWidget']);

  // Click "−" on line 4: folds table source back into TableWidget
  const refolded = expanded.update({
    effects: toggleTableFoldEffect.of({ line: 4, collapsed: true }),
  }).state;
  assert.deepEqual(getWidgets(refolded), ['TableWidget']);
});

test('#536: Mermaid and PlantUML stay collapsed when cursor touches fence boundaries and only expand manually via toggleMermaidFoldEffect', () => {
  const doc = [
    '# Title',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
    '',
    '```plantuml',
    '@startuml',
    'Alice -> Bob: Hi',
    '@enduml',
    '```',
  ].join('\n');

  const collect = (s: EditorState) => {
    const out: Array<{ name: string; from: number; to: number }> = [];
    for (const set of s.facet(EditorView.decorations)) {
      set.between(0, s.doc.length, (from, to, deco) => {
        const w = (deco.spec as { widget?: { constructor: { name: string } } }).widget;
        if (w) out.push({ name: w.constructor.name, from, to });
      });
    }
    return out;
  };

  // Cursor on opening fence line 3 (` ```mermaid `): Mermaid stays collapsed (from < to)
  const onFenceStart = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, addKeymap: false }),
      liveBlocksExtension({
        keepSource: () => false,
        getPlantuml: () => ({ enabled: true, server: 'https://www.plantuml.com/plantuml' }),
      }),
    ],
    selection: { anchor: doc.split('\n').slice(0, 2).join('\n').length + 1 },
  });
  const decosAtStart = collect(onFenceStart);
  const mermaidAtStart = decosAtStart.find((d) => d.name === 'MermaidWidget');
  const plantumlAtStart = decosAtStart.find((d) => d.name === 'PlantumlWidget');
  assert.ok(mermaidAtStart && mermaidAtStart.from < mermaidAtStart.to, 'Mermaid must stay collapsed when cursor is on opening fence line');
  assert.ok(plantumlAtStart && plantumlAtStart.from < plantumlAtStart.to, 'PlantUML must stay collapsed by default');

  // Manually expand Mermaid (line 3) and PlantUML (line 7) via `+` button:
  const manuallyExpanded = onFenceStart.update({
    effects: [
      toggleMermaidFoldEffect.of({ line: 3, collapsed: false }),
      toggleMermaidFoldEffect.of({ line: 7, collapsed: false }),
    ],
  }).state;
  const decosExpanded = collect(manuallyExpanded);
  const mermaidExpanded = decosExpanded.find((d) => d.name === 'MermaidWidget');
  const plantumlExpanded = decosExpanded.find((d) => d.name === 'PlantumlWidget');
  assert.ok(mermaidExpanded && mermaidExpanded.from === mermaidExpanded.to, 'Mermaid renders as block widget below closing fence when expanded');
  assert.ok(plantumlExpanded && plantumlExpanded.from === plantumlExpanded.to, 'PlantUML renders as block widget below closing fence when expanded');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findHtmlBlockEnd,
  findInlineHtmlSpans,
  findMarkSpans,
  maskInlineCode,
  parseOutlineSegments,
  stripOutlineFormatting,
} from './html-live-render.ts';

test('==mark== 高亮:识别、跳过内联代码、拒绝无效形态', () => {
  const line = '前==重点内容==后,以及==第二处==。';
  const spans = findMarkSpans(line);
  assert.equal(spans.length, 2);
  assert.equal(line.slice(spans[0].contentFrom, spans[0].contentTo), '重点内容');
  assert.equal(line.slice(spans[1].contentFrom, spans[1].contentTo), '第二处');
  assert.equal(line.slice(spans[0].openFrom, spans[0].openTo), '==');

  // Inside inline code the span must not match once masked.
  assert.equal(findMarkSpans(maskInlineCode('`==code==` 外面==真的==')).length, 1);
  // Setext underline / bare equals must not match.
  assert.equal(findMarkSpans('====').length, 0);
  assert.equal(findMarkSpans('== 前后有空格 ==').length, 0);
});

test('maskInlineCode 保持索引不变', () => {
  const line = 'a `x<b>y</b>` <b>ok</b>';
  const masked = maskInlineCode(line);
  assert.equal(masked.length, line.length);
  assert.equal(findInlineHtmlSpans(masked).length, 1);
  assert.equal(masked.indexOf('<b>ok</b>'), line.indexOf('<b>ok</b>'));
});

test('识别用户文档中的多行 div 图片块', () => {
  const lines = [
    '<div align="center">',
    '  <img src="https://example.com/figure.png" width="90%"/>',
    '  <p>图 1.1 智能体与环境的基本交互循环</p>',
    '</div>',
    '',
  ];
  assert.equal(findHtmlBlockEnd(lines, 0), 3);
});

test('同名嵌套 HTML 容器必须匹配到最外层结束标签', () => {
  const lines = ['<section>', '<section>inside</section>', '</section>'];
  assert.equal(findHtmlBlockEnd(lines, 0), 2);
});

test('不完整或不支持的 HTML 不折叠，保留源码可编辑', () => {
  assert.equal(findHtmlBlockEnd(['<div>', 'missing close'], 0), null);
  assert.equal(findHtmlBlockEnd(['<script>alert(1)</script>'], 0), null);
  assert.equal(findHtmlBlockEnd(['普通文本'], 0), null);
});

test('识别一行内多个 HTML 格式片段', () => {
  const line = '欢迎来到<strong>智能体（Agent）</strong>世界<sup>[1]</sup>。';
  const spans = findInlineHtmlSpans(line);
  assert.deepEqual(spans.map((span) => span.kind), ['strong', 'sup']);
  assert.equal(line.slice(spans[0].contentFrom, spans[0].contentTo), '智能体（Agent）');
  assert.equal(line.slice(spans[1].contentFrom, spans[1].contentTo), '[1]');
  assert.equal(line.slice(spans[0].openFrom, spans[0].openTo), '<strong>');
  assert.equal(line.slice(spans[1].closeFrom, spans[1].closeTo), '</sup>');
});

test('inline HTML 属性和常用语义标签', () => {
  const line = '<mark class="key">重点</mark> <u>下划线</u> <kbd>⌘K</kbd>';
  assert.deepEqual(
    findInlineHtmlSpans(line).map((span) => span.kind),
    ['mark', 'underline', 'kbd'],
  );
});

test('大纲标题高亮片段解析支持 ==高亮== 与 <mark> 标签，并忽略行内代码中的等号', () => {
  assert.deepEqual(parseOutlineSegments('第一章 ==重点内容== 总结'), [
    { text: '第一章 ', mark: false },
    { text: '重点内容', mark: true },
    { text: ' 总结', mark: false },
  ]);
  assert.deepEqual(parseOutlineSegments('比较 `a == b` 与 <mark>核心结论</mark>'), [
    { text: '比较 `a == b` 与 ', mark: false },
    { text: '核心结论', mark: true },
  ]);
  assert.equal(stripOutlineFormatting('第一章 ==重点内容== 与 <mark>结论</mark>'), '第一章 重点内容 与 结论');
});


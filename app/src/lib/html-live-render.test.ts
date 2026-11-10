import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findHtmlBlockEnd,
  findInlineHtmlSpans,
  findMarkSpans,
  findSupSubSpans,
  maskInlineCode,
  parseOutlineSegments,
  stripOutlineFormatting,
} from './html-live-render.ts';
import { renderMarkdown } from './markdown.ts';

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

test('#284 ^sup^ 上标与 ~sub~ 下标: Live Edit 识别、排除 ~~删除线~~ 与 [^脚注] 及 $数学公式$', () => {
  const line = 'H~2~O 与 x^2^，忽略 ~~删除线~~、[^1] 脚注和 $a^2 + b_2$。';
  const spans = findSupSubSpans(maskInlineCode(line));
  assert.deepEqual(spans.map((s) => ({ kind: s.kind, text: line.slice(s.contentFrom, s.contentTo) })), [
    { kind: 'sub', text: '2' },
    { kind: 'sup', text: '2' },
  ]);

  const html = renderMarkdown('H~2~O and x^2^ plus ~~strike~~');
  assert.match(html, /H<sub>2<\/sub>O/);
  assert.match(html, /x<sup>2<\/sup>/);
  assert.match(html, /<s>strike<\/s>/);
});

test('自定义高亮颜色: <mark style="background-color: ..."> 提取背景色与文字色，applyHighlightColor 支持包裹/替换/取消', async () => {
  const { applyHighlightColor } = await import('./md-format.ts');
  const line = '普通 <mark style="background-color: #fde047; color: #1f2328">重点</mark> 文本';
  const spans = findInlineHtmlSpans(line);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].kind, 'mark');
  assert.equal(spans[0].bgColor, '#fde047');
  assert.equal(spans[0].textColor, '#1f2328');

  // Wrap plain selection in colored <mark>
  const e1 = applyHighlightColor('hello world', 6, 11, '#86efac');
  const doc1 = 'hello '.concat(e1.insert);
  assert.equal(doc1, 'hello <mark style="background-color: #86efac">world</mark>');

  // Replace existing colored <mark> with another color
  const e2 = applyHighlightColor(doc1, e1.selFrom, e1.selTo, '#93c5fd');
  const doc2 = doc1.slice(0, e2.from) + e2.insert + doc1.slice(e2.to);
  assert.equal(doc2, 'hello <mark style="background-color: #93c5fd">world</mark>');

  // Toggle off when applying the same color again
  const e3 = applyHighlightColor(doc2, e2.selFrom, e2.selTo, '#93c5fd');
  const doc3 = doc2.slice(0, e3.from) + e3.insert + doc2.slice(e3.to);
  assert.equal(doc3, 'hello world');
});




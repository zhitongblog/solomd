import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown';

test('#500 T09-4: renders a Markdown table inside <details> without pushing the table outside <details>', () => {
  const md = [
    '<details>',
    '<summary>点击展开表格</summary>',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '</details>',
  ].join('\n');

  const html = renderMarkdown(md);
  assert.match(html, /<details[^>]*>[\s\S]*<summary>点击展开表格<\/summary>[\s\S]*<table[^>]*>[\s\S]*<\/table>[\s\S]*<\/details>/);
  assert.doesNotMatch(html, /<div data-source-line="\d+">\s*<details\b[^>]*>[\s\S]*<\/div>\s*<table/);
});

test('#500 T09-4: renders a Markdown table inside <details> even without blank lines around the table', () => {
  const md = [
    '<details>',
    '<summary>紧邻表格</summary>',
    '| 姓名 | 分数 |',
    '| --- | --- |',
    '| 张三 | 98 |',
    '</details>',
  ].join('\n');

  const html = renderMarkdown(md);
  assert.ok(html.includes('<details'));
  assert.ok(html.includes('<table'));
  assert.match(html, /<td[^>]*>98<\/td>/);
});

test('#500 T08-9: terminates a GFM pipe table when followed immediately by a non-pipe prose line', () => {
  const md = [
    '| Col1 | Col2 |',
    '| --- | --- |',
    '| a | b |',
    '普通段落文字（没有空行也没有竖线）',
  ].join('\n');

  const html = renderMarkdown(md);
  assert.ok(html.includes('</tbody>\n</table>'));
  assert.match(html, /<p[^>]*>普通段落文字（没有空行也没有竖线）<\/p>/);
});

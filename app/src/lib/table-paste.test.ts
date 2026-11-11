import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clipboardTableToMarkdown,
  htmlTableToMarkdown,
  isTableOnlyHtml,
  tsvToMarkdown,
} from './table-paste.ts';

test('converts Excel / WPS clipboard HTML table to Markdown table (#460)', () => {
  const excelHtml = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:x="urn:schemas-microsoft-com:office:excel">
    <head>
      <style>td { mso-number-format:"\\@"; }</style>
    </head>
    <body>
      <table>
        <!--StartFragment-->
        <tr><td>姓名</td><td>部门</td><td style="text-align:right">得分</td></tr>
        <tr><td>张三</td><td>研发部</td><td align="right">98</td></tr>
        <tr><td>李四</td><td>产品 | 设计</td><td align="right">95</td></tr>
        <!--EndFragment-->
      </table>
    </body>
    </html>
  `;
  assert.equal(
    clipboardTableToMarkdown(excelHtml, '姓名\t部门\t得分\n张三\t研发部\t98\n李四\t产品 | 设计\t95'),
    [
      '| 姓名 | 部门 | 得分 |',
      '| --- | --- | ---: |',
      '| 张三 | 研发部 | 98 |',
      '| 李四 | 产品 \\| 设计 | 95 |',
    ].join('\n'),
  );
});

test('handles multi-line cells (<br>) and colspan in HTML tables (#460)', () => {
  const html = `
    <table>
      <tr><th>阶段</th><th>说明</th></tr>
      <tr><td>第一阶段</td><td>需求分析<br>原型设计</td></tr>
    </table>
  `;
  assert.equal(
    htmlTableToMarkdown(html),
    [
      '| 阶段 | 说明 |',
      '| --- | --- |',
      '| 第一阶段 | 需求分析<br>原型设计 |',
    ].join('\n'),
  );
});

test('falls back to TSV when HTML is absent (#460)', () => {
  const tsv = '项目\t状态\t负责人\nSoloMD\t进行中\tAlex\nWebDAV\t已完成\tBot\n';
  assert.equal(
    tsvToMarkdown(tsv),
    [
      '| 项目 | 状态 | 负责人 |',
      '| --- | --- | --- |',
      '| SoloMD | 进行中 | Alex |',
      '| WebDAV | 已完成 | Bot |',
    ].join('\n'),
  );
});

test('does not convert single-cell HTML or indented code with tabs (#460)', () => {
  assert.equal(htmlTableToMarkdown('<table><tr><td>单格内容</td></tr></table>'), null);
  assert.equal(tsvToMarkdown('function foo() {\n\treturn 1;\n\t}'), null);
  assert.equal(clipboardTableToMarkdown('', '普通文本段落\n第二行'), null);
});

test('table inside a larger rich-text document is not converted alone (Outlook / Word)', () => {
  const html = `<p>Intro text</p><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table><p>Outro</p>`;
  assert.equal(isTableOnlyHtml(html), false);
  assert.equal(clipboardTableToMarkdown(html, 'Intro text\nA\tB\n1\t2\nOutro'), null);
});

test('table-only HTML (Excel / Word table + nbsp paragraph) is still a table', () => {
  const html = `<html><body><!--StartFragment--><table><tr><td>A</td><td>B</td></tr></table><p class=MsoNormal>&nbsp;</p><!--EndFragment--></body></html>`;
  assert.equal(isTableOnlyHtml(html), true);
  assert.equal(clipboardTableToMarkdown(html, 'A\tB'), '| A | B |\n| --- | --- |\n|  |  |');
});

test('text between two tables counts as outside content', () => {
  const html = `<table><tr><td>A</td></tr></table><p>between</p><table><tr><td>B</td></tr></table>`;
  assert.equal(isTableOnlyHtml(html), false);
});

test('source newlines inside cells are whitespace, only <br> is a break', () => {
  const html = `<table><tr><td>Оставить
как есть</td><td>без
изменений</td></tr><tr><td>a<br>b</td><td>c</td></tr></table>`;
  assert.equal(
    htmlTableToMarkdown(html),
    [
      '| Оставить как есть | без изменений |',
      '| --- | --- |',
      '| a<br>b | c |',
    ].join('\n'),
  );
});

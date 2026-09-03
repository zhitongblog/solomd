/**
 * Unit tests for malformed GFM table-delimiter normalization.
 *
 * The repo has no vitest/tsx dependency, so this uses Node's built-in
 * `node:test` + `node:assert` and Node 23+ native TypeScript type-stripping.
 * Run from the worktree root with:
 *
 *   node --test --experimental-strip-types \
 *     app/src/lib/markdown-tables.selftest.mjs
 *
 * (the `.selftest.mjs` wrapper resolves markdown.ts's extension-less / plugin
 * imports the same way relationships.selftest.mjs does).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderMarkdown,
  preprocessMarkdown,
  setMarkdownAutoNumberHeadings,
} from './markdown.ts';

// The render pipeline tags block elements with `data-source-line`, so <table>
// carries attributes — match the tag open, not a bare `<table>`.
const countTables = (html: string): number =>
  (html.match(/<table[\s>]/g) || []).length;

test('分隔行比表头多一列 — 用户上报的文档', () => {
  const src = `| 大类 | 领域 | 管制编码范围 |
|:----:|------|:-----------:|----------|
| 1 | 专用材料 | 1A-1E |
| 2 | 材料加工 | 2A-2E |`;
  const html = renderMarkdown(src);
  assert.equal(countTables(html), 1, '应被识别为 1 个表格');
  assert.match(html, /<th[^>]*>大类<\/th>/);
  // 首列的 `:----:` 对齐意图应保留
  assert.match(html, /<th style="text-align:center">大类<\/th>/);
});

test('分隔行比表头少一列', () => {
  const src = `| A | B | C |
|---|---|
| 1 | 2 | 3 |`;
  assert.equal(countTables(renderMarkdown(src)), 1);
});

test('列数正确的正常表格不被改动', () => {
  const src = `| A | B |
|:--|--:|
| 1 | 2 |`;
  assert.equal(preprocessMarkdown(src).replace(/\n$/, ''), src);
  assert.equal(countTables(renderMarkdown(src)), 1);
});

test('代码块内的伪表格保持原样', () => {
  const src = '```\n| A | B |\n|---|---|---|\n```';
  assert.equal(countTables(renderMarkdown(src)), 0);
  assert.match(preprocessMarkdown(src), /\|---\|---\|---\|/);
});

test('普通 HR 分隔线不被误判为表格分隔行', () => {
  const src = `文字\n\n---\n\n更多文字`;
  assert.equal(countTables(renderMarkdown(src)), 0);
});

test('含转义管道的单元格', () => {
  const src = `| A | B |\n|---|---|---|\n| a\\|b | c |`;
  assert.equal(countTables(renderMarkdown(src)), 1);
});

test('分隔行含空单元格', () => {
  const src = `| A | B | C |\n| --- |  | --- |\n| 1 | 2 | 3 |`;
  assert.equal(countTables(renderMarkdown(src)), 1);
});

test('全空的第二行不被误判为分隔行(仍是普通段落)', () => {
  const src = `| A | B |\n|  |  |\n| 1 | 2 |`;
  assert.equal(countTables(renderMarkdown(src)), 0);
});

test('一份文档中的多个畸形表格都被修复', () => {
  const src = `| 大类 | 领域 | 管制编码范围 |
|:----:|------|:-----------:|----------|
| 1 | 专用材料 | 1A-1E |

| 子章节 | 内容 |
|:------:|------|----------|
| （一） | 核材料 |`;
  assert.equal(countTables(renderMarkdown(src)), 2);
});

// ---- 编号章节自动转标题(可选设置) --------------------------------------

test('默认关闭:编号行不转标题', () => {
  setMarkdownAutoNumberHeadings(false);
  const html = renderMarkdown('6.2 出口许可证管理目录（三部分并列）');
  assert.equal(/<h[1-6][\s>]/.test(html), false);
});

test('开启后:编号行按深度转为标题', () => {
  setMarkdownAutoNumberHeadings(true);
  try {
    const html = renderMarkdown(
      '6.2 出口许可证管理目录（三部分并列）\n\n6.2.1 第一部分：两用物项',
    );
    assert.match(html, /<h2[^>]*>6\.2 出口许可证管理目录（三部分并列）<\/h2>/);
    assert.match(html, /<h3[^>]*>6\.2\.1 第一部分：两用物项<\/h3>/);
  } finally {
    setMarkdownAutoNumberHeadings(false);
  }
});

test('开启后:有序列表 / 小数句子 / 单数字 不被误转', () => {
  setMarkdownAutoNumberHeadings(true);
  try {
    // 有序列表(单段编号 + 尾点)保持列表
    assert.equal(/<h[1-6][\s>]/.test(renderMarkdown('1. 项目一')), false);
    // 以小数开头、句末有标点的散文不转
    assert.equal(/<h[1-6][\s>]/.test(renderMarkdown('3.14 是圆周率。')), false);
    // 单个数字(易误判)不转
    assert.equal(/<h[1-6][\s>]/.test(renderMarkdown('6 个要点如下')), false);
    // 代码块内不转
    assert.equal(/<h[1-6][\s>]/.test(renderMarkdown('```\n6.2 in code\n```')), false);
  } finally {
    setMarkdownAutoNumberHeadings(false);
  }
});

// #213 — nested lists inside an ORDERED list must nest (not flatten). The
// indent-normalizer stepped every level by a flat 2 spaces, which is narrower
// than an ordered marker (`1. ` = 3), so markdown-it saw the sublist as
// siblings. Nesting must survive marker-width normalization.
const nestsSublist = (html: string): boolean => /<li[^>]*>[\s\S]*?<(ol|ul)[\s>]/.test(html);

test('#213 有序列表里的嵌套列表:3 空格缩进应嵌套', () => {
  assert.equal(nestsSublist(renderMarkdown('1. first\n   1. sub a\n   2. sub b\n2. second\n')), true);
  assert.equal(nestsSublist(renderMarkdown('1. first\n   - bullet a\n   - bullet b\n2. second\n')), true);
});

test('#213 嵌套:4 空格 / 三层深 / 9→10 变宽标记', () => {
  assert.equal(nestsSublist(renderMarkdown('1. first\n    1. sub\n2. second\n')), true);
  // 三层深:每层都进一层
  const deep = renderMarkdown('1. a\n   1. b\n      1. c\n');
  assert.equal((deep.match(/<ol[\s>]/g) || []).length, 3);
  // 9. → 10. 标记宽度变化后子项仍归属 10.
  assert.equal(nestsSublist(renderMarkdown('9. nine\n10. ten\n    1. sub of ten\n')), true);
});

test('#213 回归:无序列表嵌套不受影响', () => {
  assert.equal(nestsSublist(renderMarkdown('- a\n  - b\n  - c\n- d\n')), true);
});

// ---- 正文 `[TOC]` 自动目录 -------------------------------------------------

test('[TOC] 生成带锚点和层级的正文目录', () => {
  const html = renderMarkdown(`[TOC]

# 项目概览

## 安装与使用

### Windows

## 常见问题`);
  assert.match(html, /<nav class="md-toc"[^>]*aria-label="Table of contents"/);
  assert.match(html, /<a href="#%E9%A1%B9%E7%9B%AE%E6%A6%82%E8%A7%88" class="md-toc__link">项目概览<\/a>/);
  assert.match(html, /<a href="#%E5%AE%89%E8%A3%85%E4%B8%8E%E4%BD%BF%E7%94%A8" class="md-toc__link">安装与使用<\/a>/);
  assert.equal((html.match(/class="md-toc__list"/g) || []).length, 3);
  assert.doesNotMatch(html, /\[TOC\]/i);
});

test('[TOC] 与实际标题共用重复 slug，并保留原始 source line', () => {
  const html = renderMarkdown(`[toc]

# Repeat

# Repeat`);
  assert.match(html, /href="#repeat"/);
  assert.match(html, /href="#repeat-1"/);
  assert.match(html, /<h1 id="repeat"[^>]*data-source-line="3">/);
  assert.match(html, /<h1 id="repeat-1"[^>]*data-source-line="5">/);
});

test('[TOC] 支持 Setext 和格式化标题文本', () => {
  const html = renderMarkdown(`[TOC]

Main *Title*
============

## Use \`code\``);
  assert.match(html, /href="#main-title"[^>]*>Main Title<\/a>/);
  assert.match(html, /href="#use-code"[^>]*>Use code<\/a>/);
});

test('代码块、行内文本和列表中的 [TOC] 不会展开', () => {
  const html = renderMarkdown(`\`\`\`
[TOC]
\`\`\`

这里有 [TOC] 文本。

- [TOC]

# Heading`);
  assert.doesNotMatch(html, /<nav class="md-toc"/);
  assert.match(html, /<code[^>]*>.*\[TOC\]/s);
  assert.match(html, /这里有 \[TOC\] 文本/);
});

test('无标题文档中的 [TOC] 不显示空标记', () => {
  const html = renderMarkdown('[TOC]\n\n正文');
  assert.doesNotMatch(html, /\[TOC\]|<nav class="md-toc"/i);
  assert.match(html, /<p[^>]*>正文<\/p>/);
});

test('分块实时预览可从完整文档生成 [TOC]，且不泄漏 front matter', () => {
  const html = renderMarkdown('[TOC]', {
    tocSource: `---
title: Full document
---

# 全文标题`,
  });
  assert.match(html, /<nav class="md-toc"/);
  assert.match(html, /href="#%E5%85%A8%E6%96%87%E6%A0%87%E9%A2%98"/);
  assert.doesNotMatch(html, /md-frontmatter|Full document/);
});

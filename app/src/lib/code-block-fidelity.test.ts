/**
 * Regression tests: nothing rewrites the inside of a code block.
 *
 * Every markdown preprocessing pass we run before markdown-it (table
 * delimiter repair, numbered headings, list re-indentation, inline-HTML
 * unwrapping) is line- or regex-based, which is exactly the shape of bug that
 * eats source code: a competitor shipped a release where `==` inside a C++
 * block was read as highlight syntax and swallowed the rest of the line.
 * These assertions pin the boundary — code in, same code out.
 *
 * Run from `app/`:  node src/lib/code-block-fidelity.selftest.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, preprocessMarkdown } from './markdown';

/** The text markdown-it put inside <code>, HTML-entities decoded. */
function codeText(html: string): string {
  const m = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html);
  assert.ok(m, `no <code> element in:\n${html}`);
  return m![1]
    .replace(/<[^>]+>/g, '') // syntax-highlight spans
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function fenced(body: string, lang = 'cpp'): string {
  return '```' + lang + '\n' + body + '\n```\n';
}

test('C++ with == and << survives verbatim', () => {
  const body = [
    '#include <iostream>',
    'int main() {',
    '  if (a == b && c != d) {',
    '    std::cout << "x==y" << std::endl;',
    '  }',
    '  return 0;',
    '}',
  ].join('\n');
  assert.equal(codeText(renderMarkdown(fenced(body))).trimEnd(), body);
});

test('highlight, strikethrough, sub/sup and emphasis markers are inert in code', () => {
  const body = [
    'a ==b== c',
    'x ~~y~~ z',
    'H~2~O and x^2^',
    '**not bold** and *not italic*',
    '限制：**中文粗体** 也不该被解析',
  ].join('\n');
  assert.equal(codeText(renderMarkdown(fenced(body, 'text'))).trimEnd(), body);
});

test('markdown-looking lines in code are not re-indented or renumbered', () => {
  const body = [
    '# not a heading',
    '## also not',
    '- item',
    '    - deep item',
    '1. one',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
  ].join('\n');
  assert.equal(codeText(renderMarkdown(fenced(body, 'md'))).trimEnd(), body);
  // The preprocessing passes must leave the fenced region byte-identical.
  const doc = '# Real heading\n\n' + fenced(body, 'md');
  assert.ok(preprocessMarkdown(doc).includes(body));
});

test('a broken table inside code is not repaired', () => {
  // normalizeTableDelimiters rewrites `|--|--|` rows in prose; inside a fence
  // the sample table has to stay exactly as typed or the doc is lying.
  const body = ['| a | b |', '|--|--|', '| 1 | 2 |'].join('\n');
  const doc = fenced(body, 'markdown');
  assert.equal(codeText(renderMarkdown(doc)).trimEnd(), body);
});

test('inline code is inert too', () => {
  const html = renderMarkdown('Use `a == b` and `~~x~~` here.\n');
  assert.match(html, /<code>a == b<\/code>/);
  assert.match(html, /<code>~~x~~<\/code>/);
  assert.doesNotMatch(html, /<s>|<mark>/);
});

test('tilde fences hold the same guarantees', () => {
  const body = ['a ==b==', '```', 'still inside', '```'].join('\n');
  const html = renderMarkdown('~~~text\n' + body + '\n~~~\n');
  assert.equal(codeText(html).trimEnd(), body);
});

test('== still means highlight in prose', () => {
  // The fix must not cost the feature: outside code, markdown-it-mark works.
  assert.match(renderMarkdown('a ==b== c\n'), /<mark>b<\/mark>/);
});

test('indented code blocks keep their content', () => {
  const html = renderMarkdown('text\n\n    a ==b== c\n    x ~~y~~ z\n');
  const code = codeText(html);
  assert.ok(code.includes('a ==b== c'), code);
  assert.ok(code.includes('x ~~y~~ z'), code);
});

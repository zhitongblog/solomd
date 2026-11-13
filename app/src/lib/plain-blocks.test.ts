import assert from 'node:assert/strict';
import test from 'node:test';
import { splitPlainMarkdownBlocks } from './plain-blocks';

const texts = (src: string) => splitPlainMarkdownBlocks(src).map((block) => block.text);

test('<details> with blank lines and a fence inside stays one block', () => {
  const src = [
    '![diagram](diagram.png)',
    '',
    '<details><summary>图表源码</summary>',
    '',
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> AUTH',
    '```',
    '',
    '</details>',
    '',
    'tail',
  ].join('\n');

  assert.deepEqual(texts(src), [
    '![diagram](diagram.png)',
    '',
    '<details><summary>图表源码</summary>\n\n```mermaid\nstateDiagram-v2\n  [*] --> AUTH\n```\n\n</details>',
    '',
    'tail',
  ]);
});

test('container spans are contiguous and cover the whole document', () => {
  const src = '<details open>\n<div>nested</div>\n</details>\n\npara\n';
  const blocks = splitPlainMarkdownBlocks(src);
  let expectedStart = 0;
  for (const block of blocks) {
    assert.equal(block.start, expectedStart);
    expectedStart = block.end;
  }
  assert.equal(expectedStart, src.length);
  assert.deepEqual(
    blocks.map((block) => block.text),
    ['<details open>\n<div>nested</div>\n</details>', '', 'para', ''],
  );
});

test('a container that opens inside a fence is left to the fence', () => {
  const src = '```html\n<details><summary>s</summary>\n</details>\n```\n';
  assert.deepEqual(texts(src), ['```html\n<details><summary>s</summary>\n</details>\n```', '']);
});

test('an unclosed container falls back to the paragraph rules', () => {
  assert.deepEqual(texts('<details><summary>s</summary>\n\ntext\n'), [
    '<details><summary>s</summary>',
    '',
    'text',
    '',
  ]);
});

test('a nested same-tag container does not end the block early', () => {
  const src = '<div>\n<details><summary>a</summary>\n</details>\n</div>\n\nafter\n';
  assert.deepEqual(texts(src), [
    '<div>\n<details><summary>a</summary>\n</details>\n</div>',
    '',
    'after',
    '',
  ]);
});

test('leading YAML front-matter stays a single block instead of splitting opening --- as <hr>', () => {
  const src = '---\ninbox: true\ntitle: Demo\n---\n# Heading\n';
  assert.deepEqual(texts(src), ['---\ninbox: true\ntitle: Demo\n---', '# Heading', '']);
});

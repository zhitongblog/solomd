import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInsertSnippet, MERMAID_INSERT_SNIPPET } from './insert-snippet.ts';

test('no marker: caret at the end', () => {
  assert.deepEqual(parseInsertSnippet('\n---\n'), { text: '\n---\n', anchor: 5, head: 5 });
});

test('one marker: caret there, marker stripped', () => {
  assert.deepEqual(parseInsertSnippet('$$|$$'), { text: '$$', anchor: 1, head: 1 });
  assert.deepEqual(parseInsertSnippet('\n$$\n$|$\n$$\n'), { text: '\n$$\n\n$$\n', anchor: 4, head: 4 });
});

test('two markers: the placeholder between them is selected', () => {
  const p = parseInsertSnippet('A[$|$Start$|$] --> B');
  assert.equal(p.text, 'A[Start] --> B');
  assert.equal(p.text.slice(p.anchor, p.head), 'Start');
});

test('mermaid insert template is a valid diagram as inserted', () => {
  const p = parseInsertSnippet(MERMAID_INSERT_SNIPPET);
  assert.ok(!p.text.includes('$|$'));
  // No empty node label — `A[]` is a mermaid syntax error.
  assert.ok(!/\[\s*\]/.test(p.text), p.text);
  assert.match(p.text, /```mermaid\ngraph TD\n {2}A\[Start\] --> B\[End\]\n```/);
  assert.equal(p.text.slice(p.anchor, p.head), 'Start');
});

test('slash /mermaid inserts a valid diagram with the label selected', async () => {
  const { SLASH_BLOCKS, expandSnippet } = await import('./slash-blocks.ts');
  const block = SLASH_BLOCKS.find((b) => b.id === 'mermaid')!;
  const ex = expandSnippet(block.snippet, '');
  assert.ok(!/\[\s*\]/.test(ex.text), ex.text);
  assert.equal(ex.text.slice(ex.cursorOffset, ex.cursorOffset + (ex.selectionLength ?? 0)), 'Start');
  // Plain ${cursor} snippets are unchanged.
  assert.deepEqual(expandSnippet('# ${cursor}', ''), { text: '# ', cursorOffset: 2 });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { cjkWordAt, tripleClickLineRange } from './cm-cjk-dblclick.ts';

function wordAt(doc: string, ch: number): string | null {
  const r = cjkWordAt(EditorState.create({ doc }), ch);
  return r ? doc.slice(r.from, r.to) : null;
}

test('double-click on CJK picks a word, not the clause between punctuation', () => {
  const doc = '这是一句中文。这是第二句。';
  const w = wordAt(doc, 0);
  assert.ok(w, 'a word is found');
  assert.ok(w!.length < '这是一句中文'.length, `picked "${w}"`);
  assert.ok('这是一句中文'.startsWith(w!), `picked "${w}"`);
});

test('double-click stays on its own line', () => {
  const doc = 'abc\n编辑器内容';
  const w = wordAt(doc, 5);
  assert.ok(w && !w.includes('\n'));
});

test('Latin words and punctuation fall through to CodeMirror', () => {
  assert.equal(wordAt('hello 世界', 1), null);
  assert.equal(wordAt('中文。', 2), null);
  assert.equal(wordAt('', 0), null);
});

test('tripleClickLineRange selects the full line without its trailing newline', () => {
  const doc = 'first line\nsecond line\nthird line';
  const state = EditorState.create({ doc });
  const r = tripleClickLineRange(state, 14);
  assert.equal(doc.slice(r.anchor, r.head), 'second line');
});

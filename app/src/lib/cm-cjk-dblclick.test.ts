import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cjkWordAt, tripleClickLineRange } from './cm-cjk-dblclick.ts';
import { stableClickSelection } from './cm-stable-click.ts';

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

test('stableClickSelection uses precise=false and retains lastHead instead of snapping back to startPos on null posAtCoords', () => {
  const doc = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n');
  const state = EditorState.create({
    doc,
    extensions: [stableClickSelection()],
  });
  const makers = state.facet(EditorView.mouseSelectionStyle);
  assert.equal(makers.length, 1);

  const line1000Pos = state.doc.line(1000).from;
  const line1700Pos = state.doc.line(1700).from;
  const preciseArgs: Array<boolean | undefined> = [];
  let nextPos: number | null = line1000Pos;

  const fakeView = {
    state,
    posAtCoords(_coords: { x: number; y: number }, precise?: boolean) {
      preciseArgs.push(precise);
      return nextPos;
    },
  } as unknown as EditorView;

  const style = makers[0](fakeView, {
    button: 0,
    detail: 1,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    clientX: 100,
    clientY: 100,
  } as MouseEvent);
  assert.ok(style, 'style should be created');

  // Drag down to line 1700
  nextPos = line1700Pos;
  const selAt1700 = style!.get(
    { clientX: 100, clientY: 600 } as MouseEvent,
    false,
    false,
  );
  assert.equal(selAt1700.main.anchor, line1000Pos);
  assert.equal(selAt1700.main.head, line1700Pos);

  // If posAtCoords ever returns null mid-drag, head must stay at line 1700, NOT jump back to line 1000
  nextPos = null;
  const selAfterNull = style!.get(
    { clientX: 100, clientY: 650 } as MouseEvent,
    false,
    false,
  );
  assert.equal(selAfterNull.main.anchor, line1000Pos);
  assert.equal(selAfterNull.main.head, line1700Pos);
  assert.ok(preciseArgs.every((p) => p === false), 'posAtCoords must be called with precise=false');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { focusCodeMirrorWithoutScroll, preservePointerFocusScroll } from './cm-preserve-focus.ts';

function fakeView(top: number, left = 0, focused = false) {
  const scroller = { scrollTop: top, scrollLeft: left };
  let focusCalls = 0;
  const view = {
    hasFocus: focused,
    scrollDOM: scroller,
    focus() {
      focusCalls++;
      view.hasFocus = true;
      // Model WKWebView scrolling to a stale caret during focus.
      scroller.scrollTop = top === 0 ? 2000 : 0;
      scroller.scrollLeft = 300;
    },
  };
  return { view: view as unknown as EditorView, scroller, calls: () => focusCalls };
}

test('focus synchronizes CodeMirror without jumping from the top to a stale end caret', () => {
  const s = fakeView(0);
  focusCodeMirrorWithoutScroll(s.view);
  assert.equal(s.calls(), 1);
  assert.equal(s.view.hasFocus, true);
  assert.equal(s.scroller.scrollTop, 0);
  assert.equal(s.scroller.scrollLeft, 0);
});

test('focus preserves a middle-of-document viewport and horizontal scroll', () => {
  const s = fakeView(752, 80);
  focusCodeMirrorWithoutScroll(s.view);
  assert.equal(s.scroller.scrollTop, 752);
  assert.equal(s.scroller.scrollLeft, 80);
});

test('pointer focus runs before selection handling without claiming the click', () => {
  const state = EditorState.create({ extensions: [preservePointerFocusScroll()] });
  const style = state.facet(EditorView.mouseSelectionStyle)[0];
  const s = fakeView(752);
  assert.equal(style(s.view, { button: 0 } as MouseEvent), null);
  assert.equal(s.calls(), 1);
  assert.equal(s.scroller.scrollTop, 752);
});

test('modified clicks and double clicks still fall through after safe focus', () => {
  const state = EditorState.create({ extensions: [preservePointerFocusScroll()] });
  const style = state.facet(EditorView.mouseSelectionStyle)[0];
  for (const modifiers of [{ shiftKey: true }, { metaKey: true }, { altKey: true }, { detail: 2 }, { detail: 3 }]) {
    const s = fakeView(752);
    assert.equal(style(s.view, { button: 0, ...modifiers } as MouseEvent), null);
    assert.equal(s.calls(), 1);
    assert.equal(s.scroller.scrollTop, 752);
  }
});

test('already-focused clicks and non-primary buttons do not refocus', () => {
  const state = EditorState.create({ extensions: [preservePointerFocusScroll()] });
  const style = state.facet(EditorView.mouseSelectionStyle)[0];
  for (const [focused, button] of [[true, 0], [false, 1], [false, 2]] as const) {
    const s = fakeView(752, 0, focused);
    assert.equal(style(s.view, { button } as MouseEvent), null);
    assert.equal(s.calls(), 0);
    assert.equal(s.scroller.scrollTop, 752);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EditorState, type TransactionSpec } from '@codemirror/state';
import { SearchQuery, search, setSearchQuery } from '@codemirror/search';

import { matchFrom, replaceCurrent } from './cm-find-panel.ts';

/** Just enough of an EditorView for the search commands: state + dispatch. */
function fakeView(doc: string, caret: number, find: string, replace: string) {
  let state = EditorState.create({ doc, extensions: [search()], selection: { anchor: caret } });
  state = state.update({ effects: setSearchQuery.of(new SearchQuery({ search: find, replace })) }).state;
  const view = {
    get state() {
      return state;
    },
    dispatch(...specs: TransactionSpec[]) {
      state = state.update(...specs).state;
    },
  };
  return view as unknown as import('@codemirror/view').EditorView & { readonly state: EditorState };
}

test('matchFrom finds the match at or after a position, wrapping', () => {
  const state = EditorState.create({ doc: 'a foo b foo' });
  const q = new SearchQuery({ search: 'foo' });
  assert.deepEqual(matchFrom(state, q, 0), { from: 2, to: 5 });
  assert.deepEqual(matchFrom(state, q, 2), { from: 2, to: 5 });
  assert.deepEqual(matchFrom(state, q, 3), { from: 8, to: 11 });
  assert.deepEqual(matchFrom(state, q, 11), { from: 2, to: 5 });
  assert.equal(matchFrom(state, new SearchQuery({ search: '' }), 0), null);
});

test('Replace replaces on the first click with the caret at a match (C2)', () => {
  // The counter reads "1/2" here: the caret sits at the first match.
  const view = fakeView('foo and foo', 0, 'foo', 'bar');
  assert.equal(replaceCurrent(view), true);
  assert.equal(view.state.doc.toString(), 'bar and foo');
  // …and the next match is selected, so the next click replaces it.
  const sel = view.state.selection.main;
  assert.deepEqual([sel.from, sel.to], [8, 11]);
  replaceCurrent(view);
  assert.equal(view.state.doc.toString(), 'bar and bar');
});

test('Replace with no match selected yet replaces the next one', () => {
  const view = fakeView('x foo y foo', 1, 'foo', 'bar');
  replaceCurrent(view);
  assert.equal(view.state.doc.toString(), 'x bar y foo');
});

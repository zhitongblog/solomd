import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLaunchCursorRestore } from './launch-cursor-restore.ts';

function setup() {
  let nextTimer = 1;
  const pending = new Map<number, () => void>();
  const cursors = new Map([
    ['a', { line: 199, col: 1 }],
    ['b', { line: 40, col: 3 }],
  ]);
  const moves: Array<{ line: number; col: number }> = [];
  const state = { tabId: 'a' as string | undefined, visibleAndFocused: true, mounted: true, viewportMemory: false };
  const restore = createLaunchCursorRestore(
    {
      getTabId: () => state.tabId,
      canRestore: () => state.visibleAndFocused,
      getEditor: () => (state.mounted ? { setCaret: (line, col) => moves.push({ line, col }) } : null),
      takeCursor: (id) => {
        const cursor = cursors.get(id) ?? null;
        cursors.delete(id);
        return cursor;
      },
      hasViewportMemory: () => state.viewportMemory,
    },
    {
      set: (fn, ms) => {
        assert.equal(ms, 150);
        const id = nextTimer++;
        pending.set(id, fn);
        return id;
      },
      clear: (id) => {
        pending.delete(id as number);
      },
    },
  );
  return {
    restore,
    state,
    cursors,
    moves,
    pending,
    settle() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const fn of callbacks) fn();
    },
  };
}

test('idle launch restores the saved line and column once (#586)', () => {
  const s = setup();
  s.restore.schedule();
  assert.deepEqual(s.moves, []);
  s.settle();
  assert.deepEqual(s.moves, [{ line: 199, col: 1 }]);
  s.restore.schedule();
  s.settle();
  assert.equal(s.moves.length, 1);
});

test('click/typing/wheel before launch restoration keeps the user position instead of jumping (#586)', () => {
  const s = setup();
  s.restore.schedule();
  s.restore.userIntent();
  s.settle();
  assert.deepEqual(s.moves, []);
  assert.equal(s.cursors.has('a'), false);
  assert.equal(s.cursors.has('b'), true);
});

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
  const restore = createLaunchCursorRestore({
    getTabId: () => state.tabId,
    canRestore: () => state.visibleAndFocused,
    getEditor: () => state.mounted ? { setCaret: (line, col) => moves.push({ line, col }) } : null,
    takeCursor: (id) => {
      const cursor = cursors.get(id) ?? null;
      cursors.delete(id);
      return cursor;
    },
    hasViewportMemory: () => state.viewportMemory,
  }, {
    set: (fn, ms) => {
      assert.equal(ms, 150);
      const id = nextTimer++;
      pending.set(id, fn);
      return id;
    },
    clear: (id) => { pending.delete(id as number); },
  });
  return {
    restore, state, cursors, moves, pending,
    settle() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const fn of callbacks) fn();
    },
  };
}

test('idle launch restores the saved line and column once', () => {
  const s = setup();
  s.restore.schedule();
  assert.deepEqual(s.moves, []);
  s.settle();
  assert.deepEqual(s.moves, [{ line: 199, col: 1 }]);
  s.restore.schedule();
  s.settle();
  assert.equal(s.moves.length, 1);
});

for (const intent of ['click', 'typing', 'wheel', 'touch']) {
  test(`${intent} before launch restoration keeps the user's position instead of jumping to the end`, () => {
    const s = setup();
    s.restore.schedule();
    // The pane's capture handlers call userIntent before the editor places
    // the caret or scrolls; even clicking the already-active line counts.
    s.restore.userIntent();
    s.settle();
    assert.deepEqual(s.moves, []);
    assert.equal(s.cursors.has('a'), false);
    assert.equal(s.cursors.has('b'), true, 'other tabs retain their saved cursor');
    // Refocusing or changing view mode must not resurrect the old snapshot.
    s.restore.schedule();
    s.settle();
    assert.deepEqual(s.moves, []);
  });
}

test('interaction before scheduling also supersedes the saved cursor', () => {
  const s = setup();
  s.restore.userIntent();
  s.restore.schedule();
  s.settle();
  assert.deepEqual(s.moves, []);
});

test('rescheduling leaves only one pending restoration', () => {
  const s = setup();
  s.restore.schedule();
  s.restore.schedule();
  assert.equal(s.pending.size, 1);
  s.settle();
  assert.equal(s.moves.length, 1);
});

test('switching tabs before the timer fires does not move the new document', () => {
  const s = setup();
  s.restore.schedule();
  s.state.tabId = 'b';
  s.settle();
  assert.deepEqual(s.moves, []);
  assert.equal(s.cursors.has('a'), true);
  s.restore.schedule();
  s.settle();
  assert.deepEqual(s.moves, [{ line: 40, col: 3 }]);
});

test('a hidden or unfocused editor preserves the saved cursor for later', () => {
  const s = setup();
  s.restore.schedule();
  s.state.visibleAndFocused = false;
  s.settle();
  assert.deepEqual(s.moves, []);
  assert.equal(s.cursors.has('a'), true);
  s.restore.schedule();
  assert.equal(s.pending.size, 0);
  s.state.visibleAndFocused = true;
  s.restore.schedule();
  s.settle();
  assert.equal(s.moves.length, 1);
});

test('unmount cancels the timer without discarding session memory', () => {
  const s = setup();
  s.restore.schedule();
  s.restore.cancel();
  assert.equal(s.pending.size, 0);
  s.settle();
  assert.deepEqual(s.moves, []);
  assert.equal(s.cursors.has('a'), true);
});

test('an editor that has not mounted yet does not consume session memory', () => {
  const s = setup();
  s.state.mounted = false;
  s.restore.schedule();
  s.settle();
  assert.equal(s.cursors.has('a'), true);
  assert.deepEqual(s.moves, []);
});

test('existing viewport memory takes precedence over the launch cursor', () => {
  const s = setup();
  s.state.viewportMemory = true;
  s.restore.schedule();
  s.settle();
  assert.deepEqual(s.moves, []);
  assert.equal(s.cursors.has('a'), false);
});

test('a saved cursor at the document start needs no scroll request', () => {
  const s = setup();
  s.cursors.set('a', { line: 1, col: 1 });
  s.restore.schedule();
  s.settle();
  assert.deepEqual(s.moves, []);
});

test('an empty pane never schedules a restoration', () => {
  const s = setup();
  s.state.tabId = undefined;
  s.restore.schedule();
  s.restore.userIntent();
  assert.equal(s.pending.size, 0);
  assert.equal(s.cursors.size, 2);
});

test('gotoLine remains a fallback for editors without setCaret', () => {
  const lines: number[] = [];
  let fire: (() => void) | undefined;
  const restore = createLaunchCursorRestore({
    getTabId: () => 'a',
    canRestore: () => true,
    getEditor: () => ({ gotoLine: (line) => lines.push(line) }),
    takeCursor: () => ({ line: 20, col: 8 }),
    hasViewportMemory: () => false,
  }, {
    set: (fn) => { fire = fn; return 1; },
    clear: () => { fire = undefined; },
  });
  restore.schedule();
  fire?.();
  assert.deepEqual(lines, [20]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CursorHistoryQueue } from './cursor-history.ts';

test('CursorHistoryQueue (#491): records distinct line jumps and navigates back and forward', () => {
  const q = new CursorHistoryQueue(10);
  q.record({ path: '/a.md', pos: 0, line: 1 });
  q.record({ path: '/a.md', pos: 45, line: 5 });
  q.record({ path: '/a.md', pos: 120, line: 12 });

  assert.equal(q.length, 3);
  assert.equal(q.canGoBack(), true);
  assert.equal(q.canGoForward(), false);

  assert.deepEqual(q.back(), { path: '/a.md', pos: 45, line: 5 });
  assert.deepEqual(q.back(), { path: '/a.md', pos: 0, line: 1 });
  assert.equal(q.back(), null);

  assert.deepEqual(q.forward(), { path: '/a.md', pos: 45, line: 5 });
  assert.deepEqual(q.forward(), { path: '/a.md', pos: 120, line: 12 });
  assert.equal(q.forward(), null);
});

test('CursorHistoryQueue (#491): coalesces small movements on the same line in place', () => {
  const q = new CursorHistoryQueue(10);
  q.record({ path: '/a.md', pos: 10, line: 2 });
  q.record({ path: '/a.md', pos: 15, line: 2 });
  q.record({ path: '/a.md', pos: 22, line: 2 });

  assert.equal(q.length, 1);
  assert.deepEqual(q.items[0], { path: '/a.md', pos: 22, line: 2 });
});

test('CursorHistoryQueue (#491): truncates forward history when a new jump is recorded after going back', () => {
  const q = new CursorHistoryQueue(10);
  q.record({ path: '/a.md', pos: 0, line: 1 });
  q.record({ path: '/a.md', pos: 40, line: 4 });
  q.record({ path: '/a.md', pos: 90, line: 9 });

  assert.deepEqual(q.back(), { path: '/a.md', pos: 40, line: 4 });
  q.record({ path: '/a.md', pos: 200, line: 20 });

  assert.equal(q.length, 3);
  assert.equal(q.canGoForward(), false);
  assert.deepEqual(q.back(), { path: '/a.md', pos: 40, line: 4 });
});

test('CursorHistoryQueue (#491): caps the queue at maxSize (default 10) and evicts oldest entries', () => {
  const q = new CursorHistoryQueue(10);
  for (let line = 1; line <= 14; line++) {
    q.record({ path: '/a.md', pos: line * 30, line });
  }
  assert.equal(q.length, 10);
  assert.equal(q.items[0].line, 5);
  assert.equal(q.items[9].line, 14);
});

test('CursorHistoryQueue (#491): ignores record calls inside withNavigation()', () => {
  const q = new CursorHistoryQueue(10);
  q.record({ path: '/a.md', pos: 0, line: 1 });
  q.record({ path: '/a.md', pos: 50, line: 5 });

  const target = q.back();
  assert.equal(target?.line, 1);
  q.withNavigation(() => {
    q.record({ path: '/a.md', pos: 0, line: 1 });
  });
  assert.equal(q.index, 0);
  assert.equal(q.canGoForward(), true);
});

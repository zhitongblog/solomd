/**
 * Unit tests for task metadata parsing and the checkbox rewrite.
 *
 * Run from `app/`:  node src/lib/tasks.selftest.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTaskMeta,
  isOverdue,
  localDateKey,
  compareTasks,
  toggleTaskLine,
} from './tasks';

test('plain text has no metadata', () => {
  const m = parseTaskMeta('buy milk');
  assert.deepEqual(m, { title: 'buy milk', priority: null, due: null, tags: [] });
});

test('Obsidian emoji priority and due date', () => {
  const m = parseTaskMeta('ship the release ⏫ 📅 2026-09-10');
  assert.equal(m.priority, 'high');
  assert.equal(m.due, '2026-09-10');
  assert.equal(m.title, 'ship the release');
});

test('ASCII forms work too', () => {
  assert.equal(parseTaskMeta('call the bank due:2026-01-02').due, '2026-01-02');
  assert.equal(parseTaskMeta('call the bank due: 2026-01-02').title, 'call the bank');
  assert.equal(parseTaskMeta('[#A] fix the build').priority, 'high');
  assert.equal(parseTaskMeta('[#c] tidy up').priority, 'low');
  assert.equal(parseTaskMeta('deploy !!!').priority, 'high');
  assert.equal(parseTaskMeta('deploy !!').priority, 'medium');
  assert.equal(parseTaskMeta('deploy !').priority, 'low');
  assert.equal(parseTaskMeta('deploy !!!').title, 'deploy');
});

test('an exclamation attached to a word is not a priority', () => {
  const m = parseTaskMeta('Ship it!');
  assert.equal(m.priority, null);
  assert.equal(m.title, 'Ship it!');
});

test('emoji wins over ASCII when both are present, and nothing is eaten twice', () => {
  const m = parseTaskMeta('thing 🔽 !!!');
  assert.equal(m.priority, 'low');
  assert.equal(m.title, 'thing !!!');
});

test('unrecognised text is left alone', () => {
  const m = parseTaskMeta('review PR #42 with @alex 50% done');
  assert.equal(m.title, 'review PR #42 with @alex 50% done');
  assert.deepEqual(m.tags, ['42']);
});

test('CJK tags are captured', () => {
  const m = parseTaskMeta('写周报 #工作 #写作');
  assert.deepEqual(m.tags, ['工作', '写作']);
  assert.equal(m.title, '写周报 #工作 #写作');
});

test('a malformed date is not a due date', () => {
  assert.equal(parseTaskMeta('due:2026-9-1 something').due, null);
  assert.equal(parseTaskMeta('📅 tomorrow').due, null);
});

test('overdue is strictly before today', () => {
  assert.equal(isOverdue('2026-09-02', '2026-09-03'), true);
  assert.equal(isOverdue('2026-09-03', '2026-09-03'), false);
  assert.equal(isOverdue('2026-09-04', '2026-09-03'), false);
  assert.equal(isOverdue(null, '2026-09-03'), false);
});

test('date key uses local time, not UTC', () => {
  // 00:30 local on the 3rd is still the 3rd, even where UTC says the 2nd.
  const d = new Date(2026, 8, 3, 0, 30);
  assert.equal(localDateKey(d), '2026-09-03');
});

test('sort: open before done, then due, then priority, then title', () => {
  const t = (done: boolean, text: string) => ({ done, meta: parseTaskMeta(text) });
  const list = [
    t(true, 'finished ⏫ 📅 2026-01-01'),
    t(false, 'no date'),
    t(false, 'later 📅 2026-12-01'),
    t(false, 'today 📅 2026-09-03'),
    t(false, 'also today 📅 2026-09-03 ⏫'),
  ];
  const order = [...list].sort(compareTasks).map((x) => x.meta.title);
  assert.deepEqual(order, ['also today', 'today', 'later', 'no date', 'finished']);
});

test('toggling rewrites only the checkbox on that line', () => {
  const doc = ['# H', '', '- [ ] one', '- [x] two', 'plain line'].join('\n');
  assert.equal(
    toggleTaskLine(doc, 3),
    ['# H', '', '- [x] one', '- [x] two', 'plain line'].join('\n'),
  );
  assert.equal(
    toggleTaskLine(doc, 4),
    ['# H', '', '- [ ] one', '- [ ] two', 'plain line'].join('\n'),
  );
});

test('toggling a line that is not a task refuses rather than corrupting it', () => {
  const doc = ['- [ ] one', 'plain'].join('\n');
  assert.equal(toggleTaskLine(doc, 2), null);
  assert.equal(toggleTaskLine(doc, 0), null);
  assert.equal(toggleTaskLine(doc, 99), null);
});

test('toggling preserves indentation and marker style', () => {
  assert.equal(toggleTaskLine('  * [ ] nested', 1), '  * [x] nested');
  assert.equal(toggleTaskLine('+ [X] done', 1), '+ [ ] done');
});

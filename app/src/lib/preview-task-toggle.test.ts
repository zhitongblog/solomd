import { test } from 'node:test';
import assert from 'node:assert/strict';

import { togglePreviewTask, taskLineIndexes } from './preview-task-toggle';
import { renderMarkdown } from './markdown';

const DOC = [
  '---',
  'title: T',
  '---',
  '# Tasks',
  '',
  '- [ ] one',
  '- [x] two',
  '',
  '```md',
  '- [ ] not a task (code)',
  '```',
  '',
  '1. [ ] ordered',
  '> - [ ] quoted',
].join('\n');

test('task lines skip fenced code', () => {
  assert.deepEqual(taskLineIndexes(DOC.split('\n')), [5, 6, 12, 13]);
});

test('toggles by data-line when it matches the clicked state', () => {
  const out = togglePreviewTask(DOC, 6, 0, false)!;
  assert.equal(out.split('\n')[5], '- [x] one');
  const back = togglePreviewTask(out, 6, 0, true)!;
  assert.equal(back, DOC);
  assert.equal(togglePreviewTask(DOC, 7, 1, true)!.split('\n')[6], '- [ ] two');
  assert.equal(togglePreviewTask(DOC, 13, 2, false)!.split('\n')[12], '1. [x] ordered');
  assert.equal(togglePreviewTask(DOC, 14, 3, false)!.split('\n')[13], '> - [x] quoted');
});

test('falls back to the checkbox index when data-line is off', () => {
  const out = togglePreviewTask(DOC, 2, 1, true)!;
  assert.equal(out.split('\n')[6], '- [ ] two');
});

test('refuses when neither line nor index matches the state', () => {
  assert.equal(togglePreviewTask(DOC, 6, 0, true), null);
  assert.equal(togglePreviewTask(DOC, 0, 9, false), null);
});

test('rendered preview li data-line points at the file line (front matter included)', () => {
  const html = renderMarkdown(DOC);
  const lines = [...html.matchAll(/<li[^>]*class="task-list-item"[^>]*data-line="(\d+)"/g)].map((m) => Number(m[1]));
  // Renders also accept attribute order class/data-line either way.
  const alt = [...html.matchAll(/<li[^>]*data-line="(\d+)"[^>]*class="task-list-item"/g)].map((m) => Number(m[1]));
  const got = lines.length ? lines : alt;
  assert.deepEqual(got, [6, 7, 13, 14]);
  const checkboxes = html.match(/task-list-item-checkbox/g) ?? [];
  assert.equal(checkboxes.length, 4);
  // Export HTML stays non-interactive.
  assert.ok(/task-list-item-checkbox"[^>]*disabled/.test(html));
});

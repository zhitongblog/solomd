import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideDiskChange,
  lastOwnWrite,
  noteOwnWrite,
  normalizeDiskText,
  typingIdleWait,
} from './external-change.ts';

const base = { autoReload: true, preview: false };

test('an event that changed nothing is ignored, even on a dirty tab', () => {
  // (b) after "Reload from Disk" the baseline is the disk; Linux then reports
  // our own read of the file, and the next keystroke made the tab dirty.
  assert.equal(
    decideDiskChange({ ...base, disk: 'reloaded', savedContent: 'reloaded', content: 'reloaded + typing' }),
    'ignore',
  );
  // (c) a note the app just created: empty on disk, empty baseline, typing.
  assert.equal(decideDiskChange({ ...base, disk: '', savedContent: '', content: 'new text' }), 'ignore');
});

test('our own write is recognised before markSaved catches up', () => {
  // (a) auto-save on blur: the watcher event overtakes the write's completion,
  // and the user has typed on since.
  assert.equal(
    decideDiskChange({
      ...base,
      disk: 'saved v2',
      savedContent: 'saved v1',
      content: 'saved v2 and more',
      lastOwnWrite: 'saved v2',
    }),
    'ignore',
  );
});

test('disk equal to the buffer is adopted, not asked about', () => {
  assert.equal(decideDiskChange({ ...base, disk: 'same', savedContent: 'old', content: 'same' }), 'adopt');
});

test('a real outside change reloads a clean tab and prompts on a dirty one', () => {
  assert.equal(decideDiskChange({ ...base, disk: 'theirs', savedContent: 'old', content: 'old' }), 'reload');
  assert.equal(decideDiskChange({ ...base, disk: 'theirs', savedContent: 'old', content: 'mine' }), 'prompt');
  assert.equal(
    decideDiskChange({ ...base, disk: 'theirs', savedContent: 'old', content: 'mine', lastOwnWrite: 'older' }),
    'prompt',
  );
});

test('auto-reload off: a clean tab asks, except in preview', () => {
  const off = { autoReload: false };
  assert.equal(decideDiskChange({ ...off, preview: false, disk: 'x', savedContent: 'o', content: 'o' }), 'prompt');
  assert.equal(decideDiskChange({ ...off, preview: true, disk: 'x', savedContent: 'o', content: 'o' }), 'reload');
});

test('own writes are remembered per path in LF form', () => {
  noteOwnWrite('/v/a.md', 'one\r\ntwo');
  assert.equal(lastOwnWrite('/v/a.md'), 'one\ntwo');
  assert.equal(lastOwnWrite('/v/b.md'), null);
  assert.equal(normalizeDiskText('a\r\nb\r\n'), 'a\nb\n');
});

test('the prompt waits for a pause in typing', () => {
  assert.equal(typingIdleWait(0, 1500), 1500);
  assert.equal(typingIdleWait(1000, 1500), 500);
  assert.equal(typingIdleWait(1500, 1500), 0);
  assert.equal(typingIdleWait(Number.POSITIVE_INFINITY), 0);
});

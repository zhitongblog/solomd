import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inboxCapturedAt, countInboxByPeriod, filterInboxEntries } from './inbox-filter';
import type { IndexEntry } from '../stores/workspaceIndex';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const DAY = 86_400_000;

function entry(path: string, mtimeSecs: number, fm: Record<string, unknown> = {}): IndexEntry {
  return {
    path,
    name: `${path}.md`,
    stem: path,
    mtime: mtimeSecs,
    size: 1,
    frontmatter: { inbox: true, ...fm },
    wikilinks: [],
    tags: [],
    headings: [],
    summary: '',
    title: null,
  } as unknown as IndexEntry;
}

test('mtime (seconds, as the Rust index stores it) becomes milliseconds', () => {
  const secs = Math.floor((NOW - 3600_000) / 1000);
  assert.equal(inboxCapturedAt(entry('a', secs)), secs * 1000);
});

test('a note modified today counts in Week and Month', () => {
  const today = entry('a', Math.floor(NOW / 1000) - 60);
  const old = entry('b', Math.floor((NOW - 40 * DAY) / 1000));
  assert.deepEqual(countInboxByPeriod([today, old], NOW), { week: 1, month: 1, all: 2 });
  assert.deepEqual(filterInboxEntries([old, today], 'week', NOW).map((e) => e.path), ['a']);
});

test('front-matter created wins; numeric seconds and ms both accepted', () => {
  const base = Math.floor(NOW / 1000);
  assert.equal(inboxCapturedAt(entry('a', base, { created: '2026-10-01' })), Date.parse('2026-10-01'));
  assert.equal(inboxCapturedAt(entry('a', base, { created: base - 10 })), (base - 10) * 1000);
  assert.equal(inboxCapturedAt(entry('a', base, { created: NOW - 5 })), NOW - 5);
});

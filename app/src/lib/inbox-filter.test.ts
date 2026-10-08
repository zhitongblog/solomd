import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inboxCapturedAt, filterInboxEntries } from './inbox-filter';
import type { IndexEntry } from '../stores/workspaceIndex';

function entry(mtime: number, frontmatter: Record<string, unknown> = { inbox: true }): IndexEntry {
  return {
    path: '/v/a.md', name: 'a.md', stem: 'a', mtime, size: 1, frontmatter,
    wikilinks: [], tags: [], headings: [], summary: '',
  };
}

const now = Date.UTC(2026, 9, 8, 12);
const nowSecs = Math.floor(now / 1000);

test('the index mtime is unix seconds and is read as such', () => {
  assert.equal(inboxCapturedAt(entry(nowSecs)), nowSecs * 1000);
});

test('a millisecond timestamp is left alone', () => {
  assert.equal(inboxCapturedAt(entry(0, { inbox: true, created: now })), now);
});

test('a note modified today is inside the Week and Month windows', () => {
  const e = [entry(nowSecs - 60)];
  assert.equal(filterInboxEntries(e, 'week', now).length, 1);
  assert.equal(filterInboxEntries(e, 'month', now).length, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchSafTree } from './saf-search.ts';

const tree: Record<string, { name: string; path: string; is_dir: boolean }[]> = {
  'saf:root': [
    { name: 'alpha.md', path: 'saf:root/alpha.md', is_dir: false },
    { name: 'sub', path: 'saf:root/sub', is_dir: true },
    { name: '.hidden', path: 'saf:root/.hidden', is_dir: true },
    { name: 'pic.png', path: 'saf:root/pic.png', is_dir: false },
  ],
  'saf:root/sub': [{ name: 'beta.txt', path: 'saf:root/sub/beta.txt', is_dir: false }],
  'saf:root/.hidden': [{ name: 'x.md', path: 'saf:root/.hidden/x.md', is_dir: false }],
};
const files: Record<string, string> = {
  'saf:root/alpha.md': '# Alpha\nthe ZebraCorn lives here\nnothing',
  'saf:root/sub/beta.txt': 'another zebracorn\r\nzebracorn again',
  'saf:root/.hidden/x.md': 'zebracorn hidden',
  'saf:root/pic.png': 'zebracorn',
};
const list = async (d: string) => tree[d] ?? [];
const read = async (f: string) => files[f];

test('finds matches in nested SAF folders, case-insensitively, skipping dot dirs and non-text', async () => {
  const hits = await searchSafTree('saf:root', 'zebracorn', 200, list, read);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}`),
    ['saf:root/alpha.md:2', 'saf:root/sub/beta.txt:1', 'saf:root/sub/beta.txt:2'],
  );
  assert.equal(hits[0].snippet, 'the ZebraCorn lives here');
});

test('respects the result cap and an empty query', async () => {
  assert.equal((await searchSafTree('saf:root', 'zebracorn', 2, list, read)).length, 2);
  assert.equal((await searchSafTree('saf:root', '', 200, list, read)).length, 0);
});

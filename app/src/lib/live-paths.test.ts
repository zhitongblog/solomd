import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findMissing } from './live-paths';

const disk: Record<string, string[]> = {
  '/v': ['/v/README.md', '/v/notes'],
  '/v/notes': ['/v/notes/Kept.txt', '/v/notes/NewName.md'],
};
function listDir(calls: string[]) {
  return async (dir: string) => {
    calls.push(dir);
    return disk[dir] ?? (dir === '/locked' ? null : []);
  };
}

test('renamed and deleted files are reported, live ones are not', async () => {
  const calls: string[] = [];
  const missing = await findMissing(
    ['/v/README.md', '/v/notes/NewInNotes.md', '/v/Renamed.md', '/v/notes/Kept.txt'],
    [],
    listDir(calls),
  );
  assert.deepEqual([...missing].sort(), ['/v/Renamed.md', '/v/notes/NewInNotes.md']);
  assert.deepEqual(calls.sort(), ['/v', '/v/notes']); // one listing per folder
});

test('indexed paths are trusted without touching the disk', async () => {
  const calls: string[] = [];
  const missing = await findMissing(['/v/notes/NewName.md'], ['/v/notes/NewName.md'], listDir(calls));
  assert.equal(missing.size, 0);
  assert.deepEqual(calls, []);
});

test('a folder that is gone takes its files with it', async () => {
  const missing = await findMissing(['/gone/a.md', '/gone/b.md'], [], listDir([]));
  assert.deepEqual([...missing].sort(), ['/gone/a.md', '/gone/b.md']);
});

test('a folder that cannot be listed proves nothing', async () => {
  assert.equal((await findMissing(['/locked/a.md'], [], listDir([]))).size, 0);
  const thrown = await findMissing(['/x/a.md'], [], async () => {
    throw new Error('EACCES');
  });
  assert.equal(thrown.size, 0);
});

test('Windows separators compare equal', async () => {
  const missing = await findMissing(['C:\\v\\a.md'], ['C:/v/a.md'], async () => null);
  assert.equal(missing.size, 0);
});

test('SAF URIs are never reported', async () => {
  const missing = await findMissing(['saf:tree/abc/doc.md'], [], async () => null);
  assert.equal(missing.size, 0);
});

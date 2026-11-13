import assert from 'node:assert/strict';
import { test } from 'node:test';

// Explicit .ts: `node --test` loads this module graph directly and Node's ESM
// resolver will not guess an extension (tsconfig has allowImportingTsExtensions).
import { newFileDirFor, parentDirOf, setTreeSelection, sourceFolderFor, treeSelection } from './new-file-target.ts';

// ---- parentDirOf --------------------------------------------------------

test('parentDirOf takes the folder off both separator styles', () => {
  assert.equal(parentDirOf('C:\\vault\\00 需求\\note.md'), 'C:\\vault\\00 需求');
  assert.equal(parentDirOf('/home/me/vault/note.md'), '/home/me/vault');
});

test('parentDirOf has nothing to offer for a bare file name', () => {
  assert.equal(parentDirOf('note.md'), null);
  assert.equal(parentDirOf(''), null);
});

test('parentDirOf does not mistake a volume root for a folder', () => {
  // "" would be handed to the save dialog as a start folder, which means
  // nothing anywhere; the caller must fall back instead.
  assert.equal(parentDirOf('/note.md'), null);
  assert.equal(parentDirOf('C:\\note.md'), 'C:');
});

// ---- newFileDirFor ------------------------------------------------------

test('a selected folder is the destination itself', () => {
  assert.equal(newFileDirFor({ path: 'C:\\vault\\01 测试文件夹', isDir: true }, null), 'C:\\vault\\01 测试文件夹');
});

test('a selected file sends the new file to its own folder', () => {
  assert.equal(
    newFileDirFor({ path: 'C:\\vault\\00 需求\\note.md', isDir: false }, null),
    'C:\\vault\\00 需求',
  );
});

test('with no selection the open document decides', () => {
  assert.equal(newFileDirFor(null, '/vault/sub/note.md'), '/vault/sub');
  // The document wins over nothing at all, and an untitled tab (no path) has
  // no opinion — the caller falls back to its own chain.
  assert.equal(newFileDirFor(null, null), null);
  assert.equal(newFileDirFor(null, undefined), null);
});

test('a selection the tree cannot resolve still beats the open document', () => {
  // Home folder / root paths have no usable parent: fall through to the
  // document rather than handing the dialog an empty string.
  assert.equal(newFileDirFor({ path: '/note.md', isDir: false }, '/vault/sub/other.md'), '/vault/sub');
});

// ---- #554: batch-export source folder -----------------------------------

test('#554 a selected folder is the batch-export source itself', () => {
  assert.equal(
    sourceFolderFor({ path: 'C:\\vault\\01 测试文件夹', isDir: true }),
    'C:\\vault\\01 测试文件夹',
  );
  assert.equal(sourceFolderFor({ path: '/home/me/vault', isDir: true }), '/home/me/vault');
});

test('#554 a selected file contributes its parent folder', () => {
  assert.equal(
    sourceFolderFor({ path: 'C:\\vault\\00 需求\\note.md', isDir: false }),
    'C:\\vault\\00 需求',
  );
  assert.equal(sourceFolderFor({ path: '/vault/sub/note.md', isDir: false }), '/vault/sub');
});

test('#554 no usable row and SAF URIs fall through to the caller', () => {
  assert.equal(sourceFolderFor(null), null);
  assert.equal(sourceFolderFor({ path: '/note.md', isDir: false }), null);
  assert.equal(
    sourceFolderFor({ path: 'content://com.android.externalstorage.documents/tree/primary', isDir: true }),
    null,
  );
});

// ---- the shared slot ----------------------------------------------------

test('the tree selection slot round-trips and clears', () => {
  setTreeSelection({ path: 'C:\\vault\\01 测试文件夹', isDir: true });
  assert.deepEqual(treeSelection(), { path: 'C:\\vault\\01 测试文件夹', isDir: true });
  setTreeSelection(null);
  assert.equal(treeSelection(), null);
});

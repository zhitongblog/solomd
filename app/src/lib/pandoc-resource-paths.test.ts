import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pandocResourcePaths } from './pandoc-resource-paths.ts';

test('note folder comes first, then the workspace root', () => {
  assert.deepEqual(
    pandocResourcePaths('/vault/notes/a.md', '/vault'),
    ['/vault/notes', '/vault'],
  );
});

test('a note at the workspace root does not repeat the folder', () => {
  assert.deepEqual(pandocResourcePaths('/vault/a.md', '/vault/'), ['/vault']);
  assert.deepEqual(pandocResourcePaths('C:\\vault\\a.md', 'C:\\vault'), ['C:\\vault']);
});

test('no file path still gives the workspace root', () => {
  assert.deepEqual(pandocResourcePaths(null, '/vault'), ['/vault']);
  assert.deepEqual(pandocResourcePaths(undefined, undefined), []);
});

test('SAF / content URIs are never handed to pandoc', () => {
  assert.deepEqual(pandocResourcePaths('saf:12/a.md', 'saf:12'), []);
  assert.deepEqual(pandocResourcePaths('content://tree/a.md', '/vault'), ['/vault']);
});

test('a path with no folder (bare drive / volume root) contributes nothing', () => {
  assert.deepEqual(pandocResourcePaths('C:a.md', null), []);
});

/**
 * types store — createType in a vault that has no Types/ folder yet.
 *
 * The Tauri bridge is faked through `window.__TAURI_INTERNALS__`, which is
 * what `@tauri-apps/api/core`'s `invoke` calls into.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

type Call = { cmd: string; args: Record<string, unknown> };
const calls: Call[] = [];
const dirs = new Set<string>(['/vault']);

(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'fs_create_dir') {
        const p = args.path as string;
        if (dirs.has(p)) throw new Error(`already exists: ${p}`);
        dirs.add(p);
        return null;
      }
      if (cmd === 'write_file') {
        const p = args.path as string;
        const parent = p.replace(/\/[^/]+$/, '');
        if (!dirs.has(parent)) throw new Error('write failed: No such file or directory (os error 2)');
        return null;
      }
      if (cmd === 'workspace_index_files') return [];
      return null;
    },
    transformCallback: () => 0,
  },
};

const { useTypesStore } = await import('./types.ts');
const { useWorkspaceIndexStore } = await import('./workspaceIndex.ts');

test('createType creates the Types/ folder before writing the definition', async () => {
  setActivePinia(createPinia());
  const idx = useWorkspaceIndexStore();
  idx.folder = '/vault';
  const types = useTypesStore();

  const path = await types.createType('Meeting');
  assert.equal(path, '/vault/Types/Meeting.md');
  const mkdir = calls.findIndex((c) => c.cmd === 'fs_create_dir');
  const write = calls.findIndex((c) => c.cmd === 'write_file');
  assert.ok(mkdir >= 0 && mkdir < write, 'mkdir happens before write');
  assert.equal(calls[mkdir].args.path, '/vault/Types');
  assert.match(String(calls[write].args.content), /^---\ntype: Type\n---/);

  // Second type: the folder already exists — still succeeds.
  const second = await types.createType('Project');
  assert.equal(second, '/vault/Types/Project.md');
});

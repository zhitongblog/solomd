/**
 * A12 — the caret survives a relaunch: setCursor persists it with the tab,
 * and a store created from that persisted state hands it back once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const mem = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = localStorage;
g.window = { localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
if (!('navigator' in globalThis)) g.navigator = { userAgent: 'node', platform: 'MacIntel' };

// Per-workspace tabs off → a single global bucket, which keeps the test
// independent of the workspace store.
mem.set('solomd.settings.v1', JSON.stringify({ restoreSession: true, perWorkspaceTabs: false }));

const { useTabsStore } = await import('./tabs.ts');

test('caret is persisted and restored once on the next launch', async () => {
  setActivePinia(createPinia());
  const first = useTabsStore();
  const tab = first.openFromDisk({
    filePath: '/vault/long.md',
    content: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'),
    encoding: 'UTF-8',
    language: 'markdown',
    hadBom: false,
  });
  first.setCursor(tab.id, 30, 3);
  await new Promise((r) => setTimeout(r, 900));
  const saved = JSON.parse(mem.get('solomd.tabs.v1')!);
  assert.deepEqual(saved.tabs[0].cursor, { line: 30, col: 3 });

  // "Relaunch": a fresh pinia re-runs the store's state() from localStorage.
  setActivePinia(createPinia());
  const second = useTabsStore();
  const restored = second.tabs.find((t) => t.filePath === '/vault/long.md')!;
  // The editor reporting line 1 on mount must not clobber the pending restore.
  second.setCursor(restored.id, 1, 1);
  assert.deepEqual(second.takeLaunchCursor(restored.id), { line: 30, col: 3 });
  assert.equal(second.takeLaunchCursor(restored.id), null, 'only once');
});

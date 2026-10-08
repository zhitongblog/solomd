/**
 * useInbox — ⌘E / "Mark organized & advance" must save the file, because
 * inbox membership comes from the on-disk index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const writes: { path: string; content: string }[] = [];
const g = globalThis as unknown as Record<string, unknown>;
const listeners: Record<string, ((e: Event) => void)[]> = {};
g.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'write_file') writes.push({ path: args.path as string, content: args.content as string });
      return null;
    },
    transformCallback: () => 0,
  },
  addEventListener: (n: string, f: (e: Event) => void) => { (listeners[n] ??= []).push(f); },
  removeEventListener: () => {},
  dispatchEvent: (e: Event) => { for (const f of listeners[e.type] ?? []) f(e); return true; },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: { userAgent: 'node', platform: 'MacIntel' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
for (const k of ['localStorage', 'navigator', 'matchMedia']) {
  if (!(k in globalThis)) g[k] = (g.window as Record<string, unknown>)[k];
}

const { useTabsStore } = await import('../stores/tabs.ts');
const { useInbox, readInboxFlag } = await import('./useInbox.ts');

test('toggleActive and organizeAndAdvance write the flipped flag to disk', async () => {
  setActivePinia(createPinia());
  const tabs = useTabsStore();
  tabs.openFromDisk({
    filePath: '/vault/a.md',
    content: '---\ninbox: true\n---\nbody\n',
    encoding: 'UTF-8',
    language: 'markdown',
    hadBom: false,
  });
  const inbox = useInbox();

  await inbox.organizeAndAdvance();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/vault/a.md');
  assert.equal(readInboxFlag(writes[0].content), false);
  assert.equal(tabs.activeTab!.content, tabs.activeTab!.savedContent, 'tab is clean');

  inbox.toggleActive();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(writes.length, 2);
  assert.equal(readInboxFlag(writes[1].content), true);
});

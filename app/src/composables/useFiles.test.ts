import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const writes: { path: string; content: string }[] = [];
let fileExistsResult = false;
let confirmDialogResult = false;
let confirmCalls = 0;

const g = globalThis as unknown as Record<string, unknown>;
const listeners: Record<string, ((e: Event) => void)[]> = {};
g.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'fs_file_exists') return fileExistsResult;
      if (cmd.startsWith('plugin:dialog|')) {
        confirmCalls++;
        const btns = (args.buttons as { OkCancelCustom?: [string, string] } | undefined)?.OkCancelCustom;
        if (btns) return confirmDialogResult ? btns[0] : btns[1];
        return confirmDialogResult ? 'Ok' : 'Cancel';
      }
      if (cmd === 'write_file') {
        writes.push({ path: args.path as string, content: args.content as string });
      }
      return null;
    },
    transformCallback: () => 0,
  },
  addEventListener: (n: string, f: (e: Event) => void) => {
    (listeners[n] ??= []).push(f);
  },
  removeEventListener: () => {},
  dispatchEvent: (e: Event) => {
    for (const f of listeners[e.type] ?? []) f(e);
    return true;
  },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: { userAgent: 'node', platform: 'MacIntel' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
for (const k of ['localStorage', 'navigator', 'matchMedia']) {
  if (!(k in globalThis)) g[k] = (g.window as Record<string, unknown>)[k];
}
if (!('document' in globalThis)) {
  g.document = { documentElement: { lang: 'zh-CN', classList: { toggle() {} } } };
}

const { useTabsStore } = await import('../stores/tabs.ts');
const { useSettingsStore } = await import('../stores/settings.ts');
const { useFiles } = await import('./useFiles.ts');

test('confirmSaveMissingFile prompts before saving when original file no longer exists', async () => {
  setActivePinia(createPinia());
  const tabs = useTabsStore();
  const settings = useSettingsStore();
  const files = useFiles();

  const tab = tabs.openFromDisk({
    filePath: '/tmp/3rdparty-temp.md',
    content: '# Hello\n',
    encoding: 'UTF-8',
    language: 'markdown',
    hadBom: false,
  });
  tab.content = '# Updated\n';

  // 1. Default (confirmSaveMissingFile = false): saves directly without checking or prompting
  assert.equal(settings.confirmSaveMissingFile, false);
  fileExistsResult = false;
  confirmDialogResult = false;
  writes.length = 0;
  confirmCalls = 0;

  const okDefault = await files.saveTab(tab);
  assert.equal(okDefault, true);
  assert.equal(confirmCalls, 0);
  assert.equal(writes.length, 1);

  // 2. Enabled (confirmSaveMissingFile = true) + file missing + user cancels -> does not write
  settings.toggleConfirmSaveMissingFile();
  assert.equal(settings.confirmSaveMissingFile, true);
  tab.content = '# Updated 2\n';
  fileExistsResult = false;
  confirmDialogResult = false;
  writes.length = 0;
  confirmCalls = 0;

  const okCancelled = await files.saveTab(tab);
  assert.equal(okCancelled, false);
  assert.equal(confirmCalls, 1);
  assert.equal(writes.length, 0);

  // 3. Enabled + file missing + silent auto-save (e.g. blur) -> skips save without prompting
  const okSilent = await files.saveTab(tab, { silent: true });
  assert.equal(okSilent, false);
  assert.equal(confirmCalls, 1);
  assert.equal(writes.length, 0);

  // 4. Enabled + file missing + user confirms -> recreates and writes file
  confirmDialogResult = true;
  const okConfirmed = await files.saveTab(tab);
  assert.equal(okConfirmed, true);
  assert.equal(confirmCalls, 2);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/tmp/3rdparty-temp.md');
  assert.equal(writes[0].content, '# Updated 2\n');

  // 5. Enabled + file exists on disk -> saves directly without prompting
  tab.content = '# Updated 3\n';
  fileExistsResult = true;
  writes.length = 0;
  confirmCalls = 0;

  const okExisting = await files.saveTab(tab);
  assert.equal(okExisting, true);
  assert.equal(confirmCalls, 0);
  assert.equal(writes.length, 1);
});

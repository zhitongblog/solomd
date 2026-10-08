/**
 * D6 — the "System" theme: follows prefers-color-scheme live, setTheme
 * validates its input, and a bad persisted value is migrated on load.
 * Runs the real store under Pinia with a fake window / localStorage /
 * matchMedia.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let dark = false;
const listeners: Array<() => void> = [];
const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g.window = {
  matchMedia: (q: string) => ({
    get matches() {
      return q.includes('dark') ? dark : false;
    },
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  }),
  localStorage: g.localStorage,
};
if (!g.navigator) g.navigator = { userAgent: 'node', language: 'en-US', platform: 'MacIntel' };

const { createPinia, setActivePinia } = await import('pinia');
const { useSettingsStore } = await import('./settings');
const LS_KEY = 'solomd.settings.v1';

function flipOs(toDark: boolean) {
  dark = toDark;
  for (const fn of listeners) fn();
}
function fresh() {
  setActivePinia(createPinia());
  return useSettingsStore();
}

beforeEach(() => {
  store.clear();
  dark = false;
});

test('a new install follows the OS appearance, live', () => {
  dark = true;
  const s = fresh();
  assert.equal(s.followSystemTheme, true);
  assert.equal(s.theme, 'dark');
  flipOs(false);
  assert.equal(s.theme, 'light');
  flipOs(true);
  assert.equal(s.theme, 'dark');
});

test("setTheme('system') turns following on; an explicit theme turns it off", () => {
  store.set(LS_KEY, JSON.stringify({ theme: 'nord' }));
  const s = fresh();
  assert.equal(s.followSystemTheme, false, 'an existing blob keeps its explicit theme');
  assert.equal(s.theme, 'nord');
  dark = true;
  s.setTheme('system');
  assert.equal(s.followSystemTheme, true);
  assert.equal(s.theme, 'dark');
  assert.equal(JSON.parse(store.get(LS_KEY)!).followSystemTheme, true);
  s.setTheme('dracula');
  assert.equal(s.followSystemTheme, false);
  flipOs(false);
  assert.equal(s.theme, 'dracula', 'an explicit theme ignores the OS');
});

test('setTheme ignores a value that is not a theme', () => {
  store.set(LS_KEY, JSON.stringify({ theme: 'monokai' }));
  const s = fresh();
  s.setTheme('banana' as never);
  assert.equal(s.theme, 'monokai');
  assert.equal(JSON.parse(store.get(LS_KEY) ?? '{}').theme ?? 'monokai', 'monokai');
});

test("a persisted 'system' becomes the follow-OS option", () => {
  dark = true;
  store.set(LS_KEY, JSON.stringify({ theme: 'system' }));
  const s = fresh();
  assert.equal(s.followSystemTheme, true);
  assert.equal(s.theme, 'dark');
});

test('any other invalid persisted theme is reset to the default', () => {
  store.set(LS_KEY, JSON.stringify({ theme: 'neon-pink' }));
  const s = fresh();
  assert.equal(s.followSystemTheme, false);
  assert.equal(s.theme, 'light');
});

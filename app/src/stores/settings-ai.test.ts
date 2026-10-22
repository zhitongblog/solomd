import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerById } from '../lib/ai-providers';

const storage = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};
g.window = {
  localStorage: g.localStorage,
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
const { createPinia, setActivePinia } = await import('pinia');
const { useSettingsStore } = await import('./settings');

test('loading MiniMax settings keeps explicit M3, legacy and custom models', () => {
  for (const model of ['MiniMax-M3', 'MiniMax-M2.7', 'my-custom-model', '']) {
    storage.set('solomd.settings.v1', JSON.stringify({ aiProvider: 'minimax', aiModel: model }));
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    assert.equal(settings.aiModel, model);
    assert.equal(settings.aiProvider, 'minimax');
    assert.equal(settings.aiModel || providerById(settings.aiProvider)?.defaultModel,
      model || 'MiniMax-M3.1-Flash');
  }
});

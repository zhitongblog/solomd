import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerById } from './ai-providers.ts';

test('MiniMax offers Flash first and M3 without changing the wire format or endpoint', () => {
  const provider = providerById('minimax')!;
  assert.equal(provider.defaultModel, 'MiniMax-M3.1-Flash');
  assert.equal(provider.modelHint, 'MiniMax-M3.1-Flash · MiniMax-M3');
  assert.equal(provider.apiFormat, 'openai');
  assert.equal(provider.defaultBaseUrl, 'https://api.minimax.io/v1');
});

test('OpenCode Go retains its default and only advertises its verified MiniMax M3 route', () => {
  const provider = providerById('opencode-go')!;
  assert.equal(provider.defaultModel, 'deepseek-v4-flash');
  assert.equal(provider.defaultBaseUrl, 'https://opencode.ai/zen/go/v1');
  assert.deepEqual(provider.modelHint!.split(' · ').filter((id) => id.startsWith('minimax-')), ['minimax-m3']);
});

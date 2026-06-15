import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldAutoStartMarkdownCompletion } from './cm-markdown-completion.ts';

test('starts markdown completion for ASCII wikilinks, tags, and citations', () => {
  assert.equal(shouldAutoStartMarkdownCompletion('See [[Not', null), true);
  assert.equal(shouldAutoStartMarkdownCompletion('Meeting #todo', null), true);
  assert.equal(shouldAutoStartMarkdownCompletion('Paper @smith2024', null), true);
});

test('does not restart when completion is already active or pending', () => {
  assert.equal(shouldAutoStartMarkdownCompletion('#todo', 'active'), false);
  assert.equal(shouldAutoStartMarkdownCompletion('@smith', 'pending'), false);
});

test('does not auto-dispatch for bare triggers or mid-word tags', () => {
  assert.equal(shouldAutoStartMarkdownCompletion('[[', null), false);
  assert.equal(shouldAutoStartMarkdownCompletion('#', null), false);
  assert.equal(shouldAutoStartMarkdownCompletion('@', null), false);
  assert.equal(shouldAutoStartMarkdownCompletion('abc#tag', null), false);
});

test('does not auto-dispatch for CJK composition commits or punctuation', () => {
  assert.equal(shouldAutoStartMarkdownCompletion('中文', null), false);
  assert.equal(shouldAutoStartMarkdownCompletion('中文，', null), false);
  assert.equal(shouldAutoStartMarkdownCompletion('#中文', null), false);
  assert.equal(shouldAutoStartMarkdownCompletion('[[中文', null), false);
});

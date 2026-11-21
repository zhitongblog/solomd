import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown } from './markdown.ts';
import {
  ALL_TOOLBAR_ITEMS,
  DEFAULT_TOOLBAR_ITEMS,
  normalizeToolbarItems,
} from './toolbar-items.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('v5.3.3 issue fixes (#620, #622, #626, #628, #629, #630, #631)', () => {
  it('#626: preview renders YAML frontmatter with formatted dates, tag chips, booleans, and collapsible details', () => {
    const md = [
      '---',
      'title: SoloMD Guide',
      'date: 2026-11-21',
      'published: true',
      'tags:',
      '  - markdown',
      '  - yaml',
      'url: https://solomd.app',
      '---',
      '',
      '# Body',
    ].join('\n');
    const html = renderMarkdown(md);
    assert.match(html, /<details class="md-frontmatter" open>/);
    assert.match(html, /md-frontmatter-date[^>]*>2026-11-21</);
    assert.match(html, /md-frontmatter-chip[^>]*>markdown</);
    assert.match(html, /md-frontmatter-chip[^>]*>yaml</);
    assert.match(html, /md-frontmatter-bool--true/);
    assert.match(html, /href="https:\/\/solomd\.app"/);
  });

  it('#622: normalizeToolbarItems preserves valid unique order and falls back to defaults', () => {
    assert.deepEqual(normalizeToolbarItems(null), DEFAULT_TOOLBAR_ITEMS);
    assert.deepEqual(
      normalizeToolbarItems(['newFile', 'gitAdd', 'gitPull', 'gitPush', 'invalid', 'gitAdd']),
      ['newFile', 'gitAdd', 'gitPull', 'gitPush'],
    );
    const ids = new Set(ALL_TOOLBAR_ITEMS.map((i) => i.id));
    for (const def of DEFAULT_TOOLBAR_ITEMS) {
      assert.ok(ids.has(def), `default item ${def} must exist in registry`);
    }
  });

  it('#630 & #631: PaneTabBar has no data-tauri-drag-region and keeps calm neutral active tab with accent bottom bar', () => {
    const tabBar = fs.readFileSync(path.join(root, 'components/PaneTabBar.vue'), 'utf8');
    assert.doesNotMatch(tabBar, /:data-tauri-drag-region=/);
    assert.match(tabBar, /\.tab--active\s*\{[\s\S]*?background:\s*var\(--fill-1\)/);
    assert.match(tabBar, /\.tab--active::after\s*\{[\s\S]*?background:\s*var\(--accent\)/);
  });

  it('#628 & #629: FileTree guards refresh generation, keys recursive nodes, and exposes batch new files', () => {
    const tree = fs.readFileSync(path.join(root, 'components/FileTree.vue'), 'utf8');
    assert.match(tree, /let refreshGen = 0;/);
    assert.match(tree, /key:\s*c\.path/);
    assert.match(tree, /openBatchCreate\(/);
    assert.match(tree, /confirmBatchCreate/);
  });

  it('#635: highlight.js registers ahk (autohotkey), awk, bash, and lua grammars', async () => {
    const { createHljs } = await import('./hljs-setup.ts');
    const hljs = createHljs();
    for (const lang of ['ahk', 'autohotkey', 'awk', 'bash', 'lua']) {
      assert.ok(hljs.getLanguage(lang), `hljs must resolve ${lang}`);
    }
    const ahkOut = hljs.highlight('MsgBox, Hello\nreturn', { language: 'ahk' }).value;
    assert.match(ahkOut, /hljs-/);
    const awkOut = hljs.highlight('BEGIN { print $1 }', { language: 'awk' }).value;
    assert.match(awkOut, /hljs-/);
  });

  it('#634: AIRewriteOverlay persists up to 15 custom prompts with hover preview bubble', () => {
    const overlay = fs.readFileSync(path.join(root, 'components/AIRewriteOverlay.vue'), 'utf8');
    assert.match(overlay, /MAX_PROMPT_HISTORY\s*=\s*15/);
    assert.match(overlay, /ai-overlay__history-bubble/);
    assert.match(overlay, /recordPromptHistory/);
  });
});

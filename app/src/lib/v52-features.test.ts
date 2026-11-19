import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { buildDecorations } from './cm-live-render.ts';
import { parseHljsHtmlSpans } from './cm-hljs-fallback.ts';
import { buildStandaloneHtml, prepareHtmlNavSidebar } from './html-export.ts';
import { buildHtml2PdfOptions } from './pdf-export.ts';
import {
  STARTER_PLUGIN_PRESETS,
  applyUserTransformSync,
  formatDynamicTokens,
  getActiveUserSlashBlocks,
  getUserPlugins,
  saveUserPlugins,
} from './user-plugins.ts';

const sampleHtml = [
  '<h1>Project Overview</h1>',
  '<p>Intro paragraph.</p>',
  '<h2>Architecture</h2>',
  '<p>Details here.</p>',
].join('\n');

test('#572: prepareHtmlNavSidebar strips inline .md-toc when withTocPage is false and preserves/builds it when withTocPage is true', () => {
  const withoutToc = prepareHtmlNavSidebar(sampleHtml, 'Overview', false);
  assert.ok(withoutToc.navTreeHtml.includes('md-toc__list'));
  assert.ok(!withoutToc.body.includes('class="md-toc"'));

  const withToc = prepareHtmlNavSidebar(sampleHtml, 'Overview', true);
  assert.ok(withToc.navTreeHtml.includes('md-toc__list'));
  assert.ok(withToc.body.includes('class="md-toc"'));
  assert.ok(withToc.body.includes('href="#solomd-h-1"'));
  assert.ok(withToc.body.includes('href="#solomd-h-2"'));
});

test('#572: buildStandaloneHtml supports all combinations of withNav (bookmarks) and withTocPage (leading TOC)', async () => {
  const md = '# Project Overview\n\nIntro paragraph.\n\n## Architecture\n\nDetails here.';
  const both = await buildStandaloneHtml({
    title: 'Doc',
    content: md,
    customCss: '',
    withNav: true,
    withTocPage: true,
  });
  assert.ok(both.includes('has-solomd-nav'));
  assert.ok(both.includes('class="md-toc"'));

  const tocOnly = await buildStandaloneHtml({
    title: 'Doc',
    content: md,
    customCss: '',
    withNav: false,
    withTocPage: true,
  });
  assert.ok(!tocOnly.includes('has-solomd-nav'));
  assert.ok(tocOnly.includes('class="md-toc"'));

  const navOnly = await buildStandaloneHtml({
    title: 'Doc',
    content: md,
    customCss: '',
    withNav: true,
    withTocPage: false,
  });
  assert.ok(navOnly.includes('has-solomd-nav'));
  assert.ok(!navOnly.includes('<nav class="md-toc"'));
});

test('#303: buildDecorations keeps # and ** markers hidden on the active line when hideActiveLineMarkers is true and selection is collapsed', () => {
  const doc = '# Heading Title\n\nSome **bold** text.';
  const state = EditorState.create({
    doc,
    selection: { anchor: 2 },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 2000);
  const fakeView = {
    state,
    visibleRanges: [{ from: 0, to: doc.length }],
  } as any;

  const defaultDecos = buildDecorations(fakeView, false, false);
  let defaultReplacedOnLine1 = false;
  defaultDecos.between(0, 15, (from, to) => {
    if (from === 0 && to === 2) defaultReplacedOnLine1 = true;
  });
  assert.equal(defaultReplacedOnLine1, false);

  const pureDecos = buildDecorations(fakeView, false, true);
  let pureReplacedOnLine1 = false;
  pureDecos.between(0, 15, (from, to) => {
    if (from === 0 && to === 2) pureReplacedOnLine1 = true;
  });
  assert.equal(pureReplacedOnLine1, true);

  // #605 — Even when selecting a range of text across bold/heading syntax,
  // Pure WYSIWYG keeps # and ** hidden instead of flashing raw Markdown source.
  const rangeState = EditorState.create({
    doc,
    selection: { anchor: 0, head: doc.length },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(rangeState, doc.length, 2000);
  const rangeView = {
    state: rangeState,
    visibleRanges: [{ from: 0, to: doc.length }],
  } as any;
  const rangeDecos = buildDecorations(rangeView, false, true);
  let rangeHidHeading = false;
  let rangeHidBoldOpen = false;
  const boldIdx = doc.indexOf('**');
  rangeDecos.between(0, doc.length, (from, to) => {
    if (from === 0 && to === 2) rangeHidHeading = true;
    if (from === boldIdx && to === boldIdx + 2) rangeHidBoldOpen = true;
  });
  assert.equal(rangeHidHeading, true, 'expected # to stay hidden during range selection in Pure WYSIWYG');
  assert.equal(rangeHidBoldOpen, true, 'expected ** to stay hidden during range selection in Pure WYSIWYG');
});

test('#589: parseHljsHtmlSpans maps highlight.js HTML tokens (including escaped entities) to exact source offsets', async () => {
  const { createHljs } = await import('./hljs-setup');
  const hl = createHljs();
  const bashCode = 'echo "a < b & c > d" # comment\nif [ -f "$FILE" ]; then exit 0; fi';
  const html = hl.highlight(bashCode, { language: 'bash', ignoreIllegals: true }).value;
  const spans = parseHljsHtmlSpans(html, bashCode);
  assert.ok(spans.length >= 4, 'expected bash keywords, strings, variables, and comments to produce spans');
  const classes = new Set(spans.map((s) => s.cls));
  assert.ok(classes.has('hljs-built_in') || classes.has('hljs-keyword'));
  assert.ok(classes.has('hljs-string'));
  assert.ok(classes.has('hljs-comment'));
  const commentSpan = spans.find((s) => s.cls === 'hljs-comment')!;
  assert.equal(bashCode.slice(commentSpan.from, commentSpan.to), '# comment');
});

test('#173: user-plugins expands dynamic tokens, registers slash commands, and applies regex/template transforms', () => {
  const fixed = new Date(2026, 10, 14, 9, 5); // 2026-11-14 09:05
  assert.equal(
    formatDynamicTokens('Date: ${date}, Time: ${time}, Full: ${datetime}', fixed),
    'Date: 2026-11-14, Time: 09:05, Full: 2026-11-14 09:05',
  );

  saveUserPlugins(STARTER_PLUGIN_PRESETS);
  assert.equal(getUserPlugins().length, 2);
  const blocks = getActiveUserSlashBlocks();
  assert.ok(blocks.some((b) => b.id === 'note'));
  assert.ok(blocks.some((b) => b.id === 'meeting'));

  const regexOut = applyUserTransformSync(
    {
      id: 'fix-todo',
      title: 'Convert TODO: to task item',
      kind: 'regex',
      find: '^TODO:\\s*(.+)$',
      replace: '- [ ] $1 (${date})',
      flags: 'gm',
    },
    'TODO: Ship v5.2.0',
    {},
    fixed,
  );
  assert.equal(regexOut, '- [ ] Ship v5.2.0 (2026-11-14)');

  const tplOut = applyUserTransformSync(
    {
      id: 'wrap',
      title: 'Header',
      kind: 'template',
      template: '# ${title} (${date})\n\n${content}',
    },
    'Body text',
    { title: 'Release Notes' },
    fixed,
  );
  assert.equal(tplOut, '# Release Notes (2026-11-14)\n\nBody text');
});

test('#572: buildHtml2PdfOptions avoids splitting .md-toc__link rows while allowing nested li.md-toc__item trees to span multiple pages', () => {
  const opts = buildHtml2PdfOptions('Book');
  assert.ok(Array.isArray(opts.pagebreak?.avoid));
  assert.ok(opts.pagebreak.avoid.includes('li:not(.md-toc__item)'));
  assert.ok(opts.pagebreak.avoid.includes('.md-toc__link'));
  assert.ok(!opts.pagebreak.avoid.includes('li'));
});

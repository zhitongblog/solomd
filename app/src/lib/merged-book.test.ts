import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMergedBookMarkdown } from './merged-book';
import { renderMarkdown } from './markdown';

test('#562: buildMergedBookMarkdown builds hierarchical folder + note TOC up to note level 3 and falls back to baseName when H1 is absent', () => {
  const merged = buildMergedBookMarkdown('01 书籍名', [
    {
      relDir: '第1篇 篇名1',
      baseName: 'file_1-1',
      content: [
        '---',
        'title: ignored frontmatter',
        '---',
        '# 第1章：章名1',
        '',
        '## 第1节：节名1',
        '',
        '### 第1.1小节：小节名1.1',
        '',
        '#### 四级标题不进目录',
        '',
        '![示意图](./assets/pic1.png)',
        '',
        '## 第2节：节名2',
      ].join('\n'),
    },
    {
      relDir: '第1篇 篇名1',
      baseName: 'file_1-2',
      content: '正文没有一级标题，使用文件名作为章名。\n\n## 内部二级标题',
    },
    {
      relDir: '第2篇 篇名2',
      baseName: 'file_2-1',
      content: '# 第4章：章名4\n\n正文内容',
    },
  ]);

  // Verify subfolder relative image was rewritten relative to the root export folder
  assert.match(merged, /!\[示意图\]\(第1篇 篇名1\/assets\/pic1\.png\)/);
  // Verify 4th-level heading inside the note was converted to bold text rather than a TOC heading
  assert.match(merged, /\*\*四级标题不进目录\*\*/);
  assert.doesNotMatch(merged, /^#{4,}\s+四级标题不进目录/m);

  const html = renderMarkdown(merged);
  // Extract the rendered <nav class="md-toc">...</nav>
  const tocMatch = /<nav class="md-toc"[\s\S]*?<\/nav>/.exec(html);
  assert.ok(tocMatch, 'expected [TOC] to render <nav class="md-toc">');
  const tocHtml = tocMatch[0];

  // 1) All expected TOC items are present, and 4th-level note heading is excluded
  assert.ok(tocHtml.includes('01 书籍名'));
  assert.ok(tocHtml.includes('第1篇 篇名1'));
  assert.ok(tocHtml.includes('第1章：章名1'));
  assert.ok(tocHtml.includes('第1节：节名1'));
  assert.ok(tocHtml.includes('第1.1小节：小节名1.1'));
  assert.ok(tocHtml.includes('第2节：节名2'));
  assert.ok(tocHtml.includes('file_1-2'), 'note without H1 should fall back to baseName');
  assert.ok(tocHtml.includes('内部二级标题'));
  assert.ok(tocHtml.includes('第2篇 篇名2'));
  assert.ok(tocHtml.includes('第4章：章名4'));
  assert.ok(!tocHtml.includes('四级标题不进目录'), 'note H4 must not appear in TOC');

  // 2) Folder TOC nodes point directly to the first note's first effective heading anchor
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  const links = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(tocHtml)) !== null) {
    links.set(m[2].trim(), m[1]);
  }
  assert.equal(
    links.get('第1篇 篇名1'),
    links.get('第1章：章名1'),
    'folder node 第1篇 篇名1 should jump to its first note heading 第1章：章名1',
  );
  assert.equal(
    links.get('第2篇 篇名2'),
    links.get('第4章：章名4'),
    'folder node 第2篇 篇名2 should jump to its first note heading 第4章：章名4',
  );
});

test('#562: multi-level nested folders all appear in TOC and all jump to the first note heading under them', () => {
  const merged = buildMergedBookMarkdown('01 书籍名', [
    {
      relDir: '第一部分/第1篇/A组',
      baseName: 'note_a',
      content: '# 第一章\n\n## 第一节\n\n### 1.1 小节',
    },
  ]);
  const html = renderMarkdown(merged);
  const tocMatch = /<nav class="md-toc"[\s\S]*?<\/nav>/.exec(html);
  assert.ok(tocMatch);
  const tocHtml = tocMatch[0];

  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  const links = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(tocHtml)) !== null) {
    links.set(m[2].trim(), m[1]);
  }

  const firstNoteHref = links.get('第一章');
  assert.ok(firstNoteHref);
  assert.equal(links.get('第一部分'), firstNoteHref);
  assert.equal(links.get('第1篇'), firstNoteHref);
  assert.equal(links.get('A组'), firstNoteHref);
  assert.ok(links.has('第一节'));
  assert.ok(links.has('1.1 小节'));
});

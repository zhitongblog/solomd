import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMergedBookMarkdown } from './merged-book';
import { renderMarkdown } from './markdown';
import { buildStandaloneHtml } from './html-export';
import { SOLOMD_EPUB_CSS } from './epub-style';

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

  // 2) #575: Folder TOC nodes keep their own distinct anchor IDs and jump to each folder's own heading
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  const links = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(tocHtml)) !== null) {
    links.set(m[2].trim(), m[1]);
  }
  const folder1Href = links.get('第1篇 篇名1');
  const note1Href = links.get('第1章：章名1');
  const folder2Href = links.get('第2篇 篇名2');
  const note2Href = links.get('第4章：章名4');
  assert.ok(folder1Href && note1Href);
  assert.ok(folder2Href && note2Href);
  assert.notEqual(
    folder1Href,
    note1Href,
    'folder node 第1篇 篇名1 should keep its own anchor separate from note heading 第1章：章名1',
  );
  assert.notEqual(
    folder2Href,
    note2Href,
    'folder node 第2篇 篇名2 should keep its own anchor separate from note heading 第4章：章名4',
  );
  assert.ok(html.includes(`id="${decodeURIComponent(folder1Href.slice(1))}"`));
  assert.ok(html.includes(`id="${decodeURIComponent(folder2Href.slice(1))}"`));
});

test('#575: multi-level nested folders all appear in TOC and each jumps to its own distinct folder heading', () => {
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
  const p1Href = links.get('第一部分');
  const p2Href = links.get('第1篇');
  const p3Href = links.get('A组');
  assert.ok(firstNoteHref && p1Href && p2Href && p3Href);
  assert.equal(new Set([p1Href, p2Href, p3Href, firstNoteHref]).size, 4);
  assert.ok(html.includes(`id="${decodeURIComponent(p1Href.slice(1))}"`));
  assert.ok(html.includes(`id="${decodeURIComponent(p2Href.slice(1))}"`));
  assert.ok(html.includes(`id="${decodeURIComponent(p3Href.slice(1))}"`));
  assert.ok(links.has('第一节'));
  assert.ok(links.has('1.1 小节'));
});

test('#568 & #570: merged HTML export embeds subfolder PNG/GIF images as base64 and builds navigation + search sidebar when withNav is enabled', async () => {
  const merged = buildMergedBookMarkdown('01 书籍名', [
    {
      relDir: '01 测试文件夹/01 书籍名/第3篇 篇名3',
      baseName: 'file_3-5',
      content: [
        '# 第3章 测试章节',
        '',
        '### 1.3.5 来个图片',
        '',
        '![截图](./assets/shot(1).png)',
        '',
        '### 1.3.6 来个动图',
        '',
        '![动图](assets/anim.gif)',
        '',
        '<img src="assets/inline-demo.gif" width="320" />',
      ].join('\n'),
    },
  ]);

  const fakeFiles = new Map<string, Uint8Array>([
    ['D:/Vault/01 测试文件夹/01 书籍名/第3篇 篇名3/assets/shot(1).png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ['D:/Vault/01 测试文件夹/01 书籍名/第3篇 篇名3/assets/anim.gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
    ['D:/Vault/01 测试文件夹/01 书籍名/第3篇 篇名3/assets/inline-demo.gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])],
  ]);

  const html = await buildStandaloneHtml({
    content: merged,
    title: '01 书籍名',
    filePath: 'D:\\Vault\\01 书籍名.md',
    readBytes: async (p) => fakeFiles.get(p) ?? null,
    withNav: true,
    lang: 'zh',
  });

  // 1) All 3 subfolder images (including spaced folder path, parens in filename, and HTML <img>) are base64-inlined
  assert.match(html, /src="data:image\/png;base64,iVBORw=="|src="data:image\/png;base64,iVBORw0KGgo=/);
  assert.equal((html.match(/data:image\/gif;base64,/g) || []).length, 2);

  // 2) Navigation & Global Search multi-tab sidebar is present (#570)
  assert.ok(html.includes('data-tab="nav"'), 'expected Navigation tab');
  assert.ok(html.includes('导航栏'));
  assert.ok(html.includes('data-tab="search"'), 'expected Global Search tab');
  assert.ok(html.includes('全局搜索'));
  assert.ok(html.includes('id="solomd-search-input"'));
  assert.ok(html.includes('id="solomd-search-clear"'));
  assert.ok(html.includes('id="solomd-nav-pane"'));
  assert.ok(html.includes('1.3.5 来个图片'));
  assert.ok(html.includes('1.3.6 来个动图'));
});

test('#570: single-note standalone HTML export without [TOC] builds hierarchical bookmark tree in sidebar when withNav is true', async () => {
  const html = await buildStandaloneHtml({
    content: '# 第一章 总览\n\n正文段落一\n\n## 1.1 安装说明\n\n正文段落二',
    title: '用户手册',
    withNav: true,
    lang: 'zh',
  });
  assert.ok(html.includes('id="solomd-nav-pane"'));
  assert.ok(html.includes('第一章 总览'));
  assert.ok(html.includes('1.1 安装说明'));
  assert.ok(html.includes('id="solomd-search-input"'));
});

test('#594 & #598: merged paginated HTML with TOC page has dedicated #solomd-page-toc without standalone H1 cover page, and renders < 上一主题 / 下一主题 > topic nav buttons', async () => {
  const merged = buildMergedBookMarkdown(
    'Kubernetes 指南',
    [
      { relDir: '', baseName: '01-intro', content: '# 1 简介\n\n第一节内容' },
      { relDir: '', baseName: '02-install', content: '# 2 安装\n\n第二节内容' },
    ],
    { includeRootHeading: true },
  );

  const htmlWithToc = await buildStandaloneHtml({
    content: merged,
    title: 'Kubernetes 指南',
    withNav: true,
    paginated: true,
    withTocPage: true,
    topicNav: true,
    lang: 'zh',
  });

  // Dedicated TOC section exists and does NOT contain a duplicate root <h1>
  assert.match(htmlWithToc, /id="solomd-page-toc"/);
  assert.doesNotMatch(htmlWithToc, /data-book-root="1"/);
  // Root bookmark in sidebar points to #solomd-page-toc
  assert.match(htmlWithToc, /href="#solomd-page-toc"[^>]*>Kubernetes 指南<\/a>/);
  // Topic nav buttons (< 上一主题 / 下一主题 >) are rendered at top and bottom
  assert.ok(htmlWithToc.includes('<div class="solomd-topic-nav solomd-topic-nav--top"'));
  assert.ok(htmlWithToc.includes('<div class="solomd-topic-nav solomd-topic-nav--bottom"'));
  assert.ok(htmlWithToc.includes('上一主题'));
  assert.ok(htmlWithToc.includes('下一主题'));

  // Without TOC page, root bookmark points directly to first note (#solomd-page-1)
  const htmlNoToc = await buildStandaloneHtml({
    content: merged,
    title: 'Kubernetes 指南',
    withNav: true,
    paginated: true,
    withTocPage: false,
    topicNav: false,
    lang: 'zh',
  });
  assert.doesNotMatch(htmlNoToc, /id="solomd-page-toc"/);
  assert.match(htmlNoToc, /href="#solomd-page-1"[^>]*>Kubernetes 指南<\/a>/);
  assert.ok(!htmlNoToc.includes('<div class="solomd-topic-nav solomd-topic-nav--top"'));
});

test('#597: buildMergedBookMarkdown with includeRootHeading: false omits root folder H1 and promotes chapters to level 1', () => {
  const merged = buildMergedBookMarkdown(
    '技术合集',
    [
      { relDir: '', baseName: 'ch1', content: '# 第一章\n\n## 1.1 节' },
      { relDir: '附录', baseName: 'app1', content: '# 附录 A' },
    ],
    { includeRootHeading: false },
  );
  assert.doesNotMatch(merged, /^#\s+技术合集/m);
  assert.match(merged, /^# 第一章$/m);
  assert.match(merged, /^## 1\.1 节$/m);
  assert.match(merged, /^# 附录/m);
  assert.match(merged, /^## 附录 A$/m);
});

test('#596: EPUB stylesheet suppresses automatic decimal list markers in TOC', () => {
  assert.match(SOLOMD_EPUB_CSS, /nav#toc ol[\s\S]*?list-style-type:\s*none\s*!important/);
  assert.match(SOLOMD_EPUB_CSS, /nav#toc li[\s\S]*?list-style-type:\s*none\s*!important/);
});

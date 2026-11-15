import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMergedBookMarkdown } from './merged-book';
import { buildStandaloneHtml } from './html-export';
import {
  resolveRenamedExportPath,
  suggestNumberedExportPath,
  validateHtmlContentWidth,
} from './export-overwrite';
import { renderMermaidFencesInMarkdown } from './diagram-export';
import { SOLOMD_EPUB_CSS } from './epub-style';

test('#574 & #584: standalone HTML export supports paginated <section class="page">, empty subfolder sections, resizable nav toolbar, and custom contentWidth', async () => {
  const merged = buildMergedBookMarkdown('01 书籍名', [
    {
      relDir: '第1篇',
      baseName: 'note1',
      content: '# 第一章\n\n第一页正文内容',
    },
    {
      relDir: '第1篇',
      baseName: 'note2',
      content: '# 第二章\n\n第二页正文内容',
    },
    {
      relDir: '第2篇/空目录',
      baseName: '',
      content: '',
      emptyDir: true,
    },
  ]);

  const html = await buildStandaloneHtml({
    content: merged,
    title: '01 书籍名',
    withNav: true,
    paginated: true,
    contentWidth: 1120,
    lang: 'zh',
  });

  // Paginated sections are created and hidden initially (`style="display:none"`), revealed by JS
  const sectionMatches = html.match(/<section class="page" id="solomd-page-\d+" style="display:none">/g) || [];
  assert.ok(
    sectionMatches.length >= 3,
    `expected at least 3 paginated sections (including empty subfolder), got ${sectionMatches.length}`,
  );
  assert.ok(html.includes('空目录'), 'empty subfolder must appear in merged HTML navigation & section');

  // Resizer handle + expand/collapse buttons + blue active selection style (#574)
  assert.ok(html.includes('id="solomd-sidebar-resizer"'));
  assert.ok(html.includes('id="solomd-nav-expand-btn"'));
  assert.ok(html.includes('id="solomd-nav-collapse-btn"'));
  assert.ok(html.includes('#2563EB') || html.includes('#2563eb'));

  // Custom content width CSS variable (#584)
  assert.ok(html.includes('--solomd-content-max-width: 1120px'));

  // Full unlimited width when contentWidth is 0 (#584)
  const fullWidthHtml = await buildStandaloneHtml({
    content: '# Title\n\nBody',
    title: 'FullWidth',
    withNav: true,
    contentWidth: 0,
    lang: 'zh',
  });
  assert.ok(fullWidthHtml.includes('--solomd-content-max-width: none'));
});

test('#581: suggestNumberedExportPath & resolveRenamedExportPath handle Windows/POSIX paths, auto-increment (1)/(2), and empty filename guard', async () => {
  const existing = new Set<string>([
    'D:\\Exports\\01 书籍名.pdf',
    'D:\\Exports\\01 书籍名(1).pdf',
  ]);
  const suggestion = await suggestNumberedExportPath('D:\\Exports\\01 书籍名.pdf', (p) =>
    existing.has(p),
  );
  assert.equal(suggestion.fileName, '01 书籍名(2).pdf');
  assert.equal(suggestion.path, 'D:\\Exports\\01 书籍名(2).pdf');

  // Blank filename is rejected (`null`)
  assert.equal(resolveRenamedExportPath('D:\\Exports\\01 书籍名.pdf', '   '), null);
  // Filename without extension preserves `.pdf`
  assert.equal(
    resolveRenamedExportPath('D:\\Exports\\01 书籍名.pdf', '新文件名'),
    'D:\\Exports\\新文件名.pdf',
  );
  // Explicit extension is preserved
  assert.equal(
    resolveRenamedExportPath('/Users/demo/book.html', 'book(1).html'),
    '/Users/demo/book(1).html',
  );
});

test('#584: validateHtmlContentWidth accepts 0 (unlimited) and normal widths, warns on 1..699 and > screenWidth', () => {
  assert.equal(validateHtmlContentWidth(0, 1920, true), '');
  assert.equal(validateHtmlContentWidth(960, 1920, true), '');
  assert.equal(validateHtmlContentWidth(1920, 1920, true), '');
  assert.equal(validateHtmlContentWidth(1, 1920, true), '取值过小，会影响显示效果');
  assert.equal(validateHtmlContentWidth(699, 1920, true), '取值过小，会影响显示效果');
  assert.equal(validateHtmlContentWidth(700, 1920, true), '');
  assert.equal(validateHtmlContentWidth(2560, 1920, true), '取值范围过大');
});

test('#578, #579, #583: renderMermaidFencesInMarkdown embeds PNG data URIs and SOLOMD_EPUB_CSS styles code/pre/table for Pandoc EPUB', async () => {
  // 1x1 transparent PNG bytes
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const md = [
    '# EPUB 导出质量测试',
    '',
    '行内代码 `const x = 42` 应有底纹。',
    '',
    '```ts',
    'export function greet(name: string) {',
    '  return `Hello, ${name}`;',
    '}',
    '```',
    '',
    '```mermaid',
    'graph LR',
    '  A[开始] --> B[结束]',
    '```',
    '',
    '| 列1 | 列2 |',
    '| --- | --- |',
    '| 数据A | 数据B |',
  ].join('\n');

  const transformed = await renderMermaidFencesInMarkdown(md, async (src) => {
    assert.match(src, /graph LR/);
    return { data: new Uint8Array(png1x1), width: 120, height: 60 };
  });

  // Mermaid fence became embedded PNG data URI, while TypeScript code fence remained intact
  assert.doesNotMatch(transformed, /```mermaid/);
  assert.match(transformed, /!\[\]\(data:image\/png;base64,iVBORw0KGgo/);
  assert.match(transformed, /```ts/);

  // EPUB stylesheet covers inline code, code blocks, and tables (#579, #583)
  assert.match(SOLOMD_EPUB_CSS, /\bcode\s*\{[\s\S]*?background-color:/);
  assert.match(SOLOMD_EPUB_CSS, /div\.sourceCode[\s\S]*?background-color:/);
  assert.match(SOLOMD_EPUB_CSS, /\btable\s*\{[\s\S]*?border-collapse:\s*collapse/);
  assert.match(SOLOMD_EPUB_CSS, /\bth,\s*\ntd\s*\{[\s\S]*?border:/);

  // End-to-end smoke test with local Pandoc when available
  const pandocBin = ['/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc'].find((p) => existsSync(p));
  if (pandocBin) {
    const tmp = mkdtempSync(join(tmpdir(), 'solomd-epub-test-'));
    try {
      const mdPath = join(tmp, 'input.md');
      const cssPath = join(tmp, 'epub.css');
      const epubPath = join(tmp, 'output.epub');
      writeFileSync(mdPath, transformed, 'utf8');
      writeFileSync(cssPath, SOLOMD_EPUB_CSS, 'utf8');
      execFileSync(pandocBin, [mdPath, '-f', 'markdown', '-t', 'epub', `--css=${cssPath}`, '-o', epubPath]);
      assert.ok(existsSync(epubPath), 'Pandoc produced output.epub');
      const zipEntries = execFileSync('unzip', ['-l', epubPath], { encoding: 'utf8' });
      assert.match(zipEntries, /EPUB\/media\/.*\.png/, 'Mermaid PNG embedded inside EPUB/media/');
      assert.match(zipEntries, /\.css/, 'Custom EPUB CSS embedded inside EPUB archive');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('#585: buildMergedBookMarkdown continuously renumbers hierarchical section numbers across multiple notes without touching years or count phrases', async () => {
  const merged = buildMergedBookMarkdown('产品技术手册', [
    {
      relDir: '',
      baseName: 'preface',
      content: '# 前言\n\n本手册面向研发团队。',
    },
    {
      relDir: '第1篇 基础',
      baseName: 'ch1',
      content: [
        '# 1 环境准备',
        '## 1.1 系统要求',
        '### 1.1.1 硬件要求',
        '### 1.1.2 软件要求',
        '# 2 核心概念',
        '## 2.1 数据模型',
        '### 2.1.1 实体定义',
      ].join('\n'),
    },
    {
      relDir: '第2篇 进阶',
      baseName: 'ch2',
      content: [
        '# 1 实战指南',
        '## 1.1 接口联调',
        '### 1.1.1 鉴权流程',
        '### 1.1.2 错误码处理',
        '#### 1.1.2.1 重试策略',
      ].join('\n'),
    },
    {
      relDir: '第2篇 进阶',
      baseName: 'ch3',
      content: [
        '# 1. 运维部署',
        '## 1.1 容器化部署',
        '# 2026 年度演进路线',
        '# 10 个高频排障技巧',
      ].join('\n'),
    },
  ]);

  const html = await buildStandaloneHtml({
    content: merged,
    title: '产品技术手册',
    withNav: true,
    lang: 'zh',
  });

  // Unnumbered preface stays unnumbered
  assert.ok(html.includes('前言'));
  // File 1 keeps chapters 1 and 2
  assert.ok(html.includes('1 环境准备'));
  assert.ok(html.includes('1.1 系统要求'));
  assert.ok(html.includes('1.1.1 硬件要求'));
  assert.ok(html.includes('1.1.2 软件要求'));
  assert.ok(html.includes('2 核心概念'));
  assert.ok(html.includes('2.1 数据模型'));
  assert.ok(html.includes('2.1.1 实体定义'));

  // File 2 (originally 1 / 1.1 / 1.1.1 / 1.1.2 / 1.1.2.1) continuously renumbers to 3.*
  assert.ok(html.includes('3 实战指南'));
  assert.ok(html.includes('3.1 接口联调'));
  assert.ok(html.includes('3.1.1 鉴权流程'));
  assert.ok(html.includes('3.1.2 错误码处理'));
  assert.ok(html.includes('3.1.2.1 重试策略'));
  assert.ok(!html.includes('1 实战指南'));
  assert.ok(!html.includes('1.1 接口联调'));

  // File 3 (dot style `1. `) continuously renumbers to `4. ` / `4.1`, while 4-digit years and CJK count phrases stay untouched
  assert.ok(html.includes('4. 运维部署'));
  assert.ok(html.includes('4.1 容器化部署'));
  assert.ok(html.includes('2026 年度演进路线'));
  assert.ok(html.includes('10 个高频排障技巧'));
});

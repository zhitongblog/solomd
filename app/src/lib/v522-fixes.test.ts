import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { unzipSync, strFromU8 } from 'fflate';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { SearchQuery, search, setSearchQuery } from '@codemirror/search';

import { populatePdfOutline } from './pdf-export.ts';
import { buildPandocFromArg, prepareMarkdownForPandoc } from './pandoc-markdown.ts';
import { buildMergedBookMarkdown } from './merged-book.ts';
import { markdownToDocxBlob } from './docx-export.ts';
import { replaceCurrent } from './cm-find-panel.ts';

test('#590: populatePdfOutline produces a valid complete PDF with /Outlines, xref, trailer, and %%EOF on multi-page jsPDF documents', async () => {
  const reqFromApp = createRequire(import.meta.url);
  const reqFromHtml2Pdf = createRequire(reqFromApp.resolve('html2pdf.js'));
  const { jsPDF } = reqFromHtml2Pdf('jspdf');
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  pdf.text('Page 1 Title', 15, 20);
  pdf.addPage();
  pdf.text('Page 2 Chapter', 15, 30);
  pdf.addPage();
  pdf.text('Page 3 Subsection', 15, 50);

  populatePdfOutline(pdf.outline, [
    { level: 1, text: '01 书籍名', pageNumber: 1, topMm: 15 },
    { level: 2, text: '第1章 春日絮语', pageNumber: 2, topMm: 25 },
    { level: 3, text: '1.1 静夜思', pageNumber: 3, topMm: 45 },
  ]);

  const rawPdf: string = pdf.output();
  assert.ok(rawPdf.startsWith('%PDF-'), 'PDF must begin with %PDF- header');
  assert.ok(rawPdf.includes('/Type /Outlines'), 'PDF must include /Outlines dictionary');
  assert.ok(rawPdf.includes('/Type /Catalog'), 'PDF must include /Catalog dictionary');
  assert.ok(rawPdf.includes('\nxref\n'), 'PDF must include xref table');
  assert.ok(rawPdf.includes('\ntrailer\n'), 'PDF must include trailer dictionary');
  assert.ok(rawPdf.trimEnd().endsWith('%%EOF'), 'PDF must terminate cleanly with %%EOF');
});

test('#591: prepareMarkdownForPandoc + buildPandocFromArg prevent --- disclaimers from turning into narrow 6%-width multiline tables', () => {
  const merged = buildMergedBookMarkdown('01 书籍名', [
    {
      relDir: '第10章',
      baseName: 'note1',
      content: [
        '# 抒怀篇',
        '',
        '正文段落内容。',
        '',
        '---',
        '作者声明：本文用于记录和分享作者的学习心得，可能有部分文字或示例来自AI平台，如：**DeepSeek**[链接](https://example.com)等。',
        'Copyright © 2022~2026 All rights reserved.',
      ].join('\n'),
    },
    {
      relDir: '第10章',
      baseName: 'note2',
      content: '# 下一节\n\n后续内容。',
    },
  ]);

  const prepared = prepareMarkdownForPandoc(merged);
  const fromArg = buildPandocFromArg(true);
  assert.equal(
    fromArg,
    '--from=markdown-multiline_tables-simple_tables-grid_tables+hard_line_breaks',
  );
  assert.doesNotMatch(prepared, /solomd-page-break/);
  assert.doesNotMatch(prepared, /\[TOC\]/i);

  const pandocBin = ['/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc'].find((p) =>
    existsSync(p),
  );
  if (pandocBin) {
    const html = execFileSync(pandocBin, [fromArg, '-t', 'html'], {
      input: prepared,
      encoding: 'utf8',
    });
    assert.doesNotMatch(html, /<table/i, '--- disclaimer must NOT be parsed as a narrow <table>');
    assert.match(html, /<hr\s*\/?>/i, '--- must render as a normal <hr> thematic break');
    assert.match(html, /作者声明：本文用于记录和分享作者的学习心得/);
  }
});

test('#592 & #593: markdownToDocxBlob left-aligns body paragraphs, prevents Shift+Enter justification stretch, and pre-populates clickable TOC entries', async () => {
  const merged = buildMergedBookMarkdown('01 书籍名', [
    {
      relDir: '第1篇 篇名1/1. 第1章',
      baseName: 'poem1',
      content: [
        '# 1.1 《春晓》 - 孟浩然',
        '',
        '春眠不觉晓，处处闻啼鸟。  ',
        '夜来风雨声，花落知多少。',
      ].join('\n'),
    },
    {
      relDir: '第1篇 篇名1/1. 第1章',
      baseName: 'poem2',
      content: [
        '# 1.2 《登鹳雀楼》 - 王之涣',
        '',
        '白日依山尽，黄河入海流。  ',
        '欲穷千里目，更上一层楼。',
      ].join('\n'),
    },
  ]);

  const blob = await markdownToDocxBlob(
    merged,
    '01 书籍名',
    undefined,
    'plain',
    '目录',
    null,
    null,
    true,
  );
  const parts = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const docXml = strFromU8(parts['word/document.xml']);
  const settingsXml = strFromU8(parts['word/settings.xml']);
  const stylesXml = strFromU8(parts['word/styles.xml']);

  // #592 — Left alignment + doNotExpandShiftReturn
  assert.ok(
    stylesXml.includes('<w:jc w:val="left"/>'),
    'Document default paragraph style must explicitly specify left alignment',
  );
  assert.ok(
    settingsXml.includes('<w:doNotExpandShiftReturn/>'),
    'word/settings.xml must set doNotExpandShiftReturn so <w:br/> lines never stretch',
  );

  // #593 — Populated TOC field + updateFields + heading bookmarks
  assert.ok(
    settingsXml.includes('<w:updateFields'),
    'word/settings.xml must request field update when TOC is enabled',
  );
  assert.ok(
    docXml.includes('TOC \\h \\o &quot;1-6&quot;'),
    'TOC field must cover heading levels 1-6 for nested folder books',
  );
  assert.match(
    docXml,
    /<w:hyperlink w:history="1" w:anchor="_TocSolomd_\d+">[\s\S]*?《春晓》 - 孟浩然/,
    'TOC <w:sdtContent> must contain pre-populated clickable hyperlink entries for WPS/Word',
  );
  assert.match(
    docXml,
    /<w:bookmarkStart w:name="_TocSolomd_\d+"/,
    'Body headings must carry matching _TocSolomd_N bookmark anchors',
  );
  assert.doesNotMatch(
    docXml,
    /solomd-toc-|solomd-page-break/,
    'Internal SoloMD HTML markers must not leak into DOCX text',
  );
});

test('replaceCurrent advances past zero-length regexp matches instead of looping on line 1', () => {
  let state = EditorState.create({
    doc: 'one\ntwo',
    extensions: [search()],
    selection: { anchor: 0 },
  });
  state = state.update({
    effects: setSearchQuery.of(
      new SearchQuery({ search: '^', replace: '> ', regexp: true }),
    ),
  }).state;
  const view = {
    get state() {
      return state;
    },
    dispatch(...specs: TransactionSpec[]) {
      state = state.update(...specs).state;
    },
  } as unknown as import('@codemirror/view').EditorView;

  assert.equal(replaceCurrent(view), true);
  assert.equal(state.doc.toString(), '> one\ntwo');
  assert.equal(replaceCurrent(view), true);
  assert.equal(state.doc.toString(), '> one\n> two');
});

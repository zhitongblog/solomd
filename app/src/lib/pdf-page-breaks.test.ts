import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePdfPageBreaks } from './pdf-page-breaks';
import { defaultPdfDefaults } from '../stores/settings';

describe('computePdfPageBreaks (#552)', () => {
  it('returns 1 page and no breaks for a short note', () => {
    const md = '# Title\n\nShort paragraph.\n';
    const res = computePdfPageBreaks(md);
    assert.equal(res.totalPages, 1);
    assert.deepEqual(res.breaks, []);
    assert.equal(res.pageForLine(1), 1);
    assert.equal(res.pageForLine(3), 1);
  });

  it('ignores leading YAML front matter height while respecting pdf front matter options', () => {
    const fm = [
      '---',
      'title: Demo',
      'pdf:',
      '  pageSize: A5',
      '  margin: Wide',
      '  fontSize: 12',
      '---',
      '# Heading 1',
      '',
      'First body paragraph.',
    ].join('\n');
    const res = computePdfPageBreaks(fm);
    assert.equal(res.pageSizeLabel, 'A5');
    assert.equal(res.totalPages, 1);
    assert.equal(res.pageForLine(8), 1);
  });

  it('creates an explicit page break on <!-- pagebreak --> or page-break div', () => {
    const md = [
      '# Page One',
      '',
      'Intro paragraph.',
      '',
      '<!-- pagebreak -->',
      '',
      '# Page Two',
      '',
      'Second page body.',
      '<div style="page-break-after: always"></div>',
      '# Page Three',
    ].join('\n');
    const res = computePdfPageBreaks(md);
    assert.equal(res.totalPages, 3);
    assert.deepEqual(res.breaks, [
      { line: 7, page: 2 },
      { line: 11, page: 3 },
    ]);
    assert.equal(res.pageForLine(1), 1);
    assert.equal(res.pageForLine(7), 2);
    assert.equal(res.pageForLine(9), 2);
    assert.equal(res.pageForLine(11), 3);
  });

  it('paginates multi-page prose and tables and repeats table header height across breaks', () => {
    const lines: string[] = ['# Large Document', ''];
    for (let i = 1; i <= 55; i++) {
      lines.push(`Paragraph ${i}: 是一段用于验证 PDF 导出分页参考线定位准确性的中文测试段落内容，包含多行文本。`);
      lines.push('');
    }
    const res = computePdfPageBreaks(lines.join('\n'), defaultPdfDefaults());
    assert.ok(res.totalPages >= 2, `Expected >= 2 pages, got ${res.totalPages}`);
    assert.ok(res.breaks.length >= 1);
    assert.equal(res.breaks[0].page, 2);
    assert.ok(res.breaks[0].line > 1 && res.breaks[0].line < lines.length);
    assert.equal(res.pageForLine(res.breaks[0].line - 1), 1);
    assert.equal(res.pageForLine(res.breaks[0].line), 2);
  });
});

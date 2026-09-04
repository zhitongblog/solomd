/**
 * Unit tests for DOCX template resolution.
 *
 * Run from `app/`:  node src/lib/docx-template.selftest.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOCX_PRESETS,
  parseDocxFrontMatter,
  resolveDocxTemplate,
  firstHeading,
  renderHeaderText,
} from './docx-template';

test('plain is what the exporter did before templates existed', () => {
  const t = resolveDocxTemplate('plain', '# Hi\n');
  assert.equal(t.cover, false);
  assert.equal(t.toc, false);
  assert.equal(t.header, '');
  assert.equal(t.pageNumbers, false);
  assert.equal(t.fontFamily, '');
});

test('report and academic differ where it matters', () => {
  const r = DOCX_PRESETS.report;
  const a = DOCX_PRESETS.academic;
  assert.equal(r.header, '{title}');
  assert.equal(a.header, '');
  assert.equal(a.lineSpacing, 2);
  assert.ok(r.cover && r.toc && a.cover && a.toc);
});

test('a docx: block overrides individual keys and leaves the rest', () => {
  const src = ['---', 'docx:', '  cover: false', '  fontSize: 14', '---', '', '# Doc'].join('\n');
  const t = resolveDocxTemplate('report', src);
  assert.equal(t.cover, false);       // overridden
  assert.equal(t.fontSizePt, 14);     // overridden
  assert.equal(t.toc, true);          // still the report preset
  assert.equal(t.pageNumbers, true);
});

test('the block can switch preset, and other keys apply on top of the new one', () => {
  const src = ['---', 'docx:', '  preset: academic', '  lineSpacing: 1.5', '---', '# D'].join('\n');
  const t = resolveDocxTemplate('plain', src);
  assert.equal(t.preset, 'academic');
  assert.equal(t.fontFamily, 'Times New Roman');
  assert.equal(t.lineSpacing, 1.5);
});

test('inline form works too', () => {
  const src = ['---', 'docx: { toc: false, header: "Q3" }', '---', '# D'].join('\n');
  const t = resolveDocxTemplate('report', src);
  assert.equal(t.toc, false);
  assert.equal(t.header, 'Q3');
});

test('the block stops at the next top-level key', () => {
  const src = ['---', 'docx:', '  toc: false', 'title: Real Title', '---', '# Ignored'].join('\n');
  const fm = parseDocxFrontMatter(src);
  assert.deepEqual(fm, { toc: false });
  assert.equal(resolveDocxTemplate('report', src).title, 'Real Title');
});

test('cover fields fall back: docx: → front matter → first H1 → caller', () => {
  assert.equal(resolveDocxTemplate('report', '# From Heading\n').title, 'From Heading');
  assert.equal(resolveDocxTemplate('report', 'no heading\n', 'file.md').title, 'file.md');
  const fm = ['---', 'title: FM', '---', '# Heading'].join('\n');
  assert.equal(resolveDocxTemplate('report', fm).title, 'FM');
  const both = ['---', 'title: FM', 'docx:', '  title: Explicit', '---', '# Heading'].join('\n');
  assert.equal(resolveDocxTemplate('report', both).title, 'Explicit');
});

test('a hash inside fenced code is not the title', () => {
  const src = ['```sh', '# not a heading', '```', '', '# Real'].join('\n');
  assert.equal(firstHeading(src), 'Real');
});

test('booleans accept the spellings people actually write', () => {
  for (const [v, expected] of [['true', true], ['yes', true], ['on', true], ['1', true],
                               ['false', false], ['no', false], ['off', false], ['0', false]] as const) {
    const src = ['---', 'docx:', `  toc: ${v}`, '---'].join('\n');
    assert.equal(parseDocxFrontMatter(src).toc, expected, `toc: ${v}`);
  }
});

test('nonsense values are ignored rather than applied', () => {
  const src = ['---', 'docx:', '  preset: chaos', '  fontSize: huge', '  lineSpacing: -3', '---'].join('\n');
  assert.deepEqual(parseDocxFrontMatter(src), {});
  const t = resolveDocxTemplate('report', src);
  assert.equal(t.preset, 'report');
  assert.equal(t.fontSizePt, 11);
});

test('a document with no docx: block is untouched by the parser', () => {
  assert.deepEqual(parseDocxFrontMatter('# Just a doc\n'), {});
  assert.deepEqual(parseDocxFrontMatter('---\ntitle: X\n---\n'), {});
});

test('{title} is substituted into the running header', () => {
  const t = resolveDocxTemplate('report', '# Quarterly Report\n');
  assert.equal(renderHeaderText(t), 'Quarterly Report');
  const custom = resolveDocxTemplate('report', ['---', 'docx:', '  header: "ACME — {title}"', '---', '# Q3'].join('\n'));
  assert.equal(renderHeaderText(custom), 'ACME — Q3');
});

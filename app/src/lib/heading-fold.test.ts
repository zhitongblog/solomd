/**
 * Unit tests for the heading-fold document model.
 *
 * Run from `app/`:  node src/lib/heading-fold.selftest.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scanHeadings,
  foldRangeAtLine,
  headingLinesAtOrBelow,
  allFoldableHeadingLines,
  foldedCharRanges,
  pruneFolds,
  anchorAtLine,
  remapFolds,
} from './heading-fold';

const DOC = [
  '# Title', // 0
  '', // 1
  'Intro paragraph.', // 2
  '', // 3
  '## Section A', // 4
  '', // 5
  'Body of A.', // 6
  '', // 7
  '### A.1', // 8
  'Deep body.', // 9
  '', // 10
  '## Section B', // 11
  'Body of B.', // 12
].join('\n');

test('a section runs to the next heading of the same or a shallower level', () => {
  const spans = scanHeadings(DOC);
  assert.deepEqual(
    spans.map((s) => [s.level, s.line, s.endLine]),
    [
      [1, 0, 12], // H1 owns the whole document
      [2, 4, 9], // "## Section A" stops before "## Section B"…
      [3, 8, 9], // …and its H3 child stops at the same place
      [2, 11, 12],
    ],
  );
});

test('trailing blank lines are left visible', () => {
  // Section A's last content line is 9; line 10 is blank and stays out of the
  // fold so the gap before "## Section B" survives.
  const a = scanHeadings(DOC).find((s) => s.line === 4)!;
  assert.equal(a.endLine, 9);
});

test('a heading with nothing under it is not foldable', () => {
  const spans = scanHeadings('# A\n## B\ntext\n');
  assert.equal(spans[0].foldable, true); // A owns B
  assert.equal(spans[1].foldable, true);
  assert.equal(scanHeadings('# Alone\n').length, 1);
  assert.equal(scanHeadings('# Alone\n')[0].foldable, false);
  assert.equal(foldRangeAtLine('# Alone\n', 0), null);
});

test('headings inside fenced code are not headings', () => {
  const src = ['# Real', '', '```sh', '# not a heading', 'echo hi', '```', '', 'tail'].join('\n');
  const spans = scanHeadings(src);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].line, 0);
  assert.equal(spans[0].endLine, 7); // the fold covers the fence and the tail
});

test('tilde fences close only on a fence at least as long', () => {
  // CommonMark: `~~~` cannot close `~~~~`, so line 4 is still inside the block.
  const src = ['# Real', '~~~~', '# nope', '~~~', '# still nope', '~~~~', '# Second'].join('\n');
  assert.deepEqual(scanHeadings(src).map((s) => s.line), [0, 6]);

  // …and a longer fence does close a shorter one.
  const closed = ['# Real', '~~~', '# nope', '~~~~', '# Second'].join('\n');
  assert.deepEqual(scanHeadings(closed).map((s) => s.line), [0, 4]);
});

test('YAML front matter is skipped', () => {
  const src = ['---', 'title: x', '# not a heading', '---', '', '# Real'].join('\n');
  const spans = scanHeadings(src);
  assert.deepEqual(spans.map((s) => s.line), [5]);
});

test('fold range starts at the end of the heading line', () => {
  const range = foldRangeAtLine(DOC, 4)!;
  assert.equal(DOC.slice(0, range.from).endsWith('## Section A'), true);
  assert.equal(DOC.slice(range.from, range.to).startsWith('\n'), true);
  assert.equal(DOC.slice(range.to).startsWith('\n\n## Section B'), true);
});

test('fold-to-level folds that level and deeper', () => {
  assert.deepEqual(headingLinesAtOrBelow(DOC, 1), [0, 4, 8, 11]);
  assert.deepEqual(headingLinesAtOrBelow(DOC, 2), [4, 8, 11]);
  assert.deepEqual(headingLinesAtOrBelow(DOC, 3), [8]);
  assert.deepEqual(headingLinesAtOrBelow(DOC, 4), []);
  assert.deepEqual(allFoldableHeadingLines(DOC), [0, 4, 8, 11]);
});

test('nested folds merge into one range', () => {
  const ranges = foldedCharRanges(DOC, [4, 8]);
  assert.equal(ranges.length, 1);
  const a = foldRangeAtLine(DOC, 4)!;
  assert.deepEqual(ranges[0], a);
});

test('disjoint folds stay separate', () => {
  const ranges = foldedCharRanges(DOC, [4, 11]);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0].to < ranges[1].from);
});

test('folds on lines that are no longer headings are pruned', () => {
  assert.deepEqual(pruneFolds(DOC, [4, 8, 99]), [4, 8]);
  assert.deepEqual(pruneFolds('just text\n', [0]), []);
});

test('an empty document has no headings', () => {
  assert.deepEqual(scanHeadings(''), []);
  assert.deepEqual(foldedCharRanges('', [0]), []);
});

test('folds follow their heading when lines shift', () => {
  const before = ['# One', 'a', '## Two', 'b'].join('\n');
  const after = ['intro', '', '# One', 'a', '## Two', 'b'].join('\n');
  const folds = [
    { line: 0, title: '# One' },
    { line: 2, title: '## Two' },
  ];
  assert.deepEqual(remapFolds(after, folds), [
    { line: 2, title: '# One' },
    { line: 4, title: '## Two' },
  ]);
  // sanity: the anchors were right for the original document
  assert.deepEqual(anchorAtLine(before, 2), { line: 2, title: '## Two' });
});

test('a deleted heading loses its fold', () => {
  const after = ['# One', 'a'].join('\n');
  assert.deepEqual(remapFolds(after, [{ line: 2, title: '## Gone' }]), []);
});

test('duplicate heading titles resolve to the nearest unclaimed one', () => {
  const src = ['# Dup', 'a', '# Dup', 'b'].join('\n');
  const remapped = remapFolds(src, [{ line: 2, title: '# Dup' }]);
  assert.deepEqual(remapped, [{ line: 2, title: '# Dup' }]);
  // Two folds on the same title claim distinct headings.
  const both = remapFolds(src, [
    { line: 0, title: '# Dup' },
    { line: 2, title: '# Dup' },
  ]);
  assert.deepEqual(both.map((f) => f.line), [0, 2]);
});

test('heading spans expose the line start offset for block hiding', () => {
  const src = ['# A', 'body'].join('\n');
  const span = scanHeadings(src)[0];
  assert.equal(span.start, 0);
  assert.equal(src.slice(span.start, span.headingEnd), '# A');
  assert.equal(span.title, '# A');
});

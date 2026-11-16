import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_PREVIEW_MARKS, findPreviewHitsInText } from './preview-search-hits.ts';

test('findPreviewHitsInText returns non-overlapping ranges for repeated-character queries', () => {
  // Previously `pos += 1` produced [{start: 0, end: 2}, {start: 1, end: 3}] on "---",
  // which threw DOMException IndexSizeError when wrapping Ranges in reverse order.
  assert.deepEqual(findPreviewHitsInText('---', '--'), {
    hits: [{ start: 0, end: 2 }],
    truncated: false,
  });
  assert.deepEqual(findPreviewHitsInText('----', '--'), {
    hits: [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ],
    truncated: false,
  });
  assert.deepEqual(findPreviewHitsInText('**bold**', '**'), {
    hits: [
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ],
    truncated: false,
  });
});

test('findPreviewHitsInText matches case-insensitively across ASCII and CJK', () => {
  assert.deepEqual(findPreviewHitsInText('SoloMD 搜索 solomd 搜索', 'SOLOMD 搜索'), {
    hits: [
      { start: 0, end: 9 },
      { start: 10, end: 19 },
    ],
    truncated: false,
  });
});

test('findPreviewHitsInText enforces remainingLimit and reports truncation', () => {
  const text = 'a '.repeat(MAX_PREVIEW_MARKS + 25);
  const res = findPreviewHitsInText(text, 'a', MAX_PREVIEW_MARKS);
  assert.equal(res.hits.length, MAX_PREVIEW_MARKS);
  assert.equal(res.truncated, true);
});

test('findPreviewHitsInText handles Unicode case-folding length expansion safely', () => {
  // U+0130 ('İ') lowercases to 'i\u0307' (length 2 in UTF-16).
  const text = 'İstanbul and finish';
  const res = findPreviewHitsInText(text, 'finish');
  assert.equal(res.truncated, false);
  assert.equal(res.hits.length, 1);
  assert.equal(text.slice(res.hits[0].start, res.hits[0].end), 'finish');
});

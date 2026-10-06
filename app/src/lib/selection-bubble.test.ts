import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  headingLevelAt,
  isBubbleSelection,
  isFormatActive,
  lineContext,
  nextHeadingKind,
  placeBubble,
} from './selection-bubble.ts';

test('bold is active on a bold word, not on plain or italic text', () => {
  const doc = 'a **word** and *other* text';
  const s = doc.indexOf('word');
  assert.equal(isFormatActive(doc, s, s + 4, 'bold'), true);
  assert.equal(isFormatActive(doc, s, s + 4, 'italic'), false);
  const o = doc.indexOf('other');
  assert.equal(isFormatActive(doc, o, o + 5, 'bold'), false);
  assert.equal(isFormatActive(doc, o, o + 5, 'italic'), true);
  const p = doc.indexOf('text');
  assert.equal(isFormatActive(doc, p, p + 4, 'bold'), false);
});

test('bold-italic shows both pressed', () => {
  const doc = '***both***';
  assert.equal(isFormatActive(doc, 3, 7, 'bold'), true);
  assert.equal(isFormatActive(doc, 3, 7, 'italic'), true);
});

test('inline code, list and quote report their state', () => {
  assert.equal(isFormatActive('x `code` y', 3, 7, 'code'), true);
  assert.equal(isFormatActive('x code y', 2, 6, 'code'), false);
  assert.equal(isFormatActive('- item', 2, 6, 'ul'), true);
  assert.equal(isFormatActive('item', 0, 4, 'ul'), false);
  assert.equal(isFormatActive('> said', 2, 6, 'quote'), true);
  assert.equal(isFormatActive('said', 0, 4, 'quote'), false);
});

test('links and collapsed selections are never pressed', () => {
  assert.equal(isFormatActive('[a](b)', 1, 2, 'link'), false);
  assert.equal(isFormatActive('**a**', 2, 2, 'bold'), false);
});

test('lineContext re-bases the selection onto its whole lines', () => {
  const doc = 'one\ntwo **b** two\nthree';
  const s = doc.indexOf('**b**') + 2;
  const c = lineContext(doc, s, s + 1);
  assert.equal(c.text, 'two **b** two');
  assert.equal(c.text.slice(c.from, c.to), 'b');
  assert.equal(isFormatActive(c.text, c.from, c.to, 'bold'), true);
});

test('heading level and the keyboard-bar cycle', () => {
  const doc = 'para\n# One\n## Two\n### Three\n#### Four';
  const at = (needle: string) => doc.indexOf(needle) + 1;
  assert.equal(headingLevelAt(doc, at('para')), 0);
  assert.equal(headingLevelAt(doc, at('One')), 1);
  assert.equal(headingLevelAt(doc, at('Four')), 4);
  assert.equal(nextHeadingKind(doc, at('para')), 'h1');
  assert.equal(nextHeadingKind(doc, at('One')), 'h2');
  assert.equal(nextHeadingKind(doc, at('Two')), 'h3');
  assert.equal(nextHeadingKind(doc, at('Three')), 'h3');
  assert.equal(nextHeadingKind(doc, at('Four')), 'h3');
  assert.equal(headingLevelAt('#hashtag', 1), 0);
});

test('placeBubble: above and centred when there is room', () => {
  const p = placeBubble(
    { left: 300, right: 400, top: 200, bottom: 220 },
    { width: 100, height: 38 },
    { left: 0, right: 1000, top: 0, bottom: 800 },
  );
  assert.deepEqual(p, { left: 300, top: 154, below: false });
});

test('placeBubble: flips below near the top and clamps at the edges', () => {
  const p = placeBubble(
    { left: 0, right: 20, top: 30, bottom: 50 },
    { width: 200, height: 38 },
    { left: 10, right: 500, top: 20, bottom: 800 },
  );
  assert.equal(p.below, true);
  assert.equal(p.top, 58);
  assert.equal(p.left, 18);
  const r = placeBubble(
    { left: 480, right: 495, top: 400, bottom: 420 },
    { width: 200, height: 38 },
    { left: 10, right: 500, top: 20, bottom: 800 },
  );
  assert.equal(r.left, 292);
});

test('whitespace-only selections get no bubble', () => {
  assert.equal(isBubbleSelection('   \n '), false);
  assert.equal(isBubbleSelection(''), false);
  assert.equal(isBubbleSelection(' a '), true);
});

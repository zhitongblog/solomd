/**
 * Unit tests for equation numbering and cross-references.
 *
 * Run from `app/`:  node src/lib/equations.selftest.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { numberEquations, collectLabels, findMathSpanAt } from './equations';

test('a document with no labels or refs is returned untouched', () => {
  const src = '# Title\n\n$$ a = b $$\n\ntext\n';
  assert.equal(numberEquations(src).text, src);
});

test('a labelled block gets a number, a tag and an anchor', () => {
  const src = ['before', '', '$$', 'E = mc^2 \\label{einstein}', '$$', '', 'after'].join('\n');
  const { text, refs } = numberEquations(src);
  assert.deepEqual(refs, [{ label: 'einstein', display: '1' }]);
  assert.ok(text.includes('<a id="eq-einstein"></a>'), text);
  assert.ok(text.includes('\\tag{1}'), text);
  assert.ok(!text.includes('\\label'), text);
  assert.ok(text.includes('before') && text.includes('after'));
});

test('numbering runs in document order', () => {
  const src = [
    '$$ a \\label{one} $$',
    '',
    '$$ b $$',
    '',
    '$$ c \\label{two} $$',
  ].join('\n');
  const { refs } = numberEquations(src);
  assert.deepEqual(refs, [
    { label: 'one', display: '1' },
    { label: 'two', display: '2' },
  ]);
});

test('references become links to their anchors', () => {
  const src = ['$$ a \\label{x} $$', '', 'See \\eqref{x} and \\ref{x}.'].join('\n');
  const { text } = numberEquations(src);
  assert.ok(text.includes('See [(1)](#eq-x) and [1](#eq-x).'), text);
});

test('a reference to a label that does not exist is left as written', () => {
  const src = ['$$ a \\label{x} $$', '', 'See \\eqref{typo}.'].join('\n');
  const { text } = numberEquations(src);
  assert.ok(text.includes('\\eqref{typo}'), text);
});

test('an explicit \\tag wins and does not consume a number', () => {
  const src = [
    '$$ a \\label{star} \\tag{$\\star$} $$',
    '',
    '$$ b \\label{next} $$',
    '',
    'see \\eqref{star} and \\eqref{next}',
  ].join('\n');
  const { text, refs } = numberEquations(src);
  assert.deepEqual(refs, [
    { label: 'star', display: '$\\star$' },
    { label: 'next', display: '1' },
  ]);
  // the author's tag survives, and no second \tag was added
  assert.equal((text.match(/\\tag\{/g) || []).length, 2);
  assert.ok(text.includes('[($\\star$)](#eq-star)'), text);
});

test('math inside fenced code is not numbered', () => {
  const src = ['```md', '$$ a \\label{x} $$', '```', '', 'text \\eqref{x}'].join('\n');
  const { text, refs } = numberEquations(src);
  assert.deepEqual(refs, []);
  assert.ok(text.includes('$$ a \\label{x} $$'), text);
  assert.ok(text.includes('\\eqref{x}'), text);
});

test('a reference inside fenced code is left alone', () => {
  const src = ['$$ a \\label{x} $$', '', '```', 'write \\eqref{x} like this', '```', '', 'real \\eqref{x}'].join('\n');
  const { text } = numberEquations(src);
  assert.ok(text.includes('write \\eqref{x} like this'), text);
  assert.ok(text.includes('real [(1)](#eq-x)'), text);
});

test('multi-line blocks keep their content', () => {
  const src = ['$$', '\\begin{aligned}', 'a &= b \\\\', 'c &= d', '\\end{aligned}', '\\label{sys}', '$$'].join('\n');
  const { text, refs } = numberEquations(src);
  assert.equal(refs[0].label, 'sys');
  assert.ok(text.includes('\\begin{aligned}'));
  assert.ok(text.includes('c &= d'));
  assert.ok(text.includes('\\tag{1}'));
});

test('a duplicate label keeps its own number but resolves to the first', () => {
  const src = ['$$ a \\label{d} $$', '', '$$ b \\label{d} $$', '', 'ref \\eqref{d}'].join('\n');
  const { text, refs } = numberEquations(src);
  assert.deepEqual(refs, [{ label: 'd', display: '1' }]);
  assert.ok(text.includes('[(1)](#eq-d)'));
  assert.ok(text.includes('\\tag{2}'), text);
});

test('collectLabels reports what autocomplete should offer', () => {
  const src = ['$$ a \\label{alpha} $$', '$$ b \\label{beta} $$'].join('\n');
  assert.deepEqual(collectLabels(src).map((r) => r.label), ['alpha', 'beta']);
});

test('single-line and multi-line blocks can be mixed', () => {
  const src = ['$$ a \\label{one} $$', '', '$$', 'b \\label{two}', '$$'].join('\n');
  const { refs } = numberEquations(src);
  assert.deepEqual(refs.map((r) => r.display), ['1', '2']);
});

test('finds the formula under the caret', () => {
  const doc = 'text $a+b$ more $$x^2$$ end';
  const inline = findMathSpanAt(doc, 7)!;
  assert.equal(inline.body, 'a+b');
  assert.equal(inline.display, false);
  assert.equal(doc.slice(inline.from, inline.to), '$a+b$');

  const block = findMathSpanAt(doc, 19)!;
  assert.equal(block.body, 'x^2');
  assert.equal(block.display, true);
  assert.equal(doc.slice(block.from, block.to), '$$x^2$$');

  assert.equal(findMathSpanAt(doc, 2), null);
});

test('a caret on either delimiter still finds the span', () => {
  const doc = '$a$';
  assert.ok(findMathSpanAt(doc, 0));
  assert.ok(findMathSpanAt(doc, 3));
});

test('an escaped dollar is not a delimiter', () => {
  const doc = 'costs \\$5 and \\$9 then $x$ ends';
  const span = findMathSpanAt(doc, doc.indexOf('x'))!;
  assert.equal(span.body, 'x');
});

test('a multi-line block is found from inside', () => {
  const doc = 'a\n\n$$\n\\frac{1}{2}\n$$\n\nb';
  const span = findMathSpanAt(doc, doc.indexOf('frac'))!;
  assert.equal(span.display, true);
  assert.equal(span.body, '\\frac{1}{2}');
});

test('an unterminated formula is not a span', () => {
  assert.equal(findMathSpanAt('text $a+b', 7), null);
});

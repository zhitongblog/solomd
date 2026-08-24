import assert from 'node:assert/strict';
import { test } from 'node:test';

import { transformCase, nextCaseInCycle, caseTargetRange } from './text-case.ts';

test('upper / lower are plain', () => {
  assert.equal(transformCase('hello World', 'upper'), 'HELLO WORLD');
  assert.equal(transformCase('hello World', 'lower'), 'hello world');
});

test('title case capitalises each word and lowercases the rest', () => {
  assert.equal(transformCase('hello world', 'title'), 'Hello World');
  assert.equal(transformCase('HELLO WORLD', 'title'), 'Hello World');
  assert.equal(transformCase('hELLo   wORLD', 'title'), 'Hello   World');
});

test("title case keeps an apostrophe inside one word", () => {
  // "doesn't" must not become "Doesn'T"
  assert.equal(transformCase("doesn't matter", 'title'), "Doesn't Matter");
});

test('title case handles accented Latin', () => {
  assert.equal(transformCase('éclair café', 'title'), 'Éclair Café');
});

test('CJK passes through every transform unchanged', () => {
  assert.equal(transformCase('大小写转换', 'upper'), '大小写转换');
  assert.equal(transformCase('大小写转换', 'title'), '大小写转换');
});

test('mixed CJK + Latin only touches the Latin', () => {
  assert.equal(transformCase('导出为 pdf 文件', 'upper'), '导出为 PDF 文件');
});

test('cycle order is lower -> upper -> title -> lower', () => {
  assert.equal(nextCaseInCycle('hello'), 'upper');
  assert.equal(nextCaseInCycle('HELLO'), 'title');
  assert.equal(nextCaseInCycle('Hello'), 'lower');
});

test('cycle on uncased text is a harmless no-op choice', () => {
  assert.equal(nextCaseInCycle('中文 123'), 'upper');
  assert.equal(transformCase('中文 123', 'upper'), '中文 123');
});

test('a selection is used verbatim, either direction', () => {
  const doc = 'alpha beta gamma';
  assert.deepEqual(caseTargetRange(doc, 6, 10), { from: 6, to: 10, text: 'beta' });
  // reversed selection normalises
  assert.deepEqual(caseTargetRange(doc, 10, 6), { from: 6, to: 10, text: 'beta' });
});

test('a bare caret expands to the word under it', () => {
  const doc = 'alpha beta gamma';
  assert.deepEqual(caseTargetRange(doc, 8, 8), { from: 6, to: 10, text: 'beta' });
  // caret at the word's leading edge still catches it
  assert.deepEqual(caseTargetRange(doc, 6, 6), { from: 6, to: 10, text: 'beta' });
  // caret at the trailing edge too
  assert.deepEqual(caseTargetRange(doc, 10, 10), { from: 6, to: 10, text: 'beta' });
});

test('a caret genuinely inside whitespace has no target', () => {
  // Between the two spaces — index 5 would be the trailing edge of "alpha",
  // which by design still targets that word (see the test above).
  assert.equal(caseTargetRange('alpha  beta', 6, 6), null);
  assert.equal(caseTargetRange('', 0, 0), null);
});

test("word expansion spans an apostrophe but stops at punctuation", () => {
  const doc = "it doesn't, really";
  assert.deepEqual(caseTargetRange(doc, 6, 6), { from: 3, to: 10, text: "doesn't" });
});

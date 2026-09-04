/**
 * Unit tests for import target naming.
 *
 * Run from `app/`:  node src/lib/import-plan.selftest.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { baseNameOf, fileNameOf, claimImportName, joinInFolder } from './import-plan';

test('an empty folder takes the plain name', () => {
  const taken = new Set<string>();
  assert.equal(claimImportName(taken, 'report.docx'), 'report.md');
});

test('an existing note is never overwritten', () => {
  const taken = new Set(['report.md']);
  assert.equal(claimImportName(taken, 'report.docx'), 'report-2.md');
});

test('importing the same document twice in one batch produces two files', () => {
  const taken = new Set<string>();
  assert.equal(claimImportName(taken, '/a/report.docx'), 'report.md');
  assert.equal(claimImportName(taken, '/b/report.pdf'), 'report-2.md');
  assert.equal(claimImportName(taken, '/c/report.html'), 'report-3.md');
});

test('case-insensitive: Report.md and report.md are the same file on macOS/Windows', () => {
  const taken = new Set(['report.md']);
  assert.equal(claimImportName(taken, 'Report.docx'), 'Report-2.md');
});

test('dots inside the name survive; only the last extension goes', () => {
  assert.equal(baseNameOf('v1.2.final.docx'), 'v1.2.final');
  assert.equal(claimImportName(new Set(), 'v1.2.final.docx'), 'v1.2.final.md');
});

test('a name with no extension still works', () => {
  assert.equal(claimImportName(new Set(), 'README'), 'README.md');
});

test('file name is taken off both kinds of path', () => {
  assert.equal(fileNameOf('/Users/x/docs/a.docx'), 'a.docx');
  assert.equal(fileNameOf('C:\\Users\\x\\a.docx'), 'a.docx');
  assert.equal(fileNameOf('a.docx'), 'a.docx');
});

test('joining uses the separator the folder already uses', () => {
  assert.equal(joinInFolder('/Users/x/notes', 'a.md'), '/Users/x/notes/a.md');
  assert.equal(joinInFolder('/Users/x/notes/', 'a.md'), '/Users/x/notes/a.md');
  assert.equal(joinInFolder('C:\\Users\\x', 'a.md'), 'C:\\Users\\x\\a.md');
  assert.equal(joinInFolder('C:\\Users\\x\\', 'a.md'), 'C:\\Users\\x\\a.md');
});

test('an empty base name falls back rather than producing ".md"', () => {
  assert.equal(claimImportName(new Set(), '.docx'), 'untitled.md');
});

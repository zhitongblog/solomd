import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathKey, samePath, segmentsBelow, sameName } from './path-key.ts';

test('Windows paths are one file however they are spelled', () => {
  assert.ok(samePath('C:\\Users\\Zhang\\Notes\\a.md', 'c:\\users\\zhang\\notes\\A.md'));
  assert.ok(samePath('C:\\Notes\\a.md', 'C:/Notes/a.md'));
  assert.ok(samePath('C:\\Notes\\', 'C:\\Notes'));
  assert.ok(samePath('\\\\nas\\share\\Doc.md', '\\\\NAS\\Share\\doc.md'));
  assert.ok(!samePath('C:\\Notes\\a.md', 'C:\\Notes\\b.md'));
  assert.equal(pathKey('C:\\'), 'c:\\');
});

test('macOS / Linux paths stay exact (case can matter there)', () => {
  assert.ok(!samePath('/Users/a/Notes/a.md', '/Users/a/notes/a.md'));
  assert.ok(samePath('/Users/a/Notes/', '/Users/a/Notes'));
  assert.ok(!samePath('', ''));
  assert.ok(!samePath(null, '/a'));
});

test('segmentsBelow: inside, the root itself, outside, and spelling variants', () => {
  assert.deepEqual(segmentsBelow('C:\\Users\\Z\\Desktop\\ftest', 'C:\\Users\\Z\\Desktop\\ftest\\alpha\\beta\\deep.md'), ['alpha', 'beta', 'deep.md']);
  // The case the VM reproduced: the shell passed a lower-case path.
  assert.deepEqual(segmentsBelow('C:\\Users\\Z\\Desktop\\ftest', 'c:\\users\\z\\desktop\\ftest\\zeta\\a5.md'), ['zeta', 'a5.md']);
  assert.deepEqual(segmentsBelow('C:/Users/Z/ftest/', 'C:\\Users\\Z\\ftest\\a.md'), ['a.md']);
  assert.deepEqual(segmentsBelow('C:\\Users\\Z\\ftest', 'C:\\Users\\Z\\FTEST'), []);
  assert.equal(segmentsBelow('C:\\Users\\Z\\ftest', 'C:\\Users\\Z\\ftest2\\a.md'), null);
  assert.equal(segmentsBelow('C:\\Users\\Z\\ftest', 'D:\\ftest\\a.md'), null);
  assert.deepEqual(segmentsBelow('D:\\', 'd:\\notes\\a.md'), ['notes', 'a.md']);
  assert.deepEqual(segmentsBelow('/Users/z/Notes', '/Users/z/Notes/sub/a.md'), ['sub', 'a.md']);
  assert.equal(segmentsBelow('/Users/z/Notes', '/Users/z/notes/sub/a.md'), null);
});

test('sameName follows the platform rule', () => {
  assert.ok(sameName('Alpha', 'alpha', true));
  assert.ok(!sameName('Alpha', 'alpha', false));
});

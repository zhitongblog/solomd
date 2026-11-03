import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportDefaultPath } from './export-paths.ts';

test('exportDefaultPath defaults to source note directory when customExportDir is empty (#260, #503)', () => {
  assert.equal(exportDefaultPath('/Users/alice/notes/doc.md', 'doc.pdf'), '/Users/alice/notes/doc.pdf');
  assert.equal(exportDefaultPath('/Users/alice/notes/doc.md', 'doc.pdf', ''), '/Users/alice/notes/doc.pdf');
  assert.equal(exportDefaultPath('/Users/alice/notes/doc.md', 'doc.pdf', '   '), '/Users/alice/notes/doc.pdf');
  assert.equal(exportDefaultPath('C:\\Users\\alice\\notes\\doc.md', 'doc.docx'), 'C:\\Users\\alice\\notes\\doc.docx');
  assert.equal(exportDefaultPath(null, 'doc.pdf'), null);
  assert.equal(exportDefaultPath('saf://tree/doc.md', 'doc.pdf'), null);
});

test('exportDefaultPath prefers customExportDir when configured (#503)', () => {
  assert.equal(
    exportDefaultPath('/Users/alice/notes/doc.md', 'doc.pdf', '/Users/alice/Exports'),
    '/Users/alice/Exports/doc.pdf',
  );
  assert.equal(
    exportDefaultPath('/Users/alice/notes/doc.md', 'doc.pdf', '/Users/alice/Exports/'),
    '/Users/alice/Exports/doc.pdf',
  );
  assert.equal(
    exportDefaultPath(null, 'untitled.pdf', '/Users/alice/Exports'),
    '/Users/alice/Exports/untitled.pdf',
  );
  assert.equal(
    exportDefaultPath('C:\\Users\\alice\\notes\\doc.md', 'doc.docx', 'D:\\Exports\\'),
    'D:\\Exports\\doc.docx',
  );
});

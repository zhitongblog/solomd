import test from 'node:test';
import assert from 'node:assert/strict';
import { expandNoteTemplate, BUILTIN_NOTE_TEMPLATES } from './note-templates';
import { renderMarkdown } from './markdown';
import { fileUrlToLocalPath } from './link-open';

test('#322: expandNoteTemplate replaces date, time, datetime, and title variables', () => {
  const fixedNow = new Date(2026, 10, 11, 9, 5, 0); // 2026-11-11 09:05
  const raw = '# {{title}}\nDate: {{date}} {{time}}\nFull: {{datetime}} ({{year}}-{{month}}-{{day}})';
  const out = expandNoteTemplate(raw, { title: 'Weekly Sync', now: fixedNow });
  assert.equal(
    out,
    '# Weekly Sync\nDate: 2026-11-11 09:05\nFull: 2026-11-11 09:05 (2026-11-11)',
  );
  assert.ok(BUILTIN_NOTE_TEMPLATES.length >= 4);
});

test('#285: renderMarkdown renders Pandoc / PHP Markdown Extra definition lists (<dl><dt><dd>)', () => {
  const md = 'Markdown\n: A lightweight markup language\n: Created by John Gruber\n';
  const html = renderMarkdown(md);
  assert.ok(html.includes('<dl data-source-line="1">'), `Expected <dl> in rendered HTML, got: ${html}`);
  assert.ok(html.includes('<dt data-source-line="1">Markdown</dt>'), `Expected <dt>Markdown</dt>, got: ${html}`);
  assert.ok(html.includes('<dd data-source-line="2">A lightweight markup language</dd>'));
  assert.ok(html.includes('<dd data-source-line="3">Created by John Gruber</dd>'));
});

test('#380: fileUrlToLocalPath converts file:// URLs to POSIX and Windows paths', () => {
  assert.equal(fileUrlToLocalPath('file:///Users/alex/Notes/test%20doc.md'), '/Users/alex/Notes/test doc.md');
  assert.equal(fileUrlToLocalPath('file:///C:/Users/alex/note.md'), 'C:\\Users\\alex\\note.md');
  assert.equal(fileUrlToLocalPath('https://solomd.app'), null);
});

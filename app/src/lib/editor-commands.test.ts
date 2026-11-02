import assert from 'node:assert/strict';
import { test } from 'node:test';

import { autoNumberHeadings, dedentCodeBlockSelection, deleteWord, indentCodeBlockPaste, selectCodeBlockBody, selectLine, selectWord, shiftHeading, type Range, type TextEdit } from './editor-commands.ts';

/** `|` marks the selection ends (one `|` = a bare caret). */
function parse(marked: string): { doc: string; from: number; to: number } {
  const first = marked.indexOf('|');
  const rest = marked.slice(first + 1);
  const second = rest.indexOf('|');
  const doc = second < 0 ? marked.replace('|', '') : marked.slice(0, first) + rest.replace('|', '');
  return { doc, from: first, to: second < 0 ? first : first + second };
}
function show(doc: string, from: number, to: number): string {
  return from === to
    ? doc.slice(0, from) + '|' + doc.slice(from)
    : doc.slice(0, from) + '|' + doc.slice(from, to) + '|' + doc.slice(to);
}
function sel(marked: string, fn: (d: string, f: number, t: number) => Range | null): string | null {
  const { doc, from, to } = parse(marked);
  const r = fn(doc, from, to);
  return r ? show(doc, r.from, r.to) : null;
}
function edit(marked: string, fn: (d: string, f: number, t: number) => TextEdit | null): string | null {
  const { doc, from, to } = parse(marked);
  const e = fn(doc, from, to);
  if (!e) return null;
  const out = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  return show(out, e.selFrom, e.selTo);
}

test('select word: inside, at either edge, and nothing between spaces', () => {
  assert.equal(sel('one tw|o three', selectWord), 'one |two| three');
  assert.equal(sel('one |two three', selectWord), 'one |two| three');
  assert.equal(sel('one two| three', selectWord), 'one |two| three');
  assert.equal(sel('one  |  two', selectWord), null);
});

test('select word: a selection grows to the words it touches', () => {
  assert.equal(sel('one t|wo th|ree', selectWord), 'one |two three| four'.replace(' four', ''));
});

test('select word: CJK picks a word, not the whole clause', () => {
  const r = sel('我们使用中文|输入法写作', selectWord);
  assert.ok(r, 'a CJK word is found');
  const picked = r!.split('|')[1];
  assert.ok(picked.length >= 1 && picked.length < 9, `picked "${picked}"`);
});

test('select word never crosses a line break', () => {
  assert.equal(sel('alpha\n|beta', selectWord), 'alpha\n|beta|');
  assert.equal(sel('alpha|\nbeta', selectWord), '|alpha|\nbeta');
});

test('delete word takes one neighbouring space with it', () => {
  assert.equal(edit('a wo|rd here', deleteWord), 'a |here');
  assert.equal(edit('wo|rd here', deleteWord), '|here');
  assert.equal(edit('a wo|rd.', deleteWord), 'a|.');
  assert.equal(edit('a wo|rd', deleteWord), 'a|');
  assert.equal(edit('a  |  b', deleteWord), null);
});

test('select line: the line without its break, then line by line', () => {
  assert.equal(sel('one\ntw|o\nthree', selectLine), 'one\n|two|\nthree');
  assert.equal(sel('one\n|two|\nthree', selectLine), 'one\n|two\nthree|');
  // At the last line it stays put.
  assert.equal(sel('one\n|two|', selectLine), 'one\n|two|');
  // A partial selection spanning lines covers those lines whole.
  assert.equal(sel('o|ne\ntw|o\nthree', selectLine), '|one\ntwo|\nthree');
});

test('heading promote / demote walk the levels and are inverses', () => {
  const up = (m: string) => edit(m, (d, f, t) => shiftHeading(d, f, t, 'promote'));
  const down = (m: string) => edit(m, (d, f, t) => shiftHeading(d, f, t, 'demote'));
  assert.equal(up('### Ti|tle'), '## Ti|tle');
  assert.equal(up('# Ti|tle'), null);
  assert.equal(up('Plain te|xt'), '###### Plain te|xt');
  assert.equal(down('## Ti|tle'), '### Ti|tle');
  assert.equal(down('###### Ti|tle'), 'Ti|tle');
  assert.equal(down('Plain te|xt'), null);
});

test('convert to paragraph drops the marker; caret inside the marker lands at the text', () => {
  const para = (m: string) => edit(m, (d, f, t) => shiftHeading(d, f, t, 'paragraph'));
  assert.equal(para('## Ti|tle'), 'Ti|tle');
  assert.equal(para('#|# Title'), '|Title');
  assert.equal(para('Already plain|'), null);
});

test('heading commands leave lists, quotes, fences and blank lines alone', () => {
  const up = (m: string) => edit(m, (d, f, t) => shiftHeading(d, f, t, 'promote'));
  assert.equal(up('- ite|m'), null);
  assert.equal(up('> quo|te'), null);
  assert.equal(up('```\n# not a he|ading\n```'), null);
  // A selection over several lines shifts each heading line.
  assert.equal(up('|## A\n\ntext\n### B|'), '|# A\n\n###### text\n## B|');
});

test('autoNumberHeadings numbers hierarchically, skips fences, and toggles off when already numbered (#474)', () => {
  const doc = '# Intro\n## Part A\n### Detail\n## Part B\n```\n# Not a heading\n```\n# Outro';
  const e1 = autoNumberHeadings(doc, 0, 0);
  assert.ok(e1);
  const numberedDoc = doc.slice(0, e1!.from) + e1!.insert + doc.slice(e1!.to);
  assert.equal(
    numberedDoc,
    '# 1. Intro\n## 1.1 Part A\n### 1.1.1 Detail\n## 1.2 Part B\n```\n# Not a heading\n```\n# 2. Outro',
  );
  // Running again when already accurately numbered removes the numbers cleanly.
  const e2 = autoNumberHeadings(numberedDoc, 0, 0);
  assert.ok(e2);
  const unnumberedDoc = numberedDoc.slice(0, e2!.from) + e2!.insert + numberedDoc.slice(e2!.to);
  assert.equal(unnumberedDoc, doc);
});

test('autoNumberHeadings add-mode refreshes numbers with a minimal diff range (#484, #489)', () => {
  // Adding a new heading between 1.1 and 1.2 renumbers 1.2 -> 1.3 and leaves
  // the unchanged prefix (# 1. Intro\n## 1.1 Part A\n## ) outside [from, to].
  const added = '# 1. Intro\n## 1.1 Part A\n## Inserted\n## 1.2 Part B';
  const eAdd = autoNumberHeadings(added, 0, 0, 'add');
  assert.ok(eAdd);
  assert.ok(eAdd!.from > '# 1. Intro\n## 1.1 Part A\n'.length, 'unchanged prefix is excluded from diff');
  const afterAdd = added.slice(0, eAdd!.from) + eAdd!.insert + added.slice(eAdd!.to);
  assert.equal(
    afterAdd,
    '# 1. Intro\n## 1.1 Part A\n## 1.2 Inserted\n## 1.3 Part B',
  );
  // Deleting a heading's text leaving "## 1.1 " strips the orphan number and renumbers following headings
  const cleared = '# 1. Intro\n## 1.1 \n## 1.2 Part B';
  const eClear = autoNumberHeadings(cleared, 0, 0, 'add');
  assert.ok(eClear);
  const afterClear = cleared.slice(0, eClear!.from) + eClear!.insert + cleared.slice(eClear!.to);
  assert.equal(afterClear, '# 1. Intro\n## \n## 1.1 Part B');
});

test('selectCodeBlockBody selects the code block body first and returns null when already selected', () => {
  const doc = '# Title\n```js\nconst a = 1;\nconst b = 2;\n```\nFooter';
  assert.equal(
    sel('# Title\n```js\nconst |a = 1;\nconst b = 2;\n```\nFooter', selectCodeBlockBody),
    '# Title\n```js\n|const a = 1;\nconst b = 2;|\n```\nFooter',
  );
  // Once the full body is selected, a second Ctrl+A returns null so the editor selects the whole document.
  assert.equal(
    sel('# Title\n```js\n|const a = 1;\nconst b = 2;|\n```\nFooter', selectCodeBlockBody),
    null,
  );
  // Indented fenced code block inside a list item:
  assert.equal(
    sel('1. 列表一\n   ```ts\n   let |x = 1;\n   ```\n2. 列表二', selectCodeBlockBody),
    '1. 列表一\n   ```ts\n   |let x = 1;|\n   ```\n2. 列表二',
  );
  assert.equal(
    sel('1. 列表一\n   ```ts\n   |let x = 1;|\n   ```\n2. 列表二', selectCodeBlockBody),
    null,
  );
  // Outside a code block returns null:
  assert.equal(sel('# Title|\n```js\na\n```', selectCodeBlockBody), null);
  void doc;
});

test('dedentCodeBlockSelection strips fence alignment spaces while preserving inner code indentation', () => {
  const doc = '1. 列表一\n   ```ts\n   function foo() {\n     return 42;\n   }\n   ```\n2. 列表二';
  // Ctrl+A selection inside the code block
  const bodyRange = selectCodeBlockBody(doc, doc.indexOf('function'))!;
  assert.equal(
    dedentCodeBlockSelection(doc, bodyRange.from, bodyRange.to),
    'function foo() {\n  return 42;\n}',
  );
  // Manual drag selection that includes the leading alignment spaces on line 1
  const manualFrom = doc.indexOf('   function');
  const manualTo = doc.lastIndexOf('\n   ```');
  assert.equal(
    dedentCodeBlockSelection(doc, manualFrom, manualTo),
    'function foo() {\n  return 42;\n}',
  );
  // Selection outside a code block is untouched
  assert.equal(dedentCodeBlockSelection(doc, 0, 7), '1. 列表一\n');
});

test('indentCodeBlockPaste pads subsequent pasted lines with the code fence indentation', () => {
  const indent8 = '        ';
  const docWithIndentedBlankLine = `1. 列表项\n${indent8}\`\`\`js\n${indent8}\n${indent8}\`\`\``;
  const cursorAtCol8 = docWithIndentedBlankLine.indexOf(`\n${indent8}\n`) + 1 + indent8.length;
  const snippet = 'function hello() {\n  return 1;\n}';

  // Pasting when cursor is already at column 8 after the fence spaces:
  const outAtCol8 = indentCodeBlockPaste(docWithIndentedBlankLine, cursorAtCol8, cursorAtCol8, snippet);
  assert.equal(outAtCol8, `function hello() {\n${indent8}  return 1;\n${indent8}}`);

  // Pasting when cursor is at column 0 on an empty line inside the 8-space fenced block:
  const docWithCol0BlankLine = `1. 列表项\n${indent8}\`\`\`js\n\n${indent8}\`\`\``;
  const cursorAtCol0 = docWithCol0BlankLine.indexOf('\n\n') + 1;
  const outAtCol0 = indentCodeBlockPaste(docWithCol0BlankLine, cursorAtCol0, cursorAtCol0, snippet);
  assert.equal(outAtCol0, `${indent8}function hello() {\n${indent8}  return 1;\n${indent8}}`);
});

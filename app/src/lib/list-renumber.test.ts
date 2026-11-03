import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapPos, renumberAfterEdit, structuralEditRange } from './list-renumber.ts';
import { renderMarkdown } from './markdown.ts';

/** The stored document after editing `prev` into `next`. */
function after(prev: string, next: string): string {
  return renumberAfterEdit(prev, next)?.value ?? next;
}

test('deleting a middle item renumbers the rest (the reported case)', () => {
  assert.equal(after('1. 第一项\n2. 第二项\n3. 第三项', '1. 第一项\n3. 第三项'), '1. 第一项\n2. 第三项');
});

test('deleting the first item keeps the original start', () => {
  assert.equal(after('1. a\n2. b\n3. c', '2. b\n3. c'), '2. b\n3. c');
  assert.equal(after('5. a\n6. b\n7. c\n8. d', '5. a\n7. c\n8. d'), '5. a\n6. c\n7. d');
});

test('Enter in the middle of a list shifts the following numbers', () => {
  assert.equal(after('1. a\n2. b\n3. c', '1. a\n2. \n2. b\n3. c'), '1. a\n2. \n3. b\n4. c');
});

test('loose lists, nested children and continuation lines stay one list', () => {
  const prev = '1. a\n\n   more\n2. b\n   - x\n   - y\n3. c\n4. d';
  const next = '1. a\n\n   more\n2. b\n   - x\n   - y\n4. d';
  assert.equal(after(prev, next), '1. a\n\n   more\n2. b\n   - x\n   - y\n3. d');
});

test('a nested ordered list is numbered on its own', () => {
  const prev = '1. a\n   1. x\n   2. y\n   3. z\n2. b';
  const next = '1. a\n   1. x\n   3. z\n2. b';
  assert.equal(after(prev, next), '1. a\n   1. x\n   2. z\n2. b');
});

test('lazy 1. 1. 1. lists are left as written', () => {
  assert.equal(after('1. a\n1. b\n1. c', '1. a\n1. c'), '1. a\n1. c');
});

test('typing inside a marker never triggers (no newline added or removed)', () => {
  assert.equal(structuralEditRange('1. a\n10. b', '1. a\n1. b'), null);
  assert.equal(renumberAfterEdit('1. a\n2. b\n3. c', '1. a\n5. b\n3. c'), null);
});

test('lists elsewhere in the document are not touched', () => {
  const prev = '1. a\n3. b\n\ntext\n\n1. x\n2. y\n3. z';
  const next = '1. a\n3. b\n\ntext\n\n1. x\n3. z';
  assert.equal(after(prev, next), '1. a\n3. b\n\ntext\n\n1. x\n2. z');
});

test('a different delimiter or a bullet ends the list', () => {
  assert.equal(after('1. a\n2. b\n3. c\n1) x\n2) y', '1. a\n3. c\n1) x\n2) y'), '1. a\n2. c\n1) x\n2) y');
  assert.equal(after('1. a\n2. b\n- c\n7. d', '1. a\n- c\n7. d'), '1. a\n- c\n7. d');
});

test('ordered lists inside quotes, and not inside code fences', () => {
  assert.equal(after('> 1. a\n> 2. b\n> 3. c', '> 1. a\n> 3. c'), '> 1. a\n> 2. c');
  const code = '```\n1. a\n2. b\n3. c\n```';
  assert.equal(after(code, '```\n1. a\n3. c\n```'), '```\n1. a\n3. c\n```');
});

test('crossing 9 → 10 and back maps the caret', () => {
  const prev = Array.from({ length: 10 }, (_, i) => `${i + 1}. x`).join('\n');
  const next = prev.replace('2. x\n', '');
  const r = renumberAfterEdit(prev, next)!;
  assert.equal(r.value, Array.from({ length: 9 }, (_, i) => `${i + 1}. x`).join('\n'));
  // A caret at the end of the old "10. x" line moves back one character.
  assert.equal(mapPos(next.length, r.changes), r.value.length);
});

test('headings and block constructs split ordered lists even without blank lines (#466)', () => {
  // Heading directly between two ordered lists (no blank line before/after heading)
  assert.equal(
    after(
      '1. 第一项\n2. 第二项\n# 标题\n1. 新第一项\n2. 新第二项',
      '1. 第一项\n2. 第二项\n# 标题\n1. 新第一项\n2. 新第二项\n3. 新第三项',
    ),
    '1. 第一项\n2. 第二项\n# 标题\n1. 新第一项\n2. 新第二项\n3. 新第三项',
  );
  // Heading with blank line after it but no blank line before it
  assert.equal(
    after(
      '1. 第一项\n2. 第二项\n### 子标题\n\n1. 新第一项\n2. 新第二项',
      '1. 第一项\n2. 第二项\n### 子标题\n\n1. 新第一项\n2. 新第二项\n',
    ),
    '1. 第一项\n2. 第二项\n### 子标题\n\n1. 新第一项\n2. 新第二项\n',
  );
  // Horizontal rule, code fence, or unindented paragraph before a new `1.` list
  assert.equal(
    after(
      '1. a\n2. b\n---\n1. c\n2. d',
      '1. a\n2. b\n---\n1. c\n2. d\n',
    ),
    '1. a\n2. b\n---\n1. c\n2. d\n',
  );
  assert.equal(
    after(
      '1. a\n2. b\n说明段落\n1. c\n2. d',
      '1. a\n2. b\n说明段落\n1. c\n2. d\n',
    ),
    '1. a\n2. b\n说明段落\n1. c\n2. d\n',
  );
});

test('ordered list item missing space before CJK (1.当前) keeps nested 2.1-2.3 and outer 3. aligned in editor and preview', () => {
  const md = [
    '# 规则',
    '1.当前一',
    '2. 原二',
    '   1. 子一',
    '   2. 子二',
    '   3. 子三',
    '3. 当三',
    '4. 四',
  ].join('\n');

  const html = renderMarkdown(md);
  // Outer <ol> has 4 direct items (`当前一`, `原二`, `当三`, `四`) and `原二` wraps a 3-item nested <ol>
  assert.ok(html.includes('<li data-source-line="2">当前一</li>'), '1.当前一 should render as first <li>');
  assert.ok(
    html.includes('<li data-source-line="6">子三</li>\n</ol>\n</li>\n<li data-source-line="7">当三</li>'),
    '3. 当三 should close the nested <ol> and be the 3rd outer <li>, not 2.4',
  );

  // Structural edit in the editor also normalizes `1.当前一` -> `1. 当前一`
  assert.equal(
    after('# 规则\n1.当前一\n2. 原二', '# 规则\n1.当前一\n2. 原二\n3. 当三'),
    '# 规则\n1. 当前一\n2. 原二\n3. 当三',
  );
});


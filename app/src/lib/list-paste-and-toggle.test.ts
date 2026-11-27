import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indentCodeBlockPaste } from './editor-commands.ts';
import { applyFormat, type FormatKind } from './md-format.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Helper: `|` marks caret (single) or selection (pair). */
function runFmt(marked: string, kind: FormatKind): string {
  const first = marked.indexOf('|');
  const second = marked.indexOf('|', first + 1);
  assert.ok(first >= 0, 'test input needs a | marker');
  const doc = marked.replace(/\|/g, '');
  const from = first;
  const to = second >= 0 ? second - 1 : first;
  const e = applyFormat(doc, from, to, kind);
  const next = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  if (e.selFrom === e.selTo) {
    return next.slice(0, e.selFrom) + '|' + next.slice(e.selFrom);
  }
  return (
    next.slice(0, e.selFrom) +
    '|' +
    next.slice(e.selFrom, e.selTo) +
    '|' +
    next.slice(e.selTo)
  );
}

/** Helper: simulate pasting `clip` at `|` (or replacing `|...|`) in `marked`. */
function runPaste(
  marked: string,
  clip: string,
  mode?: 'softBreak' | 'listItems',
): string {
  const first = marked.indexOf('|');
  const second = marked.indexOf('|', first + 1);
  assert.ok(first >= 0, 'test input needs a | marker');
  const doc = marked.replace(/\|/g, '');
  const from = first;
  const to = second >= 0 ? second - 1 : first;
  const inserted = indentCodeBlockPaste(doc, from, to, clip, mode ? { listMultiLineMode: mode } : undefined);
  return doc.slice(0, from) + inserted + doc.slice(to);
}

test('List Paste: Notepad++ Windows CRLF multi-line plain text aligns as soft breaks across OL/UL/nested/task/quote', () => {
  const crlf = '第一行\r\n第二行\r\n第三行';

  // 1. Empty ordered & unordered list items
  assert.equal(runPaste('1. |', crlf), '1. 第一行\n   第二行\n   第三行');
  assert.equal(runPaste('- |', crlf), '- 第一行\n  第二行\n  第三行');

  // 2. Non-empty 1-digit & 2-digit ordered list items
  assert.equal(runPaste('1. 标题：|', crlf), '1. 标题：第一行\n   第二行\n   第三行');
  assert.equal(runPaste('10. 第十项 |', 'lineA\r\nlineB'), '10. 第十项 lineA\n    lineB');

  // 3. Nested 2nd-level unordered & ordered items
  assert.equal(runPaste('  - 子项 |', 'alpha\r\nbeta'), '  - 子项 alpha\n    beta');
  assert.equal(runPaste('   1. 子项 |', 'alpha\r\nbeta'), '   1. 子项 alpha\n      beta');

  // 4. Task list item aligns to list marker content column (2 spaces)
  assert.equal(runPaste('- [ ] 任务：|', '步骤1\r\n步骤2'), '- [ ] 任务：步骤1\n  步骤2');

  // 5. Mid-line paste & replacing selected text inside a list item
  assert.equal(runPaste('1. 前|后', '甲\r\n乙'), '1. 前甲\n   乙后');
  assert.equal(runPaste('- |旧内容|', '新1\r\n新2'), '- 新1\n  新2');

  // 6. Blank lines inside pasted text do NOT emit trailing whitespace
  assert.equal(runPaste('1. 项 |', '段一\r\n\r\n段二'), '1. 项 段一\n\n   段二');

  // 7. Empty AND non-empty soft-break continuation lines under a list
  assert.equal(runPaste('1. 项\n   |', 'a\r\nb'), '1. 项\n   a\n   b');
  assert.equal(runPaste('1. 项\n   已有文字 |', 'a\r\nb'), '1. 项\n   已有文字 a\n   b');
  assert.equal(runPaste('- 项\n  已有文字 |', 'a\r\nb'), '- 项\n  已有文字 a\n  b');

  // 8. Blockquote list items & blockquote soft-break continuation lines
  assert.equal(runPaste('> 1. 引用 |', 'a\r\nb'), '> 1. 引用 a\n>    b');
  assert.equal(runPaste('> - 引用\n>   已有 |', 'a\r\nb'), '> - 引用\n>   已有 a\n>   b');

  // 9. Plain non-list paragraph & indented non-list text stay untouched
  assert.equal(runPaste('普通段落 |', 'a\r\nb'), '普通段落 a\r\nb');
  assert.equal(runPaste('普通段落\n  缩进 |', 'a\r\nb'), '普通段落\n  缩进 a\r\nb');
});

test('List Paste: listItems mode converts lines 2+ into sibling list items while keeping tables and fences intact', () => {
  const crlf = '第一行\r\n第二行\r\n第三行';

  // Unordered, ordered (auto-incrementing), nested, task, blockquote
  assert.equal(runPaste('- |', crlf, 'listItems'), '- 第一行\n- 第二行\n- 第三行');
  assert.equal(runPaste('1. |', crlf, 'listItems'), '1. 第一行\n2. 第二行\n3. 第三行');
  assert.equal(runPaste('  - |', 'a\nb', 'listItems'), '  - a\n  - b');
  assert.equal(runPaste('   10. |', 'a\nb', 'listItems'), '   10. a\n   11. b');
  assert.equal(runPaste('- [ ] |', '任务1\n任务2', 'listItems'), '- [ ] 任务1\n- [ ] 任务2');
  assert.equal(runPaste('> - |', 'a\nb', 'listItems'), '> - a\n> - b');
  assert.equal(runPaste('> 1. |', 'a\nb', 'listItems'), '> 1. a\n> 2. b');

  // Blank lines stay blank without incrementing ordered number
  assert.equal(runPaste('1. |', 'a\n\nb', 'listItems'), '1. a\n\n2. b');

  // Already-prefixed list lines do not get double-prefixed
  assert.equal(runPaste('- |', 'a\n- b\n  - c', 'listItems'), '- a\n- b\n  - c');

  // Tables and fenced code blocks still stay intact (never prefixed with `- `)
  const table = '| A | B |\n| - | - |\n| 1 | 2 |';
  assert.equal(runPaste('- |', table, 'listItems'), '- | A | B |\n  | - | - |\n  | 1 | 2 |');
  const fence = '```ts\nconst x = 1;\n```';
  assert.equal(runPaste('- |', fence, 'listItems'), '- ```ts\n  const x = 1;\n  ```');
});

test('List Paste: HTML rich-text paste path also routes through indentCodeBlockPaste', () => {
  const src = fs.readFileSync(path.join(__dirname, 'cm-image-paste.ts'), 'utf8');
  assert.match(src, /import \{ indentCodeBlockPaste \} from '\.\/editor-commands'/);
  assert.match(src, /indentCodeBlockPaste\(el\.value, el\.selectionStart \?\? 0, el\.selectionEnd \?\? 0, mdHtml/);
  assert.match(src, /indentCodeBlockPaste\(view\.state\.doc\.toString\(\), sel\.from, sel\.to, mdHtml/);
});

test('List Toggle: 1st-level OL/UL repeat shortcut clears entire contiguous sibling group from any line', () => {
  // Ordered list: caret on line 1, line 2, or line 3
  assert.equal(runFmt('1. a|\n2. b\n3. c', 'ol'), 'a|\nb\nc');
  assert.equal(runFmt('1. a\n2. b|\n3. c', 'ol'), 'a\nb|\nc');
  assert.equal(runFmt('1. a\n2. b\n3. c|', 'ol'), 'a\nb\nc|');

  // Unordered list: caret on line 1, line 2, or line 3
  assert.equal(runFmt('- a|\n- b\n- c', 'ul'), 'a|\nb\nc');
  assert.equal(runFmt('- a\n- b|\n- c', 'ul'), 'a\nb|\nc');
  assert.equal(runFmt('- a\n- b\n- c|', 'ul'), 'a\nb\nc|');

  // Two separate lists separated by a blank line: only the active group clears
  assert.equal(runFmt('1. a\n2. b|\n\n1. c\n2. d', 'ol'), 'a\nb|\n\n1. c\n2. d');
  assert.equal(runFmt('- a\n- b|\n\n- c\n- d', 'ul'), 'a\nb|\n\n- c\n- d');

  // Blockquote list groups
  assert.equal(runFmt('> 1. a\n> 2. b|\n> 3. c', 'ol'), '> a\n> b|\n> c');
  assert.equal(runFmt('> - a\n> - b|\n> - c', 'ul'), '> a\n> b|\n> c');
});

test('List Toggle: multi-level nested UL <-> OL switching shifts child indents cleanly without splitting lists', () => {
  // 2-level UL with UL children <-> OL
  const ul2 = '- a|\n  - sub1\n  - sub2\n- b';
  const ol2 = '1. a|\n   - sub1\n   - sub2\n2. b';
  assert.equal(runFmt(ul2, 'ol'), ol2);
  assert.equal(runFmt(ol2, 'ul'), ul2);

  // 2-level UL with OL children <-> OL
  const ulWithOlChild = '- a|\n  1. sub1\n  2. sub2\n- b';
  const olWithOlChild = '1. a|\n   1. sub1\n   2. sub2\n2. b';
  assert.equal(runFmt(ulWithOlChild, 'ol'), olWithOlChild);
  assert.equal(runFmt(olWithOlChild, 'ul'), ulWithOlChild);

  // 3-level nested list round-trip
  const ul3 = '- a|\n  - b\n    - c\n- d';
  const ol3 = '1. a|\n   - b\n     - c\n2. d';
  assert.equal(runFmt(ul3, 'ol'), ol3);
  assert.equal(runFmt(ol3, 'ul'), ul3);

  // List with soft-break continuation lines round-trip
  const ulCont = '- a|\n  续行内容\n- b';
  const olCont = '1. a|\n   续行内容\n2. b';
  assert.equal(runFmt(ulCont, 'ol'), olCont);
  assert.equal(runFmt(olCont, 'ul'), ulCont);

  // Blockquote nested list round-trip
  const qUl = '> - a|\n>   - sub\n> - b';
  const qOl = '> 1. a|\n>    - sub\n> 2. b';
  assert.equal(runFmt(qUl, 'ol'), qOl);
  assert.equal(runFmt(qOl, 'ul'), qUl);

  // Toggling off 1st-level or 2nd-level nested list clears only that sibling level
  assert.equal(runFmt('1. a|\n   - sub1\n2. b', 'ol'), 'a|\n   - sub1\nb');
  assert.equal(runFmt('1. a\n   1. sub1|\n   2. sub2\n2. b', 'ol'), '1. a\n   sub1|\n   sub2\n2. b');

  // Re-enabling 1st-level OL/UL after toggling off MUST jump over 2nd-level children and restore ALL 1st-level siblings
  const olOff = runFmt('1. a|\n   - sub1\n   - sub2\n2. b', 'ol');
  assert.equal(olOff, 'a|\n   - sub1\n   - sub2\nb');
  assert.equal(runFmt(olOff, 'ol'), '1. a|\n   - sub1\n   - sub2\n2. b');

  const ulOff = runFmt('- a|\n  - sub1\n  - sub2\n- b', 'ul');
  assert.equal(ulOff, 'a|\n  - sub1\n  - sub2\nb');
  assert.equal(runFmt(ulOff, 'ul'), '- a|\n  - sub1\n  - sub2\n- b');
});

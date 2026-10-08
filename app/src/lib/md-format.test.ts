import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyFormat, type FormatKind } from './md-format.ts';

/** `|` marks the selection ends (one `|` = a bare caret). */
function run(marked: string, kind: FormatKind): string {
  const first = marked.indexOf('|');
  const rest = marked.slice(first + 1);
  const second = rest.indexOf('|');
  const doc = second < 0 ? marked.replace('|', '') : marked.slice(0, first) + rest.replace('|', '');
  const from = first;
  const to = second < 0 ? first : first + second;
  const e = applyFormat(doc, from, to, kind);
  const out = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  return e.selFrom === e.selTo
    ? out.slice(0, e.selFrom) + '|' + out.slice(e.selFrom)
    : out.slice(0, e.selFrom) + '|' + out.slice(e.selFrom, e.selTo) + '|' + out.slice(e.selTo);
}

test('bold wraps a selection and comes back off', () => {
  assert.equal(run('a |word| b', 'bold'), 'a **|word|** b');
  assert.equal(run('a **|word|** b', 'bold'), 'a |word| b');
});

test('bold on a selection that includes its markers unwraps', () => {
  assert.equal(run('a |**word**| b', 'bold'), 'a |word| b');
});

test('a bare caret formats the word under it — but not a whole CJK clause', () => {
  assert.equal(run('hello wo|rld', 'bold'), 'hello **|world|**');
  assert.equal(run('这是重|点内容', 'bold'), '这是重**|**点内容');
  assert.equal(run('这是|重点|内容', 'bold'), '这是**|重点|**内容');
});

test('a bare caret with no word leaves the caret between the markers', () => {
  assert.equal(run('a | b', 'bold'), 'a **|** b');
  assert.equal(run('|', 'code'), '`|`');
});

test('italic and bold do not mistake each other', () => {
  assert.equal(run('**|word|**', 'italic'), '***|word|***');
  assert.equal(run('***|word|***', 'italic'), '**|word|**');
  assert.equal(run('***|word|***', 'bold'), '*|word|*');
  assert.equal(run('*|word|*', 'bold'), '***|word|***');
  assert.equal(run('*|word|*', 'italic'), '|word|');
});

test('strike and inline code toggle', () => {
  assert.equal(run('|x|', 'strike'), '~~|x|~~');
  assert.equal(run('~~|x|~~', 'strike'), '|x|');
  assert.equal(run('`|x|`', 'code'), '|x|');
});

test('link selects the url placeholder; a selected url becomes the target', () => {
  assert.equal(run('see |docs| now', 'link'), 'see [docs](|url|) now');
  assert.equal(run('|https://a.b/c|', 'link'), '[|](https://a.b/c)');
});

test('headings set, switch level, and toggle off', () => {
  assert.equal(run('Ti|tle', 'h2'), '## Title|');
  assert.equal(run('## Ti|tle', 'h3'), '### Title|');
  assert.equal(run('### Ti|tle', 'h3'), 'Title|');
});

test('heading only touches the caret line', () => {
  assert.equal(run('one\ntw|o\nthree', 'h1'), 'one\n# two|\nthree');
});

test('lists apply per line, number in order, skip blank lines, toggle off', () => {
  assert.equal(run('|a\nb|', 'ul'), '|- a\n- b|');
  assert.equal(run('|a\n\nb|', 'ol'), '|1. a\n\n2. b|');
  assert.equal(run('|- a\n- b|', 'ul'), '|a\nb|');
});

test('switching list type replaces the marker instead of stacking', () => {
  assert.equal(run('|- a\n- b|', 'ol'), '|1. a\n2. b|');
  assert.equal(run('|1. a|', 'task'), '|- [ ] a|');
  assert.equal(run('|- [x] a|', 'task'), '|a|');
  assert.equal(run('  |- a|', 'task'), '|  - [ ] a|');
});

test('a selection ending at a line start does not drag the next line in', () => {
  assert.equal(run('|a\n|b', 'quote'), '|> a|\nb');
});

test('quote toggles', () => {
  assert.equal(run('|> a\n> b|', 'quote'), '|a\nb|');
});

test('code block wraps whole lines and unwraps', () => {
  assert.equal(run('x\n|let a = 1;|\ny', 'codeblock'), 'x\n```|\nlet a = 1;\n```\ny');
  assert.equal(run('|```\nlet a = 1;\n```|', 'codeblock'), '|let a = 1;|');
});

test('#360: a heading on an empty first line of a multi-line document', () => {
  assert.equal(run('|\nsecond line', 'h1'), '# |\nsecond line');
  assert.equal(run('|\n\nthird', 'h2'), '## |\n\nthird');
  // the other lines the reporter checked keep working
  assert.equal(run('|', 'h1'), '# |');
  assert.equal(run('first\n|\nthird', 'h1'), 'first\n# |\nthird');
  assert.equal(run('|first\nsecond', 'h1'), '# first|\nsecond');
});

test('#360: list and quote prefixes on an empty first line too', () => {
  assert.equal(run('|\nsecond', 'ul'), '- |\nsecond');
  assert.equal(run('|\nsecond', 'quote'), '> |\nsecond');
});

test('bold across paragraphs wraps each line on its own (emphasis cannot cross a line break)', () => {
  assert.equal(
    run('|段落A\n\n段落B\n\n段落C 最后|一段', 'bold'),
    '|**段落A**\n\n**段落B**\n\n**段落C 最后**|一段',
  );
  // …and the same command takes it off again.
  assert.equal(run('|**段落A**\n\n**段落B**|', 'bold'), '|段落A\n\n段落B|');
});

test('multi-line inline formats leave line prefixes outside the markers', () => {
  assert.equal(run('|- one\n- two\n## Title|', 'bold'), '|- **one**\n- **two**\n## **Title**|');
  assert.equal(run('|1. a\n2. b|', 'strike'), '|1. ~~a~~\n2. ~~b~~|');
});

test('mixed lines are completed, not toggled off; italic does not mistake bold', () => {
  assert.equal(run('|**a**\nb|', 'bold'), '|**a**\n**b**|');
  assert.equal(run('|**a**\n**b**|', 'italic'), '|***a***\n***b***|');
});

test('code block toggles off with the caret on a fence line or inside the block', () => {
  // F-6A: the wrap leaves the caret on the opening fence; a second press unwraps.
  assert.equal(run('line one|', 'codeblock'), '```|\nline one\n```');
  assert.equal(run('```|\nline one\n```', 'codeblock'), '|line one');
  assert.equal(run('a\n```js\nlet |x = 1;\n```\nb', 'codeblock'), 'a\nlet |x = 1;\nb');
  assert.equal(run('```\nx\n```|', 'codeblock'), 'x|');
  assert.equal(run('~~~\n|x|\n~~~', 'codeblock'), '|x|');
  assert.equal(run('```|\n```', 'codeblock'), '|');
  // Between two blocks is in neither: it wraps.
  assert.equal(run('```\na\n```\nmid|\n```\nb\n```', 'codeblock'), '```\na\n```\n```|\nmid\n```\n```\nb\n```');
  // A ``` inside a ~~~ block does not end it.
  assert.equal(run('~~~\n```\nx|\n~~~', 'codeblock'), '```\nx|');
});

test('a bare caret inside an existing bold / italic span removes it, CJK too', () => {
  // F-6B
  assert.equal(run('这是**粗|体**文字', 'bold'), '这是粗|体文字');
  assert.equal(run('这是*斜|体*文字', 'italic'), '这是斜|体文字');
  assert.equal(run('这是**粗体|**文字', 'bold'), '这是粗体|文字');
  assert.equal(run('a **two wo|rds** b', 'bold'), 'a two wo|rds b');
  // Bold is not italic, and the space between two spans is in neither.
  assert.equal(run('这是**粗|体**文字', 'italic'), '这是**粗*|*体**文字');
  assert.equal(run('**甲** 中|间 **乙**', 'bold'), '**甲** 中**|**间 **乙**');
  // Adding bold to CJK still does not swallow the clause.
  assert.equal(run('这是重|点内容', 'bold'), '这是重**|**点内容');
});

/** Like `run`, for Tab / Shift+Tab; null when the editor's own indent applies. */
async function tab(marked: string, outdent = false): Promise<string | null> {
  const { listIndentEdit } = await import('./md-format.ts');
  const first = marked.indexOf('|');
  const rest = marked.slice(first + 1);
  const second = rest.indexOf('|');
  const doc = second < 0 ? marked.replace('|', '') : marked.slice(0, first) + rest.replace('|', '');
  const e = listIndentEdit(doc, first, second < 0 ? first : first + second, outdent);
  if (!e) return null;
  const out = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  return e.selFrom === e.selTo
    ? out.slice(0, e.selFrom) + '|' + out.slice(e.selFrom)
    : out.slice(0, e.selFrom) + '|' + out.slice(e.selFrom, e.selTo) + '|' + out.slice(e.selTo);
}

test('Tab nests an ordered item at its marker width and renumbers both levels', async () => {
  // F-7: two spaces under "1. " is a lazy continuation, not a sub-list.
  assert.equal(await tab('1. one\n2. t|wo\n3. three'), '1. one\n   1. t|wo\n2. three');
  assert.equal(await tab('9. a\n10. b\n11. c|'), '9. a\n10. b\n    1. c|');
  // Joining an existing sub-list continues its numbers.
  assert.equal(await tab('1. one\n   1. a\n2. b|\n3. c'), '1. one\n   1. a\n   2. b|\n2. c');
  // Bullets keep two spaces.
  assert.equal(await tab('- a\n- b|'), '- a\n  - b|');
  // A bullet under a number goes to the number's content column.
  assert.equal(await tab('1. one\n- x|'), '1. one\n   - x|');
});

test('Shift+Tab lifts a nested item back out and renumbers', async () => {
  assert.equal(await tab('1. one\n   1. t|wo\n2. three', true), '1. one\n2. t|wo\n3. three');
  assert.equal(await tab('1. one\n   1. a|\n   2. b\n2. c', true), '1. one\n2. a|\n   1. b\n3. c');
  assert.equal(await tab('- a\n  - b|', true), '- a\n- b|');
});

test('Tab defers to the editor where there is nothing to nest under', async () => {
  assert.equal(await tab('plain |text'), null);
  assert.equal(await tab('1. fi|rst'), null);
  assert.equal(await tab('1. top|', true), null);
});

test('Tab on a selection of items moves them together', async () => {
  assert.equal(await tab('1. a\n|2. b\n3. c|'), '1. a\n   |1. b\n   2. c|');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWordClipboardHtml } from './word-clipboard.ts';
import { stripMarkdownFormatting } from './clean-ai.ts';
import { renderMarkdown } from './markdown.ts';

test('strips .katex-html visual layer and promotes clean MathML for Word equations (#427)', () => {
  const rawHtml = `
    <p>行内公式 <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">x</span><span class="msupsub">2</span></span></span></span> 测试</p>
    <div class="math-block"><span class="katex-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></math></span><span class="katex-html" aria-hidden="true">E=mc2</span></span></span></div>
  `;

  const out = buildWordClipboardHtml(rawHtml);
  assert.ok(!out.includes('katex-html'), '.katex-html should be stripped');
  assert.ok(out.includes('<math xmlns="http://www.w3.org/1998/Math/MathML"'));
  assert.ok(out.includes('<msup><mi>x</mi><mn>2</mn></msup>'));
  assert.ok(out.includes('display="block"'));
});

test('strips code block toolbar headers and joins .cb-line spans with <br> (#427)', () => {
  const rawHtml = `
    <div class="code-block" data-lang="ts">
      <div class="code-block__header">
        <span class="code-block__lang">ts</span>
        <button class="code-block__copy">Copy</button>
      </div>
      <pre><code class="hljs"><span class="cb-line" data-line="1">const a = 1;</span>\n<span class="cb-line" data-line="2">const b = 2;</span></code></pre>
    </div>
  `;

  const out = buildWordClipboardHtml(rawHtml);
  assert.ok(!out.includes('code-block__header'), 'header bar should be stripped');
  assert.ok(!out.includes('code-block__copy'), 'copy button should be stripped');
  assert.ok(out.includes('const a = 1;<br>const b = 2;'), 'lines should be joined with <br>');
});

test('converts <ol> and <ul> into explicit hanging-indent paragraphs and preserves (1)(2) sub-items (#427, #432)', () => {
  const rawHtml = `
    <ol>
      <li>第一项<br>（1）子项一<br>（2）子项二</li>
      <li><p>第二项</p><p>（1）段落子项A</p><p>（2）段落子项B</p></li>
    </ol>
    <p>中间段落</p>
    <ol><li>新列表第一项</li></ol>
    <ul><li class="task-list-item"><input type="checkbox" checked>已完成</li><li class="task-list-item"><input type="checkbox">未完成</li></ul>
    <table><thead><tr><th>列A</th></tr></thead><tbody><tr><td>值1</td></tr></tbody></table>
  `;

  const out = buildWordClipboardHtml(rawHtml);
  // Both <ol> blocks start at 1. with 24pt left margin and -18pt hanging indent (6pt inside left border)
  assert.ok(out.includes('margin:3pt 0 3pt 24pt;text-indent:-18pt;">1. 第一项</p>'));
  assert.ok(out.includes('margin:3pt 0 3pt 24pt;">（1）子项一</p>'));
  assert.ok(out.includes('margin:3pt 0 3pt 24pt;">（2）子项二</p>'));
  assert.ok(out.includes('margin:3pt 0 3pt 24pt;text-indent:-18pt;">2. 第二项</p>'));
  assert.ok(out.includes('margin:3pt 0 3pt 24pt;">（1）段落子项A</p>'));
  assert.ok(out.includes('margin:3pt 0 3pt 24pt;">（2）段落子项B</p>'));
  assert.ok(out.includes('margin:3pt 0 3pt 24pt;text-indent:-18pt;">1. 新列表第一项</p>'));
  assert.ok(!/<ol\b/i.test(out), 'raw <ol> should be converted to explicit paragraphs');
  assert.ok(out.includes('☑ 已完成'));
  assert.ok(out.includes('☐ 未完成'));
  assert.ok(!out.includes('<input'));
  assert.ok(out.includes('border-collapse: collapse'));
  assert.ok(out.includes('background: #ffe7cc'));
  assert.ok(out.includes('xmlns:w="urn:schemas-microsoft-com:office:word"'));
});

test('strips backslash escapes in plain-text and Word clipboard copy while preserving code spans', () => {
  const md = [
    '\\# 不是标题',
    '\\*不是斜体\\* 且 \\*\\*不是粗体\\*\\*',
    '1\\. 不是有序列表',
    '\\- 不是无序列表',
    '\\＃ 全角井号转义',
    '行内代码 `\\# 保留反斜杠` 测试',
    '```js',
    'const s = "\\# 保留代码块反斜杠";',
    '```',
  ].join('\n');

  const plain = stripMarkdownFormatting(md);
  assert.ok(plain.includes('# 不是标题'), 'escaped # should become literal # without backslash');
  assert.ok(!plain.includes('\\# 不是标题'), 'backslash before # should be removed in plain text');
  assert.ok(plain.includes('*不是斜体* 且 **不是粗体**'), 'escaped * should become literal * without backslash');
  assert.ok(plain.includes('1. 不是有序列表'), 'escaped 1\\. should become literal 1. without backslash');
  assert.ok(plain.includes('- 不是无序列表'), 'escaped \\- should become literal - without backslash');
  assert.ok(plain.includes('＃ 全角井号转义'), 'escaped fullwidth ＃ should become literal ＃ without backslash');
  assert.ok(plain.includes('\\# 保留反斜杠'), 'inline code should keep backslash');
  assert.ok(plain.includes('const s = "\\# 保留代码块反斜杠";'), 'fenced code block should keep backslash');

  const wordHtml = buildWordClipboardHtml(renderMarkdown(md));
  assert.ok(wordHtml.includes('># 不是标题') && !wordHtml.includes('<h1'), 'Word HTML should render literal # without backslash or <h1>');
  assert.ok(!wordHtml.includes('\\# 不是标题'), 'Word HTML should not contain \\# outside code');
  assert.ok(wordHtml.includes('＃ 全角井号转义'), 'Word HTML should unescape fullwidth \\＃');
  assert.ok(wordHtml.includes('\\# 保留反斜杠'), 'Word HTML inline code should preserve \\#');
});



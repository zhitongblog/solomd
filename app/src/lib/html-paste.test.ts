import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardHtmlToMarkdown } from './html-paste.ts';
import { clipboardTableToMarkdown } from './table-paste.ts';

test('clipboardHtmlToMarkdown (#308): converts headings, bold, italic, strike, highlight, inline code, and links', () => {
  const html = `
    <!--StartFragment-->
    <h2>Section Title</h2>
    <p>Hello <strong>world</strong>, this is <em>italic</em>, <del>deleted</del>, <mark>highlighted</mark>, and <code>const x = 1</code> with a <a href="https://solomd.app">SoloMD link</a>.</p>
    <!--EndFragment-->
  `;
  const md = clipboardHtmlToMarkdown(html, 'Section Title\nHello world...');
  assert.equal(
    md,
    '## Section Title\n\nHello **world**, this is *italic*, ~~deleted~~, ==highlighted==, and `const x = 1` with a [SoloMD link](https://solomd.app).',
  );
});

test('clipboardHtmlToMarkdown (#308): converts nested unordered/ordered lists and task list checkboxes', () => {
  const html = `
    <ul>
      <li>First item
        <ul>
          <li>Nested bullet</li>
        </ul>
      </li>
      <li><input type="checkbox" checked> Done task</li>
      <li><input type="checkbox"> Pending task</li>
    </ul>
    <ol start="3">
      <li>Third item</li>
      <li>Fourth item</li>
    </ol>
  `;
  const md = clipboardHtmlToMarkdown(html, 'First item');
  assert.equal(
    md,
    '- First item\n  - Nested bullet\n- [x] Done task\n- [ ] Pending task\n\n3. Third item\n4. Fourth item',
  );
});

test('clipboardHtmlToMarkdown (#308): converts fenced code blocks with language class and blockquotes', () => {
  const html = `
    <blockquote><p>Quoted wisdom</p></blockquote>
    <pre><code class="language-typescript">function add(a: number, b: number) {\n  return a + b;\n}</code></pre>
  `;
  const md = clipboardHtmlToMarkdown(html, 'Quoted wisdom');
  assert.equal(
    md,
    '> Quoted wisdom\n\n```typescript\nfunction add(a: number, b: number) {\n  return a + b;\n}\n```',
  );
});

test('clipboardHtmlToMarkdown (#308): converts superscript and subscript tags to ^sup^ and ~sub~', () => {
  const html = `<p>H<sub>2</sub>O and E = mc<sup>2</sup></p>`;
  const md = clipboardHtmlToMarkdown(html, 'H2O and E = mc2');
  assert.equal(md, 'H~2~O and E = mc^2^');
});

test('clipboardHtmlToMarkdown (#308): returns null for VS Code / syntax-highlighted span-only HTML so plain paste is preserved', () => {
  const vscodeHtml = `<div data-metadata="vscode-editor" style="font-family: monospace;"><span style="color: #569cd6;">const</span> <span style="color: #9cdcfe;">a</span> = 1;</div>`;
  assert.equal(clipboardHtmlToMarkdown(vscodeHtml, 'const a = 1;'), null);
});

test('clipboardHtmlToMarkdown (#308): returns null when plainText is already raw Markdown', () => {
  const html = `<p># Heading</p><p>Some **bold** text</p>`;
  const plain = `# Heading\n\nSome **bold** text`;
  assert.equal(clipboardHtmlToMarkdown(html, plain), null);
});

/** Outlook-style clipboard HTML (message body with a table in the middle). */
const OUTLOOK_HTML = `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><style><!--
p.MsoNormal, li.MsoNormal {margin:0cm; font-size:11.0pt; font-family:"Calibri",sans-serif;}
--></style></head><body lang=RU style='word-wrap:break-word'><!--StartFragment--><div class=WordSection1><p class=MsoNormal>Здравствуйте, Алина!<o:p></o:p></p><p class=MsoNormal><o:p>&nbsp;</o:p></p><p class=MsoNormal>Для удобства фиксирую итоги нашего разговора от 9 ноября.<o:p></o:p></p><p class=MsoNormal><b>Доступы и PAM<o:p></o:p></b></p><ul style='margin-top:0cm' type=disc><li class=MsoListParagraph style='mso-list:l0 level1 lfo1'>PAM нужен системным администраторам.<o:p></o:p></li><li class=MsoListParagraph style='mso-list:l0 level1 lfo1'>PAM нужен для переноса между средами.<o:p></o:p></li></ul><p class=MsoNormal><b>Поддержка 1Формы в 2027 году<o:p></o:p></b></p><p class=MsoNormal>Мы предложили три варианта:<o:p></o:p></p><table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0><tr><td width=62><p class=MsoNormal><b>Вариант<o:p></o:p></b></p></td><td width=300><p class=MsoNormal><b>Условия<o:p></o:p></b></p></td><td width=100><p class=MsoNormal><b>Стоимость<o:p></o:p></b></p></td></tr><tr><td><p class=MsoNormal>1<o:p></o:p></p></td><td><p class=MsoNormal>Оставить
как есть: Олег продолжает работу<o:p></o:p></p></td><td><p class=MsoNormal>без
изменений<o:p></o:p></p></td></tr><tr><td><p class=MsoNormal>2<o:p></o:p></p></td><td><p class=MsoNormal>Специалист
с загрузкой 50%<o:p></o:p></p></td><td><p class=MsoNormal>157 тыс.
руб.<o:p></o:p></p></td></tr></table><p class=MsoNormal><o:p>&nbsp;</o:p></p><p class=MsoNormal>С уважением,<o:p></o:p></p><p class=MsoNormal>Сергей Сафонов<o:p></o:p></p></div><!--EndFragment--></body></html>`;

const OUTLOOK_PLAIN = `Здравствуйте, Алина!\r\n\r\nДля удобства фиксирую итоги нашего разговора от 9 ноября.\r\nДоступы и PAM\r\n PAM нужен системным администраторам.\r\n PAM нужен для переноса между средами.\r\nПоддержка 1Формы в 2027 году\r\nМы предложили три варианта:\r\nВариант\tУсловия\tСтоимость\r\n1\tОставить как есть: Олег продолжает работу\tбез изменений\r\n2\tСпециалист с загрузкой 50%\t157 тыс. руб.\r\n\r\nС уважением,\r\nСергей Сафонов`;

test('Outlook message with a table in the middle keeps all content (#308)', () => {
  // The table-only handler must step aside for a full document…
  assert.equal(clipboardTableToMarkdown(OUTLOOK_HTML, OUTLOOK_PLAIN), null);
  // …and the general converter produces the whole message.
  const md = clipboardHtmlToMarkdown(OUTLOOK_HTML, OUTLOOK_PLAIN)!;
  assert.match(md, /^Здравствуйте, Алина!/);
  assert.match(md, /\*\*Доступы и PAM\*\*/);
  assert.match(md, /- PAM нужен системным администраторам\./);
  assert.match(md, /\| Вариант \| Условия \| Стоимость \|/);
  assert.match(md, /\| 1 \| Оставить как есть: Олег продолжает работу \| без изменений \|/);
  assert.match(md, /С уважением,\n\nСергей Сафонов$/);
  assert.doesNotMatch(md, /<br>/);
});

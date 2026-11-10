import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardHtmlToMarkdown } from './html-paste.ts';

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

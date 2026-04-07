import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { writeText, writeHtml } from '@tauri-apps/plugin-clipboard-manager';
import { markdownToDocxBlob } from '../lib/docx-export';
import { markdownToPdfBlob } from '../lib/pdf-export';
import { renderMarkdown } from '../lib/markdown';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';

const HTML_TEMPLATE = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<style>
  :root {
    --brand: #ff9f40;
    --brand-soft: #ffe7cc;
    --ink: #1f1d1a;
    --ink-muted: #6a6560;
    --rule: #e6e2d8;
    --paper: #fbfaf6;
    --code-bg: #f3efe7;
    --code-key: #ff9f40;
    --row-alt: #f7f4ec;
  }
  html, body { background: var(--paper); }
  body {
    max-width: 760px;
    margin: 56px auto;
    padding: 0 56px 96px;
    font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto,
      "Helvetica Neue", Arial,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
      "Noto Sans CJK SC", "WenQuanYi Micro Hei",
      system-ui, sans-serif;
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  h1, h2, h3, h4, h5, h6 {
    line-height: 1.25;
    font-weight: 700;
    color: var(--ink);
    margin: 2em 0 0.6em;
  }
  h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
  h1 {
    font-size: 2.15em;
    border-bottom: 2px solid var(--brand);
    padding-bottom: .35em;
    letter-spacing: -0.01em;
  }
  h2 {
    font-size: 1.55em;
    border-bottom: 1px solid var(--rule);
    padding-bottom: .25em;
  }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1.05em; }
  h5, h6 { font-size: 1em; color: var(--ink-muted); }
  p { margin: .9em 0; }
  a {
    color: var(--brand);
    text-decoration: none;
    border-bottom: 1px solid var(--brand-soft);
  }
  a:hover { border-bottom-color: var(--brand); }
  strong { color: var(--ink); }
  em { color: var(--ink); }
  code {
    font-family: "JetBrains Mono", "SF Mono", "Menlo", "Consolas",
      "Liberation Mono", monospace;
    font-size: .9em;
    background: var(--code-bg);
    padding: .15em .45em;
    border-radius: 4px;
    color: #8a4a00;
  }
  pre {
    background: var(--code-bg);
    padding: 16px 20px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 1.2em 0;
    line-height: 1.55;
    border: 1px solid var(--rule);
  }
  pre code {
    background: transparent;
    padding: 0;
    color: var(--ink);
    font-size: .88em;
  }
  pre code .hljs-keyword,
  pre code .hljs-built_in,
  pre code .hljs-tag { color: var(--code-key); }
  blockquote {
    border-left: 4px solid var(--brand);
    background: linear-gradient(to right, var(--brand-soft) 0%, transparent 40%);
    margin: 1.4em 0;
    padding: .5em 1.2em;
    color: var(--ink-muted);
    font-style: italic;
    border-radius: 0 4px 4px 0;
  }
  blockquote p { margin: .4em 0; }
  ul, ol { padding-left: 1.8em; margin: .9em 0; }
  li { margin: .3em 0; }
  li > p { margin: .3em 0; }
  table {
    border-collapse: collapse;
    margin: 1.4em 0;
    width: 100%;
    font-size: .95em;
  }
  th, td {
    border: 1px solid var(--rule);
    padding: 8px 14px;
    text-align: left;
  }
  thead th {
    background: var(--brand-soft);
    color: var(--ink);
    font-weight: 700;
    border-bottom: 2px solid var(--brand);
  }
  tbody tr:nth-child(even) { background: var(--row-alt); }
  hr {
    border: none;
    border-top: 1px solid var(--rule);
    margin: 2.4em 0;
  }
  img {
    max-width: 100%;
    border-radius: 6px;
    margin: 1.2em 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .08);
  }
  .katex-display { overflow-x: auto; overflow-y: hidden; margin: 1.2em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );
}

/** Strip Markdown syntax to produce plain prose. */
function stripMarkdown(src: string): string {
  return src
    // Remove fenced code blocks (keep contents)
    .replace(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g, '$1')
    // Inline code: `x` -> x
    .replace(/`([^`]+)`/g, '$1')
    // Images: ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Links: [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Bold/italic: **x** _x_ *x* __x__ -> x
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    // Strikethrough
    .replace(/~~(.+?)~~/g, '$1')
    // Headings: # x -> x
    .replace(/^#{1,6}\s+/gm, '')
    // Blockquotes: > x -> x
    .replace(/^>\s?/gm, '')
    // List markers
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .trim();
}

export function useExport() {
  const tabs = useTabsStore();
  const toasts = useToastsStore();

  function activeOr(): { content: string; baseName: string } | null {
    const tab = tabs.activeTab;
    if (!tab) {
      toasts.error('No active document');
      return null;
    }
    return {
      content: tab.content,
      baseName: tab.fileName.replace(/\.[^.]+$/, ''),
    };
  }

  async function exportHtml() {
    const ctx = activeOr();
    if (!ctx) return;
    const path = await saveDialog({
      defaultPath: `${ctx.baseName}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (!path) return;
    const html = HTML_TEMPLATE(ctx.baseName, renderMarkdown(ctx.content));
    try {
      await invoke('write_file', { path, content: html, encoding: 'UTF-8' });
      toasts.success('Exported to HTML');
    } catch (e) {
      toasts.error(`Export failed: ${e}`);
    }
  }

  async function exportDocx() {
    const ctx = activeOr();
    if (!ctx) return;
    const path = await saveDialog({
      defaultPath: `${ctx.baseName}.docx`,
      filters: [{ name: 'Word Document', extensions: ['docx'] }],
    });
    if (!path) return;
    try {
      const blob = await markdownToDocxBlob(ctx.content, ctx.baseName);
      const buffer = new Uint8Array(await blob.arrayBuffer());
      // Tauri 2 serializes Uint8Array as a number array which Rust accepts as Vec<u8>.
      await invoke('write_binary_file', { path, data: Array.from(buffer) });
      toasts.success('Exported to DOCX');
    } catch (e) {
      console.error(e);
      toasts.error(`DOCX export failed: ${e}`);
    }
  }

  /** Native-feel PDF export: build a real .pdf file via html2pdf.js. */
  async function exportPdf() {
    const ctx = activeOr();
    if (!ctx) return;
    const path = await saveDialog({
      defaultPath: `${ctx.baseName}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!path) return;
    const tid = toasts.info('Generating PDF…', 0);
    try {
      const blob = await markdownToPdfBlob(ctx.content, ctx.baseName);
      const buffer = new Uint8Array(await blob.arrayBuffer());
      await invoke('write_binary_file', { path, data: Array.from(buffer) });
      toasts.dismiss(tid);
      toasts.success('Exported to PDF');
    } catch (e) {
      console.error(e);
      toasts.dismiss(tid);
      toasts.error(`PDF export failed: ${e}`);
    }
  }

  /** Fallback: open the system print dialog (still useful as backup). */
  function exportPdfPrint() {
    document.body.classList.add('printing');
    window.print();
    setTimeout(() => document.body.classList.remove('printing'), 500);
  }

  async function copyAsHtml() {
    const ctx = activeOr();
    if (!ctx) return;
    const html = renderMarkdown(ctx.content);
    try {
      await writeHtml(html);
      toasts.success('Copied as HTML');
    } catch (e) {
      // Fallback: write plain HTML string as text
      try {
        await writeText(html);
        toasts.success('Copied HTML source');
      } catch (e2) {
        toasts.error(`Copy failed: ${e2}`);
      }
    }
  }

  async function copyAsPlainText() {
    const ctx = activeOr();
    if (!ctx) return;
    const text = stripMarkdown(ctx.content);
    try {
      await writeText(text);
      toasts.success('Copied as plain text');
    } catch (e) {
      toasts.error(`Copy failed: ${e}`);
    }
  }

  async function copyAsMarkdown() {
    const ctx = activeOr();
    if (!ctx) return;
    try {
      await writeText(ctx.content);
      toasts.success('Copied as Markdown');
    } catch (e) {
      toasts.error(`Copy failed: ${e}`);
    }
  }

  return {
    exportHtml,
    exportDocx,
    exportPdf,
    exportPdfPrint,
    copyAsHtml,
    copyAsPlainText,
    copyAsMarkdown,
  };
}

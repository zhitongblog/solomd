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
  body {
    max-width: 760px;
    margin: 40px auto;
    padding: 0 24px 80px;
    font: 16px/1.7 -apple-system, "Segoe UI", Inter, Roboto, system-ui, sans-serif;
    color: #1a1a1a;
    background: #fafaf7;
  }
  h1, h2, h3, h4 { line-height: 1.25; }
  h1 { font-size: 2em; border-bottom: 1px solid #e5e3dc; padding-bottom: .3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e5e3dc; padding-bottom: .25em; }
  a { color: #ff9f40; }
  code { font-family: "JetBrains Mono", Menlo, Consolas, monospace; background: #f0eee8; padding: .15em .4em; border-radius: 4px; }
  pre { background: #f0eee8; padding: 14px 16px; border-radius: 6px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid #ff9f40; margin: 1em 0; padding: .2em 1em; color: #666; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #e5e3dc; padding: 6px 12px; }
  hr { border: none; border-top: 1px solid #e5e3dc; margin: 2em 0; }
  img { max-width: 100%; }
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

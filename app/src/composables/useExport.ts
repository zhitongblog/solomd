import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { EditorView } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { writeText, writeHtml, writeImage } from '@tauri-apps/plugin-clipboard-manager';
import { Image } from '@tauri-apps/api/image';
import { documentDir, join } from '@tauri-apps/api/path';
import { isIOS } from '../lib/platform';
import { markdownToDocxBlob } from '../lib/docx-export';
import { markdownToPdfBlob } from '../lib/pdf-export';
import { markdownToImageBlob } from '../lib/image-export';
import { renderMarkdown, extractImageRoot } from '../lib/markdown';
import { rewriteLinkUrls, rewriteImageUrls } from '../lib/image-resolve';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { track } from '../lib/telemetry';
import {
  resolvePdfOptions,
  userTouchedPdfDefaults,
  buildPrintStyle,
} from '../lib/pdf-options';

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

/**
 * Read the selected Markdown source from a CodeMirror editor.
 *
 * Used by all four Copy-as-* paths. We do NOT require `.cm-editor.cm-focused`:
 * the toolbar's direct Copy button uses `@click`, which fires AFTER the
 * editor loses focus on mousedown — by the time we run, the focused-class is
 * already gone and the selection would silently fall through to whole-doc.
 *
 * Instead: read the current window selection, then walk up to confirm it
 * lives inside *some* `.cm-editor`. That stays correct whether the trigger
 * was a keyboard shortcut (focus preserved), a dropdown menu item using
 * `@mousedown.prevent` (focus preserved), or a plain `@click` button (focus
 * lost — but the selection range survives).
 */
/**
 * Read the active editor selection straight from CodeMirror's `EditorView`
 * state — the source of truth. This is required for **rectangular / column
 * selections** (#90): those are *multiple* selection ranges, which Chromium /
 * WebView2's single-range `window.getSelection()` can't represent, so the old
 * DOM-based reader saw a collapsed/empty selection and callers fell back to
 * the *whole document* ("select a block, copy → got everything"). Reading the
 * ranges from CM state also survives the editor losing DOM focus when a
 * toolbar Copy button is clicked (CM keeps the selection in state).
 *
 * Ranges are joined with the document's own line break, matching CodeMirror's
 * native multi-selection copy.
 */
function cmSelectionText(): string | null {
  const editors = Array.from(document.querySelectorAll<HTMLElement>('.cm-editor'));
  if (!editors.length) return null;
  // Prefer the focused editor; fall back to any editor that holds a non-empty
  // selection (covers blur-on-toolbar-click and split panes / tiles).
  const focused = document.querySelector<HTMLElement>('.cm-editor.cm-focused');
  const ordered = focused ? [focused, ...editors.filter((e) => e !== focused)] : editors;
  for (const el of ordered) {
    const view = EditorView.findFromDOM(el);
    if (!view) continue;
    const parts: string[] = [];
    for (const r of view.state.selection.ranges) {
      if (r.empty) continue;
      parts.push(view.state.sliceDoc(r.from, r.to));
    }
    if (parts.length) {
      const text = parts.join(view.state.lineBreak);
      return text.trim() ? text : null;
    }
  }
  return null;
}

function getEditorSelectionMd(): string | null {
  if (typeof document === 'undefined') return null;
  // Primary: CodeMirror state (handles normal + rectangular selections).
  const cmText = cmSelectionText();
  if (cmText) return cmText;
  // Fallback: DOM selection — for rendered text in the preview pane, which
  // is not a CodeMirror editor.
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  // Walk up from the selection's common ancestor to find a `.cm-editor`.
  // Use Element.closest where available; fall back to manual walk for text
  // nodes (which don't have closest()).
  let node: Node | null = range.commonAncestorContainer;
  while (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const inEditor = (node as Element | null)?.closest?.('.cm-editor');
  if (!inEditor) return null;
  const text = sel.toString();
  return text.trim() ? text : null;
}

export function useExport() {
  const tabs = useTabsStore();
  const toasts = useToastsStore();
  const settings = useSettingsStore();

  function activeOr(): { content: string; baseName: string; filePath?: string } | null {
    const tab = tabs.activeTab;
    if (!tab) {
      toasts.error('No active document');
      return null;
    }
    // Tolerate stale persisted state from older versions where the
    // field was named `title` instead of `fileName`.
    const name = (tab as { fileName?: string; title?: string }).fileName
      ?? (tab as { title?: string }).title
      ?? 'Untitled';
    return {
      content: tab.content ?? '',
      baseName: name.replace(/\.[^.]+$/, ''),
      filePath: tab.filePath,
    };
  }

  /**
   * Source for "Copy as X" — the editor selection if present, else the
   * whole active document. Returns the source plus a flag callers use to
   * customize the success toast.
   */
  function copySource(): { source: string; isSelection: boolean } | null {
    const ctx = activeOr();
    if (!ctx) return null;
    const sel = getEditorSelectionMd();
    return sel !== null
      ? { source: sel, isSelection: true }
      : { source: ctx.content, isSelection: false };
  }

  // iOS save flow: Tauri's saveDialog returns a `file:///…` URL that
  // `write_file` can't write to (Rust's `std::fs::write` treats the URL
  // literally → ENOENT; even if we strip `file://`, security-scoped paths
  // outside our sandbox are unreachable without NSURL's
  // startAccessingSecurityScopedResource). Instead, on iOS we write to the
  // app's own Documents directory — UIFileSharingEnabled + LSSupports
  // OpeningDocumentsInPlace surface that folder under "On My iPhone › SoloMD"
  // in the Files app, so users can move/iCloud-sync from there.
  async function pickWritePath(
    filename: string,
    filters: { name: string; extensions: string[] }[],
  ): Promise<string | null> {
    if (isIOS()) {
      const dir = await documentDir();
      return await join(dir, filename);
    }
    return await saveDialog({ defaultPath: filename, filters });
  }

  function iosSavedToast(filename: string): string {
    return `Saved to On My iPhone › SoloMD › ${filename}`;
  }

  // Modern Clipboard API works on all desktops and on iOS 16+ WKWebView,
  // and supports rich types (HTML, PNG) — unlike Tauri's plugin-clipboard-
  // manager iOS implementation which only ships `writeText`.
  function hasNativeClipboardWrite(): boolean {
    return typeof navigator !== 'undefined'
      && typeof navigator.clipboard !== 'undefined'
      && typeof navigator.clipboard.write === 'function'
      && typeof (window as unknown as { ClipboardItem?: unknown }).ClipboardItem !== 'undefined';
  }

  async function exportHtml() {
    track('file_exported', { format: 'html' });
    const ctx = activeOr();
    if (!ctx) return;
    const filename = `${ctx.baseName}.html`;
    const path = await pickWritePath(filename, [{ name: 'HTML', extensions: ['html'] }]);
    if (!path) return;
    // v4.3.0 issue #77 — rewrite local-file `href` / `src` URLs to
    // absolute `file://` paths so the exported HTML doesn't bake in
    // `http://tauri.localhost/...` references that break when shared.
    const imageRoot = extractImageRoot(ctx.content);
    const body = rewriteLinkUrls(
      rewriteImageUrls(renderMarkdown(ctx.content), imageRoot, ctx.filePath),
      imageRoot,
      ctx.filePath,
    );
    const html = HTML_TEMPLATE(ctx.baseName, body);
    try {
      await invoke('write_file', { path, content: html, encoding: 'UTF-8' });
      toasts.success(isIOS() ? iosSavedToast(filename) : 'Exported to HTML');
    } catch (e) {
      toasts.error(`Export failed: ${e}`);
    }
  }

  async function exportDocx() {
    track('file_exported', { format: 'docx' });
    const ctx = activeOr();
    if (!ctx) return;
    const filename = `${ctx.baseName}.docx`;
    const path = await pickWritePath(filename, [{ name: 'Word Document', extensions: ['docx'] }]);
    if (!path) return;
    try {
      const blob = await markdownToDocxBlob(ctx.content, ctx.baseName, ctx.filePath);
      const buffer = new Uint8Array(await blob.arrayBuffer());
      // Tauri 2 serializes Uint8Array as a number array which Rust accepts as Vec<u8>.
      await invoke('write_binary_file', { path, data: Array.from(buffer) });
      toasts.success(isIOS() ? iosSavedToast(filename) : 'Exported to DOCX');
    } catch (e) {
      console.error(e);
      toasts.error(`DOCX export failed: ${e}`);
    }
  }

  /** Native-feel PDF export: build a real .pdf file via html2pdf.js. */
  async function exportPdf() {
    track('file_exported', { format: 'pdf' });
    const ctx = activeOr();
    if (!ctx) return;
    const filename = `${ctx.baseName}.pdf`;
    const path = await pickWritePath(filename, [{ name: 'PDF', extensions: ['pdf'] }]);
    if (!path) return;
    const tid = toasts.info('Generating PDF…', 0);
    try {
      const pdfOpts = resolvePdfOptions(
        settings.pdfDefaults,
        ctx.content,
        userTouchedPdfDefaults(settings.pdfDefaults),
      );
      const blob = await markdownToPdfBlob(ctx.content, ctx.baseName, pdfOpts, ctx.filePath);
      const buffer = new Uint8Array(await blob.arrayBuffer());
      await invoke('write_binary_file', { path, data: Array.from(buffer) });
      toasts.dismiss(tid);
      toasts.success(isIOS() ? iosSavedToast(filename) : 'Exported to PDF');
    } catch (e) {
      console.error(e);
      toasts.dismiss(tid);
      toasts.error(`PDF export failed: ${e}`);
    }
  }

  /**
   * Open the system print dialog with the rendered markdown.
   * Builds a hidden iframe with the same HTML template used for export,
   * Print: mount a print-only overlay with the rendered markdown, then ask
   * Tauri (Rust side) to open the native print dialog. @media print CSS
   * hides the app shell so only our overlay prints cleanly.
   *
   * Why Rust? WKWebView's window.print() is silently no-op in Tauri 2 on
   * macOS. Tauri's Rust-side `WebviewWindow::print()` routes to the platform
   * native print (NSPrintOperation on macOS, WebView2 PrintAsync on Windows,
   * WebKitGTK print on Linux).
   */
  async function exportPdfPrint() {
    track('file_exported', { format: 'pdf_print' });
    const ctx = activeOr();
    if (!ctx) return;

    // Strip YAML front matter before rendering — users don't want the
    // metadata block to show up in the printed output.
    const source = ctx.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    // v4.3.0 issue #77 — same link/image rewriting as the file-export path,
    // so the print overlay (and therefore the resulting PDF from the system
    // print dialog) doesn't show `http://tauri.localhost/...` links.
    const imageRoot = extractImageRoot(source);
    const body = rewriteLinkUrls(
      rewriteImageUrls(renderMarkdown(source), imageRoot, ctx.filePath),
      imageRoot,
      ctx.filePath,
    );

    let overlay = document.getElementById('solomd-print-overlay') as HTMLDivElement | null;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'solomd-print-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<div class="solomd-print-content preview-content">${body}</div>`;
    document.body.classList.add('solomd-printing');

    // v2.5 F3: inject @page / @media print stylesheet derived from
    // Settings → PDF defaults + per-doc `pdf:` front matter override.
    // When the user has never touched Settings AND the doc has no
    // `pdf:` block, `buildPrintStyle` returns "" and we mirror
    // pre-v2.5 webview-default behavior.
    const pdfOpts = resolvePdfOptions(
      settings.pdfDefaults,
      ctx.content,
      userTouchedPdfDefaults(settings.pdfDefaults),
    );
    const styleCss = buildPrintStyle(pdfOpts);
    let styleEl: HTMLStyleElement | null = null;
    if (styleCss) {
      styleEl = document.createElement('style');
      styleEl.id = 'solomd-print-style';
      styleEl.textContent = styleCss;
      document.head.appendChild(styleEl);
    }

    const cleanup = () => {
      document.body.classList.remove('solomd-printing');
      overlay?.remove();
      styleEl?.remove();
    };

    // Give KaTeX / images a tick to apply layout before print.
    await new Promise((r) => setTimeout(r, 200));
    try {
      await invoke('print_webview');
    } catch (e) {
      console.error('[print] failed', e);
      toasts.error(`Print failed: ${e}`);
    } finally {
      // The native print sheet is modal; by the time invoke resolves,
      // the user has already dismissed it. Safe to tear down now.
      setTimeout(cleanup, 100);
    }
  }

  async function copyAsHtml() {
    const src = copySource();
    if (!src) return;
    const html = renderMarkdown(src.source);
    const okMsg = src.isSelection ? 'Copied selection as HTML' : 'Copied as HTML';
    // Native Clipboard API first — supports rich HTML on all desktops and on
    // iOS 16+. Tauri's `writeHtml` is unimplemented on iOS so we'd otherwise
    // fall through to plain text and lose formatting.
    if (hasNativeClipboardWrite()) {
      try {
        const item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([src.source], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([item]);
        toasts.success(okMsg);
        return;
      } catch {
        // fall through to Tauri plugin
      }
    }
    try {
      await writeHtml(html);
      toasts.success(okMsg);
    } catch (e) {
      // Fallback: write plain HTML string as text
      try {
        await writeText(html);
        toasts.success(src.isSelection ? 'Copied selection HTML source' : 'Copied HTML source');
      } catch (e2) {
        toasts.error(`Copy failed: ${e2}`);
      }
    }
  }

  async function copyAsPlainText() {
    const src = copySource();
    if (!src) return;
    const text = stripMarkdown(src.source);
    const okMsg = src.isSelection ? 'Copied selection as plain text' : 'Copied as plain text';
    try {
      await writeText(text);
      toasts.success(okMsg);
    } catch (e) {
      toasts.error(`Copy failed: ${e}`);
    }
  }

  async function copyAsMarkdown() {
    const src = copySource();
    if (!src) return;
    const okMsg = src.isSelection ? 'Copied selection as Markdown' : 'Copied as Markdown';
    try {
      await writeText(src.source);
      toasts.success(okMsg);
    } catch (e) {
      toasts.error(`Copy failed: ${e}`);
    }
  }

  /**
   * Export as PNG image (renders preview, captures with html2canvas).
   * Honors the active editor selection — matches `copyAsImage` so "select
   * region, save as image" produces an image of *just that region* instead
   * of the whole document.
   */
  async function exportImage() {
    track('file_exported', { format: 'image' });
    const ctx = activeOr();
    if (!ctx) return;
    const sel = getEditorSelectionMd();
    const source = sel ?? ctx.content;
    const isSelection = sel !== null;
    const filename = isSelection
      ? `${ctx.baseName}-selection.png`
      : `${ctx.baseName}.png`;
    const path = await pickWritePath(filename, [{ name: 'PNG Image', extensions: ['png'] }]);
    if (!path) return;
    const tid = toasts.info(isSelection ? 'Generating selection image…' : 'Generating image…', 0);
    try {
      const blob = await markdownToImageBlob(source, ctx.baseName, ctx.filePath, {
        branding: settings.imageExportBranding,
      });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      await invoke('write_binary_file', { path, data: Array.from(buffer) });
      toasts.dismiss(tid);
      const msg = isIOS()
        ? iosSavedToast(filename)
        : isSelection
          ? 'Exported selection to PNG image'
          : 'Exported to PNG image';
      toasts.success(msg);
    } catch (e) {
      console.error(e);
      toasts.dismiss(tid);
      toasts.error(`Image export failed: ${e}`);
    }
  }

  /** Copy rendered markdown as a PNG image to the clipboard. */
  async function copyAsImage() {
    const ctx = activeOr();
    if (!ctx) return;
    const sel = getEditorSelectionMd();
    const source = sel ?? ctx.content;
    const isSelection = sel !== null;
    const tid = toasts.info(isSelection ? 'Capturing selection…' : 'Capturing image…', 0);
    try {
      const blob = await markdownToImageBlob(source, ctx.baseName, ctx.filePath, {
        branding: settings.imageExportBranding,
      });

      // Native Clipboard API supports `image/png` on iOS 16+ and all
      // desktops. Tauri's `writeImage` is unimplemented on iOS so we'd
      // otherwise fall through to the save-as fallback.
      if (hasNativeClipboardWrite()) {
        try {
          const item = new ClipboardItem({ 'image/png': blob });
          await navigator.clipboard.write([item]);
          toasts.dismiss(tid);
          toasts.success(isSelection ? 'Copied selection as image' : 'Copied as image');
          return;
        } catch {
          // fall through to Tauri plugin
        }
      }

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const img = await Image.fromBytes(bytes);
      await writeImage(img);
      toasts.dismiss(tid);
      toasts.success(isSelection ? 'Copied selection as image' : 'Copied as image');
    } catch (e) {
      console.error(e);
      toasts.dismiss(tid);
      // Fallback: save to file instead
      try {
        const filename = `${ctx.baseName}.png`;
        const path = await pickWritePath(filename, [{ name: 'PNG Image', extensions: ['png'] }]);
        if (path) {
          const blob2 = await markdownToImageBlob(source, ctx.baseName, ctx.filePath, {
            branding: settings.imageExportBranding,
          });
          const buffer = new Uint8Array(await blob2.arrayBuffer());
          await invoke('write_binary_file', { path, data: Array.from(buffer) });
          toasts.success(isIOS() ? iosSavedToast(filename) : 'Clipboard failed — saved as PNG instead');
        } else {
          toasts.error(`Copy image failed: ${e}`);
        }
      } catch (e2) {
        toasts.error(`Copy image failed: ${e}`);
      }
    }
  }

  return {
    exportHtml,
    exportDocx,
    exportPdf,
    exportPdfPrint,
    exportImage,
    copyAsHtml,
    copyAsPlainText,
    copyAsMarkdown,
    copyAsImage,
  };
}

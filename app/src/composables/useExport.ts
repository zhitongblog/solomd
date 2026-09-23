import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { EditorView } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { writeText, writeHtml, writeImage } from '@tauri-apps/plugin-clipboard-manager';
import { Image } from '@tauri-apps/api/image';
import { documentDir, join } from '@tauri-apps/api/path';
import { isIOS } from '../lib/platform';
// Loaded per export rather than at startup. Between them these three pull in
// `docx`, jsPDF + html2canvas and the mermaid renderer — megabytes that a user
// who only opens a note to read it should never have to compile.
const markdownToDocxBlob: typeof import('../lib/docx-export')['markdownToDocxBlob'] =
  async (...args) => (await import('../lib/docx-export')).markdownToDocxBlob(...args);
const markdownToPdfBlob: typeof import('../lib/pdf-export')['markdownToPdfBlob'] =
  async (...args) => (await import('../lib/pdf-export')).markdownToPdfBlob(...args);
const markdownToImageBlob: typeof import('../lib/image-export')['markdownToImageBlob'] =
  async (...args) => (await import('../lib/image-export')).markdownToImageBlob(...args);
import { renderMarkdown, extractImageRoot } from '../lib/markdown';
// Tiny shim: the mermaid bundle itself stays behind a dynamic import inside
// it, so touching this module costs nothing at startup.
import { initMermaid } from '../lib/mermaid-lazy';
import { exportDefaultPath } from '../lib/export-paths';
import { useI18n } from '../i18n';
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
import {
  HTML_TEMPLATE,
  buildStandaloneHtml,
} from '../lib/html-export';

export { HTML_TEMPLATE, buildStandaloneHtml };

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

/** Nearest ancestor element carrying a source-line annotation, walking up. */
function elementWithSourceLine(node: Node | null): HTMLElement | null {
  let n: Node | null = node;
  while (n && n.nodeType === Node.TEXT_NODE) n = n.parentNode;
  let el = n as HTMLElement | null;
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    if (el.hasAttribute?.('data-source-line') || el.hasAttribute?.('data-line')) return el;
    el = el.parentElement;
  }
  return null;
}

function sourceLineOf(el: HTMLElement): number {
  return Number(el.getAttribute('data-source-line') || el.getAttribute('data-line') || 0);
}

/**
 * Map a selection inside the rendered **preview pane** back to the Markdown
 * source. The preview blocks are annotated with `data-source-line` (1-indexed)
 * by `renderMarkdown`, so we slice `content` from the first selected block to
 * the end of the last selected block (block-granular — selecting part of a
 * paragraph copies the whole paragraph's source, which is the sensible
 * "Copy as Markdown" behaviour). Returns null when the selection isn't in the
 * preview, so callers fall through to other strategies.
 *
 * Fixes: in preview/reading mode, "select a region, copy" used to copy the
 * **whole document** — the old DOM fallback required the selection to be inside
 * a `.cm-editor` and bailed for the preview pane.
 */
function previewSelectionToSource(content: string): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  let anc: Node | null = range.commonAncestorContainer;
  while (anc && anc.nodeType === Node.TEXT_NODE) anc = anc.parentNode;
  const previewRoot = (anc as Element | null)?.closest?.('.preview-content');
  if (!previewRoot) return null;
  const startEl = elementWithSourceLine(range.startContainer);
  if (!startEl) return null;
  const endEl = elementWithSourceLine(range.endContainer) ?? startEl;
  const startLine = sourceLineOf(startEl);
  if (!startLine) return null;
  const endLineAttr = sourceLineOf(endEl) || startLine;
  // Bound the last block: slice up to just before the next annotated block.
  const nextLines = Array.from(
    previewRoot.querySelectorAll<HTMLElement>('[data-source-line],[data-line]'),
  )
    .map(sourceLineOf)
    .filter((n) => n > endLineAttr)
    .sort((a, b) => a - b);
  const lines = content.split(/\r?\n/);
  const endLine = nextLines.length ? nextLines[0] - 1 : lines.length;
  const slice = lines.slice(startLine - 1, Math.max(startLine, endLine)).join('\n');
  return slice.trim() ? slice : null;
}

/**
 * Markdown source for the active selection, or null. Tries, in order:
 *  1. CodeMirror state — editor selections (normal + rectangular).
 *  2. Preview pane — map the rendered selection to source lines (needs the
 *     document `content`, passed by callers).
 *  3. Raw DOM selection text inside a `.cm-editor` (last-resort).
 */
function getEditorSelectionMd(content?: string): string | null {
  if (typeof document === 'undefined') return null;
  const cmText = cmSelectionText();
  if (cmText) return cmText;
  if (content != null) {
    const previewText = previewSelectionToSource(content);
    if (previewText) return previewText;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  let node: Node | null = range.commonAncestorContainer;
  while (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const inEditor = (node as Element | null)?.closest?.('.cm-editor');
  if (!inEditor) return null;
  const text = sel.toString();
  return text.trim() ? text : null;
}

// Mermaid ids must be unique per render across the whole session — mermaid
// keys internal state off them and reusing one yields an empty diagram.
let printMermaidId = 0;

export function useExport() {
  const tabs = useTabsStore();
  const toasts = useToastsStore();
  const settings = useSettingsStore();
  const { t } = useI18n();

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
    const sel = getEditorSelectionMd(ctx.content);
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
    // #260 — start in the document's own folder instead of wherever the
    // last save happened. Falls back to a bare filename for unsaved
    // buffers and virtual (SAF) paths, which is the old behaviour.
    const defaultPath = exportDefaultPath(activeOr()?.filePath, filename) ?? filename;
    return await saveDialog({ defaultPath, filters });
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
    const html = await buildStandaloneHtml(ctx.baseName, body);
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
      const blob = await markdownToDocxBlob(
        ctx.content,
        ctx.baseName,
        ctx.filePath,
        settings.docxPreset,
        t('docx.contents'),
      );
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
   * #301 — render ```mermaid fences inside the print overlay.
   *
   * `renderMarkdown()` leaves a mermaid fence as a plain
   * `<pre><code class="language-mermaid">` — the Preview pane and the image
   * PDF path (`markdownToPdfBlob`) each turn that into an SVG afterwards, but
   * the text PDF path never did, so "导出为 PDF（文字）" printed the diagram
   * source verbatim. Same treatment as those two, and it must finish BEFORE
   * the print dialog opens or the platform captures a half-rendered overlay.
   *
   * The `.mermaid-block` / `.mermaid-error` classes are the ones Preview's
   * global `:where(.preview-content) …` rules target, and the overlay content
   * div already carries `preview-content`, so the SVG is centered and
   * width-clamped on paper without any extra CSS.
   */
  async function renderPrintMermaid(container: HTMLElement, dark: boolean) {
    const blocks = container.querySelectorAll('pre > code.language-mermaid');
    if (!blocks.length) return;   // no diagrams: never load the renderer
    const mermaid = await initMermaid({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
    });
    for (const block of Array.from(blocks)) {
      const pre = block.parentElement as HTMLElement | null;
      if (!pre) continue;
      const code = (block.textContent || '').trim();
      const id = `print-mmd-${++printMermaidId}`;
      try {
        const { svg } = await mermaid.render(id, code);
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-block';
        wrap.innerHTML = svg;
        pre.replaceWith(wrap);
      } catch (e) {
        // A broken diagram must not abort the print — show the reason where
        // the diagram would have been, exactly like the Preview pane does.
        const err = document.createElement('pre');
        err.className = 'mermaid-error';
        err.textContent = `Mermaid error: ${(e as Error).message}`;
        pre.replaceWith(err);
      }
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
    // KaTeX styling comes from the bundle — `main.ts` imports
    // `katex/dist/katex.min.css` and its selectors (`.katex`, `.katex-display`)
    // are global, so the overlay picks them up even though it lives outside
    // `#app`. This used to <link> katex.min.css off jsDelivr, which meant every
    // print silently hit the network: math came out unstyled with no
    // connection, and an offline-first app with no telemetry leaked a request
    // per print.
    overlay.innerHTML = `<div class="solomd-print-content preview-content">${body}</div>`;
    // Print palette, independent of the app theme. The overlay sits outside
    // #app but still inherits :root's tokens, so a dark theme used to put a
    // dark code slab on paper. `follow` adds no class and keeps that.
    const printTheme = settings.printTheme || 'light';
    overlay.classList.remove('print-theme-light', 'print-theme-dark');
    if (printTheme !== 'follow') overlay.classList.add(`print-theme-${printTheme}`);
    document.body.classList.add('solomd-printing');
    document.body.classList.toggle('solomd-printing--dark', printTheme === 'dark');

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
      document.body.classList.remove('solomd-printing', 'solomd-printing--dark');
      overlay?.remove();
      styleEl?.remove();
    };

    // #301 — swap mermaid fences for SVGs and WAIT for them. This has to
    // happen after the print-theme class is on the overlay (so the diagram
    // palette matches the paper) and before `print_webview`, because the
    // native print sheet snapshots the DOM as it finds it.
    // Query by class rather than firstElementChild: that only happened to be
    // the content div because the <link> above was just removed, and the next
    // person to prepend anything to the overlay would silently skip mermaid.
    const printContent = overlay.querySelector<HTMLElement>('.solomd-print-content');
    if (printContent) {
      try {
        await renderPrintMermaid(
          printContent,
          printTheme === 'dark' || (printTheme === 'follow' && settings.theme === 'dark'),
        );
      } catch (e) {
        // Only reachable if the mermaid chunk itself fails to load (per-diagram
        // failures are handled inside). Printing the document with the fences
        // still as code beats refusing to print at all — and #115 says we must
        // never leave the overlay + `body.solomd-printing` mounted.
        console.error('[print] mermaid render failed', e);
      }
    }

    // Give KaTeX / images a tick to apply layout before print.
    await new Promise((r) => setTimeout(r, 200));
    try {
      await invoke('print_webview');
      // The native print sheet is modal; by the time invoke resolves,
      // the user has already dismissed it. Safe to tear down shortly after.
      setTimeout(cleanup, 100);
    } catch (e) {
      console.error('[print] failed', e);
      // #115 — tear down the print DOM (the full-screen #solomd-print-overlay
      // + `body.solomd-printing`) SYNCHRONOUSLY on error. The old code only
      // scheduled cleanup via setTimeout in `finally`; if the print invoke
      // rejected, the editor was left under the print-mode body state and
      // felt unresponsive ("mouse input dead after an export error" on macOS).
      cleanup();
      toasts.error(`Print failed: ${e}`);
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
    const sel = getEditorSelectionMd(ctx.content);
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
    const sel = getEditorSelectionMd(ctx.content);
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

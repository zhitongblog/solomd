/**
 * Image paste / drag-drop extension for CodeMirror 6.
 *
 * Listens on the editor's host DOM for paste & drop events containing
 * image data. Saves each image to disk (via the `write_binary_file` Tauri
 * command), then inserts a markdown image reference at the cursor.
 *
 * Save location:
 *   - If the current tab has a file path, images go into
 *     `<dirname-of-file>/_assets/`.
 *   - Otherwise (untitled tab) they go into a temp directory.
 */

import { EditorView } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { tempDir, sep } from '@tauri-apps/api/path';

export interface ImagePasteOptions {
  getFilePath: () => string | undefined;
  /** Override temp directory (mainly for tests). */
  tempDir?: string;
}

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function timestamp(): string {
  const d = new Date();
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function randSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function extFromMime(mime: string): string {
  return IMAGE_MIME_EXT[mime.toLowerCase()] || 'png';
}

function extFromName(name: string): string | undefined {
  const i = name.lastIndexOf('.');
  if (i < 0) return undefined;
  return name.slice(i + 1).toLowerCase();
}

function dirnameOf(p: string, sepCh: string): string {
  // Strip trailing separator.
  let end = p.length;
  while (end > 0 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--;
  let i = end - 1;
  while (i >= 0 && p[i] !== '/' && p[i] !== '\\') i--;
  if (i < 0) return '.';
  if (i === 0) return p[0] === '/' ? '/' : p.slice(0, 1);
  return p.slice(0, i) || sepCh;
}

function joinPath(a: string, b: string, sepCh: string): string {
  if (!a) return b;
  if (a.endsWith('/') || a.endsWith('\\')) return a + b;
  return a + sepCh + b;
}

async function resolveTempDir(override?: string): Promise<string> {
  if (override) return override;
  try {
    return await tempDir();
  } catch {
    return '/tmp';
  }
}

async function readFileAsUint8(file: File | Blob): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

async function saveAndInsert(
  view: EditorView,
  bytes: Uint8Array,
  ext: string,
  opts: ImagePasteOptions,
): Promise<void> {
  let sepCh: string;
  try {
    sepCh = sep();
  } catch {
    sepCh = '/';
  }

  const filePath = opts.getFilePath();
  const filename = `image-${timestamp()}-${randSuffix()}.${ext}`;

  let fullPath: string;
  let insertText: string;

  if (filePath) {
    const dir = dirnameOf(filePath, sepCh);
    const assetsDir = joinPath(dir, '_assets', sepCh);
    fullPath = joinPath(assetsDir, filename, sepCh);
    insertText = `![](_assets/${filename})`;
  } else {
    const t = await resolveTempDir(opts.tempDir);
    const solomdDir = joinPath(t, 'solomd', sepCh);
    fullPath = joinPath(solomdDir, filename, sepCh);
    insertText = `![](${fullPath})`;
  }

  try {
    await invoke('write_binary_file', {
      path: fullPath,
      data: Array.from(bytes),
    });
  } catch (err) {
    // Best-effort: log and abort this image.
    console.error('[cm-image-paste] failed to write image', err);
    return;
  }

  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: insertText },
    selection: { anchor: pos + insertText.length },
  });
}

async function handlePaste(
  event: ClipboardEvent,
  view: EditorView,
  opts: ImagePasteOptions,
): Promise<boolean> {
  const cd = event.clipboardData;
  if (!cd) return false;
  const items = cd.items;
  if (!items || items.length === 0) return false;

  const images: Array<{ blob: Blob; ext: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) images.push({ blob: f, ext: extFromName(f.name) || extFromMime(item.type) });
    }
  }
  if (images.length === 0) return false;

  event.preventDefault();
  for (const img of images) {
    const bytes = await readFileAsUint8(img.blob);
    await saveAndInsert(view, bytes, img.ext, opts);
  }
  return true;
}

async function handleDrop(
  event: DragEvent,
  view: EditorView,
  opts: ImagePasteOptions,
): Promise<boolean> {
  const dt = event.dataTransfer;
  if (!dt) return false;
  const files = dt.files;
  if (!files || files.length === 0) return false;

  const images: Array<{ file: File; ext: string }> = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.type.startsWith('image/')) {
      images.push({ file: f, ext: extFromName(f.name) || extFromMime(f.type) });
    }
  }
  if (images.length === 0) return false;

  event.preventDefault();
  for (const img of images) {
    const bytes = await readFileAsUint8(img.file);
    await saveAndInsert(view, bytes, img.ext, opts);
  }
  return true;
}

/**
 * Insert a markdown image reference for an OS file path that the user
 * dragged into the window. Unlike paste/drop on the editor DOM (where we
 * already have the bytes), this path comes from Tauri's webview-level
 * drag-drop event, so we copy the file via the Rust `copy_file` command
 * instead of round-tripping bytes through JS.
 */
export async function insertImageFromPath(
  view: EditorView,
  srcPath: string,
  opts: ImagePasteOptions,
): Promise<void> {
  let sepCh: string;
  try {
    sepCh = sep();
  } catch {
    sepCh = '/';
  }

  const ext = extFromName(srcPath) || 'png';
  const filename = `image-${timestamp()}-${randSuffix()}.${ext}`;
  const filePath = opts.getFilePath();

  let dstPath: string;
  let insertText: string;
  if (filePath) {
    const dir = dirnameOf(filePath, sepCh);
    const assetsDir = joinPath(dir, '_assets', sepCh);
    dstPath = joinPath(assetsDir, filename, sepCh);
    insertText = `![](_assets/${filename})`;
  } else {
    const t = await resolveTempDir(opts.tempDir);
    const solomdDir = joinPath(t, 'solomd', sepCh);
    dstPath = joinPath(solomdDir, filename, sepCh);
    insertText = `![](${dstPath})`;
  }

  try {
    await invoke('copy_file', { src: srcPath, dst: dstPath });
  } catch (err) {
    console.error('[cm-image-paste] copy_file failed', err);
    throw err;
  }

  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: insertText },
    selection: { anchor: pos + insertText.length },
  });
}

export function imagePasteExtension(opts: ImagePasteOptions) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      // Fire and forget — the async handler calls preventDefault() sync
      // BEFORE any awaits, so the browser never inserts the image fallback.
      const cd = event.clipboardData;
      if (!cd || !cd.items) return false;
      let hasImage = false;
      for (let i = 0; i < cd.items.length; i++) {
        const it = cd.items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          hasImage = true;
          break;
        }
      }
      if (!hasImage) return false;
      event.preventDefault();
      void handlePaste(event, view, opts);
      return true;
    },
    drop(event, view) {
      const dt = event.dataTransfer;
      if (!dt || !dt.files || dt.files.length === 0) return false;
      let hasImage = false;
      for (let i = 0; i < dt.files.length; i++) {
        if (dt.files[i].type.startsWith('image/')) {
          hasImage = true;
          break;
        }
      }
      if (!hasImage) return false;
      event.preventDefault();
      void handleDrop(event, view, opts);
      return true;
    },
  });
}

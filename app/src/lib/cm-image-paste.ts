/**
 * Image paste / drag-drop extension for CodeMirror 6.
 *
 * Listens on the editor's host DOM for paste & drop events containing
 * image data. Saves each image to disk (via the `write_binary_file` Tauri
 * command), then inserts a markdown image reference at the cursor.
 *
 * Save location (only when the tab has a file path; otherwise → temp dir):
 *   - `shared` (default): `<dirname>/_assets/<filename>` — one shared
 *     folder per directory. Pre-v4.3.5 behavior; safe for legacy vaults.
 *   - `per-file`: `<dirname>/<basename>.assets/<filename>` — each .md gets
 *     its own assets folder. `fs_rename` on the Rust side moves the folder
 *     along with the file and rewrites link refs when the basename changes.
 */

import { EditorView } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { tempDir, sep } from '@tauri-apps/api/path';

export interface ImagePasteOptions {
  getFilePath: () => string | undefined;
  /** Current document content, used to read front-matter `imageRoot`. */
  getDocContent?: () => string;
  /** Override temp directory (mainly for tests). */
  tempDir?: string;
  /** v4.3.5 — `shared` (`_assets/`) vs `per-file` (`<stem>.assets/`).
   *  Defaults to `shared` if absent (back-compat for callers that haven't
   *  been updated yet). */
  getAttachmentMode?: () => 'shared' | 'per-file' | 'custom';
  /** #88 — folder name for the `shared` attachment mode (default `_assets`).
   *  `per-file` mode always uses `<stem>.assets/` regardless of this. */
  getAssetsDirName?: () => string;
  /** #7 (顾河) — Typora-style path template for the `custom` attachment mode.
   *  Supports `${filename}` (note stem). Relative templates resolve against
   *  the note's folder; absolute paths are used as-is. */
  getCustomPath?: () => string;
}

/** Minimal front-matter imageRoot parser (kept local to avoid import cycles). */
function parseImageRootFast(source: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!m) return null;
  const im = /^(?:imageRoot|image_root|typora-root-url)\s*:\s*(.+?)\s*$/m.exec(m[1]);
  if (!im) return null;
  return im[1].replace(/^["']|["']$/g, '').trim() || null;
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

/** Basename of a path without its extension. `/a/b/foo.md` → `foo`. Used
 *  in per-file attachment mode to derive `<basename>.assets/`. */
function basenameNoExt(p: string): string {
  let start = p.length - 1;
  while (start >= 0 && p[start] !== '/' && p[start] !== '\\') start--;
  const base = p.slice(start + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Compute the assets directory + URL-encodable folder segment for the
 *  current attachment mode. Returns `null` when there's no file path (caller
 *  must fall back to the temp-dir branch). */
function resolveAssetsDir(
  filePath: string,
  sepCh: string,
  mode: 'shared' | 'per-file' | 'custom',
  sharedDirName: string,
  customPath?: string,
): { dir: string; urlPrefix: string } {
  const parent = dirnameOf(filePath, sepCh);
  if (mode === 'per-file') {
    const stem = basenameNoExt(filePath);
    const folder = `${stem}.assets`;
    return { dir: joinPath(parent, folder, sepCh), urlPrefix: folder };
  }
  if (mode === 'custom') {
    // #7 — Typora-style template, e.g. `./images/${filename}/`. Expand the
    // `${filename}` token (note stem) and normalize to forward slashes for the
    // markdown URL; the on-disk dir is rebuilt with the platform separator.
    const stem = basenameNoExt(filePath);
    const raw = (customPath || './images/${filename}/').trim();
    const urlPrefix = raw
      .replace(/\$\{filename\}/g, stem)
      .replace(/\\/g, '/')
      .replace(/\/+$/, ''); // drop trailing slash; `${urlPrefix}/${file}` re-adds it
    // Absolute? (`/…`, `~…`, or `C:\…`) → use as-is; otherwise join onto the
    // note's folder. `./` and `.` segments are dropped when building the dir.
    const isAbs = /^([/~]|[A-Za-z]:[\\/])/.test(raw);
    let dir: string;
    if (isAbs) {
      dir = urlPrefix.replace(/\//g, sepCh);
    } else {
      const segs = urlPrefix.split('/').filter((s) => s !== '' && s !== '.');
      dir = parent;
      for (const s of segs) dir = joinPath(dir, s, sepCh);
    }
    if (!dir.endsWith(sepCh)) dir += sepCh;
    return { dir, urlPrefix };
  }
  return { dir: joinPath(parent, sharedDirName, sepCh), urlPrefix: sharedDirName };
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
  const insertText = await saveImageBytes(bytes, ext, opts);
  if (!insertText) return;
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: insertText },
    selection: { anchor: pos + insertText.length },
  });
}

/**
 * Persist image bytes to the right location (front-matter imageRoot / assets dir
 * / temp) and return the markdown link to insert, or null on failure. Shared by
 * the CodeMirror editor and the Windows plain-textarea editor.
 */
export async function saveImageBytes(
  bytes: Uint8Array,
  ext: string,
  opts: ImagePasteOptions,
): Promise<string | null> {
  let sepCh: string;
  try {
    sepCh = sep();
  } catch {
    sepCh = '/';
  }

  const filePath = opts.getFilePath();
  const filename = `image-${timestamp()}-${randSuffix()}.${ext}`;

  // If the document has a front-matter `imageRoot`, write to that dir and
  // insert a markdown link relative to it.
  const imageRoot = opts.getDocContent ? parseImageRootFast(opts.getDocContent()) : null;

  let fullPath: string;
  let insertText: string;

  if (imageRoot && filePath) {
    const rootAbs = imageRoot.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(imageRoot);
    const rootDir = rootAbs
      ? imageRoot
      : joinPath(dirnameOf(filePath, sepCh), imageRoot, sepCh);
    fullPath = joinPath(rootDir, filename, sepCh);
    insertText = `![](${filename})`;
  } else if (filePath) {
    const mode = opts.getAttachmentMode ? opts.getAttachmentMode() : 'shared';
    const sharedDir = opts.getAssetsDirName ? (opts.getAssetsDirName() || '_assets') : '_assets';
    const customPath = opts.getCustomPath ? opts.getCustomPath() : undefined;
    const { dir: assetsDir, urlPrefix } = resolveAssetsDir(filePath, sepCh, mode, sharedDir, customPath);
    fullPath = joinPath(assetsDir, filename, sepCh);
    insertText = `![](${urlPrefix}/${filename})`;
  } else {
    const t = await resolveTempDir(opts.tempDir);
    const solomdDir = joinPath(t, 'solomd', sepCh);
    fullPath = joinPath(solomdDir, filename, sepCh);
    // Use forward slashes in the markdown URL. On Windows the path is built
    // with `\`, and markdown-it (used by the preview pane) treats `\` in URLs
    // as escape characters — it silently strips them, leaving a mangled src
    // that 404s. Live-edit's image regex captures the raw text untouched, so
    // it loaded fine there; only preview broke. Backslash→slash makes both
    // modes resolve the same absolute path. (No-op on macOS/Linux.)
    insertText = `![](${fullPath.replace(/\\/g, '/')})`;
  }

  try {
    await invoke('write_binary_file', {
      path: fullPath,
      data: Array.from(bytes),
    });
  } catch (err) {
    // Best-effort: log and abort this image.
    console.error('[cm-image-paste] failed to write image', err);
    return null;
  }

  return insertText;
}

/**
 * Clipboard image paste for a plain `<textarea>` editor. Extracts image items,
 * saves them, and calls `insert` with each markdown link. Returns true if it
 * handled (and consumed) the paste.
 */
export async function handleTextareaImagePaste(
  event: ClipboardEvent,
  opts: ImagePasteOptions,
  insert: (text: string) => void,
): Promise<boolean> {
  const cd = event.clipboardData;
  if (!cd || !cd.items) return false;
  const images: Array<{ blob: Blob; ext: string }> = [];
  for (let i = 0; i < cd.items.length; i++) {
    const item = cd.items[i];
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) images.push({ blob: f, ext: extFromName(f.name) || extFromMime(item.type) });
    }
  }
  if (images.length === 0) return false;
  event.preventDefault();
  for (const img of images) {
    const bytes = await readFileAsUint8(img.blob);
    const text = await saveImageBytes(bytes, img.ext, opts);
    if (text) insert(text);
  }
  return true;
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
  const imageRoot = opts.getDocContent ? parseImageRootFast(opts.getDocContent()) : null;

  let dstPath: string;
  let insertText: string;
  if (imageRoot && filePath) {
    const rootAbs = imageRoot.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(imageRoot);
    const rootDir = rootAbs
      ? imageRoot
      : joinPath(dirnameOf(filePath, sepCh), imageRoot, sepCh);
    dstPath = joinPath(rootDir, filename, sepCh);
    insertText = `![](${filename})`;
  } else if (filePath) {
    const mode = opts.getAttachmentMode ? opts.getAttachmentMode() : 'shared';
    const sharedDir = opts.getAssetsDirName ? (opts.getAssetsDirName() || '_assets') : '_assets';
    const customPath = opts.getCustomPath ? opts.getCustomPath() : undefined;
    const { dir: assetsDir, urlPrefix } = resolveAssetsDir(filePath, sepCh, mode, sharedDir, customPath);
    dstPath = joinPath(assetsDir, filename, sepCh);
    insertText = `![](${urlPrefix}/${filename})`;
  } else {
    const t = await resolveTempDir(opts.tempDir);
    const solomdDir = joinPath(t, 'solomd', sepCh);
    dstPath = joinPath(solomdDir, filename, sepCh);
    // Forward slashes in the URL — see the saveAndInsert temp-dir branch
    // comment above for why (markdown-it eats `\` as escapes on Windows).
    insertText = `![](${dstPath.replace(/\\/g, '/')})`;
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

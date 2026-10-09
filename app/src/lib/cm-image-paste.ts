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
import { tempDir, sep, documentDir } from '@tauri-apps/api/path';
import { uploadImage, type ResolvedUploader } from './image-upload';
import { markdownImage } from './md-image-url';
import { isContentUri, isSafPath, sniffImageExt } from './image-source';

export interface ImagePasteOptions {
  getFilePath: () => string | undefined;
  /** Current document content, used to read front-matter `imageRoot`. */
  getDocContent?: () => string;
  /** Override temp directory (mainly for tests). */
  tempDir?: string;
  /** 图床 / image-host uploader resolved for a target filename, or null to
   *  save locally only. When present and `.onPaste` is true, pasted/dropped
   *  images are uploaded and the returned URL is inserted (with a local
   *  fallback on failure). */
  getUploader?: (filename: string) => ResolvedUploader | null;
  /** Surface upload progress/results to the user (wired to toasts + i18n by
   *  the editor). `key` is an i18n key under `toast.*`. */
  notify?: (
    kind: 'info' | 'success' | 'error',
    key: string,
    params?: Record<string, unknown>,
  ) => void;
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

/** #349 — bytes of an Android `content://` URI, through the fs plugin's
 *  ContentResolver bridge (the same one #148 uses to open notes). */
async function readContentUri(uri: string): Promise<Uint8Array> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  return readFile(uri);
}

function reportFailure(opts: ImagePasteOptions, err: unknown): void {
  console.error('[cm-image-paste] image insert failed', err);
  opts.notify?.('error', 'toast.imageInsertFailed', { error: String(err) });
}

async function readFileAsUint8(file: File | Blob): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

function getSep(): string {
  try {
    return sep();
  } catch {
    return '/';
  }
}

function makeFilename(ext: string): string {
  return `image-${timestamp()}-${randSuffix()}.${ext}`;
}

/**
 * Compute where a new image with `filename` should live locally, and the
 * markdown link to insert for it — based on front-matter `imageRoot`, the
 * attachment mode, or (no file path) the temp dir. Pure-ish: only touches
 * `sep()` / `tempDir()`. Shared by the local-save and upload paths.
 */
async function prepareLocalTarget(
  filename: string,
  opts: ImagePasteOptions,
): Promise<{ fullPath: string; insertText: string }> {
  const sepCh = getSep();
  const filePath = opts.getFilePath();
  const imageRoot = opts.getDocContent ? parseImageRootFast(opts.getDocContent()) : null;

  // #349 — a note in a SAF vault has a `saf:<documentId>` path. Joining
  // `_assets/` onto it gives a string that no filesystem call can write, so
  // the image was silently lost. SAF can't store binary files yet: keep the
  // image in SoloMD's own Documents folder and link it by absolute path
  // (the asset protocol scope covers it, so it renders), and say so.
  if (isSafPath(filePath)) {
    let base: string;
    try {
      base = await documentDir();
    } catch {
      base = await resolveTempDir(opts.tempDir);
    }
    const fullPath = joinPath(joinPath(base, '_assets', sepCh), filename, sepCh);
    opts.notify?.('info', 'toast.imageSavedOutsideVault');
    return { fullPath, insertText: markdownImage(fullPath.replace(/\\/g, '/')) };
  }

  if (imageRoot && filePath) {
    const rootAbs = imageRoot.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(imageRoot);
    const rootDir = rootAbs ? imageRoot : joinPath(dirnameOf(filePath, sepCh), imageRoot, sepCh);
    return { fullPath: joinPath(rootDir, filename, sepCh), insertText: markdownImage(filename) };
  }
  if (filePath) {
    const mode = opts.getAttachmentMode ? opts.getAttachmentMode() : 'shared';
    const sharedDir = opts.getAssetsDirName ? opts.getAssetsDirName() || '_assets' : '_assets';
    const customPath = opts.getCustomPath ? opts.getCustomPath() : undefined;
    const { dir: assetsDir, urlPrefix } = resolveAssetsDir(filePath, sepCh, mode, sharedDir, customPath);
    return {
      fullPath: joinPath(assetsDir, filename, sepCh),
      insertText: markdownImage(`${urlPrefix}/${filename}`),
    };
  }
  const t = await resolveTempDir(opts.tempDir);
  const fullPath = joinPath(joinPath(t, 'solomd', sepCh), filename, sepCh);
  // Forward slashes in the markdown URL — markdown-it eats `\` as escapes on
  // Windows, mangling the preview src. (No-op on macOS/Linux.)
  return { fullPath, insertText: markdownImage(fullPath.replace(/\\/g, '/')) };
}

/** Temp path for an image we only need transiently (upload source when not
 *  keeping a local copy). */
async function prepareTempTarget(
  filename: string,
  opts: ImagePasteOptions,
): Promise<string> {
  const sepCh = getSep();
  const t = await resolveTempDir(opts.tempDir);
  return joinPath(joinPath(t, 'solomd', sepCh), filename, sepCh);
}

async function writeBytes(fullPath: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await invoke('write_binary_file', { path: fullPath, data: Array.from(bytes) });
    return true;
  } catch (err) {
    console.error('[cm-image-paste] failed to write image', err);
    return false;
  }
}

function insertAtCursor(view: EditorView, text: string): void {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
}

/** Replace the `![](token)` upload placeholder with `finalText`, locating it
 *  live in the current doc so concurrent typing doesn't desync the position.
 *  No-op if the user already deleted the placeholder. */
function replaceToken(view: EditorView, token: string, finalText: string): void {
  const needle = `![](${token})`;
  const idx = view.state.doc.toString().indexOf(needle);
  if (idx < 0) return;
  view.dispatch({ changes: { from: idx, to: idx + needle.length, insert: finalText } });
}

/**
 * Upload `srcPath` via the resolved uploader and return the markdown to insert:
 * `![](url)` on success, or `fallback()` (a local link) on failure. Emits
 * info/success/error toasts via `opts.notify`.
 */
async function performUpload(
  up: ResolvedUploader,
  srcPath: string,
  opts: ImagePasteOptions,
  fallback: () => Promise<string>,
): Promise<string> {
  opts.notify?.('info', 'toast.imageUploading');
  try {
    const url = await uploadImage(up.cfg, srcPath);
    opts.notify?.('success', 'toast.imageUploaded');
    return markdownImage(url);
  } catch (err) {
    console.error('[cm-image-paste] upload failed', err);
    opts.notify?.('error', 'toast.imageUploadFailed');
    return await fallback();
  }
}

/**
 * Persist image bytes locally and return the markdown link to insert, or null
 * on failure. Used by the Windows plain-textarea editor (which inserts text via
 * a callback rather than a CodeMirror view). No upload — kept simple.
 */
export async function saveImageBytes(
  bytes: Uint8Array,
  ext: string,
  opts: ImagePasteOptions,
): Promise<string | null> {
  const { fullPath, insertText } = await prepareLocalTarget(makeFilename(ext), opts);
  return (await writeBytes(fullPath, bytes)) ? insertText : null;
}

/**
 * Save (and optionally upload) pasted/dropped image bytes, inserting the
 * resulting markdown at the cursor. When an uploader is configured with
 * auto-upload on, inserts an `![](token)` placeholder immediately, then swaps
 * in the hosted URL (or a local fallback) once the upload settles.
 */
async function saveAndInsert(
  view: EditorView,
  bytes: Uint8Array,
  ext: string,
  opts: ImagePasteOptions,
): Promise<void> {
  const filename = makeFilename(ext);
  const up = opts.getUploader ? opts.getUploader(filename) : null;
  const local = await prepareLocalTarget(filename, opts);

  if (!up || !up.onPaste) {
    if (await writeBytes(local.fullPath, bytes)) insertAtCursor(view, local.insertText);
    else reportFailure(opts, `could not write ${local.fullPath}`);
    return;
  }

  // Materialize the upload source: the assets file (keepLocal) or a temp copy.
  let srcPath: string;
  if (up.keepLocal) {
    if (!(await writeBytes(local.fullPath, bytes))) {
      insertAtCursor(view, local.insertText);
      return;
    }
    srcPath = local.fullPath;
  } else {
    const temp = await prepareTempTarget(filename, opts);
    if (!(await writeBytes(temp, bytes))) {
      // Temp write failed — fall back to a plain local save.
      if (await writeBytes(local.fullPath, bytes)) insertAtCursor(view, local.insertText);
      return;
    }
    srcPath = temp;
  }

  const token = `solomd-uploading-${randSuffix()}${randSuffix()}`;
  insertAtCursor(view, `![](${token})`);
  const finalText = await performUpload(up, srcPath, opts, async () => {
    // On failure keep a local copy: assets file already exists when keepLocal;
    // otherwise copy the temp file into the attachments folder.
    if (up.keepLocal) return local.insertText;
    try {
      await invoke('copy_file', { src: srcPath, dst: local.fullPath });
      return local.insertText;
    } catch {
      return markdownImage(srcPath.replace(/\\/g, '/'));
    }
  });
  replaceToken(view, token, finalText);
}

/**
 * True when a paste event carries nothing the webview can insert: no text,
 * no HTML, no URI list and no files. WebKitGTK (Linux) delivers exactly this
 * when the system clipboard holds only an image — `clipboardData.types` and
 * `.items` are both empty, so the image never reaches the page and the paste
 * silently did nothing (Linux regression run, B4).
 */
export function isEmptyClipboardEvent(cd: DataTransfer | null): boolean {
  if (!cd) return false;
  if (cd.files && cd.files.length > 0) return false;
  if (cd.items && cd.items.length > 0) return false;
  return !cd.types || cd.types.length === 0;
}

/**
 * Read an image straight off the OS clipboard through the Tauri clipboard
 * plugin (arboard, from Rust) and re-encode it as PNG. `null` when the
 * clipboard holds no image or the plugin is unavailable (iOS, a browser).
 */
export async function readClipboardImageAsPng(): Promise<Uint8Array | null> {
  let image: { rgba(): Promise<Uint8Array>; size(): Promise<{ width: number; height: number }>; close?(): Promise<void> } | null = null;
  try {
    const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
    image = await readImage();
    const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
    if (!width || !height || rgba.length < width * height * 4) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4), width, height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    try {
      await image?.close?.();
    } catch {
      /* resource already gone */
    }
  }
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
  if (isEmptyClipboardEvent(cd)) {
    // Image-only clipboard on WebKitGTK: ask the OS clipboard directly.
    event.preventDefault();
    const png = await readClipboardImageAsPng();
    if (!png) return false;
    const text = await saveOrUploadText(png, 'png', opts);
    if (text) insert(text);
    return true;
  }
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
    const text = await saveOrUploadText(bytes, img.ext, opts);
    if (text) insert(text);
  }
  return true;
}

/**
 * Blocking variant of `saveAndInsert` for the plain-textarea editor: saves
 * locally, or (if an uploader is configured with auto-upload) uploads and
 * returns the hosted URL — falling back to a local link on failure. Awaits the
 * upload before returning (no placeholder, unlike the CodeMirror path).
 */
async function saveOrUploadText(
  bytes: Uint8Array,
  ext: string,
  opts: ImagePasteOptions,
): Promise<string | null> {
  const filename = makeFilename(ext);
  const up = opts.getUploader ? opts.getUploader(filename) : null;
  const local = await prepareLocalTarget(filename, opts);
  if (!up || !up.onPaste) {
    if (await writeBytes(local.fullPath, bytes)) return local.insertText;
    reportFailure(opts, `could not write ${local.fullPath}`);
    return null;
  }
  let srcPath: string;
  if (up.keepLocal) {
    if (!(await writeBytes(local.fullPath, bytes))) {
      reportFailure(opts, `could not write ${local.fullPath}`);
      return null;
    }
    srcPath = local.fullPath;
  } else {
    const temp = await prepareTempTarget(filename, opts);
    if (!(await writeBytes(temp, bytes))) {
      return (await writeBytes(local.fullPath, bytes)) ? local.insertText : null;
    }
    srcPath = temp;
  }
  return performUpload(up, srcPath, opts, async () => {
    if (up.keepLocal) return local.insertText;
    try {
      await invoke('copy_file', { src: srcPath, dst: local.fullPath });
      return local.insertText;
    } catch {
      return markdownImage(srcPath.replace(/\\/g, '/'));
    }
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
  // #349 — Android pickers return content:// URIs: read the bytes and take
  // the paste path, which writes bytes instead of copying a file.
  if (isContentUri(srcPath)) {
    let bytes: Uint8Array;
    try {
      bytes = await readContentUri(srcPath);
    } catch (err) {
      reportFailure(opts, err);
      return;
    }
    await saveAndInsert(view, bytes, sniffImageExt(bytes) || extFromName(srcPath) || 'png', opts);
    return;
  }
  const ext = extFromName(srcPath) || 'png';
  const filename = makeFilename(ext);
  const up = opts.getUploader ? opts.getUploader(filename) : null;
  const local = await prepareLocalTarget(filename, opts);

  if (!up || !up.onPaste) {
    try {
      await invoke('copy_file', { src: srcPath, dst: local.fullPath });
    } catch (err) {
      // Was a rethrow that nobody caught: the insert just didn't happen.
      reportFailure(opts, err);
      return;
    }
    insertAtCursor(view, local.insertText);
    return;
  }

  // Upload source: copy into the attachments folder first when keeping a local
  // copy; otherwise upload the original file in place (no copy needed).
  let uploadSrc = srcPath;
  if (up.keepLocal) {
    await invoke('copy_file', { src: srcPath, dst: local.fullPath });
    uploadSrc = local.fullPath;
  }
  const token = `solomd-uploading-${randSuffix()}${randSuffix()}`;
  insertAtCursor(view, `![](${token})`);
  const finalText = await performUpload(up, uploadSrc, opts, async () => {
    if (up.keepLocal) return local.insertText;
    try {
      await invoke('copy_file', { src: srcPath, dst: local.fullPath });
      return local.insertText;
    } catch {
      return markdownImage(srcPath.replace(/\\/g, '/'));
    }
  });
  replaceToken(view, token, finalText);
}

/**
 * The markdown to insert for an image file on disk, for editors without a
 * CodeMirror view (the Windows plain textarea editors). Copies the file into
 * the attachments folder like {@link insertImageFromPath}, uploads it when an
 * uploader is set to run on paste, and returns the link — or null if the copy
 * failed. Before this existed, dropping an image file onto the Windows editor
 * inserted the bare file path as text.
 */
export async function imageTextFromPath(
  srcPath: string,
  opts: ImagePasteOptions,
): Promise<string | null> {
  if (isContentUri(srcPath)) {
    let bytes: Uint8Array;
    try {
      bytes = await readContentUri(srcPath);
    } catch (err) {
      reportFailure(opts, err);
      return null;
    }
    return saveOrUploadText(bytes, sniffImageExt(bytes) || extFromName(srcPath) || 'png', opts);
  }
  const ext = extFromName(srcPath) || 'png';
  const filename = makeFilename(ext);
  const up = opts.getUploader ? opts.getUploader(filename) : null;
  const local = await prepareLocalTarget(filename, opts);
  const copyLocal = async (): Promise<boolean> => {
    try {
      await invoke('copy_file', { src: srcPath, dst: local.fullPath });
      return true;
    } catch (err) {
      reportFailure(opts, err);
      return false;
    }
  };
  if (!up || !up.onPaste) return (await copyLocal()) ? local.insertText : null;
  let uploadSrc = srcPath;
  if (up.keepLocal) {
    if (!(await copyLocal())) return null;
    uploadSrc = local.fullPath;
  }
  return performUpload(up, uploadSrc, opts, async () => {
    if (up.keepLocal) return local.insertText;
    return (await copyLocal()) ? local.insertText : markdownImage(srcPath.replace(/\\/g, '/'));
  });
}

export function imagePasteExtension(opts: ImagePasteOptions) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      // Fire and forget — the async handler calls preventDefault() sync
      // BEFORE any awaits, so the browser never inserts the image fallback.
      const cd = event.clipboardData;
      if (isEmptyClipboardEvent(cd)) {
        // Image-only clipboard on WebKitGTK: the event is empty, so read the
        // image from the OS clipboard (Tauri plugin) and insert that.
        event.preventDefault();
        void (async () => {
          const png = await readClipboardImageAsPng();
          if (png) await saveAndInsert(view, png, 'png', opts);
        })();
        return true;
      }
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

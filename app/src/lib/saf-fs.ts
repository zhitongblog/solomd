/**
 * #148 (Magic OS follow-up) — Storage Access Framework (SAF) file layer.
 *
 * On some OEM ROMs (Honor/Huawei Magic OS) MANAGE_EXTERNAL_STORAGE grants
 * nothing — std::fs on /storage/emulated/0 hits EACCES even with the permission
 * and after a restart. SAF is the universal, permission-free alternative: the
 * user picks a folder in the system dialog and we read/write it through
 * ContentResolver (native layer in saf_android.rs + MainActivity.kt).
 *
 * A SAF location is a (treeUri, documentId) pair. To thread it through the
 * existing path-based frontend with minimal churn, we encode files/folders as
 * the virtual path `saf:<documentId>` and keep the constant treeUri on the
 * workspace store. The helpers below wrap the saf_* Tauri commands and shape
 * their results like the normal `list_dir` / `read_file` responses.
 */
import { invoke } from '@tauri-apps/api/core';
import type { FileReadResult, Language } from '../types';

export const SAF_PREFIX = 'saf:';
/** Standard Android DocumentsContract.Document.MIME_TYPE_DIR for creating SAF directories. */
export const SAF_DIR_MIME = 'vnd.android.document/directory';

export function isSafPath(p: string | null | undefined): boolean {
  return typeof p === 'string' && p.startsWith(SAF_PREFIX);
}
export function toSafPath(docId: string): string {
  return SAF_PREFIX + docId;
}
export function fromSafPath(p: string): string {
  return p.startsWith(SAF_PREFIX) ? p.slice(SAF_PREFIX.length) : p;
}

const MD_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'markdn', 'mdtext', 'text']);
function langFor(name: string): Language {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return MD_EXTS.has(ext) ? 'markdown' : 'plaintext';
}

interface RawSafEntry {
  name: string;
  docId: string;
  isDir: boolean;
}
/** Same shape the file tree expects from `list_dir` (name/path/is_dir). */
export interface SafListEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export async function safList(treeUri: string, docId: string): Promise<SafListEntry[]> {
  const entries = await invoke<RawSafEntry[]>('saf_list', { treeUri, docId });
  return entries.map((e) => ({ name: e.name, path: toSafPath(e.docId), is_dir: e.isDir }));
}

export async function safRead(treeUri: string, docId: string): Promise<FileReadResult> {
  const content = await invoke<string>('saf_read', { treeUri, docId });
  const name = docId.split('/').pop() || docId;
  return { content, encoding: 'UTF-8', language: langFor(name), had_bom: false };
}

/** #476 — Read a binary file (e.g. image) from SAF as a base64 string. */
export async function safReadBase64(treeUri: string, docId: string): Promise<string> {
  return await invoke<string>('saf_read_base64', { treeUri, docId });
}

export async function safWrite(treeUri: string, docId: string, content: string): Promise<void> {
  await invoke('saf_write', { treeUri, docId, content });
}

/** #502 — Overwrite a SAF document with Base64-encoded binary bytes. */
export async function safWriteBase64(
  treeUri: string,
  docId: string,
  base64: string,
): Promise<void> {
  await invoke('saf_write_base64', { treeUri, docId, base64 });
}

/** Create a file under `parentDocId`; returns its documentId. */
export async function safCreate(
  treeUri: string,
  parentDocId: string,
  name: string,
  mime = 'text/markdown',
): Promise<string> {
  return await invoke<string>('saf_create', { treeUri, parentDocId, mime, name });
}

/** Delete a SAF document (file or directory). */
export async function safDelete(treeUri: string, docId: string): Promise<void> {
  await invoke('saf_delete', { treeUri, docId });
}

/** #502 — Create a folder under `parentDocId`; returns its documentId. */
export async function safCreateDir(
  treeUri: string,
  parentDocId: string,
  name: string,
): Promise<string> {
  return await invoke<string>('saf_create', {
    treeUri,
    parentDocId,
    mime: SAF_DIR_MIME,
    name,
  });
}

/**
 * #502 — Ensure a relative subfolder path (e.g. `"_assets"` or `"daily/2026"`)
 * exists under `parentDocId`, creating any missing segments via `safCreateDir`.
 * Returns the final directory's `docId`.
 */
export async function safEnsureSubdir(
  treeUri: string,
  parentDocId: string,
  relDir: string,
): Promise<string> {
  const segs = relDir
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.');
  let curDocId = parentDocId;
  for (const seg of segs) {
    const children = await safList(treeUri, curDocId);
    const existing = children.find(
      (c) => c.is_dir && (c.name === seg || c.name.toLowerCase() === seg.toLowerCase()),
    );
    if (existing) {
      curDocId = fromSafPath(existing.path);
    } else {
      curDocId = await safCreateDir(treeUri, curDocId, seg);
    }
  }
  return curDocId;
}

export async function safPersistedTrees(): Promise<string[]> {
  try {
    return await invoke<string[]>('saf_persisted_trees');
  } catch {
    return [];
  }
}

export interface SafVault {
  treeUri: string;
  rootDocId: string;
  name: string;
}

/** Launch the system folder picker (result arrives asynchronously). */
export async function safLaunchPicker(): Promise<void> {
  await invoke('saf_pick_folder');
}

/**
 * Drain one native pick result. The SAF picker is a separate activity that
 * backgrounds our WebView, so the result (delivered via onActivityResult) can't
 * be awaited inline — a JS poll loop is paused/lost across the transition.
 * Instead the caller polls this on resume (visibilitychange). Returns:
 *   'pending' — no result yet (still picking)
 *   null      — user cancelled
 *   SafVault  — a granted folder
 */
export async function safResolvePicked(): Promise<SafVault | null | 'pending'> {
  const res = await invoke<string | null>('saf_poll_picked');
  if (res === null) return 'pending';
  if (res === '') return null;
  const rootDocId = await invoke<string>('saf_tree_root', { treeUri: res });
  const name = await invoke<string>('saf_tree_name', { treeUri: res, docId: rootDocId });
  return { treeUri: res, rootDocId, name };
}

/**
 * #611 — Recover `{ treeUri, rootDocId, name }` for a `saf:<docId>` path (e.g.
 * from `recentFolders` persisted before `safVaults` existed, or a subfolder inside
 * a granted SAF tree) by matching against Android's persisted URI permissions.
 */
export async function safRecoverVaultForPath(safPath: string): Promise<SafVault | null> {
  if (!isSafPath(safPath)) return null;
  const targetDocId = fromSafPath(safPath);
  if (!targetDocId) return null;
  const trees = await safPersistedTrees();
  let bestTreeUri = '';
  let bestRootLen = -1;
  for (const treeUri of trees) {
    try {
      const rootDocId = await invoke<string>('saf_tree_root', { treeUri });
      const matches =
        targetDocId === rootDocId ||
        targetDocId.startsWith(`${rootDocId}/`) ||
        (rootDocId.endsWith(':') && targetDocId.startsWith(rootDocId));
      if (matches && rootDocId.length > bestRootLen) {
        bestTreeUri = treeUri;
        bestRootLen = rootDocId.length;
      }
    } catch {
      /* ignore invalid/revoked tree URI */
    }
  }
  if (!bestTreeUri) return null;
  let name = targetDocId.split('/').pop()?.split(':').pop() || 'Vault';
  try {
    const fetched = await invoke<string>('saf_tree_name', { treeUri: bestTreeUri, docId: targetDocId });
    if (fetched) name = fetched;
  } catch {
    /* keep fallback segment name */
  }
  return { treeUri: bestTreeUri, rootDocId: targetDocId, name };
}

export interface SafAllFilesAccessStatus {
  supported: boolean;
  granted: boolean;
}

/**
 * #611 — Check whether MANAGE_EXTERNAL_STORAGE ("All Files Access") is declared
 * in this APK and currently granted on Android 11+ (needed on OEM ROMs such as
 * ColorOS 16 / Android 16 when Syncthing / VNote syncs non-media `.md` files).
 */
export async function safAllFilesAccessStatus(): Promise<SafAllFilesAccessStatus> {
  try {
    return await invoke<SafAllFilesAccessStatus>('saf_all_files_access_status');
  } catch {
    return { supported: false, granted: true };
  }
}

/** #611 — Launch Android's system settings page to grant All Files Access. */
export async function safRequestAllFilesAccess(): Promise<void> {
  try {
    await invoke('saf_request_all_files_access');
  } catch {
    /* ignore on unsupported platforms */
  }
}

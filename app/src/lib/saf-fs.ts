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

export async function safWrite(treeUri: string, docId: string, content: string): Promise<void> {
  await invoke('saf_write', { treeUri, docId, content });
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

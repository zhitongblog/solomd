/**
 * F3 — Typed relationships (v4.6) composable.
 *
 * Wraps the workspace index for the RelationshipsPanel:
 *   - `forwardFor(path)`     — forward typed relationships authored in the
 *                              doc's YAML front matter (read from the index).
 *   - `referencedByFor(stem)`— inverse edges, resolved server-side over the
 *                              in-memory index (`workspace_index_referenced_by`),
 *                              memoized per `idx.entries` identity via a WeakMap
 *                              (Tolaria's approach) to avoid O(entries×refs)
 *                              recompute on every active-doc change.
 *   - `addRef` / `removeRef` / `addRelationshipKey` — front-matter edit path:
 *                              read the doc, rewrite its YAML block via the
 *                              pure transforms in `lib/relationships.ts`, and
 *                              persist with `write_file`.
 *
 * Edit safety: relationship edits only touch the *active* document, and only
 * when its editor buffer is clean — a dirty buffer is saved first (so a panel
 * edit never races the editor autosave or clobbers unsaved body changes).
 */
import { invoke } from '@tauri-apps/api/core';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkspaceIndexStore, type IndexEntry, type ReferencedByRef } from '../stores/workspaceIndex';
import { useToastsStore } from '../stores/toasts';
import type { FileReadResult } from '../types';
import {
  extractRelationships,
  setRelationshipInBlock,
  parseWikilinkTarget,
} from '../lib/relationships';

/** Cache of referenced-by promises keyed by the entries array identity, so a
 *  stable entries array reuses in-flight / resolved lookups; a fresh entries
 *  array (after `solomd://index-updated`) gets a clean cache automatically. */
const refByCache = new WeakMap<IndexEntry[], Map<string, Promise<ReferencedByRef[]>>>();

/** Split a full document into (bom, fenced-frontmatter-block, rest-after-block).
 *  Returns null when the doc doesn't open with a `---` front-matter fence. */
function splitFrontMatter(
  doc: string,
): { bom: string; block: string; after: string } | null {
  const bom = doc.startsWith('﻿') ? '﻿' : '';
  const body = bom ? doc.slice(1) : doc;
  if (!body.startsWith('---')) return null;
  const nl = body.indexOf('\n');
  if (nl < 0) return null;
  const afterOpen = body.slice(nl + 1);
  const end = afterOpen.indexOf('\n---');
  if (end < 0) return null;
  const block = afterOpen.slice(0, end);
  // Skip past `\n---` and the trailing newline of the closing fence, if any.
  let cursor = end + '\n---'.length;
  if (afterOpen[cursor] === '\n') cursor += 1;
  const after = afterOpen.slice(cursor);
  return { bom, block, after };
}

/** Rebuild a document from its three parts, re-emitting the `---` fences. */
function joinFrontMatter(bom: string, block: string, after: string): string {
  return `${bom}---\n${block}\n---\n${after}`;
}

/** Synthesize a minimal front-matter block in a doc that has none. */
function withSynthesizedFrontMatter(doc: string, block: string): string {
  const bom = doc.startsWith('﻿') ? '﻿' : '';
  const rest = bom ? doc.slice(1) : doc;
  const sep = rest.length === 0 ? '' : rest.startsWith('\n') ? '' : '\n';
  return `${bom}---\n${block}\n---\n${sep}${rest}`;
}

export function useRelationships() {
  const tabs = useTabsStore();
  const workspace = useWorkspaceStore();
  const idx = useWorkspaceIndexStore();
  const toasts = useToastsStore();

  /** Forward typed relationships for the entry at `path` (from the index;
   *  falls back to parsing the active tab's frontmatter object isn't needed —
   *  the index already carries the parsed `relationships` map). */
  function forwardFor(path: string | null): Record<string, string[]> {
    if (!path) return {};
    const e = idx.byPath.get(path);
    if (e?.relationships) return e.relationships;
    // Fallback: derive from raw frontmatter if the index predates F3.
    if (e?.frontmatter) return extractRelationships(e.frontmatter);
    return {};
  }

  /** Inverse edges pointing at `stem`, memoized off `idx.entries` identity. */
  function referencedByFor(stem: string | null): Promise<ReferencedByRef[]> {
    if (!stem) return Promise.resolve([]);
    const entries = idx.entries;
    let bucket = refByCache.get(entries);
    if (!bucket) {
      bucket = new Map();
      refByCache.set(entries, bucket);
    }
    const key = stem.toLowerCase();
    const cached = bucket.get(key);
    if (cached) return cached;
    const p = idx.referencedBy(stem);
    bucket.set(key, p);
    return p;
  }

  // --- Edit path -----------------------------------------------------------

  /** Read the active doc (saving the editor buffer first if dirty), returning
   *  its on-disk content + the path/encoding needed to write it back, or null
   *  when there is no editable active markdown doc. */
  async function readActiveDoc(): Promise<
    { path: string; content: string; encoding: string; lineEnding?: 'lf' | 'crlf'; tabId: string } | null
  > {
    const tab = tabs.activeTab;
    if (!tab || !tab.filePath) {
      toasts.error('No active document to edit relationships on.');
      return null;
    }
    if (tab.language !== 'markdown') {
      toasts.error('Relationships can only be edited on Markdown notes.');
      return null;
    }
    if (tab.content !== tab.savedContent) {
      // Don't race the editor buffer — persist current edits first.
      toasts.error('Save the document first, then edit relationships.');
      return null;
    }
    try {
      const res = await invoke<FileReadResult>('read_file', { path: tab.filePath });
      return {
        path: tab.filePath,
        content: res.content,
        encoding: tab.encoding || res.encoding || 'UTF-8',
        lineEnding: tab.lineEnding,
        tabId: tab.id,
      };
    } catch (e) {
      toasts.error(`Failed to read document: ${e}`);
      return null;
    }
  }

  /** Persist a rewritten document back to disk and keep the open tab in sync. */
  async function writeActiveDoc(
    doc: { path: string; encoding: string; lineEnding?: 'lf' | 'crlf'; tabId: string },
    newContent: string,
  ): Promise<boolean> {
    try {
      const payload =
        doc.lineEnding === 'crlf' ? newContent.replace(/\n/g, '\r\n') : newContent;
      await invoke('write_file', {
        path: doc.path,
        content: payload,
        encoding: doc.encoding,
        workspace: workspace.currentFolder ?? undefined,
      });
      // Keep the editor buffer in sync so it doesn't show stale content / a
      // false dirty dot. Both content and savedContent move together (the
      // tab was clean before this edit, guaranteed by readActiveDoc).
      tabs.setContent(doc.tabId, newContent);
      tabs.markSaved(doc.tabId, doc.path);
      // The Rust watcher will re-index and emit `solomd://index-updated`,
      // refreshing both panels. Nudge an immediate index refresh too.
      idx.refresh().catch(() => {});
      return true;
    } catch (e) {
      toasts.error(`Failed to save relationship: ${e}`);
      return false;
    }
  }

  /** Compute the new ref list for `key` after applying `mutate`, then write. */
  async function applyEdit(
    key: string,
    mutate: (current: string[]) => string[],
  ): Promise<boolean> {
    const doc = await readActiveDoc();
    if (!doc) return false;

    const current = forwardFor(doc.path)[key] ?? [];
    const next = dedupeRefs(mutate(current));

    const split = splitFrontMatter(doc.content);
    let newDoc: string;
    if (split) {
      const newBlock = setRelationshipInBlock(split.block, key, next);
      newDoc = joinFrontMatter(split.bom, newBlock, split.after);
    } else {
      // No front matter — synthesize one (only meaningful when adding refs).
      if (next.length === 0) return true;
      const newBlock = setRelationshipInBlock('', key, next);
      newDoc = withSynthesizedFrontMatter(doc.content, newBlock);
    }
    if (newDoc === doc.content) return true; // no-op
    return writeActiveDoc(doc, newDoc);
  }

  /** Add a `[[stem]]` ref under relationship `key` on the active doc. */
  function addRef(key: string, targetStem: string): Promise<boolean> {
    const ref = `[[${parseWikilinkTarget(targetStem)}]]`;
    return applyEdit(key, (cur) => [...cur, ref]);
  }

  /** Remove a ref (by its canonical `[[stem]]` form) from relationship `key`. */
  function removeRef(key: string, ref: string): Promise<boolean> {
    const targetLc = parseWikilinkTarget(ref).toLowerCase();
    return applyEdit(key, (cur) =>
      cur.filter((r) => parseWikilinkTarget(r).toLowerCase() !== targetLc),
    );
  }

  /** Introduce a brand-new relationship key with a first target ref. */
  function addRelationshipKey(key: string, targetStem: string): Promise<boolean> {
    const cleanKey = key.trim();
    if (!cleanKey) {
      toasts.error('Relationship name cannot be empty.');
      return Promise.resolve(false);
    }
    return addRef(cleanKey, targetStem);
  }

  return {
    forwardFor,
    referencedByFor,
    addRef,
    removeRef,
    addRelationshipKey,
  };
}

/** De-duplicate refs by canonical target (case-insensitive), keeping order. */
function dedupeRefs(refs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refs) {
    const k = parseWikilinkTarget(r).toLowerCase();
    if (k.length === 0 || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

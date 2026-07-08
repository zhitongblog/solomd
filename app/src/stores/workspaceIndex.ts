/**
 * Vue/Pinia store wrapping the Rust `workspace_index` Tauri commands.
 *
 * Single source of truth for v2.0 features that need to know what's in the
 * current workspace folder:
 *   - Wikilinks (F1) → autocomplete + resolve target
 *   - Backlinks (F1) → list of references to the active doc
 *   - Tags (F3) → sidebar panel
 *   - Bases (F6) → properties table
 *
 * Whenever the workspace folder changes (workspace store), we re-init the
 * Rust index. The Rust side emits `solomd://index-updated` after every
 * mutation; we listen and refresh our cached `entries` array.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface WikilinkRef {
  target: string;
  heading?: string | null;
  alias?: string | null;
  line: number;
}

export interface IndexEntry {
  path: string;
  name: string;
  stem: string;
  mtime: number;
  size: number;
  /** Parsed YAML front matter (an object, or null if none). */
  frontmatter: Record<string, unknown> | null;
  wikilinks: WikilinkRef[];
  tags: string[];
  headings: string[];
  summary: string;
  title?: string | null;
  /**
   * F3 (v4.6) typed relationships: map `frontmatter key → list of canonical
   * `[[ref]]`s`. Populated server-side by the Rust extractor (mirrors
   * `lib/relationships.ts::extractRelationships`). Reserved/structural keys
   * are excluded. May be absent on entries served from an older index cache.
   */
  relationships?: Record<string, string[]>;
}

export interface BacklinkRef {
  from_path: string;
  from_name: string;
  line: number;
  context: string[];
}

/** F3 — one inverse (referenced-by) edge resolved server-side over the
 *  in-memory index by `workspace_index_referenced_by`. */
export interface ReferencedByRef {
  from_path: string;
  from_name: string;
  /** The forward-relationship frontmatter key on the source note. */
  via_key: string;
}

export interface TagCount {
  tag: string;
  count: number;
  files: string[];
}

interface State {
  /** Workspace folder path (null when no folder is open). */
  folder: string | null;
  /** Whether the Rust index has been initialized for the current folder. */
  ready: boolean;
  /** Cached files list. Refreshed on `solomd://index-updated`. */
  entries: IndexEntry[];
  /** Cached tag counts. */
  tags: TagCount[];
  /** Last error message, if any (shown in the UI). */
  lastError: string | null;
}

let unlistenIndex: UnlistenFn | null = null;

export const useWorkspaceIndexStore = defineStore('workspaceIndex', {
  state: (): State => ({
    folder: null,
    ready: false,
    entries: [],
    tags: [],
    lastError: null,
  }),
  getters: {
    /** Map stem → entry for O(1) wikilink resolution in autocomplete. */
    byStem(state): Map<string, IndexEntry> {
      const m = new Map<string, IndexEntry>();
      for (const e of state.entries) m.set(e.stem.toLowerCase(), e);
      return m;
    },
    /** Map path → entry for backlink lookup. */
    byPath(state): Map<string, IndexEntry> {
      const m = new Map<string, IndexEntry>();
      for (const e of state.entries) m.set(e.path, e);
      return m;
    },
    /**
     * F3 — forward typed relationships for the entry at `path`, as a map of
     * `frontmatter key → [[ref]] list`. Returns `{}` when the entry is
     * unknown or has none.
     */
    relationshipsFor(state) {
      return (path: string): Record<string, string[]> => {
        const e = state.entries.find((x) => x.path === path);
        return e?.relationships ?? {};
      };
    },
  },
  actions: {
    /** Called by the workspace store whenever the folder changes. */
    async setFolder(folder: string | null) {
      if (folder === this.folder) return;
      this.folder = folder;
      this.ready = false;
      this.entries = [];
      this.tags = [];
      if (!folder) return;
      try {
        await invoke<number>('workspace_index_init', { folder });
        await this.refresh();
        if (!unlistenIndex) {
          unlistenIndex = await listen('solomd://index-updated', () => {
            this.refresh().catch(() => {});
          });
        }
        this.ready = true;
      } catch (e) {
        this.lastError = String(e);
        console.warn('workspace_index_init failed', e);
      }
    },

    async refresh(): Promise<void> {
      try {
        const [files, tags] = await Promise.all([
          invoke<IndexEntry[]>('workspace_index_files'),
          invoke<TagCount[]>('workspace_index_tags'),
        ]);
        this.entries = files;
        this.tags = tags;
      } catch (e) {
        // Probably not initialized yet; quietly retry on next event.
      }
    },

    async resolve(name: string): Promise<string | null> {
      try {
        return await invoke<string | null>('workspace_index_resolve', { name });
      } catch {
        return null;
      }
    },

    async backlinksFor(target: string): Promise<BacklinkRef[]> {
      try {
        return await invoke<BacklinkRef[]>('workspace_index_backlinks', { target });
      } catch {
        return [];
      }
    },

    /**
     * F3 — inverse relationships: notes whose front matter has a typed
     * relationship key pointing at `target` (resolved server-side over the
     * in-memory index by stem / title / alias / path-suffix). `target` is a
     * wikilink target stem (e.g. the active doc's filename stem).
     */
    async referencedBy(target: string): Promise<ReferencedByRef[]> {
      try {
        return await invoke<ReferencedByRef[]>('workspace_index_referenced_by', { target });
      } catch {
        return [];
      }
    },

    async rescan(): Promise<void> {
      try {
        await invoke('workspace_index_rescan');
        await this.refresh();
      } catch (e) {
        this.lastError = String(e);
      }
    },
  },
});

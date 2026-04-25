/**
 * Vue/Pinia store wrapping the Rust `rag` Tauri commands.
 *
 * Tracks index status (X of Y notes indexed) and exposes `search()` for
 * the panel. The settings toggle is the single source of truth — when
 * `settings.ragEnabled` flips on, we call `rag_set_enabled` (which
 * triggers a background scan); when it flips off, we just stop calling
 * search. We don't tear the DB down — re-enabling is then instant.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

export interface RagStatus {
  enabled: boolean;
  ready: boolean;
  total_files: number;
  indexed_files: number;
  total_chunks: number;
  backend: string;
  index_version: number;
}

export interface RagHit {
  path: string;
  name: string;
  chunk_idx: number;
  char_start: number;
  char_end: number;
  score: number;
  snippet: string;
}

interface State {
  status: RagStatus | null;
  indexing: boolean;
  searching: boolean;
  lastError: string | null;
}

export const useRagStore = defineStore('rag', {
  state: (): State => ({
    status: null,
    indexing: false,
    searching: false,
    lastError: null,
  }),
  actions: {
    async refreshStatus(folder: string | null): Promise<void> {
      if (!folder) {
        this.status = null;
        return;
      }
      try {
        this.status = await invoke<RagStatus>('rag_index_status', { folder });
      } catch (e) {
        this.lastError = String(e);
      }
    },

    /** Toggle indexing on/off; triggers a scan when turning on. */
    async setEnabled(folder: string | null, enabled: boolean): Promise<void> {
      if (!folder) return;
      this.indexing = enabled;
      try {
        this.status = await invoke<RagStatus>('rag_set_enabled', { folder, enabled });
      } catch (e) {
        this.lastError = String(e);
      } finally {
        this.indexing = false;
      }
    },

    async reindex(folder: string | null): Promise<void> {
      if (!folder) return;
      this.indexing = true;
      this.lastError = null;
      try {
        this.status = await invoke<RagStatus>('rag_reindex', { folder });
      } catch (e) {
        this.lastError = String(e);
      } finally {
        this.indexing = false;
      }
    },

    async search(folder: string | null, query: string, limit = 20): Promise<RagHit[]> {
      if (!folder || !query.trim()) return [];
      this.searching = true;
      this.lastError = null;
      try {
        const hits = await invoke<RagHit[]>('rag_search', {
          args: { folder, query, limit },
        });
        return hits;
      } catch (e) {
        this.lastError = String(e);
        return [];
      } finally {
        this.searching = false;
      }
    },

    /** Called by the workspace_index file watcher (single-file rescan). */
    async reindexFile(folder: string | null, filePath: string): Promise<void> {
      if (!folder) return;
      try {
        await invoke('rag_reindex_file', { folder, filePath });
      } catch {
        // best-effort; full reindex will catch up if this misses.
      }
    },
  },
});

/**
 * Pinia store for v2.2 AutoGit per-note history.
 *
 * Wraps the Rust `git_*` Tauri commands and caches the per-folder
 * `WorkspaceStatus` so the History panel can render synchronously.
 *
 * The cache is invalidated on every `solomd://index-updated` event the
 * Rust workspace_index file watcher emits — that fires on every file
 * change, which is exactly when our git status would have changed.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { hasGitBackend } from '../lib/platform';

export interface WorkspaceStatus {
  initialized: boolean;
  head_sha: string | null;
  head_message: string | null;
  dirty: boolean;
  branch: string | null;
}

export interface CommitMeta {
  sha: string;
  short_sha: string;
  message: string;
  author: string;
  /** Seconds since UNIX epoch. */
  time: number;
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

export interface DiffResult {
  from_sha: string | null;
  to_sha: string;
  hunks: DiffHunk[];
  unified: string;
}

interface State {
  /** Last folder we queried — used to detect cache misses. */
  folder: string | null;
  status: WorkspaceStatus | null;
  /** Cached per-file commit lists, keyed by absolute file path. */
  history: Record<string, CommitMeta[]>;
  loading: boolean;
  staging: boolean;
  pulling: boolean;
  pushing: boolean;
  lastError: string | null;
}

let unlisten: UnlistenFn | null = null;

export const useGitHistoryStore = defineStore('gitHistory', {
  state: (): State => ({
    folder: null,
    status: null,
    history: {},
    loading: false,
    staging: false,
    pulling: false,
    pushing: false,
    lastError: null,
  }),

  getters: {
    /** Convenience flag for empty-state UI in HistoryPanel. */
    isInitialized(state): boolean {
      return state.status?.initialized === true;
    },
  },

  actions: {
    /**
     * Refresh the cached `WorkspaceStatus` for the active folder. Cheap —
     * the Rust side only inspects the index, not the whole tree.
     */
    async refreshStatus(folder: string | null): Promise<void> {
      // #230 — `git_*` is compiled out of the Android binary (no git2 there).
      // Without this the version-history panel probes on every folder open and
      // parks a `Command git_workspace_status not found` in `lastError`.
      if (!hasGitBackend()) {
        this.folder = folder;
        this.status = null;
        return;
      }
      if (!folder) {
        this.folder = null;
        this.status = null;
        return;
      }
      this.folder = folder;
      try {
        this.status = await invoke<WorkspaceStatus>('git_workspace_status', { folder });
      } catch (e) {
        this.lastError = String(e);
        this.status = null;
      }
      // Set up the auto-refresh listener once.
      if (!unlisten) {
        try {
          unlisten = await listen('solomd://index-updated', () => {
            // Invalidate cached histories — the file under cursor likely
            // got a new commit.
            this.history = {};
            if (this.folder) this.refreshStatus(this.folder).catch(() => {});
          });
        } catch {
          /* ignore */
        }
      }
    },

    /** `git init` + initial commit. */
    async init(folder: string, initialMessage?: string, excludeAssets?: boolean): Promise<void> {
      this.loading = true;
      try {
        await invoke('git_init_workspace', {
          folder,
          initialMessage: initialMessage ?? null,
          excludeAssets: excludeAssets ?? false,
        });
        await this.refreshStatus(folder);
      } finally {
        this.loading = false;
      }
    },

    /** Stage + commit. Returns the new SHA, or null if nothing changed. */
    async commit(folder: string, filePath?: string, message?: string): Promise<string | null> {
      try {
        const sha = await invoke<string | null>('git_auto_commit', {
          folder,
          filePath: filePath ?? null,
          message: message ?? null,
        });
        // Bust caches so the panel reloads.
        this.history = {};
        await this.refreshStatus(folder);
        return sha ?? null;
      } catch (e) {
        this.lastError = String(e);
        throw e;
      }
    },

    async historyFor(
      folder: string,
      filePath: string,
      limit = 50,
    ): Promise<CommitMeta[]> {
      const key = filePath;
      if (this.history[key]) return this.history[key];
      try {
        const list = await invoke<CommitMeta[]>('git_file_history', {
          folder,
          filePath,
          limit,
        });
        this.history[key] = list;
        return list;
      } catch (e) {
        this.lastError = String(e);
        return [];
      }
    },

    async diff(folder: string, filePath: string, sha: string): Promise<DiffResult | null> {
      try {
        return await invoke<DiffResult>('git_file_diff', { folder, filePath, sha });
      } catch (e) {
        this.lastError = String(e);
        return null;
      }
    },

    async fileAt(folder: string, filePath: string, sha: string): Promise<string | null> {
      try {
        return await invoke<string>('git_file_at_version', { folder, filePath, sha });
      } catch (e) {
        this.lastError = String(e);
        return null;
      }
    },

    /** #620 — Stage changes (`git add`) without committing. */
    async stage(folder: string, filePath?: string): Promise<number> {
      this.staging = true;
      try {
        const count = await invoke<number>('git_stage', {
          folder,
          filePath: filePath ?? null,
        });
        await this.refreshStatus(folder);
        return count;
      } catch (e) {
        this.lastError = String(e);
        throw e;
      } finally {
        this.staging = false;
      }
    },

    /** #620 — Run system `git pull` for plain local git repos. */
    async cliPull(folder: string): Promise<string> {
      this.pulling = true;
      try {
        const out = await invoke<string>('git_cli_pull', { folder });
        this.history = {};
        await this.refreshStatus(folder);
        window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
        return out;
      } catch (e) {
        this.lastError = String(e);
        throw e;
      } finally {
        this.pulling = false;
      }
    },

    /** #620 — Run system `git push` for plain local git repos. */
    async cliPush(folder: string): Promise<string> {
      this.pushing = true;
      try {
        const out = await invoke<string>('git_cli_push', { folder });
        await this.refreshStatus(folder);
        return out;
      } catch (e) {
        this.lastError = String(e);
        throw e;
      } finally {
        this.pushing = false;
      }
    },

    async rollback(folder: string, filePath: string, sha: string): Promise<void> {
      await invoke('git_rollback_file', { folder, filePath, sha });
      // Clear cached history for the file — caller will save+commit shortly.
      delete this.history[filePath];
    },
  },
});

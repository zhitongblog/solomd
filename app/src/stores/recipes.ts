/**
 * v4.0 Pillar 2 — Recipes store.
 *
 * Wraps the `recipes_*` Tauri commands so the Settings → Recipes panel
 * (and the future Command Palette "Run recipe…" entry) can share a
 * single cache + mutation surface.
 *
 * Listens for `solomd://recipes-run-finished` events emitted by the
 * Rust runner so the pending-runs section refreshes without polling.
 */

import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ---------------------------------------------------------------------------
// Wire-format types — mirror the Rust `RecipeSummary` / `RunMeta` structs.
// ---------------------------------------------------------------------------

export interface RecipeSummary {
  name: string;
  slug: string;
  path: string;
  trigger: string;
  schedule: string | null;
  match_glob: string | null;
  tag: string | null;
  allow_write: boolean;
  write_cap: number;
  provider: string;
  model: string;
  last_run_status: string | null;
  last_run_id: string | null;
  last_run_started_at: number | null;
}

export interface RecipeMeta {
  name: string;
  path: string;
  trigger: string;
  branch: string;
}

export interface TokenCounts {
  input: number;
  output: number;
}

export interface RunMeta {
  run_id: string;
  kind: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  workspace: string;
  provider: string;
  model: string;
  recipe: RecipeMeta | null;
  tokens: TokenCounts;
  cost_usd_estimate: number;
  error: string | null;
  accepted: boolean | null;
}

interface State {
  /** Loaded list of recipes for the active workspace. */
  recipes: RecipeSummary[];
  /** Pending-review runs (status="ok" + accepted=null). */
  pendingRuns: RunMeta[];
  /** Full run history, newest first. */
  history: RunMeta[];
  /** Last error from any backend call. UI surfaces this in a toast. */
  lastError: string | null;
  /** Are we currently fetching from the backend? */
  loading: boolean;
  /** Cached unlisten fn from the run-finished subscription. */
  unlistenRun: UnlistenFn | null;
  /** Workspace path the cache was last populated for. */
  cachedFor: string | null;
}

export const useRecipesStore = defineStore('recipes', {
  state: (): State => ({
    recipes: [],
    pendingRuns: [],
    history: [],
    lastError: null,
    loading: false,
    unlistenRun: null,
    cachedFor: null,
  }),
  actions: {
    /**
     * Refresh `recipes` + `pendingRuns` + `history` for `workspace`.
     * Cheap to call repeatedly — the Rust side just rescans
     * `.solomd/agents/` and `.solomd/agent-runs/` (both are small).
     */
    async refresh(workspace: string | null): Promise<void> {
      if (!workspace) {
        this.recipes = [];
        this.pendingRuns = [];
        this.history = [];
        this.cachedFor = null;
        return;
      }
      this.loading = true;
      this.lastError = null;
      try {
        const [recipes, pending, history] = await Promise.all([
          invoke<RecipeSummary[]>('recipes_list', { workspace }),
          invoke<RunMeta[]>('recipes_pending_runs', { workspace }),
          invoke<RunMeta[]>('recipes_history', { workspace }),
        ]);
        this.recipes = recipes;
        this.pendingRuns = pending;
        this.history = history;
        this.cachedFor = workspace;
      } catch (e) {
        this.lastError = String(e);
      } finally {
        this.loading = false;
      }
    },

    /** Run a recipe manually. Returns the new run id. */
    async runNow(workspace: string, slug: string): Promise<string | null> {
      this.lastError = null;
      try {
        const runId = await invoke<string>('recipes_run_now', { workspace, slug });
        // Refresh on completion is already triggered by the
        // `recipes-run-finished` listener; no need to await it here.
        return runId;
      } catch (e) {
        this.lastError = String(e);
        return null;
      }
    },

    /** Save a recipe yaml. Slug defaults to the one parsed out of `name`. */
    async save(
      workspace: string,
      yaml: string,
      slug?: string,
    ): Promise<string | null> {
      this.lastError = null;
      try {
        const path = await invoke<string>('recipes_save', {
          req: { workspace, yaml, slug: slug ?? null },
        });
        await this.refresh(workspace);
        return path;
      } catch (e) {
        this.lastError = String(e);
        return null;
      }
    },

    async readYaml(workspace: string, slug: string): Promise<string | null> {
      try {
        return await invoke<string>('recipes_get', { workspace, slug });
      } catch (e) {
        this.lastError = String(e);
        return null;
      }
    },

    async delete(workspace: string, slug: string): Promise<void> {
      try {
        await invoke('recipes_delete', { workspace, slug });
        await this.refresh(workspace);
      } catch (e) {
        this.lastError = String(e);
      }
    },

    async readDiff(workspace: string, runId: string): Promise<string | null> {
      try {
        return await invoke<string>('recipes_run_diff', { workspace, runId });
      } catch (e) {
        this.lastError = String(e);
        return null;
      }
    },

    async readTrace(workspace: string, runId: string): Promise<string | null> {
      try {
        return await invoke<string>('recipes_read_trace', { workspace, runId });
      } catch (e) {
        this.lastError = String(e);
        return null;
      }
    },

    async readRunMd(workspace: string, runId: string): Promise<string | null> {
      try {
        return await invoke<string>('recipes_read_run_md', { workspace, runId });
      } catch (e) {
        this.lastError = String(e);
        return null;
      }
    },

    async accept(workspace: string, runId: string): Promise<boolean> {
      this.lastError = null;
      try {
        await invoke('recipes_accept_run', { workspace, runId });
        await this.refresh(workspace);
        return true;
      } catch (e) {
        this.lastError = String(e);
        return false;
      }
    },

    async reject(workspace: string, runId: string): Promise<boolean> {
      this.lastError = null;
      try {
        await invoke('recipes_reject_run', { workspace, runId });
        await this.refresh(workspace);
        return true;
      } catch (e) {
        this.lastError = String(e);
        return false;
      }
    },

    /**
     * Subscribe to the `recipes-run-finished` event. Idempotent — calls
     * after the first one are no-ops. Components that care should call
     * `unsubscribe()` on unmount, but it's fine for the listener to live
     * for the app's lifetime since it just refreshes the cache.
     */
    async subscribe(workspaceGetter: () => string | null): Promise<void> {
      if (this.unlistenRun) return;
      this.unlistenRun = await listen('solomd://recipes-run-finished', () => {
        const ws = workspaceGetter();
        if (ws) {
          // Don't await — fire-and-forget refresh.
          this.refresh(ws);
        }
      });
    },

    async unsubscribe(): Promise<void> {
      if (this.unlistenRun) {
        this.unlistenRun();
        this.unlistenRun = null;
      }
    },
  },
});

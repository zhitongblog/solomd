/**
 * v4.0 Pillar 3 — agent trace store.
 *
 * Caches per-run trace lines fetched from the Rust side, plus a list of
 * recent run summaries for the panel's "history" tab and the Recipes
 * Settings page. Reads only — writes are owned by P1's panel runner and
 * P2's recipe runner, both of which call into the canonical Rust
 * `Emitter` directly. The frontend never appends to `trace.jsonl` itself.
 *
 * Cache invalidation:
 *   - `loadTrace(workspace, run_id, force?)` re-fetches when `force` is
 *     true OR the cached entry is older than `STALE_MS`. Otherwise the
 *     cached array is returned. The TraceView re-loads on a tick while a
 *     run is still streaming so freshness comes from the consumer's
 *     polling, not from cache TTL.
 *   - `loadRuns(workspace, force?)` is the same shape for the summaries.
 *
 * No persistence. The trace is on disk; reloading the app re-reads it.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

/** One parsed line from `trace.jsonl`. Mirrors `crate::trace::TraceLine`. */
export interface TraceLine {
  /** Unix milliseconds, UTC. */
  ts: number;
  run_id: string;
  /** 1-based monotonic step index. */
  seq: number;
  /** Lower-snake_case kind (e.g. `"tool_call"`). */
  kind: string;
  /** All other fields the kind carries — see contracts C2. */
  [key: string]: unknown;
}

/** Recent-run summary. Mirrors `crate::agent_trace::RunSummary`. */
export interface RunSummary {
  run_id: string;
  kind: string;
  status: string;
  /** Unix seconds. */
  started_at: number;
  ended_at: number | null;
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd_estimate: number;
  has_meta: boolean;
}

interface CachedTrace {
  lines: TraceLine[];
  fetched_at: number;
}

interface State {
  /** key = `${workspace}:${run_id}` */
  cache: Record<string, CachedTrace>;
  /** key = workspace */
  runs: Record<string, RunSummary[]>;
  loading: Record<string, boolean>;
  error: string | null;
}

const STALE_MS = 1500;

export const useAgentTraceStore = defineStore('agentTrace', {
  state: (): State => ({
    cache: {},
    runs: {},
    loading: {},
    error: null,
  }),
  getters: {
    isLoading: (state) => (key: string) => !!state.loading[key],
  },
  actions: {
    cacheKey(workspace: string, runId: string) {
      return `${workspace}::${runId}`;
    },

    async loadTrace(workspace: string, runId: string, force = false): Promise<TraceLine[]> {
      const key = this.cacheKey(workspace, runId);
      const hit = this.cache[key];
      if (!force && hit && Date.now() - hit.fetched_at < STALE_MS) {
        return hit.lines;
      }
      this.loading[key] = true;
      try {
        const lines = await invoke<TraceLine[]>('agent_trace_read', {
          workspace,
          runId,
        });
        this.cache[key] = { lines, fetched_at: Date.now() };
        this.error = null;
        return lines;
      } catch (e) {
        this.error = String(e);
        throw e;
      } finally {
        this.loading[key] = false;
      }
    },

    async loadRuns(workspace: string, force = false): Promise<RunSummary[]> {
      const key = `runs::${workspace}`;
      const hit = this.runs[workspace];
      if (!force && hit && hit.length > 0) {
        // We don't TTL the list — the caller refreshes explicitly when
        // a run starts/ends. This avoids hammering the FS on every
        // panel re-render.
        return hit;
      }
      this.loading[key] = true;
      try {
        const list = await invoke<RunSummary[]>('agent_trace_list', { workspace });
        this.runs[workspace] = list;
        this.error = null;
        return list;
      } catch (e) {
        this.error = String(e);
        throw e;
      } finally {
        this.loading[key] = false;
      }
    },

    /**
     * Mint a new run dir whose trace is the prefix of `runId` up to
     * (but not including) `seq`. Returns the new run id; the caller is
     * responsible for re-issuing the model call (P1's `ai_chat`).
     */
    async replayFrom(workspace: string, runId: string, seq: number): Promise<string> {
      const newRunId = await invoke<string>('agent_trace_replay_from', {
        workspace,
        runId,
        seq,
      });
      // Force-refresh the recent runs list so the new entry shows up.
      await this.loadRuns(workspace, true);
      return newRunId;
    },

    invalidate(workspace: string, runId?: string) {
      if (runId) {
        delete this.cache[this.cacheKey(workspace, runId)];
      } else {
        for (const k of Object.keys(this.cache)) {
          if (k.startsWith(`${workspace}::`)) delete this.cache[k];
        }
      }
      delete this.runs[workspace];
    },
  },
});

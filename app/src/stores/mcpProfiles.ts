/**
 * v4.0 P4 — MCP federation profile store.
 *
 * Backs the Settings → Integrations "MCP profiles" UI. A *profile* is a
 * named bundle of `(alias, workspace path)` entries the user wants to
 * expose through one solomd-mcp invocation. The profile name doubles as
 * the `mcpServers.<key>` in the rendered Claude Desktop config snippet.
 *
 * The Rust side (`mcp_profiles::*` Tauri commands) owns disk persistence
 * — we keep an in-memory mirror of the profile list and refresh it after
 * every mutation. Optimistic updates keep the UI responsive while the
 * round-trip to Tauri lands.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

export interface McpWorkspaceEntry {
  alias: string;
  path: string;
}

export interface McpProfile {
  name: string;
  entries: McpWorkspaceEntry[];
  allow_write: boolean;
}

interface State {
  profiles: McpProfile[];
  loaded: boolean;
  loading: boolean;
  error: string;
  savingName: string;
}

export const useMcpProfilesStore = defineStore('mcpProfiles', {
  state: (): State => ({
    profiles: [],
    loaded: false,
    loading: false,
    error: '',
    savingName: '',
  }),
  getters: {
    byName(state): Record<string, McpProfile> {
      const out: Record<string, McpProfile> = {};
      for (const p of state.profiles) out[p.name] = p;
      return out;
    },
  },
  actions: {
    async refresh() {
      this.loading = true;
      this.error = '';
      try {
        this.profiles = await invoke<McpProfile[]>('mcp_profiles_list');
        this.loaded = true;
      } catch (e) {
        this.error = String((e as Error)?.message ?? e);
      } finally {
        this.loading = false;
      }
    },

    /**
     * Upsert by name. The Rust side validates and throws on bad input
     * (empty entries, duplicate alias, illegal characters, ...) — we
     * surface the error string verbatim to the caller.
     */
    async save(profile: McpProfile): Promise<void> {
      this.savingName = profile.name;
      try {
        // Optimistic update — replace or append in-place so the UI moves
        // immediately. The Rust round-trip below will hand us back the
        // canonical list, so any race lands the right way.
        const idx = this.profiles.findIndex((p) => p.name === profile.name);
        if (idx >= 0) this.profiles[idx] = profile;
        else this.profiles.push(profile);
        this.profiles = await invoke<McpProfile[]>('mcp_profiles_save', {
          profile,
        });
      } finally {
        this.savingName = '';
      }
    },

    async remove(name: string): Promise<void> {
      const before = this.profiles;
      this.profiles = this.profiles.filter((p) => p.name !== name);
      try {
        this.profiles = await invoke<McpProfile[]>('mcp_profiles_delete', {
          name,
        });
      } catch (e) {
        // Roll back on failure.
        this.profiles = before;
        throw e;
      }
    },

    async exportConfig(name: string, mcpPath: string | null): Promise<string> {
      return await invoke<string>('mcp_profiles_export_config', {
        name,
        mcpPath: mcpPath ?? null,
      });
    },
  },
});

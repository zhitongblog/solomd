/**
 * v4.6 F1 — Properties inspector store.
 *
 * Holds the out-of-band configuration that the inspector layers on top of the
 * Markdown frontmatter (which stays the only source of truth for the *values*):
 *
 *   - `displayModes`: per-key user override of the inferred display mode.
 *   - `pinned`: keys the user pinned to the top of the inspector.
 *
 * This config is NEVER written into notes. It persists to a workspace-scoped
 * file `.solomd/properties.json` (mirroring Bases' `.solomd/views/*` and
 * Tolaria's vault-config approach), so a recast/pin survives restarts without
 * polluting git-tracked note diffs.
 *
 * It also derives vault-wide autocomplete sources (`vaultStatuses`,
 * `vaultTagsByKey`) from the existing workspace index entries, so Status/Tags
 * cells can suggest values already used elsewhere in the vault.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import type { DisplayMode } from '../lib/property-types';
import { useWorkspaceIndexStore } from './workspaceIndex';

interface PropertiesConfig {
  displayModes: Record<string, DisplayMode>;
  pinned: string[];
}

interface State {
  folder: string | null;
  displayModes: Record<string, DisplayMode>;
  pinned: string[];
  loaded: boolean;
}

const CONFIG_REL = '.solomd/properties.json';

function joinPath(folder: string, rel: string): string {
  const sep = folder.includes('\\') ? '\\' : '/';
  const f = folder.endsWith(sep) ? folder.slice(0, -1) : folder;
  return `${f}${sep}${rel.split('/').join(sep)}`;
}

function dirOf(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  return idx >= 0 ? p.slice(0, idx) : p;
}

export const usePropertiesStore = defineStore('properties', {
  state: (): State => ({
    folder: null,
    displayModes: {},
    pinned: [],
    loaded: false,
  }),

  getters: {
    /** Vault-wide set of status values seen on `status`-ish properties. */
    vaultStatuses(): string[] {
      const idx = useWorkspaceIndexStore();
      const seen = new Set<string>();
      const STATUS_RE = /\b(status|state|stage|phase)\b/i;
      for (const e of idx.entries) {
        const fm = e.frontmatter;
        if (!fm || typeof fm !== 'object') continue;
        for (const [k, v] of Object.entries(fm as Record<string, unknown>)) {
          if (!STATUS_RE.test(k)) continue;
          if (typeof v === 'string' && v.trim()) seen.add(v.trim());
        }
      }
      return Array.from(seen).sort((a, b) => a.localeCompare(b));
    },

    /** Map of key → distinct array/tag values seen across the vault for it. */
    vaultTagsByKey(): Record<string, string[]> {
      const idx = useWorkspaceIndexStore();
      const out: Record<string, Set<string>> = {};
      for (const e of idx.entries) {
        const fm = e.frontmatter;
        if (!fm || typeof fm !== 'object') continue;
        for (const [k, v] of Object.entries(fm as Record<string, unknown>)) {
          if (!Array.isArray(v)) continue;
          const set = (out[k] ??= new Set<string>());
          for (const item of v) {
            if (typeof item === 'string' && item.trim()) set.add(item.trim());
          }
        }
      }
      const result: Record<string, string[]> = {};
      for (const [k, set] of Object.entries(out)) {
        result[k] = Array.from(set).sort((a, b) => a.localeCompare(b));
      }
      return result;
    },
  },

  actions: {
    /** Override for a key, or undefined when none. */
    overrideFor(key: string): DisplayMode | undefined {
      return this.displayModes[key];
    },

    isPinned(key: string): boolean {
      return this.pinned.includes(key);
    },

    /** Bind to a workspace folder and load its `.solomd/properties.json`. */
    async setFolder(folder: string | null) {
      if (folder === this.folder && this.loaded) return;
      this.folder = folder;
      this.displayModes = {};
      this.pinned = [];
      this.loaded = false;
      if (!folder) return;
      await this.load();
    },

    async load() {
      if (!this.folder) return;
      const path = joinPath(this.folder, CONFIG_REL);
      try {
        const res = await invoke<{ content: string }>('read_file', { path });
        const parsed = JSON.parse(res.content) as Partial<PropertiesConfig>;
        this.displayModes =
          parsed.displayModes && typeof parsed.displayModes === 'object'
            ? (parsed.displayModes as Record<string, DisplayMode>)
            : {};
        this.pinned = Array.isArray(parsed.pinned) ? parsed.pinned.filter((x) => typeof x === 'string') : [];
      } catch {
        // No config yet (file missing) — start empty. Not an error.
        this.displayModes = {};
        this.pinned = [];
      }
      this.loaded = true;
    },

    async persist() {
      if (!this.folder) return;
      const path = joinPath(this.folder, CONFIG_REL);
      const config: PropertiesConfig = {
        displayModes: this.displayModes,
        pinned: this.pinned,
      };
      try {
        // Ensure `.solomd/` exists, then write.
        await invoke('fs_create_dir', { path: dirOf(path) }).catch(() => {});
        await invoke('write_file', {
          path,
          content: JSON.stringify(config, null, 2) + '\n',
          encoding: 'utf-8',
        });
      } catch (e) {
        console.warn('properties config persist failed', e);
      }
    },

    async setDisplayMode(key: string, mode: DisplayMode | null) {
      if (mode == null) {
        delete this.displayModes[key];
      } else {
        this.displayModes = { ...this.displayModes, [key]: mode };
      }
      await this.persist();
    },

    async togglePinned(key: string) {
      if (this.pinned.includes(key)) {
        this.pinned = this.pinned.filter((k) => k !== key);
      } else {
        this.pinned = [...this.pinned, key];
      }
      await this.persist();
    },
  },
});

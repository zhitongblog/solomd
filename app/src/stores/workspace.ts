import { defineStore } from 'pinia';
import { useTabsStore } from './tabs';

const LS_KEY = 'solomd.workspace.v1';
const MAX_RECENT = 12;
const MAX_RECENT_FOLDERS = 8;

interface WorkspaceState {
  recentFiles: string[];
  recentFolders: string[];
  currentFolder: string | null;
}

function load(): WorkspaceState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WorkspaceState>;
      return {
        recentFiles: Array.isArray(parsed.recentFiles) ? parsed.recentFiles : [],
        recentFolders: Array.isArray(parsed.recentFolders) ? parsed.recentFolders : [],
        currentFolder: typeof parsed.currentFolder === 'string' ? parsed.currentFolder : null,
      };
    }
  } catch {}
  return { recentFiles: [], recentFolders: [], currentFolder: null };
}

export const useWorkspaceStore = defineStore('workspace', {
  state: (): WorkspaceState => load(),
  actions: {
    persist() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.$state));
      } catch {}
    },
    pushRecent(path: string) {
      this.recentFiles = [path, ...this.recentFiles.filter((p) => p !== path)].slice(0, MAX_RECENT);
      this.persist();
    },
    removeRecent(path: string) {
      this.recentFiles = this.recentFiles.filter((p) => p !== path);
      this.persist();
    },
    clearRecent() {
      this.recentFiles = [];
      this.persist();
    },
    /** v4.3.5 — workspace switcher. `setFolder` already runs every time the
     *  user opens a folder (picker or session restore), so threading the
     *  recent-folders MRU through it keeps both lists in sync without extra
     *  call sites. `null` (closed workspace) doesn't get pushed. */
    setFolder(folder: string | null) {
      const prev = this.currentFolder;
      this.currentFolder = folder;
      if (folder) {
        this.recentFolders = [
          folder,
          ...this.recentFolders.filter((p) => p !== folder),
        ].slice(0, MAX_RECENT_FOLDERS);
      }
      // Persist FIRST so the tabs store reads the new currentFolder when it
      // writes the destination bucket below.
      this.persist();
      // Per-workspace tab scoping: when the active folder actually changes,
      // swap the visible tabs to that workspace's remembered set (carrying
      // unsaved/untitled tabs across). No-op when scoping is disabled.
      if (folder !== prev) {
        try {
          useTabsStore().onWorkspaceSwitched(prev, folder);
        } catch {}
      }
    },
    removeRecentFolder(path: string) {
      this.recentFolders = this.recentFolders.filter((p) => p !== path);
      this.persist();
    },
    clearRecentFolders() {
      this.recentFolders = [];
      this.persist();
    },
  },
});

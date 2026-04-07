import { defineStore } from 'pinia';

const LS_KEY = 'solomd.workspace.v1';
const MAX_RECENT = 12;

interface WorkspaceState {
  recentFiles: string[];
  currentFolder: string | null;
}

function load(): WorkspaceState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { recentFiles: [], currentFolder: null, ...JSON.parse(raw) };
  } catch {}
  return { recentFiles: [], currentFolder: null };
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
    setFolder(folder: string | null) {
      this.currentFolder = folder;
      this.persist();
    },
  },
});

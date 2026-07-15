import { defineStore } from 'pinia';
import { useTabsStore } from './tabs';

const LS_KEY = 'solomd.workspace.v1';
const MAX_RECENT = 12;
const MAX_RECENT_FOLDERS = 8;

interface WorkspaceState {
  recentFiles: string[];
  recentFolders: string[];
  currentFolder: string | null;
  // #148 — when the current folder is a SAF (Android content-URI) vault,
  // `currentFolder` is the virtual `saf:<rootDocId>` path and these hold the
  // constant tree URI + display name the saf-fs layer needs. Null on ordinary
  // filesystem workspaces (desktop/iOS).
  safTreeUri: string | null;
  safName: string | null;
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
        safTreeUri: typeof parsed.safTreeUri === 'string' ? parsed.safTreeUri : null,
        safName: typeof parsed.safName === 'string' ? parsed.safName : null,
      };
    }
  } catch {}
  return { recentFiles: [], recentFolders: [], currentFolder: null, safTreeUri: null, safName: null };
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
      // Leaving (or replacing) a SAF vault with an ordinary folder clears the
      // SAF context so the file layer stops routing through ContentResolver.
      if (!folder || !folder.startsWith('saf:')) {
        this.safTreeUri = null;
        this.safName = null;
      }
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
    /** #148 — open a SAF (content-URI) vault. `rootPath` is `saf:<rootDocId>`. */
    setSafVault(treeUri: string, rootPath: string, name: string) {
      this.safTreeUri = treeUri;
      this.safName = name;
      // Reuse setFolder for tab-scoping/recents, but it would null out the SAF
      // context (rootPath starts with "saf:" so it's preserved), so set after.
      this.setFolder(rootPath);
      this.safTreeUri = treeUri;
      this.safName = name;
      this.persist();
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

/**
 * v2.6.1 — Pinia store for cloud-folder detection + cross-device session
 * restore.
 *
 * Two unrelated-looking concerns share one store because the UX hooks
 * them together: when a workspace opens, we (a) probe the path to see if
 * it's already in iCloud / Dropbox / OneDrive / Google Drive, and (b)
 * write a session.<deviceId>.json + check sibling sessions in the
 * .solomd/ folder. Surfacing both as a single "current workspace cloud
 * status" object keeps the UI banner straightforward.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

export type CloudProvider = 'none' | 'icloud' | 'dropbox' | 'onedrive' | 'google_drive';

export interface CloudFolderInfo {
  provider: CloudProvider;
  label: string;
}

export interface SessionTab {
  file_path: string | null;
  file_name: string;
  cursor_line: number | null;
  cursor_col: number | null;
}

export interface SessionPayload {
  device_id: string;
  device_label: string;
  saved_at: number;
  active_index: number;
  tabs: SessionTab[];
}

export interface SiblingSession {
  device_id: string;
  device_label: string;
  saved_at: number;
  tab_count: number;
}

interface State {
  deviceId: string | null;
  cloud: CloudFolderInfo;
  /** Sibling sessions found in `.solomd/` of the current workspace, sorted
   *  newest-first. Excludes our own. */
  siblings: SiblingSession[];
  /** True after we've shown the cross-device restore prompt for this
   *  workspace, so we don't nag on every visit. */
  promptedSessionFor: string | null;
}

export const useCloudSyncStore = defineStore('cloudSync', {
  state: (): State => ({
    deviceId: null,
    cloud: { provider: 'none', label: '' },
    siblings: [],
    promptedSessionFor: null,
  }),

  getters: {
    isInCloudFolder(state): boolean {
      return state.cloud.provider !== 'none';
    },
    /** Sibling session with the freshest timestamp, or null. */
    freshestSibling(state): SiblingSession | null {
      return state.siblings[0] ?? null;
    },
  },

  actions: {
    async ensureDeviceId(): Promise<string> {
      if (this.deviceId) return this.deviceId;
      this.deviceId = await invoke<string>('device_id_get_or_create');
      return this.deviceId;
    },

    async refresh(folder: string | null): Promise<void> {
      if (!folder) {
        this.cloud = { provider: 'none', label: '' };
        this.siblings = [];
        return;
      }
      this.cloud = await invoke<CloudFolderInfo>('cloud_folder_detect', { folder });
      const id = await this.ensureDeviceId();
      this.siblings = await invoke<SiblingSession[]>('session_list_others', {
        folder,
        ourDeviceId: id,
      });
    },

    async saveSession(folder: string, payload: SessionPayload): Promise<void> {
      await invoke('session_save', { folder, payload });
    },

    async loadSession(folder: string, deviceId: string): Promise<SessionPayload | null> {
      return await invoke<SessionPayload | null>('session_load', { folder, deviceId });
    },

    markPrompted(folder: string): void {
      this.promptedSessionFor = folder;
    },
  },
});

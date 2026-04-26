/**
 * v2.6 — GitHub-backed sync (Pinia store).
 *
 * Wraps the Rust `github_*` Tauri commands. Owns:
 *   - PAT presence flag (stored in OS keychain on the Rust side; we cache
 *     `hasToken` here so the UI can reactively show "linked vs sign-in")
 *   - Cached `SyncStatus` for the current workspace folder, refreshed on
 *     a) link/unlink, b) explicit refresh, c) after push/pull
 *
 * Design notes:
 *   - Single-user product. No multi-account or org-scoped picks; we just
 *     show the PAT-owner's own repos.
 *   - Settings.autoGitEnabled is a *prerequisite* — GitHub sync only
 *     pushes/pulls commits, so the AutoGit layer must be writing them.
 *   - All errors surface as toasts via the caller; the store stashes
 *     `lastError` for diagnostics but doesn't toast itself (keeps it
 *     usable from non-Vue contexts).
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  clone_url: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  updated_at: string;
}

export interface SyncConfig {
  remote_url: string;
  auto_push: boolean;
  auto_pull_minutes: number;
  last_push_at: number | null;
  last_pull_at: number | null;
}

export interface SyncStatus {
  linked: boolean;
  remote_url: string;
  auto_push: boolean;
  auto_pull_minutes: number;
  encrypted: boolean;
  provider: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  has_conflicts: boolean;
  conflicts: string[];
  last_push_at: number | null;
  last_pull_at: number | null;
}

export interface CryptoStatus {
  enabled: boolean;
  has_key: boolean;
}

export interface PullResult {
  kind: 'fast_forward' | 'up_to_date' | 'conflicts' | 'merged';
  conflicts: string[];
}

interface State {
  hasToken: boolean;
  user: GitHubUser | null;
  repos: GitHubRepo[];
  folder: string | null;
  status: SyncStatus | null;
  loading: boolean;
  pushing: boolean;
  pulling: boolean;
  lastError: string | null;
}

export const useGithubSyncStore = defineStore('githubSync', {
  state: (): State => ({
    hasToken: false,
    user: null,
    repos: [],
    folder: null,
    status: null,
    loading: false,
    pushing: false,
    pulling: false,
    lastError: null,
  }),

  getters: {
    isLinked(state): boolean {
      return Boolean(state.status?.linked);
    },
    hasConflicts(state): boolean {
      return Boolean(state.status?.has_conflicts);
    },
  },

  actions: {
    async refreshHasToken(): Promise<void> {
      try {
        this.hasToken = await invoke<boolean>('github_has_token');
      } catch (e) {
        this.lastError = String(e);
        this.hasToken = false;
      }
    },

    async setToken(token: string): Promise<void> {
      await invoke('github_set_token', { token });
      this.hasToken = true;
      // Also refresh the user immediately so UI can show the avatar.
      await this.refreshUser();
    },

    async clearToken(): Promise<void> {
      await invoke('github_clear_token');
      this.hasToken = false;
      this.user = null;
      this.repos = [];
    },

    async refreshUser(): Promise<void> {
      try {
        this.user = await invoke<GitHubUser>('github_user');
      } catch (e) {
        this.lastError = String(e);
        this.user = null;
      }
    },

    async listRepos(): Promise<GitHubRepo[]> {
      this.loading = true;
      try {
        this.repos = await invoke<GitHubRepo[]>('github_list_repos');
        return this.repos;
      } catch (e) {
        this.lastError = String(e);
        this.repos = [];
        throw e;
      } finally {
        this.loading = false;
      }
    },

    async createRepo(name: string, isPrivate: boolean): Promise<GitHubRepo> {
      const repo = await invoke<GitHubRepo>('github_create_vault_repo', {
        name,
        private: isPrivate,
      });
      // Insert at the head of the cached list so the picker reflects it.
      this.repos.unshift(repo);
      return repo;
    },

    async link(
      folder: string,
      remoteUrl: string,
      opts: { encrypted?: boolean; provider?: string } = {},
    ): Promise<void> {
      await invoke<SyncConfig>('github_link_workspace', {
        folder,
        remoteUrl,
        encrypted: opts.encrypted ?? false,
        provider: opts.provider ?? 'github',
      });
      await this.refreshStatus(folder);
    },

    async cryptoStatus(folder: string): Promise<CryptoStatus> {
      return await invoke<CryptoStatus>('crypto_status', { folder });
    },

    async setPassphrase(folder: string, passphrase: string): Promise<void> {
      await invoke('crypto_set_passphrase', { folder, passphrase });
    },

    async clearPassphrase(folder: string): Promise<void> {
      await invoke('crypto_clear_passphrase', { folder });
    },

    async decryptNow(folder: string): Promise<void> {
      await invoke('crypto_decrypt_after_pull', { folder });
    },

    async setConfig(
      folder: string,
      autoPush: boolean,
      autoPullMinutes: number,
    ): Promise<void> {
      await invoke<SyncConfig>('github_set_config', {
        folder,
        autoPush,
        autoPullMinutes,
      });
      await this.refreshStatus(folder);
    },

    async unlink(folder: string): Promise<void> {
      await invoke('github_unlink_workspace', { folder });
      await this.refreshStatus(folder);
    },

    async refreshStatus(folder: string | null): Promise<void> {
      if (!folder) {
        this.folder = null;
        this.status = null;
        return;
      }
      this.folder = folder;
      try {
        this.status = await invoke<SyncStatus>('github_sync_status', { folder });
      } catch (e) {
        this.lastError = String(e);
        // Don't null the status on error — keep the last known good so the
        // UI doesn't flicker between "linked" and "not linked" on a flaky
        // network probe.
      }
    },

    async push(folder: string): Promise<void> {
      this.pushing = true;
      try {
        await invoke('github_push', { folder });
        await this.refreshStatus(folder);
      } catch (e) {
        this.lastError = String(e);
        throw e;
      } finally {
        this.pushing = false;
      }
    },

    async pull(folder: string): Promise<PullResult> {
      this.pulling = true;
      try {
        const r = await invoke<PullResult>('github_pull', { folder });
        await this.refreshStatus(folder);
        return r;
      } catch (e) {
        this.lastError = String(e);
        throw e;
      } finally {
        this.pulling = false;
      }
    },

    async resolveConflict(
      folder: string,
      file: string,
      choice: 'local' | 'remote' | 'both',
    ): Promise<void> {
      await invoke('github_resolve_conflict', { folder, file, choice });
      await this.refreshStatus(folder);
    },
  },
});

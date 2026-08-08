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
  /** Set when GitHub rejects the stored token (401 / Bad credentials), i.e.
   *  the PAT expired or was revoked. Drives a "reconnect" banner + toast so the
   *  user isn't left staring at a raw `GitHub API 401` on their next sync. */
  tokenInvalid: boolean;
  /** Classified push error type after last failed push attempt. Reset on next push. */
  pushErrorType: PushErrorType;
  /** Classified pull error type after last failed pull attempt. Reset on next pull. */
  pullErrorType: PullErrorType;

  // Gitea-specific state
  giteaUrl: string;
  hasGiteaToken: boolean;
  giteaUser: GitHubUser | null;
  giteaRepos: GitHubRepo[];
  giteaLoading: boolean;
  giteaUrlValid: boolean | null;
  giteaTokenInvalid: boolean;
}

/** Does this error indicate the GitHub token is no longer valid (expired /
 *  revoked)? The Rust side surfaces `GitHub API 401 Unauthorized: {...Bad
 *  credentials...}`; match on either signal. Exported so the auto-sync glue
 *  reuses the exact same classification. */
export function isGithubAuthError(e: unknown): boolean {
  const s = String((e as { message?: string })?.message ?? e ?? '');
  return /\b401\b|bad credentials/i.test(s);
}

/** Classify push errors from the Rust backend. Returns a machine-readable tag. */
export type PushErrorType = 'none' | 'auth' | 'protected-branch' | 'non-fast-forward' | 'other';
export type PullErrorType = 'none' | 'auth' | 'conflict' | 'other';

export function classifyPushError(e: unknown): PushErrorType {
  if (isGithubAuthError(e)) return 'auth';
  const s = String(e);
  if (/protected branch/i.test(s) || /create a pull request/i.test(s)) return 'protected-branch';
  if (/non-fast-forward/i.test(s) || /pull first/i.test(s)) return 'non-fast-forward';
  return 'other';
}

export function classifyPullError(e: unknown): PullErrorType {
  if (isGithubAuthError(e)) return 'auth';
  const s = String(e);
  if (/conflict/i.test(s)) return 'conflict';
  return 'other';
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
    tokenInvalid: false,
    pushErrorType: 'none',
    pullErrorType: 'none',

    // Gitea state
    giteaUrl: '',
    hasGiteaToken: false,
    giteaUser: null,
    giteaRepos: [],
    giteaLoading: false,
    giteaUrlValid: null,
    giteaTokenInvalid: false,
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
      this.tokenInvalid = false;
    },

    async refreshUser(): Promise<void> {
      try {
        this.user = await invoke<GitHubUser>('github_user');
        // A successful /user call proves the token is good again — clear any
        // stale "expired" flag (e.g. after the user reconnects).
        this.tokenInvalid = false;
      } catch (e) {
        this.lastError = String(e);
        this.user = null;
        if (isGithubAuthError(e)) this.tokenInvalid = true;
      }
    },

    async listRepos(): Promise<GitHubRepo[]> {
      this.loading = true;
      try {
        this.repos = await invoke<GitHubRepo[]>('github_list_repos');
        this.tokenInvalid = false;
        return this.repos;
      } catch (e) {
        this.lastError = String(e);
        this.repos = [];
        if (isGithubAuthError(e)) this.tokenInvalid = true;
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

    async getProxy(): Promise<string> {
      return await invoke<string>('proxy_get');
    },

    async setProxy(url: string): Promise<void> {
      await invoke('proxy_set', { url });
    },

    async enableEncryption(folder: string, passphrase: string): Promise<void> {
      await invoke('github_enable_encryption', { folder, passphrase });
      await this.refreshStatus(folder);
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

    async push(folder: string, commitMessage?: string): Promise<void> {
      this.pushing = true;
      this.pushErrorType = 'none';
      try {
        await invoke('github_push', { folder, commitMessage: commitMessage ?? null });
        await this.refreshStatus(folder);
      } catch (e) {
        this.lastError = String(e);
        this.pushErrorType = classifyPushError(e);
        throw e;
      } finally {
        this.pushing = false;
      }
    },

    async pull(folder: string): Promise<PullResult> {
      this.pulling = true;
      this.pullErrorType = 'none';
      try {
        const r = await invoke<PullResult>('github_pull', { folder });
        await this.refreshStatus(folder);
        return r;
      } catch (e) {
        this.lastError = String(e);
        this.pullErrorType = classifyPullError(e);
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

    // ─── Gitea actions ─────────────────────────────────────────

    async getGiteaUrl(): Promise<string> {
      try {
        this.giteaUrl = await invoke<string>('gitea_get_url');
        return this.giteaUrl;
      } catch {
        return '';
      }
    },

    async setGiteaUrl(url: string): Promise<void> {
      await invoke('gitea_set_url', { url });
      this.giteaUrl = url;
    },

    async validateGiteaUrl(url: string): Promise<boolean> {
      const valid = await invoke<boolean>('gitea_validate_url', { url });
      this.giteaUrlValid = valid;
      return valid;
    },

    async refreshHasGiteaToken(): Promise<void> {
      try {
        this.hasGiteaToken = await invoke<boolean>('gitea_has_token');
      } catch {
        this.hasGiteaToken = false;
      }
    },

    async setGiteaToken(token: string): Promise<void> {
      await invoke('gitea_set_token', { token });
      this.hasGiteaToken = true;
      if (this.giteaUrl) {
        await this.refreshGiteaUser(this.giteaUrl);
      }
    },

    async clearGiteaToken(): Promise<void> {
      await invoke('gitea_clear_token');
      this.hasGiteaToken = false;
      this.giteaUser = null;
      this.giteaRepos = [];
      this.giteaTokenInvalid = false;
    },

    async refreshGiteaUser(baseUrl: string): Promise<void> {
      try {
        this.giteaUser = await invoke<GitHubUser>('gitea_user', { baseUrl });
        this.giteaTokenInvalid = false;
      } catch (e) {
        this.lastError = String(e);
        this.giteaUser = null;
        this.giteaTokenInvalid = true;
      }
    },

    async listGiteaRepos(baseUrl: string): Promise<GitHubRepo[]> {
      this.giteaLoading = true;
      try {
        this.giteaRepos = await invoke<GitHubRepo[]>('gitea_list_repos', { baseUrl });
        this.giteaTokenInvalid = false;
        return this.giteaRepos;
      } catch (e) {
        this.lastError = String(e);
        this.giteaRepos = [];
        this.giteaTokenInvalid = true;
        throw e;
      } finally {
        this.giteaLoading = false;
      }
    },

    async createGiteaRepo(baseUrl: string, name: string, isPrivate: boolean): Promise<GitHubRepo> {
      const repo = await invoke<GitHubRepo>('gitea_create_vault_repo', {
        baseUrl,
        name,
        private: isPrivate,
      });
      this.giteaRepos.unshift(repo);
      return repo;
    },
  },
});

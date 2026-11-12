/**
 * v2.2 (rev. 2) — immediate AutoGit on save.
 *
 * Design after the v2.2 launch UX disaster:
 *   - No debounce. Every ⌘S → snapshot. The user sees a toast every time
 *     so the feature is never invisible.
 *   - One toggle (`autoGitEnabled`) controls everything. Flipping it ON
 *     immediately initializes the repo if needed.
 *   - All errors surface as toasts. The previous quiet:true silent-bail
 *     pattern is what made every prior bug invisible to the user.
 *
 * `start()` is called from App.vue's setup. It registers a
 * `solomd:saved` window listener (dispatched by `useFiles().saveActive`)
 * and runs `git_auto_commit` immediately when AutoGit is enabled.
 */
import { watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSettingsStore, resolveSyncTargetFolder } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useGitHistoryStore } from '../stores/gitHistory';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { hasGitBackend } from '../lib/platform';
import { PROVIDERS } from '../lib/ai-providers';

export function useAutoCommit() {
  const settings = useSettingsStore();
  const workspace = useWorkspaceStore();
  const gh = useGitHistoryStore();
  const tabs = useTabsStore();
  const toasts = useToastsStore();
  const { t } = useI18n();

  let listening = false;
  let busy = false;

  function isEnabled(): boolean {
    return Boolean(settings.autoGitEnabled);
  }

  /** Init the workspace as a git repo. Toasts on success and failure. */
  async function ensureInitialized(folder: string): Promise<boolean> {
    if (!gh.status) await gh.refreshStatus(folder);
    if (gh.isInitialized) return true;
    try {
      await gh.init(folder);
      toasts.info(t('history.initialized'));
      return true;
    } catch (e) {
      toasts.error(`${t('history.commitFailed')}: ${e}`);
      console.warn('autogit init failed', e);
      return false;
    }
  }

  /** #129 — Optionally generate a concise 1-line Git commit message via AI. */
  async function generateAiCommitMessage(filePath?: string): Promise<string | undefined> {
    if (!settings.autoGitAiMessage || !settings.aiEnabled) return undefined;
    const tab = tabs.activeTab;
    const excerpt = (tab?.content || '').slice(0, 1800).trim();
    if (!excerpt) return undefined;
    const fileName = filePath ? filePath.split(/[/\\]/).pop() || 'note.md' : tab?.fileName || 'note.md';
    const providerCfg = PROVIDERS.find((p) => p.id === settings.aiProvider);
    const model = settings.aiModel?.trim() || providerCfg?.defaultModel || 'gpt-4o-mini';
    const requestId = `autogit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      let unlistenDone: (() => void) | null = null;
      let unlistenErr: (() => void) | null = null;
      const finish = (msg?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unlistenDone) unlistenDone();
        if (unlistenErr) unlistenErr();
        resolve(msg);
      };
      const timer = setTimeout(() => finish(undefined), 5000);

      void (async () => {
        try {
          unlistenDone = await listen<{ request_id: string; full_text: string }>(
            'solomd://ai-done',
            (ev) => {
              if (ev.payload?.request_id !== requestId) return;
              const line = (ev.payload.full_text || '')
                .replace(/^["'`]+|["'`]+$/g, '')
                .split(/\r?\n/)[0]
                ?.trim()
                .slice(0, 72);
              finish(line || undefined);
            },
          );
          unlistenErr = await listen<{ request_id: string }>('solomd://ai-error', (ev) => {
            if (ev.payload?.request_id !== requestId) return;
            finish(undefined);
          });
          await invoke('ai_rewrite', {
            request: {
              provider: settings.aiProvider,
              api_format: providerCfg?.apiFormat || settings.aiProvider,
              model,
              system:
                'You write concise, single-line Git commit messages (under 60 characters, no quotes, no markdown fences) summarizing the note update.',
              user: `Write a concise 1-line commit summary for saving "${fileName}":`,
              selection: excerpt,
              base_url: settings.aiBaseUrl?.trim() || providerCfg?.defaultBaseUrl || null,
              request_id: requestId,
            },
          });
        } catch {
          finish(undefined);
        }
      })();
    });
  }

  /** Run a single auto-commit. Always surfaces a toast (no quiet path). */
  async function performCommit(): Promise<void> {
    if (busy) return;
    if (!isEnabled()) return;
    const filePath = tabs.activeTab?.filePath ?? undefined;
    const folder = resolveSyncTargetFolder(
      filePath,
      workspace.currentFolder,
      settings.syncVaults,
      settings.syncOnlyRegisteredVaults,
    );
    if (!folder) return;
    busy = true;
    try {
      if (!(await ensureInitialized(folder))) return;
      try {
        const aiMessage = await generateAiCommitMessage(filePath);
        const sha = await gh.commit(folder, filePath, aiMessage);
        if (sha) {
          toasts.success(t('history.savedSnapshot', { sha: sha.slice(0, 7) }));
        }
        // Ok(None) (no diff vs HEAD) is a normal no-op — don't bother the user.
      } catch (e) {
        toasts.error(`${t('history.commitFailed')}: ${e}`);
        console.warn('autogit commit failed', e);
      }
    } finally {
      busy = false;
    }
  }

  /** ⌘S handler. Fires immediately, no debounce. */
  function onSaved(): void {
    void performCommit();
  }

  function start(): void {
    if (listening) return;
    // #230 — AutoGit is the loudest path of all: it toasts on every failure,
    // so on Android (no libgit2 → no `git_*` commands) an enabled-from-a-prior-
    // session toggle would fire an error toast on literally every save.
    if (!hasGitBackend()) return;
    listening = true;
    window.addEventListener('solomd:saved', onSaved as EventListener);

    // The moment AutoGit is toggled ON, immediately initialize the repo
    // so the user gets visible feedback right after flipping the switch
    // (and a baseline `init:` commit for the history panel to show).
    // `immediate: true` also covers the boot case where AutoGit was
    // already on from a prior session: we still need to ensure the
    // current workspace has a `.git/`. We also re-watch currentFolder
    // because the user can switch workspaces mid-session.
    watch(
      [() => settings.autoGitEnabled, () => workspace.currentFolder],
      async ([enabled, folder]) => {
        if (!enabled || !folder) return;
        await ensureInitialized(folder);
      },
      { immediate: true },
    );
  }

  function stop(): void {
    if (!listening) return;
    listening = false;
    window.removeEventListener('solomd:saved', onSaved as EventListener);
  }

  /** Explicit "Save snapshot now" command-palette entry. Bypasses the toggle. */
  async function commitNow(): Promise<void> {
    const folder = workspace.currentFolder;
    if (!folder) {
      toasts.warning(t('history.noFolder'));
      return;
    }
    if (!(await ensureInitialized(folder))) return;
    const filePath = tabs.activeTab?.filePath ?? undefined;
    try {
      const sha = await gh.commit(folder, filePath);
      if (sha) {
        toasts.success(t('history.savedSnapshot', { sha: sha.slice(0, 7) }));
      } else {
        toasts.info(t('history.nothingToCommit'));
      }
    } catch (e) {
      toasts.error(`${t('history.commitFailed')}: ${e}`);
      console.warn('manual snapshot failed', e);
    }
  }

  return { start, stop, commitNow };
}

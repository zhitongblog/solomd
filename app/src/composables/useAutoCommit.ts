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
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useGitHistoryStore } from '../stores/gitHistory';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

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

  /** Run a single auto-commit. Always surfaces a toast (no quiet path). */
  async function performCommit(): Promise<void> {
    if (busy) return;
    if (!isEnabled()) return;
    const folder = workspace.currentFolder;
    if (!folder) return;
    busy = true;
    try {
      if (!(await ensureInitialized(folder))) return;
      const filePath = tabs.activeTab?.filePath ?? undefined;
      try {
        const sha = await gh.commit(folder, filePath);
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

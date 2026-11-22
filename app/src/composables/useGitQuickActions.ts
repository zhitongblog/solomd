/**
 * #620 — Main-UI quick actions for Git (`git add`, `git pull`, `git push`).
 *
 * Works seamlessly for both:
 *  - Workspaces linked to SoloMD's built-in GitHub / Gitee / Gitea Sync
 *    (`useGithubSync`), and
 *  - Plain local Git repositories using SSH or system credential helpers
 *    (`git_stage` / `git_cli_pull` / `git_cli_push`).
 */
import { computed } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useGitHistoryStore } from '../stores/gitHistory';
import { useGithubSyncStore } from '../stores/githubSync';
import { useTabsStore } from '../stores/tabs';
import { useGithubSync } from './useGithubSync';
import { useFiles } from './useFiles';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { hasGitBackend } from '../lib/platform';

export function useGitQuickActions() {
  const workspace = useWorkspaceStore();
  const gitHistory = useGitHistoryStore();
  const githubSync = useGithubSyncStore();
  const tabs = useTabsStore();
  const ghSync = useGithubSync();
  const files = useFiles();
  const toasts = useToastsStore();
  const { t } = useI18n();

  const folder = computed(() => workspace.currentFolder);

  const isGitRepo = computed(
    () =>
      hasGitBackend() &&
      !!folder.value &&
      (gitHistory.isInitialized || githubSync.isLinked),
  );

  const busyAdd = computed(() => gitHistory.staging);
  const busyPull = computed(() => gitHistory.pulling || githubSync.pulling);
  const busyPush = computed(() => gitHistory.pushing || githubSync.pushing);

  /** #641 — Flush unsaved open tabs inside the current workspace before staging/pushing
   *  so edits that haven't hit autosave yet are actually included in git add / push. */
  async function flushDirtyWorkspaceTabs() {
    const root = folder.value;
    if (!root) return;
    const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    for (const tab of [...tabs.tabs]) {
      if (tab.content === tab.savedContent || !tab.filePath) continue;
      const normPath = tab.filePath.replace(/\\/g, '/').toLowerCase();
      if (normPath === normRoot || normPath.startsWith(normRoot + '/')) {
        try {
          await files.saveTab(tab, { silent: true });
        } catch {
          // Best-effort; let the user see any save error separately.
        }
      }
    }
  }

  async function gitAdd() {
    if (!folder.value) {
      toasts.warning(t('gitQuick.noFolder'));
      return;
    }
    if (!isGitRepo.value) {
      toasts.warning(t('gitQuick.notGitRepo'));
      return;
    }
    try {
      await flushDirtyWorkspaceTabs();
      const count = await gitHistory.stage(folder.value);
      if (count > 0) {
        toasts.success(t('gitQuick.stagedCount', { count }));
      } else {
        toasts.info(t('gitQuick.nothingToStage'));
      }
    } catch (err) {
      toasts.error(t('gitQuick.addFailed', { err: String(err) }));
    }
  }

  async function gitPull() {
    if (!folder.value) {
      toasts.warning(t('gitQuick.noFolder'));
      return;
    }
    if (!isGitRepo.value) {
      toasts.warning(t('gitQuick.notGitRepo'));
      return;
    }
    if (githubSync.isLinked) {
      await ghSync.pullNow();
      return;
    }
    try {
      const out = await gitHistory.cliPull(folder.value);
      toasts.success(out ? t('gitQuick.pullDoneDetail', { detail: out.split('\n')[0] }) : t('gitQuick.pullDone'));
    } catch (err) {
      toasts.error(t('gitQuick.pullFailed', { err: String(err) }));
    }
  }

  async function gitPush() {
    if (!folder.value) {
      toasts.warning(t('gitQuick.noFolder'));
      return;
    }
    if (!isGitRepo.value) {
      toasts.warning(t('gitQuick.notGitRepo'));
      return;
    }
    await flushDirtyWorkspaceTabs();
    if (githubSync.isLinked) {
      // #641 — Always commit staged/working-tree edits before pushing so
      // `git add` → `push` (or one-click `push`) never silently pushes an old HEAD.
      await ghSync.pushNow();
      return;
    }
    try {
      // #641 — Always invoke commit unconditionally (commit_staged returns None
      // cleanly when HEAD already matches the index/working tree) instead of
      // relying on a potentially stale or extension-filtered `status.dirty` flag.
      await gitHistory.commit(folder.value);
      const out = await gitHistory.cliPush(folder.value);
      toasts.success(out ? t('gitQuick.pushDoneDetail', { detail: out.split('\n')[0] }) : t('gitQuick.pushDone'));
    } catch (err) {
      toasts.error(t('gitQuick.pushFailed', { err: String(err) }));
    }
  }

  return {
    isGitRepo,
    busyAdd,
    busyPull,
    busyPush,
    gitAdd,
    gitPull,
    gitPush,
  };
}

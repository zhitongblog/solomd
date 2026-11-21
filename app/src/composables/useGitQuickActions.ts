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
import { useGithubSync } from './useGithubSync';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { hasGitBackend } from '../lib/platform';

export function useGitQuickActions() {
  const workspace = useWorkspaceStore();
  const gitHistory = useGitHistoryStore();
  const githubSync = useGithubSyncStore();
  const ghSync = useGithubSync();
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
    if (githubSync.isLinked) {
      await ghSync.pushNow();
      return;
    }
    try {
      // Auto-commit pending workspace changes before pushing so a quick
      // "Add → Push" or one-click "Push" never silently pushes an old HEAD.
      if (gitHistory.status?.dirty) {
        await gitHistory.commit(folder.value);
      }
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

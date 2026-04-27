/**
 * v2.6 — auto-push + auto-pull glue.
 *
 * Runs alongside `useAutoCommit`:
 *   - On `solomd:saved` (after AutoGit has committed), if the workspace is
 *     linked AND `auto_push` is on, push to GitHub.
 *   - On a fixed interval (`auto_pull_minutes`), pull.
 *
 * Both push and pull surface toasts. `quiet` is intentionally not an
 * option here — silent failures were the v2.2 footgun and we don't repeat
 * the mistake in v2.6.
 */
import { watch } from 'vue';
import { useGithubSyncStore } from '../stores/githubSync';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

export function useGithubSync() {
  const sync = useGithubSyncStore();
  const workspace = useWorkspaceStore();
  const toasts = useToastsStore();
  const { t } = useI18n();

  let listening = false;
  let pulling = false;
  let pulltimer: ReturnType<typeof setInterval> | null = null;
  // Debounce auto-push so a flurry of saves coalesces into one push.
  let pushTimer: ReturnType<typeof setTimeout> | null = null;

  async function refreshIfLinked(folder: string | null): Promise<void> {
    if (!folder) return;
    await sync.refreshStatus(folder);
  }

  async function pushIfWanted(): Promise<void> {
    const folder = workspace.currentFolder;
    if (!folder) return;
    if (!sync.status?.linked) return;
    if (!sync.status?.auto_push) return;
    try {
      await sync.push(folder);
      toasts.success(t('githubSync.pushedToast'));
    } catch (e) {
      toasts.error(`${t('githubSync.pushFailed')}: ${e}`);
    }
  }

  function onSaved(): void {
    if (pushTimer) clearTimeout(pushTimer);
    // 5s debounce: AutoGit has just committed; give the user a moment in
    // case they ⌘S three more times before going to lunch.
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void pushIfWanted();
    }, 5000);
  }

  async function pullIfWanted(): Promise<void> {
    if (pulling) return;
    const folder = workspace.currentFolder;
    if (!folder) return;
    if (!sync.status?.linked) return;
    if (sync.status.dirty) {
      // Pulling onto a dirty tree would let libgit2 cancel the merge — and
      // would also confuse the user about which version is theirs. Wait
      // until AutoGit catches up.
      return;
    }
    pulling = true;
    try {
      const r = await sync.pull(folder);
      if (r.kind === 'fast_forward' || r.kind === 'merged') {
        toasts.success(t('githubSync.pulledToast'));
        // Notify the rest of the app that files changed under us so the
        // workspace index, file tree, and active editor reload from disk.
        window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
      } else if (r.kind === 'conflicts') {
        toasts.warning(t('githubSync.pullConflicts', { n: String(r.conflicts.length) }));
        // The conflict panel surfaces in the History panel when
        // `sync.status.has_conflicts` is true.
      }
    } catch (e) {
      toasts.error(`${t('githubSync.pullFailed')}: ${e}`);
    } finally {
      pulling = false;
    }
  }

  function rescheduleTimer(): void {
    if (pulltimer) {
      clearInterval(pulltimer);
      pulltimer = null;
    }
    const minutes = sync.status?.auto_pull_minutes ?? 0;
    if (!sync.status?.linked || minutes <= 0) return;
    pulltimer = setInterval(() => {
      void pullIfWanted();
    }, minutes * 60_000);
  }

  function start(): void {
    if (listening) return;
    listening = true;
    window.addEventListener('solomd:saved', onSaved as EventListener);

    // Whenever workspace changes, refresh the linked status. Whenever
    // the auto-pull interval changes, reschedule the timer.
    watch(
      () => workspace.currentFolder,
      (f) => {
        void refreshIfLinked(f);
      },
      { immediate: true },
    );
    watch(
      () => [sync.status?.linked, sync.status?.auto_pull_minutes],
      () => rescheduleTimer(),
      { immediate: true },
    );

    // Best-effort: on boot, do one immediate pull if linked. Catches the
    // common "edited on iPad last night" case the moment the app opens.
    setTimeout(() => {
      void pullIfWanted();
    }, 2000);
  }

  function stop(): void {
    if (!listening) return;
    listening = false;
    window.removeEventListener('solomd:saved', onSaved as EventListener);
    if (pulltimer) {
      clearInterval(pulltimer);
      pulltimer = null;
    }
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
  }

  /** Command-palette entry: pull right now, regardless of timer. */
  async function pullNow(): Promise<void> {
    await pullIfWanted();
  }

  /** Command-palette entry: push right now, even if auto_push is off. */
  async function pushNow(): Promise<void> {
    const folder = workspace.currentFolder;
    if (!folder) {
      toasts.warning(t('history.noFolder'));
      return;
    }
    if (!sync.status?.linked) {
      toasts.warning(t('githubSync.notLinked'));
      return;
    }
    try {
      await sync.push(folder);
      toasts.success(t('githubSync.pushedToast'));
    } catch (e) {
      toasts.error(`${t('githubSync.pushFailed')}: ${e}`);
    }
  }

  return { start, stop, pullNow, pushNow };
}

/**
 * v2.2 — debounced auto-commit hook.
 *
 * `start()` is called from App.vue's setup. It registers a `solomd:saved`
 * window listener (the parent will dispatch this event from
 * `useFiles().saveActive`) and schedules a `git_auto_commit` after
 * `settings.autoGitDebounceSeconds` of save inactivity. Default 30s — short
 * enough that a quick burst of saves becomes a single commit, long enough
 * that you don't end up with a commit per keystroke.
 *
 * `commitNow()` is the explicit "Save snapshot now" command palette entry.
 *
 * The `settings.autoGitEnabled` flag is read via duck-typing for now —
 * the parent will add the actual field to `stores/settings.ts` later, so
 * this module must compile against the *current* Settings type.
 */
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

  let timer: ReturnType<typeof setTimeout> | null = null;
  let listening = false;

  function debounceMs(): number {
    // Duck-type: settings.autoGitDebounceSeconds doesn't exist on the type
    // yet (parent adds it). Fall back to 30s.
    const v = (settings as unknown as { autoGitDebounceSeconds?: number })
      .autoGitDebounceSeconds;
    return Math.max(2, v ?? 30) * 1000;
  }

  function isEnabled(): boolean {
    return Boolean(
      (settings as unknown as { autoGitEnabled?: boolean }).autoGitEnabled,
    );
  }

  /** Fire the actual git commit. Quiet if there's nothing to commit. */
  async function performCommit(opts?: { quiet?: boolean }): Promise<void> {
    const folder = workspace.currentFolder;
    if (!folder) return;
    if (!gh.status) await gh.refreshStatus(folder);
    if (!gh.isInitialized) {
      // AutoGit is enabled but the workspace isn't a repo yet — auto-init
      // it so the user doesn't have to dig through the history panel for a
      // separate "Initialize" button. We surface the init via toast even
      // on the auto path because it's a one-time event the user should
      // know about (a `.git/` directory will appear in their workspace).
      try {
        await gh.init(folder);
        toasts.info(t('history.initialized'));
      } catch (e) {
        if (!opts?.quiet) {
          toasts.error(`${t('history.commitFailed')}: ${e}`);
        }
        console.warn('autogit init failed', e);
        return;
      }
    }
    const filePath = tabs.activeTab?.filePath ?? undefined;
    try {
      const sha = await gh.commit(folder, filePath);
      if (sha && !opts?.quiet) {
        toasts.success(t('history.savedSnapshot', { sha: sha.slice(0, 7) }));
      }
    } catch (e) {
      // Surface the error even on the auto path — silent failures are
      // why the v2.2 launch shipped with AutoGit "doing nothing" (rel_path
      // symlink bug). Always toast so the user can see what went wrong.
      toasts.error(`${t('history.commitFailed')}: ${e}`);
      console.warn('autogit commit failed', e);
    }
  }

  function onSaved() {
    if (!isEnabled()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      performCommit({ quiet: true }).catch(() => {});
    }, debounceMs());
  }

  function start(): void {
    if (listening) return;
    listening = true;
    window.addEventListener('solomd:saved', onSaved as EventListener);
  }

  function stop(): void {
    if (!listening) return;
    listening = false;
    window.removeEventListener('solomd:saved', onSaved as EventListener);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** Explicit "Save snapshot now" — bypasses debounce + the enabled flag. */
  async function commitNow(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await performCommit({ quiet: false });
  }

  return { start, stop, commitNow };
}

import { ref } from 'vue';
import { checkForUpdate, downloadAndInstallUpdate } from '../lib/check-update';
import { useToastsStore } from '../stores/toasts';
import { useTabsStore } from '../stores/tabs';
import { useFiles } from './useFiles';
import { useI18n } from '../i18n';
import type { Tab } from '../types';

/** Shared so the Settings button and Help → Check for Updates show one state. */
const checking = ref(false);

/** Count open tabs that currently have unsaved changes (saved files or non-empty untitled drafts). */
export function countUnsavedTabs(
  tabsList: ReadonlyArray<Pick<Tab, 'id' | 'filePath' | 'content' | 'savedContent'>>,
  isDirty: (id: string) => boolean,
): number {
  return tabsList.filter((tab) =>
    tab.filePath ? isDirty(tab.id) : tab.content !== tab.savedContent,
  ).length;
}

async function startDownloadAndInstall(cleanVer: string, isZh: boolean): Promise<void> {
  const toasts = useToastsStore();
  const tabs = useTabsStore();
  const files = useFiles();

  const initMsg = isZh
    ? `正在下载更新 v${cleanVer}…`
    : `Downloading update v${cleanVer}…`;
  const toastId = toasts.push(initMsg, 'info', 0);

  const ok = await downloadAndInstallUpdate(cleanVer, (p) => {
    const item = toasts.items.find((it) => it.id === toastId);
    if (!item) return;
    const pct = p.percent != null ? ` ${p.percent}%` : '';
    const src = p.source ? ` (${p.source})` : '';
    item.message = isZh
      ? `正在下载更新 v${cleanVer}${pct}${src}…`
      : `Downloading update v${cleanVer}${pct}${src}…`;
  });

  toasts.resolve(toastId);
  if (ok) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('solomd:flush-content-sync'));
    }
    tabs.persist();
    const stillDirty = countUnsavedTabs(tabs.tabs, (id) => tabs.isDirty(id));
    if (stillDirty > 0) {
      toasts.push(
        isZh
          ? `v${cleanVer} 下载完成，正在启动安装程序（仍有 ${stillDirty} 个未保存文档）`
          : `v${cleanVer} downloaded — launching installer (${stillDirty} unsaved document(s))`,
        'warning',
        0,
        () => { void files.saveAll(); },
        { actionLabel: isZh ? '保存全部文档' : 'Save All' },
      );
    } else {
      toasts.success(
        isZh
          ? `v${cleanVer} 下载完成，正在启动安装程序…`
          : `v${cleanVer} downloaded — launching installer…`,
        5000,
      );
    }
  }
}

export async function runDirectUpdateInstall(version: string): Promise<void> {
  const toasts = useToastsStore();
  const tabs = useTabsStore();
  const files = useFiles();
  const { lang } = useI18n();
  const isZh = lang.value === 'zh';
  const cleanVer = version.replace(/^v/, '');

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('solomd:flush-content-sync'));
  }
  tabs.persist();

  const dirtyCount = countUnsavedTabs(tabs.tabs, (id) => tabs.isDirty(id));
  if (dirtyCount > 0) {
    toasts.push(
      isZh
        ? `升级到 v${cleanVer} 前有 ${dirtyCount} 个未保存文档，建议先保存`
        : `${dirtyCount} unsaved document(s) open before updating to v${cleanVer}`,
      'warning',
      0,
      undefined,
      {
        actions: [
          {
            label: isZh ? '保存全部并升级' : 'Save All & Update',
            run: () => {
              void (async () => {
                await files.saveAll();
                tabs.persist();
                await startDownloadAndInstall(cleanVer, isZh);
              })();
            },
          },
          {
            label: isZh ? '直接升级' : 'Update Anyway',
            run: () => {
              void startDownloadAndInstall(cleanVer, isZh);
            },
          },
        ],
      },
    );
    return;
  }

  await startDownloadAndInstall(cleanVer, isZh);
}

/**
 * "Check for updates now" — Settings → Advanced and, since bug/C1, the Help
 * menu. One implementation so the two can never report differently.
 */
export function useUpdateCheck() {
  const toasts = useToastsStore();
  const { t } = useI18n();

  async function manualCheckUpdate(): Promise<void> {
    if (checking.value) return;
    checking.value = true;
    try {
      const r = await checkForUpdate();
      if (r.error) {
        // Both solomd.app proxy + GitHub/Gitee direct failed (offline / DNS / etc).
        // Don't lie to the user with "up to date" — show a real error.
        toasts.error(t('settings.updateCheckFailed'));
      } else if (r.hasUpdate && r.latest) {
        await runDirectUpdateInstall(r.latest);
      } else {
        toasts.info(t('settings.upToDate'));
      }
    } catch (e) {
      toasts.error(String(e));
    } finally {
      checking.value = false;
    }
  }

  return { checking, manualCheckUpdate };
}

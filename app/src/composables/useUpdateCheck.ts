import { ref } from 'vue';
import { checkForUpdate, downloadAndInstallUpdate } from '../lib/check-update';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

/** Shared so the Settings button and Help → Check for Updates show one state. */
const checking = ref(false);

export async function runDirectUpdateInstall(version: string): Promise<void> {
  const toasts = useToastsStore();
  const { lang } = useI18n();
  const isZh = lang.value === 'zh';
  const cleanVer = version.replace(/^v/, '');
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
    toasts.success(
      isZh
        ? `v${cleanVer} 下载完成，正在启动安装程序…`
        : `v${cleanVer} downloaded — launching installer…`,
      5000,
    );
  }
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

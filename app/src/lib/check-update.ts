import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';

const RELEASES_URL = 'https://api.github.com/repos/zhitongblog/solomd/releases/latest';

export interface UpdateResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string;
}

/** Returns semver comparison: 1 if a > b, -1 if a < b, 0 if equal */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

const MAS_BUILD = import.meta.env.VITE_MAS_BUILD === '1';

export const isMasBuild = (): boolean => MAS_BUILD;

export async function checkForUpdate(): Promise<UpdateResult> {
  const current = await getVersion().catch(() => '0.0.0');
  if (MAS_BUILD) {
    return { current, latest: null, hasUpdate: false, url: '' };
  }
  try {
    const res = await fetch(RELEASES_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    const hasUpdate = latest && compareSemver(latest, current) > 0;
    return {
      current,
      latest,
      hasUpdate: !!hasUpdate,
      url: data.html_url || 'https://github.com/zhitongblog/solomd/releases',
    };
  } catch {
    return {
      current,
      latest: null,
      hasUpdate: false,
      url: 'https://github.com/zhitongblog/solomd/releases',
    };
  }
}

/** Open the release page in the system browser. */
export async function openReleaseUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    /* ignore */
  }
}

/** Store the last-checked timestamp so we don't spam GitHub on every launch. */
const LS_KEY = 'solomd.update.last-check';
const CHECK_INTERVAL = 24 * 3600 * 1000; // 24 hours

export async function checkForUpdateOnStartup(): Promise<UpdateResult | null> {
  if (MAS_BUILD) return null;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const ts = Number(raw);
      if (Date.now() - ts < CHECK_INTERVAL) return null;
    }
  } catch {}
  const result = await checkForUpdate();
  try {
    localStorage.setItem(LS_KEY, String(Date.now()));
  } catch {}
  return result;
}

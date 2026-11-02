import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * Update check & direct installer download protocol.
 *
 * Three metadata sources, in priority order:
 *
 *   1. solomd.app /api/stats — Cloudflare Pages Function that proxies the
 *      GitHub releases API server-side, edge-cached for 5 min. Clients hit
 *      our own domain so they're never rate-limited (regardless of how many
 *      SoloMD installs share the same NAT IP).
 *   2. Gitee Releases API (prioritized in mainland China) / GitHub API
 *      fallback — used if #1 is unreachable.
 *
 * If all fail, we surface a `null` latest with `error: true` so the UI
 * shows "couldn't check, retry" instead of silently lying with "up to date"
 * (which was the v2.4.x bug that prompted this rewrite).
 */

const STATS_URL = 'https://solomd.app/api/stats';
const GITHUB_FALLBACK_URL = 'https://api.github.com/repos/zhitongblog/solomd/releases/latest';
const GITEE_FALLBACK_URL = 'https://gitee.com/api/v5/repos/zhitong45/solomd/releases/latest';

export interface UpdateResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string;
  /** True when no source could be reached. UI should show
   *  "couldn't check" rather than "up to date". */
  error: boolean;
}

export interface UpdateProgressPayload {
  version: string;
  downloaded: number;
  total: number | null;
  percent: number | null;
  source: string;
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

const RELEASES_PAGE = 'https://github.com/zhitongblog/solomd/releases';
const GITEE_RELEASES_PAGE = 'https://gitee.com/zhitong45/solomd/releases';

let cachedIsChina: boolean | null = null;

function isChinaByLocaleOrTimezone(): boolean {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (
      tz === 'Asia/Shanghai' ||
      tz === 'Asia/Chongqing' ||
      tz === 'Asia/Urumqi' ||
      tz === 'Asia/Harbin'
    ) {
      return true;
    }
  } catch {}
  try {
    if (typeof navigator !== 'undefined' && /^zh[-_]?cn$/i.test(navigator.language || '')) {
      return true;
    }
  } catch {}
  return false;
}

/**
 * Detect whether the current visitor is in mainland China (CN).
 * Checks Cloudflare edge trace (`loc=CN`) first, falling back to
 * system timezone (`Asia/Shanghai`) and locale (`zh-CN`).
 */
export async function detectVisitorIsChina(): Promise<boolean> {
  if (cachedIsChina !== null) return cachedIsChina;
  for (const traceUrl of [
    'https://solomd.app/cdn-cgi/trace',
    'https://www.cloudflare.com/cdn-cgi/trace',
  ]) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(traceUrl, { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        const locLine = text
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('loc='));
        if (locLine) {
          cachedIsChina = locLine === 'loc=CN';
          return cachedIsChina;
        }
      }
    } catch {
      /* try next */
    }
  }
  cachedIsChina = isChinaByLocaleOrTimezone();
  return cachedIsChina;
}

async function fetchFromStatsProxy(): Promise<{ tag: string; url: string } | null> {
  try {
    const res = await fetch(STATS_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { latest_tag?: string | null; latest_url?: string | null };
    if (!data.latest_tag) return null;
    return {
      tag: data.latest_tag.replace(/^v/, ''),
      url: data.latest_url || RELEASES_PAGE,
    };
  } catch {
    return null;
  }
}

async function fetchFromGitHubDirect(): Promise<{ tag: string; url: string } | null> {
  try {
    const res = await fetch(GITHUB_FALLBACK_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const tag = (data.tag_name || '').replace(/^v/, '');
    if (!tag) return null;
    return { tag, url: data.html_url || RELEASES_PAGE };
  } catch {
    return null;
  }
}

async function fetchFromGiteeDirect(): Promise<{ tag: string; url: string } | null> {
  try {
    const res = await fetch(GITEE_FALLBACK_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    const tag = (data.tag_name || '').replace(/^v/, '');
    if (!tag) return null;
    return { tag, url: `${GITEE_RELEASES_PAGE}/tag/v${tag}` };
  } catch {
    return null;
  }
}

export async function checkForUpdate(): Promise<UpdateResult> {
  const current = await getVersion().catch(() => '0.0.0');
  if (MAS_BUILD) {
    return { current, latest: null, hasUpdate: false, url: '', error: false };
  }

  // Try our own proxy first (no rate limit, edge-cached).
  let info = await fetchFromStatsProxy();
  if (!info) {
    const isCn = isChinaByLocaleOrTimezone();
    if (isCn) {
      info = (await fetchFromGiteeDirect()) || (await fetchFromGitHubDirect());
    } else {
      info = (await fetchFromGitHubDirect()) || (await fetchFromGiteeDirect());
    }
  }

  if (!info) {
    return {
      current,
      latest: null,
      hasUpdate: false,
      url: RELEASES_PAGE,
      error: true,
    };
  }

  const hasUpdate = compareSemver(info.tag, current) > 0;
  return {
    current,
    latest: info.tag,
    hasUpdate,
    url: info.url,
    error: false,
  };
}

/**
 * Fallback browser opener when direct installer download fails or on mobile.
 * Automatically routes mainland China (`CN`) visitors to the Gitee release
 * mirror and international visitors to GitHub / solomd.app.
 */
export async function openReleaseUrl(_url: string, version?: string | null): Promise<void> {
  try {
    const isCn = await detectVisitorIsChina();
    const cleanVer = (version || '').trim().replace(/^v/, '');
    if (isCn) {
      const target = cleanVer
        ? `${GITEE_RELEASES_PAGE}/tag/v${cleanVer}`
        : GITEE_RELEASES_PAGE;
      await openUrl(target);
    } else {
      const target = cleanVer
        ? `${RELEASES_PAGE}/tag/v${cleanVer}`
        : 'https://solomd.app/#download';
      await openUrl(target);
    }
  } catch {
    /* ignore */
  }
}

let activeUpdateDownload = false;

/**
 * Directly download the platform installer (`.msi` on Windows, `.dmg` on macOS,
 * `.AppImage` on Linux) from Gitee (when in China) or GitHub (with automatic
 * cross-mirror fallback) and launch the installer immediately.
 */
export async function downloadAndInstallUpdate(
  version: string,
  onProgress?: (p: UpdateProgressPayload) => void,
): Promise<boolean> {
  if (activeUpdateDownload) return false;
  activeUpdateDownload = true;
  let unlisten: (() => void) | null = null;
  try {
    const preferCn = await detectVisitorIsChina();
    if (onProgress) {
      unlisten = await listen<UpdateProgressPayload>('solomd://update-progress', (ev) => {
        onProgress(ev.payload);
      });
    }
    await invoke<string>('download_and_install_update', {
      version,
      preferCn,
    });
    return true;
  } catch {
    await openReleaseUrl('', version);
    return false;
  } finally {
    if (unlisten) {
      try {
        unlisten();
      } catch {}
    }
    activeUpdateDownload = false;
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
  // Only stamp the cache when the check actually succeeded — failed
  // checks shouldn't lock us out for 24 h.
  if (!result.error) {
    try {
      localStorage.setItem(LS_KEY, String(Date.now()));
    } catch {}
  }
  return result;
}

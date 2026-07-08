import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * Update check protocol.
 *
 * Two sources, in priority order:
 *
 *   1. solomd.app /api/stats — Cloudflare Pages Function that proxies the
 *      GitHub releases API server-side, edge-cached for 5 min. Clients hit
 *      our own domain so they're never rate-limited (regardless of how many
 *      SoloMD installs share the same NAT IP).
 *   2. Direct api.github.com fallback — only used if #1 is unreachable
 *      (offline, ad-blocker on solomd.app, etc).
 *
 * If both fail, we surface a `null` latest with `error: true` so the UI
 * shows "couldn't check, retry" instead of silently lying with "up to date"
 * (which was the v2.4.x bug that prompted this rewrite).
 */

const STATS_URL = 'https://solomd.app/api/stats';
const GITHUB_FALLBACK_URL = 'https://api.github.com/repos/zhitongblog/solomd/releases/latest';

export interface UpdateResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string;
  /** True when neither source could be reached. UI should show
   *  "couldn't check" rather than "up to date". */
  error: boolean;
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

async function fetchFromStatsProxy(): Promise<{ tag: string; url: string } | null> {
  try {
    const res = await fetch(STATS_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { latest_tag?: string | null; latest_url?: string | null };
    if (!data.latest_tag) return null;
    return {
      tag: data.latest_tag,
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

export async function checkForUpdate(): Promise<UpdateResult> {
  const current = await getVersion().catch(() => '0.0.0');
  if (MAS_BUILD) {
    return { current, latest: null, hasUpdate: false, url: '', error: false };
  }

  // Try our own proxy first (no rate limit, edge-cached).
  let info = await fetchFromStatsProxy();
  // Fall back to GitHub direct if the proxy is unreachable. This is the
  // path that was rate-limited as the only source — it's still useful as
  // backup since most users don't share an IP that's already exhausted.
  if (!info) info = await fetchFromGitHubDirect();

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
  // Only stamp the cache when the check actually succeeded — failed
  // checks shouldn't lock us out for 24 h.
  if (!result.error) {
    try {
      localStorage.setItem(LS_KEY, String(Date.now()));
    } catch {}
  }
  return result;
}

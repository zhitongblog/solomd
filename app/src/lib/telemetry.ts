/**
 * Telemetry wrapper. All events go through `track()` which checks the
 * user's opt-out setting before POSTing to our self-hosted analytics
 * endpoint at solomd.app/api/track.
 *
 * Privacy model:
 *   - We never send IP, User-Agent, fingerprint, or any OS identifier.
 *   - `anon_id` is a UUIDv4 generated client-side and stored in
 *     localStorage. Clearing storage rotates it. It is a device id,
 *     not a person id; the server never tries to correlate it with
 *     anything else.
 *   - Properties are filtered server-side: only short, low-cardinality
 *     strings/numbers/booleans pass the validator (see
 *     web/functions/api/track.ts). Anything PII-shaped is dropped.
 *   - The user can opt out at any time via Settings → 发送匿名使用数据.
 *
 * Network model:
 *   - Fire-and-forget POST. Endpoint returns 204 in all cases (success
 *     or any validation failure) so a flaky build can't be probed.
 *   - 2s timeout via AbortController — telemetry must never delay the
 *     user's action. Drop the event if the network is slow or offline.
 *
 * Set `localStorage.solomd.telemetryDebug = '1'` to log every track()
 * in the devtools console.
 */
import { getVersion } from '@tauri-apps/api/app';
import { useSettingsStore } from '../stores/settings';

type EventProps = Record<string, string | number | boolean>;

const DEFAULT_ENDPOINT = 'https://solomd.app/api/track';
const ENDPOINT =
  (import.meta.env.VITE_ANALYTICS_ENDPOINT as string | undefined) || DEFAULT_ENDPOINT;

const POST_TIMEOUT_MS = 2000;
const ANON_ID_KEY = 'solomd.anonId';

const TELEMETRY_DEBUG = (() => {
  try {
    return localStorage.getItem('solomd.telemetryDebug') === '1';
  } catch {
    return false;
  }
})();

function ensureAnonId(): string {
  try {
    const existing = localStorage.getItem(ANON_ID_KEY);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(ANON_ID_KEY, fresh);
    return fresh;
  } catch {
    // No localStorage — return a transient id so the server can still
    // dedupe within the session, but it won't survive reload.
    return crypto.randomUUID();
  }
}

function detectOs(): 'mac' | 'windows' | 'linux' | 'ipad' | 'web' {
  try {
    const ua = navigator.userAgent || '';
    // iPad first — iPadOS WKWebView reports "Mac OS X" + touch points
    // or "iPad" depending on the version.
    if (/iPad/i.test(ua)) return 'ipad';
    if (
      /Macintosh|Mac OS X/i.test(ua) &&
      typeof (navigator as any).maxTouchPoints === 'number' &&
      (navigator as any).maxTouchPoints > 1
    ) {
      return 'ipad';
    }
    if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return 'web';
  } catch {
    return 'web';
  }
}

function detectLocale(): 'en' | 'zh' {
  try {
    const settings = useSettingsStore();
    return settings.language === 'zh' ? 'zh' : 'en';
  } catch {
    try {
      return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
    } catch {
      return 'en';
    }
  }
}

let cachedVersion: string | null = null;
async function getAppVersion(): Promise<string | null> {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = await getVersion();
    return cachedVersion;
  } catch {
    return null;
  }
}

async function postEvent(payload: Record<string, unknown>): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(payload),
      // No Content-Type header — keeps the request simple-CORS so it
      // never triggers a preflight, even when the endpoint origin
      // changes for testing. The Pages Function accepts any body.
      signal: ctrl.signal,
      keepalive: true,
    });
  } catch (err) {
    if (TELEMETRY_DEBUG) console.warn('[telemetry] post failed', err);
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget — never await, never throw into callers. */
export function track(event: string, props?: EventProps): void {
  try {
    const settings = useSettingsStore();
    if (!settings.telemetryEnabled) return;
  } catch {
    // Pinia not ready; swallow silently — telemetry must never break the app.
    return;
  }

  const anonId = ensureAnonId();
  const os = detectOs();
  const locale = detectLocale();

  // Resolve version asynchronously; first event after launch will fire
  // with version=null if the Tauri API hasn't replied yet — that's fine,
  // subsequent events will carry it once cached.
  void getAppVersion().then((appVersion) => {
    const payload = {
      event,
      anon_id: anonId,
      app_version: appVersion,
      os,
      locale,
      props: props || {},
    };
    if (TELEMETRY_DEBUG) console.debug('[telemetry] tracking', payload);
    void postEvent(payload);
  });
}

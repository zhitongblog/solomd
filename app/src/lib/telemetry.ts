/**
 * Telemetry wrapper. All events go through `track()` which checks the
 * user's opt-out setting before invoking the Aptabase plugin.
 *
 * Why no @aptabase/tauri npm package: the latest published version
 * (0.4.1) imports `invoke` from `@tauri-apps/api`, but Tauri 2 removed
 * that top-level re-export (invoke now lives at `@tauri-apps/api/core`).
 * The result is a silent no-op on every call. The aptabase repo's main
 * branch has the fix but no new npm release. Rather than pin a git
 * dependency for one 10-line module, we call the plugin command directly.
 *
 * Privacy model: Aptabase does not collect IP, fingerprints, or any PII
 * by design. We additionally respect a user-controlled toggle (defaults
 * ON, settable via Settings → 发送匿名使用数据).
 */
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';

type EventProps = Record<string, string | number>;

/** Fire-and-forget — never await, never throw into callers. */
export function track(event: string, props?: EventProps): void {
  try {
    const settings = useSettingsStore();
    if (!settings.telemetryEnabled) return;
    invoke('plugin:aptabase|track_event', { name: event, props })
      .then(() => {
        if (TELEMETRY_DEBUG) console.debug('[telemetry] tracked', event, props);
      })
      .catch((err) => {
        if (TELEMETRY_DEBUG) console.warn('[telemetry] failed', event, err);
      });
  } catch {
    // Pinia not ready; swallow silently — telemetry must never break the app.
  }
}

/**
 * Set `localStorage.solomd.telemetryDebug = '1'` to see every track() call
 * in the devtools console. Useful for verifying events actually flow when
 * the Aptabase dashboard shows nothing — most often that's the dashboard's
 * "hide debug events" filter (toggle in the top right) rather than a bug
 * in our wiring.
 */
const TELEMETRY_DEBUG = (() => {
  try {
    return localStorage.getItem('solomd.telemetryDebug') === '1';
  } catch {
    return false;
  }
})();

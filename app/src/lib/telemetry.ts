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
    invoke('plugin:aptabase|track_event', { name: event, props }).catch(() => {});
  } catch {
    // Pinia not ready; swallow silently — telemetry must never break the app.
  }
}

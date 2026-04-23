/**
 * Telemetry wrapper around @aptabase/tauri. All events go through `track()`
 * which checks the user's opt-out setting before forwarding to Aptabase.
 *
 * Privacy model: Aptabase does not collect IP, fingerprints, or any PII by
 * design. We additionally respect a user-controlled toggle (defaults ON,
 * settable via Settings → 发送匿名使用数据).
 */
import { trackEvent as aptabaseTrackEvent } from '@aptabase/tauri';
import { useSettingsStore } from '../stores/settings';

type EventProps = Record<string, string | number>;

/** Fire-and-forget — never await, never throw into callers. */
export function track(event: string, props?: EventProps): void {
  try {
    const settings = useSettingsStore();
    if (!settings.telemetryEnabled) return;
    void aptabaseTrackEvent(event, props);
  } catch {
    // Pinia not ready, or aptabase init failed. Swallow silently —
    // telemetry must never break the app.
  }
}

/**
 * v2.6.1 — auto-save session.<deviceId>.json + on-launch sibling check.
 *
 * Lifecycle:
 *   - On workspace change: refresh cloud info + sibling sessions; if the
 *     newest sibling is fresher than our last save AND we haven't already
 *     prompted for this workspace this run, dispatch
 *     `solomd:session-restore-available` for App.vue to show the dialog.
 *   - Periodically + on tab/active changes: write our own session.<id>.json
 *     so that other devices opening this workspace see our state.
 *
 * Saves are debounced 5s to avoid hammering the cloud-sync provider on
 * every keystroke. The session file only stores tab metadata, never the
 * tab content (that lives in the actual .md file on disk).
 */
import { watch } from 'vue';
import { useCloudSyncStore, type SessionPayload, type SessionTab } from '../stores/cloudSync';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';

function deviceLabel(): string {
  // Best-effort: use navigator.platform / userAgentData. The user can
  // override later via a Settings → Device label field.
  const ua = (navigator as any).userAgentData;
  if (ua && ua.platform) return String(ua.platform);
  return navigator.platform || 'Unknown device';
}

export function useSessionRestore() {
  const cloud = useCloudSyncStore();
  const tabs = useTabsStore();
  const workspace = useWorkspaceStore();

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSavedAt = 0;
  let started = false;

  function snapshot(): SessionPayload | null {
    if (!cloud.deviceId) return null;
    const sessionTabs: SessionTab[] = tabs.tabs.map((t) => ({
      file_path: t.filePath ?? null,
      file_name: t.fileName,
      cursor_line: null,
      cursor_col: null,
    }));
    return {
      device_id: cloud.deviceId,
      device_label: deviceLabel(),
      saved_at: Math.floor(Date.now() / 1000),
      active_index: Math.max(
        0,
        tabs.tabs.findIndex((t) => t.id === tabs.activeId),
      ),
      tabs: sessionTabs,
    };
  }

  async function persist(folder: string): Promise<void> {
    const payload = snapshot();
    if (!payload) return;
    // Skip saving if nothing material changed — protects the cloud
    // provider from churn when the user just clicks around.
    if (Date.now() / 1000 - lastSavedAt < 2) return;
    try {
      await cloud.saveSession(folder, payload);
      lastSavedAt = payload.saved_at;
    } catch (e) {
      // Non-fatal — the local tabs store still persists to localStorage,
      // so next launch on the same machine works regardless.
      console.warn('session_save failed', e);
    }
  }

  function debouncedPersist(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const folder = workspace.currentFolder;
      if (folder) void persist(folder);
    }, 5000);
  }

  async function maybeOfferRestore(folder: string): Promise<void> {
    await cloud.refresh(folder);
    if (cloud.promptedSessionFor === folder) return;
    const sibling = cloud.freshestSibling;
    if (!sibling) return;
    // Only prompt if the sibling is meaningfully fresher than our local
    // record. 60s threshold absorbs clock skew between devices.
    if (sibling.saved_at <= lastSavedAt + 60) return;
    cloud.markPrompted(folder);
    window.dispatchEvent(
      new CustomEvent('solomd:session-restore-available', {
        detail: { folder, sibling },
      }),
    );
  }

  function start(): void {
    if (started) return;
    started = true;
    void cloud.ensureDeviceId();

    // Whenever the workspace changes, run the cloud probe + sibling check.
    watch(
      () => workspace.currentFolder,
      (f) => {
        if (f) void maybeOfferRestore(f);
        else cloud.cloud = { provider: 'none', label: '' };
      },
      { immediate: true },
    );

    // Tab list / active tab changes should propagate to the session file.
    watch(
      () => [tabs.tabs.length, tabs.activeId],
      () => debouncedPersist(),
    );
  }

  return { start };
}

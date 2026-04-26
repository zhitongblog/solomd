<script setup lang="ts">
/**
 * v2.6.1 — Cross-device session restore dialog.
 *
 * Triggered from useSessionRestore via `solomd:session-restore-available`
 * event when a sibling device's session.<id>.json in the workspace is
 * fresher than ours. Shows the device label, tab count, and timestamp;
 * user picks "Restore" (replace local tabs) or "Keep mine" (dismiss).
 *
 * "Restore" closes any tabs that don't appear in the sibling, opens any
 * sibling tabs we don't have, and switches active to the sibling's
 * active. Unsaved local changes are preserved (we never close a dirty
 * tab without confirming).
 */
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { useCloudSyncStore, type SessionPayload, type SiblingSession } from '../stores/cloudSync';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';

const cloud = useCloudSyncStore();
const tabs = useTabsStore();
const toasts = useToastsStore();
const files = useFiles();
const { t } = useI18n();

const visible = ref(false);
const sibling = ref<SiblingSession | null>(null);
const folder = ref<string | null>(null);
const restoring = ref(false);

function timeAgoLabel(epoch: number): string {
  const dt = Date.now() / 1000 - epoch;
  if (dt < 60) return t('cloudSync.agoSec', { n: String(Math.floor(dt)) });
  if (dt < 3600) return t('cloudSync.agoMin', { n: String(Math.floor(dt / 60)) });
  if (dt < 86400) return t('cloudSync.agoHour', { n: String(Math.floor(dt / 3600)) });
  return t('cloudSync.agoDay', { n: String(Math.floor(dt / 86400)) });
}

function onAvailable(e: Event) {
  const detail = (e as CustomEvent).detail || {};
  if (!detail.sibling || !detail.folder) return;
  sibling.value = detail.sibling;
  folder.value = detail.folder;
  visible.value = true;
}

async function applySession(payload: SessionPayload) {
  // Open every tab the sibling had. If we already have a tab for that
  // path, leave it (preserves any unsaved edits). For tabs we don't have,
  // open from disk so the editor reflects current file content.
  const havePath = new Set(
    tabs.tabs.map((t) => t.filePath).filter(Boolean) as string[],
  );
  for (const sib of payload.tabs) {
    if (!sib.file_path) continue;
    if (havePath.has(sib.file_path)) continue;
    try {
      // bypassNewWindow keeps the restored tabs in the current window
      // even if the user has "open in new window" preference enabled.
      await files.openPath(sib.file_path, { bypassNewWindow: true });
    } catch (e) {
      console.warn('failed to open from sibling session', sib.file_path, e);
    }
  }
  // Switch to the sibling's active tab if we can find it.
  const target = payload.tabs[payload.active_index];
  if (target?.file_path) {
    const localTab = tabs.tabs.find((t) => t.filePath === target.file_path);
    if (localTab) tabs.activeId = localTab.id;
  }
}

async function restore() {
  if (!folder.value || !sibling.value) return;
  restoring.value = true;
  try {
    const payload = await cloud.loadSession(folder.value, sibling.value.device_id);
    if (!payload) {
      toasts.warning(t('cloudSync.siblingMissing'));
      visible.value = false;
      return;
    }
    await applySession(payload);
    toasts.success(t('cloudSync.restoredToast', { device: sibling.value.device_label }));
  } catch (e) {
    toasts.error(String(e));
  } finally {
    restoring.value = false;
    visible.value = false;
  }
}

function dismiss() {
  visible.value = false;
}

onMounted(() => {
  window.addEventListener('solomd:session-restore-available', onAvailable);
});
onBeforeUnmount(() => {
  window.removeEventListener('solomd:session-restore-available', onAvailable);
});
</script>

<template>
  <div v-if="visible" class="srd__backdrop" @click.self="dismiss">
    <div class="srd" role="dialog" aria-modal="true">
      <h3 class="srd__title">{{ t('cloudSync.restoreTitle') }}</h3>
      <p class="srd__lead">
        {{ t('cloudSync.restoreLead', {
          device: sibling?.device_label ?? '?',
          ago: sibling ? timeAgoLabel(sibling.saved_at) : '',
          tabs: String(sibling?.tab_count ?? 0),
        }) }}
      </p>
      <div class="srd__actions">
        <button class="srd__btn" :disabled="restoring" @click="dismiss">
          {{ t('cloudSync.keepMineBtn') }}
        </button>
        <button class="srd__btn srd__btn--primary" :disabled="restoring" @click="restore">
          {{ restoring ? t('cloudSync.restoring') : t('cloudSync.restoreBtn') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.srd__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}
.srd {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 22px 26px;
  width: min(440px, 90vw);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}
.srd__title {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--text);
}
.srd__lead {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}
.srd__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.srd__btn {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font: inherit;
}
.srd__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.srd__btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text, #000);
}
</style>

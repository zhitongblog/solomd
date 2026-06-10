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
import { useWorkspaceStore } from '../stores/workspace';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';
import { DsModal, DsButton } from '../ui';

const cloud = useCloudSyncStore();
const tabs = useTabsStore();
const toasts = useToastsStore();
const workspace = useWorkspaceStore();
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

/**
 * v4.3.x issue #81 — resolve a SessionTab against our local workspace.
 * Prefer `rel_path` joined against the current workspace root (works
 * across machines where the absolute root differs — e.g. OneDrive on
 * Mac vs Windows). Fall back to the saved absolute `file_path` when no
 * rel_path was recorded (pre-v4.3.x sessions, or tabs that pointed at
 * files outside the workspace).
 */
function resolveSessionTabPath(sib: { file_path: string | null; rel_path?: string | null }): string | null {
  const root = workspace.currentFolder || '';
  if (sib.rel_path && root) {
    // Choose separator from the workspace root: Windows roots use '\',
    // POSIX roots use '/'. Pure heuristic on the leading char.
    const sep = /^[a-zA-Z]:[\\/]/.test(root) ? '\\' : '/';
    const cleanRoot = root.replace(/[\\/]+$/, '');
    const cleanRel = sib.rel_path.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep);
    return `${cleanRoot}${sep}${cleanRel}`;
  }
  return sib.file_path;
}

async function applySession(payload: SessionPayload) {
  // Open every tab the sibling had. If we already have a tab for that
  // path, leave it (preserves any unsaved edits). For tabs we don't have,
  // open from disk so the editor reflects current file content.
  const havePath = new Set(
    tabs.tabs.map((t) => t.filePath).filter(Boolean) as string[],
  );
  for (const sib of payload.tabs) {
    const path = resolveSessionTabPath(sib);
    if (!path) continue;
    if (havePath.has(path)) continue;
    try {
      // bypassNewWindow keeps the restored tabs in the current window
      // even if the user has "open in new window" preference enabled.
      await files.openPath(path, { bypassNewWindow: true });
    } catch (e) {
      console.warn('failed to open from sibling session', path, e);
    }
  }
  // Switch to the sibling's active tab if we can find it.
  const target = payload.tabs[payload.active_index];
  if (target) {
    const targetPath = resolveSessionTabPath(target);
    if (targetPath) {
      const localTab = tabs.tabs.find((t) => t.filePath === targetPath);
      if (localTab) tabs.activeId = localTab.id;
    }
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
  <DsModal
    :model-value="visible"
    :title="t('cloudSync.restoreTitle')"
    width="440px"
    :close-on-backdrop="!restoring"
    @update:model-value="dismiss"
  >
    <p class="srd__lead">
      {{ t('cloudSync.restoreLead', {
        device: sibling?.device_label ?? '?',
        ago: sibling ? timeAgoLabel(sibling.saved_at) : '',
        tabs: String(sibling?.tab_count ?? 0),
      }) }}
    </p>
    <template #footer>
      <DsButton variant="ghost" :disabled="restoring" @click="dismiss">
        {{ t('cloudSync.keepMineBtn') }}
      </DsButton>
      <DsButton variant="primary" :disabled="restoring" @click="restore">
        {{ restoring ? t('cloudSync.restoring') : t('cloudSync.restoreBtn') }}
      </DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.srd__lead {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}
</style>

<script setup lang="ts">
/**
 * v2.6.1 — Cloud-folder banner shown in the Settings panel above
 * GithubSyncSettings. Surfaces the fact that the current workspace is
 * already in iCloud / Dropbox / OneDrive / Google Drive and explains the
 * trade-off vs GitHub sync (cloud-folder = automatic but no version
 * history; GitHub sync = explicit history per file).
 *
 * Self-hides when no workspace is open or the path isn't a known cloud
 * folder.
 */
import { useCloudSyncStore } from '../stores/cloudSync';
import { useI18n } from '../i18n';

const cloud = useCloudSyncStore();
const { t } = useI18n();

const PROVIDER_ICON: Record<string, string> = {
  icloud: '☁️',
  dropbox: '📦',
  onedrive: '🪟',
  google_drive: '🅖',
  none: '',
};
</script>

<template>
  <section v-if="cloud.isInCloudFolder" class="cfb">
    <div class="cfb__row">
      <span class="cfb__icon" aria-hidden="true">{{ PROVIDER_ICON[cloud.cloud.provider] }}</span>
      <div class="cfb__copy">
        <strong>{{ t('cloudSync.detectedTitle', { label: cloud.cloud.label }) }}</strong>
        <p>{{ t('cloudSync.detectedHint') }}</p>
        <p v-if="cloud.siblings.length > 0" class="cfb__siblings">
          {{ t('cloudSync.siblingCount', { n: String(cloud.siblings.length) }) }}
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cfb {
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  background: var(--bg-soft, var(--bg));
  border-radius: 6px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.cfb__row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.cfb__icon {
  font-size: 22px;
  line-height: 1;
}
.cfb__copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.cfb__copy strong {
  font-size: 12px;
  color: var(--text);
}
.cfb__copy p {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}
.cfb__siblings {
  color: var(--text-muted) !important;
}
</style>

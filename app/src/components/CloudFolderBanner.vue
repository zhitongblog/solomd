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
import Icon from './Icons.vue';

const cloud = useCloudSyncStore();
const { t } = useI18n();

// 5.0 — one line icon for every provider instead of a different emoji each;
// the provider's name is in the banner text.
</script>

<template>
  <section v-if="cloud.isInCloudFolder" class="cfb">
    <div class="cfb__row">
      <Icon v-if="cloud.cloud.provider !== 'none'" name="cloud" :size="16" class="cfb__icon" aria-hidden="true" />
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
  flex: none;
  color: var(--text-2);
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

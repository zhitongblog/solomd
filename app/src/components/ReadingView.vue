<script setup lang="ts">
/**
 * v2.4 — Public reading mode.
 *
 * Maximally clean single-doc preview: no editor pane, no toolbar, no
 * file tree, no statusbar — just centered prose. A small floating ✕
 * button (top right) restores the user's previous view mode.
 *
 * Reuses `Preview.vue`'s renderer via the `skin: 'reading'` prop, so
 * we don't duplicate the markdown / mermaid / image-overlay pipeline.
 */
import { computed } from 'vue';
import Preview from './Preview.vue';
import Icon from './Icons.vue';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useI18n } from '../i18n';

const tabs = useTabsStore();
const settings = useSettingsStore();
const { t } = useI18n();

const tab = computed(() => tabs.activeTab);

function exit() {
  settings.exitReadingMode();
}
</script>

<template>
  <div class="reading-view" data-reading-view>
    <button
      class="reading-view__close"
      :title="t('reading.exitTooltip')"
      :aria-label="t('reading.exit')"
      @click="exit"
    >
      <Icon name="close" :size="18" />
    </button>
    <div v-if="tab" class="reading-view__doc">
      <Preview
        :source="tab.content"
        :file-path="tab.filePath"
        skin="reading"
      />
    </div>
    <div v-else class="reading-view__empty">
      {{ t('reading.empty') }}
    </div>
  </div>
</template>

<style scoped>
.reading-view {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg);
}
.reading-view__doc {
  flex: 1;
  display: flex;
  min-height: 0;
}
.reading-view__doc > :deep(.preview-host) {
  flex: 1;
  min-height: 0;
}
.reading-view__close {
  position: absolute;
  top: 14px;
  right: 18px;
  z-index: 50;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s, transform 0.15s;
  /* Stay clear of iOS notch / home-indicator areas */
  top: max(14px, env(safe-area-inset-top, 0px));
  right: max(18px, env(safe-area-inset-right, 0px));
}
.reading-view__close:hover {
  color: var(--text);
  border-color: var(--accent);
  background: var(--bg-hover);
}
.reading-view__close:active {
  transform: scale(0.96);
}
.reading-view__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 14px;
}
</style>

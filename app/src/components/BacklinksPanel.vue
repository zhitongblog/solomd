<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useTilesStore } from '../stores/tiles';
import { useWorkspaceIndexStore, type BacklinkRef } from '../stores/workspaceIndex';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';
import Icons from './Icons.vue';
import PanelHeader from './panel/PanelHeader.vue';

const tabs = useTabsStore();
const tiles = useTilesStore();
const idx = useWorkspaceIndexStore();
const files = useFiles();
const { t } = useI18n();

const emit = defineEmits<{ close: [] }>();

const refs = ref<BacklinkRef[]>([]);
const loading = ref(false);

/** Stem (filename without extension) of the active tab's file. Used as the
 * canonical wikilink target to look up backlinks for. */
const activeStem = computed(() => {
  const t = tabs.activeTab;
  if (!t || !t.fileName) return null;
  return t.fileName.replace(/\.[^.]+$/, '');
});

async function reload() {
  if (!activeStem.value) {
    refs.value = [];
    return;
  }
  loading.value = true;
  try {
    refs.value = await idx.backlinksFor(activeStem.value);
  } finally {
    loading.value = false;
  }
}

watch(activeStem, () => {
  reload();
});

watch(
  () => idx.entries.length,
  () => {
    reload();
  },
);

onMounted(() => {
  reload();
});

async function openBacklink(ref: BacklinkRef) {
  await files.openPath(ref.from_path, { bypassNewWindow: true });
  // After open, the tab change won't trigger a scroll. Use timeout to give
  // the editor view a tick to mount, then dispatch outline-goto for line nav.
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent('solomd:outline-goto', {
        detail: { line: ref.line, paneId: tiles.focusedPaneId },
      }),
    );
  }, 200);
}

onBeforeUnmount(() => {});
</script>

<template>
  <div class="backlinks rp">
    <PanelHeader :title="t('backlinks.heading')" :count="loading ? null : refs.length" @close="emit('close')" />

    <div v-if="loading" class="rp-empty">{{ t('backlinks.loading') }}</div>
    <div v-else-if="!idx.ready" class="rp-empty">{{ t('backlinks.openFolder') }}</div>
    <div v-else-if="!activeStem" class="rp-empty">{{ t('backlinks.noActive') }}</div>
    <div v-else-if="refs.length === 0" class="rp-empty">{{ t('backlinks.noResults') }}</div>

    <ul v-else class="rp-body rp-list">
      <li v-for="(r, i) in refs" :key="`${r.from_path}-${r.line}-${i}`">
        <button class="rp-row rp-row--tall" @click="openBacklink(r)">
          <span class="backlinks__line">
            <Icons class="rp-row__icon" name="file" :size="14" />
            <span class="rp-row__label">{{ r.from_name }}</span>
            <span class="rp-count">L{{ r.line }}</span>
          </span>
          <span v-if="r.context.length > 0" class="rp-snippet backlinks__ctx">{{ r.context.join('\n') }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.backlinks__line {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.backlinks__ctx {
  padding-left: 22px;
  box-sizing: border-box;
}
</style>

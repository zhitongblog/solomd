<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceIndexStore, type BacklinkRef } from '../stores/workspaceIndex';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';

const tabs = useTabsStore();
const idx = useWorkspaceIndexStore();
const files = useFiles();
const { t } = useI18n();

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
        detail: { line: ref.line, paneId: undefined },
      }),
    );
  }, 200);
}

onBeforeUnmount(() => {});
</script>

<template>
  <div class="backlinks">
    <header class="backlinks__head">
      <span class="backlinks__title">{{ t('backlinks.heading') }}</span>
      <span v-if="!loading" class="backlinks__count">{{ refs.length }}</span>
    </header>

    <div v-if="loading" class="backlinks__empty">{{ t('backlinks.loading') }}</div>
    <div v-else-if="!idx.ready" class="backlinks__empty">{{ t('backlinks.openFolder') }}</div>
    <div v-else-if="!activeStem" class="backlinks__empty">{{ t('backlinks.noActive') }}</div>
    <div v-else-if="refs.length === 0" class="backlinks__empty">{{ t('backlinks.noResults') }}</div>

    <ul v-else class="backlinks__list">
      <li v-for="(r, i) in refs" :key="`${r.from_path}-${r.line}-${i}`" class="backlinks__item">
        <button class="backlinks__row" @click="openBacklink(r)">
          <div class="backlinks__file">{{ r.from_name }}</div>
          <div class="backlinks__loc">L{{ r.line }}</div>
          <pre class="backlinks__ctx" v-if="r.context.length > 0">{{ r.context.join('\n') }}</pre>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.backlinks {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.backlinks__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.backlinks__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.backlinks__count {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.backlinks__empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.backlinks__list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  flex: 1;
}
.backlinks__item + .backlinks__item {
  margin-top: 4px;
}
.backlinks__row {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.backlinks__row:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}
.backlinks__file {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  display: inline-block;
}
.backlinks__loc {
  display: inline-block;
  margin-left: 8px;
  font-size: 10px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.backlinks__ctx {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: var(--bg-soft);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  border-left: 2px solid var(--accent);
}
</style>

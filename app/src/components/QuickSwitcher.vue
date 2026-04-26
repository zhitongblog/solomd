<script setup lang="ts">
/**
 * v2.5 — VSCode-style ⌘P quick file switcher.
 *
 * Empty input  → MRU (workspace.recentFiles) then MFU (recentEdits).
 * Typing       → fuzzy filter via recentEdits.topN(n, query).
 * ↑/↓ Enter    → navigate + open. Esc / outside-click close.
 *
 * Lists open tabs as `extra` so an unsaved Untitled tab is reachable too.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useRecentEditsStore } from '../stores/recentEdits';
import { useTabsStore } from '../stores/tabs';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const workspace = useWorkspaceStore();
const recentEdits = useRecentEditsStore();
const tabs = useTabsStore();
const files = useFiles();
const { t } = useI18n();

const query = ref('');
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLUListElement | null>(null);
const TOP_N = 50;

const openTabPaths = computed(() => tabs.tabs.map((tab) => tab.filePath).filter((p): p is string => !!p));

const results = computed<string[]>(() => {
  return recentEdits.topN(TOP_N, query.value, workspace.recentFiles, openTabPaths.value);
});

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx > 0 ? path.slice(0, idx) : '';
}

watch(
  () => props.open,
  async (v) => {
    if (v) {
      query.value = '';
      selectedIdx.value = 0;
      await nextTick();
      inputRef.value?.focus();
      inputRef.value?.select();
    }
  },
);

watch(results, () => {
  selectedIdx.value = 0;
});

watch(selectedIdx, async () => {
  await nextTick();
  const list = listRef.value;
  if (!list) return;
  const item = list.children[selectedIdx.value] as HTMLElement | undefined;
  if (item && item.scrollIntoView) {
    item.scrollIntoView({ block: 'nearest' });
  }
});

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (results.value.length === 0) return;
    selectedIdx.value = Math.min(selectedIdx.value + 1, results.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (results.value.length === 0) return;
    selectedIdx.value = Math.max(selectedIdx.value - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openIdx(selectedIdx.value);
  }
}

async function openIdx(i: number) {
  const path = results.value[i];
  if (!path) return;
  emit('close');
  // If the path matches an already-open tab, just activate it instead of
  // re-reading from disk (which would also push it to a new window when
  // the "open in new window" setting is on — wrong behavior for ⌘P).
  const existing = tabs.tabs.find((tab) => tab.filePath === path);
  if (existing) {
    tabs.activeId = existing.id;
    return;
  }
  await files.openPath(path, { bypassNewWindow: true });
}
</script>

<template>
  <div v-if="open" class="quick-switcher__backdrop" @click.self="emit('close')">
    <div class="quick-switcher" role="dialog" aria-label="Quick file switcher">
      <input
        ref="inputRef"
        v-model="query"
        @keydown="onKey"
        class="quick-switcher__input"
        :placeholder="t('quickSwitcher.placeholder')"
        spellcheck="false"
        autocomplete="off"
      />
      <ul ref="listRef" class="quick-switcher__list" v-if="results.length">
        <li
          v-for="(path, i) in results"
          :key="path"
          class="quick-switcher__item"
          :class="{ 'quick-switcher__item--active': i === selectedIdx }"
          @click="openIdx(i)"
          @mouseenter="selectedIdx = i"
        >
          <span class="quick-switcher__name">{{ basename(path) }}</span>
          <span v-if="dirname(path)" class="quick-switcher__path">{{ dirname(path) }}</span>
        </li>
      </ul>
      <div class="quick-switcher__empty" v-else>
        {{ query ? t('quickSwitcher.noMatch') : t('quickSwitcher.empty') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.quick-switcher__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  z-index: 1000;
}
.quick-switcher {
  width: min(620px, 92vw);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 60vh;
}
.quick-switcher__input {
  background: transparent;
  border: none;
  outline: none;
  padding: 14px 16px;
  font: 14px var(--font-ui);
  color: var(--text);
  border-bottom: 1px solid var(--border);
}
.quick-switcher__list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  overflow-y: auto;
}
.quick-switcher__item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.quick-switcher__item--active {
  background: var(--bg-active);
}
.quick-switcher__name {
  color: var(--text);
  flex: 0 0 auto;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.quick-switcher__path {
  color: var(--text-faint);
  font-size: 11px;
  font-family: var(--font-mono);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.quick-switcher__empty {
  padding: 18px;
  color: var(--text-muted);
  text-align: center;
  font-size: 13px;
}
</style>

<script setup lang="ts">
/**
 * Global workspace search — persistent right-sidebar pane (v4.0.2).
 *
 * Earlier versions opened as a modal dialog over the editor. The persistent
 * panel layout — contributed by @beihai23 in PR #50 — keeps results visible
 * while the user clicks through matches, which fits the search-browse-compare
 * workflow common in knowledge-base editing.
 *
 * Mounts when the parent renders the 'search' pane in the rs-pane-host stack;
 * unmounts on close. ⌘⇧F toggles the parent's `searchOpen` ref.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useGlobalSearch, type SearchHit } from '../composables/useGlobalSearch';
import { useFiles } from '../composables/useFiles';
import { useTabsStore } from '../stores/tabs';
import { useTilesStore } from '../stores/tiles';
import { useWorkspaceStore } from '../stores/workspace';
import { useI18n } from '../i18n';

const props = defineProps<{ prefill?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const search = useGlobalSearch();
const files = useFiles();
const tabs = useTabsStore();
const tiles = useTilesStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

const query = ref('');
const hits = ref<SearchHit[]>([]);
const loading = ref(false);
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const activeFilePath = computed(() => tabs.activeTab?.filePath ?? '');

let debounceTimer: number | null = null;

onMounted(async () => {
  if (props.prefill) {
    query.value = props.prefill;
  }
  await nextTick();
  inputRef.value?.focus();
  if (query.value) doSearch();
});

watch(
  () => props.prefill,
  async (v) => {
    if (v && v !== query.value) {
      query.value = v;
      await nextTick();
      inputRef.value?.focus();
    }
  },
);

watch(query, () => {
  if (debounceTimer != null) {
    window.clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(doSearch, 220);
});

async function doSearch() {
  const q = query.value.trim();
  if (!q) {
    hits.value = [];
    return;
  }
  loading.value = true;
  try {
    hits.value = await search.search(q);
    selectedIdx.value = 0;
  } finally {
    loading.value = false;
  }
}

const grouped = computed(() => {
  const map = new Map<string, SearchHit[]>();
  for (const h of hits.value) {
    if (!map.has(h.file)) map.set(h.file, []);
    map.get(h.file)!.push(h);
  }
  return Array.from(map.entries());
});

function shortPath(p: string) {
  const folder = workspace.currentFolder;
  if (folder && p.startsWith(folder)) {
    return p.slice(folder.length).replace(/^[\\/]/, '');
  }
  return p.split(/[\\/]/).slice(-2).join('/');
}

async function openHit(hit: SearchHit) {
  try {
    await files.openPath(hit.file);
    nextTick(() => {
      window.dispatchEvent(
        new CustomEvent('solomd:outline-goto', {
          detail: { line: hit.line, paneId: tiles.focusedPaneId },
        }),
      );
    });
  } catch (e) {
    console.error('GlobalSearch: openPath failed', e);
  }
}

function highlight(snippet: string): string {
  const q = query.value.trim();
  if (!q) return escapeHtml(snippet);
  const re = new RegExp(`(${escapeRe(q)})`, 'gi');
  return escapeHtml(snippet).replace(re, '<mark>$1</mark>');
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c),
  );
}
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIdx.value = Math.min(selectedIdx.value + 1, hits.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIdx.value = Math.max(selectedIdx.value - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const hit = hits.value[selectedIdx.value];
    if (hit) openHit(hit);
  }
}
</script>

<template>
  <div class="sp">
    <header class="sp__head">
      <span class="sp__title">{{ t('search.heading') }}</span>
      <button
        class="rs-pane-close"
        type="button"
        :title="t('rightSidebar.hidePane')"
        @click="emit('close')"
      >×</button>
    </header>
    <div class="sp__input-wrap">
      <input
        ref="inputRef"
        v-model="query"
        class="sp__input"
        :placeholder="t('search.placeholder')"
        spellcheck="false"
        @keydown="onKey"
      />
      <span v-if="loading" class="sp__loading">…</span>
    </div>
    <div v-if="!workspace.currentFolder" class="sp__empty">
      {{ t('search.openFolder') }}
    </div>
    <div v-else-if="!query.trim()" class="sp__empty">
      {{ t('search.typeToSearch') }}
    </div>
    <div v-else-if="!hits.length && !loading" class="sp__empty">
      {{ t('search.noMatches') }}
    </div>
    <div v-else class="sp__results">
      <div v-for="[file, fileHits] in grouped" :key="file" class="sp__group">
        <div
          class="sp__file"
          :class="{ 'sp__file--active': file === activeFilePath }"
        >{{ shortPath(file) }}</div>
        <div
          v-for="hit in fileHits"
          :key="hit.line"
          class="sp__hit"
          :class="{ 'sp__hit--active': hits.indexOf(hit) === selectedIdx }"
          @click="openHit(hit)"
          @mouseenter="selectedIdx = hits.indexOf(hit)"
        >
          <span class="sp__lineno">L{{ hit.line }}</span>
          <span class="sp__snippet" v-html="highlight(hit.snippet)"></span>
        </div>
      </div>
    </div>
    <div class="sp__footer">
      <span>{{ t('search.hitCount', { n: hits.length }) }}</span>
      <span>{{ t('search.keyHint') }}</span>
    </div>
  </div>
</template>

<style scoped>
.sp {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  overflow: hidden;
}
.sp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.sp__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.sp__input-wrap {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
  padding: 0 12px;
}
.sp__input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  padding: 10px 0;
  font: 13px var(--font-ui);
  color: var(--text);
}
.sp__loading {
  color: var(--accent);
  font-size: 14px;
}
.sp__empty {
  padding: 24px 16px;
  color: var(--text-faint);
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
}
.sp__results {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.sp__group {
  margin-bottom: 4px;
}
.sp__file {
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sp__file--active {
  position: relative;
}
.sp__file--active::after {
  content: ' ●';
  font-size: 8px;
  vertical-align: middle;
}
.sp__hit {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px 5px 20px;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.1s;
}
.sp__hit:hover,
.sp__hit--active {
  background: var(--bg-hover, rgba(255, 159, 64, 0.12));
}
.sp__lineno {
  color: var(--text-faint);
  flex-shrink: 0;
  font-size: 10px;
  width: 32px;
}
.sp__snippet {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp__snippet :deep(mark) {
  background: var(--accent, #ff9f40);
  color: #fff;
  padding: 0 2px;
  border-radius: 2px;
}
.sp__footer {
  display: flex;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 10px;
  color: var(--text-faint);
  border-top: 1px solid var(--border);
}
</style>

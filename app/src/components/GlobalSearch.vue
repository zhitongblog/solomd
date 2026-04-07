<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useGlobalSearch, type SearchHit } from '../composables/useGlobalSearch';
import { useFiles } from '../composables/useFiles';
import { useWorkspaceStore } from '../stores/workspace';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const search = useGlobalSearch();
const files = useFiles();
const workspace = useWorkspaceStore();

const query = ref('');
const hits = ref<SearchHit[]>([]);
const loading = ref(false);
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

let debounceTimer: number | null = null;

watch(
  () => props.open,
  async (v) => {
    if (v) {
      await nextTick();
      inputRef.value?.focus();
      if (query.value) doSearch();
    }
  }
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
  emit('close');
  await files.openPath(hit.file);
  // Note: jumping to the specific line would require an editorRef call from
  // the parent. We just open the file for now; integrators can wire goto-line.
}

function highlight(snippet: string): string {
  const q = query.value.trim();
  if (!q) return escapeHtml(snippet);
  const re = new RegExp(`(${escapeRe(q)})`, 'gi');
  return escapeHtml(snippet).replace(re, '<mark>$1</mark>');
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
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
  <div v-if="open" class="gs__backdrop" @click.self="emit('close')">
    <div class="gs" role="dialog" aria-label="Global search">
      <div class="gs__header">
        <input
          ref="inputRef"
          v-model="query"
          @keydown="onKey"
          class="gs__input"
          placeholder="Search across files in folder…"
          spellcheck="false"
        />
        <span v-if="loading" class="gs__loading">…</span>
      </div>
      <div v-if="!workspace.currentFolder" class="gs__empty">
        Open a folder first (Ctrl+B → Folder)
      </div>
      <div v-else-if="!query.trim()" class="gs__empty">
        Type to search across all .md / .txt files in {{ workspace.currentFolder }}
      </div>
      <div v-else-if="!hits.length && !loading" class="gs__empty">
        No matches
      </div>
      <div v-else class="gs__results">
        <div v-for="[file, fileHits] in grouped" :key="file" class="gs__group">
          <div class="gs__file">{{ shortPath(file) }}</div>
          <div
            v-for="hit in fileHits"
            :key="hit.line"
            class="gs__hit"
            :class="{ 'gs__hit--active': hits.indexOf(hit) === selectedIdx }"
            @click="openHit(hit)"
            @mouseenter="selectedIdx = hits.indexOf(hit)"
          >
            <span class="gs__lineno">L{{ hit.line }}</span>
            <span class="gs__snippet" v-html="highlight(hit.snippet)"></span>
          </div>
        </div>
      </div>
      <div class="gs__footer">
        <span>{{ hits.length }} hits</span>
        <span>↑↓ navigate · ↵ open · Esc close</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gs__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 10vh;
  z-index: 1000;
}
.gs {
  width: min(720px, 94vw);
  max-height: 70vh;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.gs__header {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
  padding: 0 16px;
}
.gs__input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  padding: 14px 0;
  font: 14px var(--font-ui);
  color: var(--text);
}
.gs__loading {
  color: var(--accent);
  font-size: 16px;
}
.gs__empty {
  padding: 32px;
  color: var(--text-faint);
  text-align: center;
  font-size: 13px;
}
.gs__results {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}
.gs__group {
  margin-bottom: 8px;
}
.gs__file {
  padding: 6px 16px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.gs__hit {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 16px 6px 24px;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs__hit:hover,
.gs__hit--active {
  background: var(--bg-active);
}
.gs__lineno {
  color: var(--text-faint);
  flex-shrink: 0;
  font-size: 10px;
  width: 36px;
}
.gs__snippet {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs__snippet :deep(mark) {
  background: var(--accent);
  color: var(--accent-fg);
  padding: 0 2px;
  border-radius: 2px;
}
.gs__footer {
  display: flex;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: 11px;
  color: var(--text-faint);
  border-top: 1px solid var(--border);
}
</style>

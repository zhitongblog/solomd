<script setup lang="ts">
/**
 * v2.5 — VSCode-style ⌘P quick file switcher.
 *
 * Empty input  → MRU (workspace.recentFiles) then MFU (recentEdits).
 * Typing       → fuzzy filter via recentEdits.topN(n, query).
 * ↑/↓ Enter    → navigate + open. Esc / outside-click close.
 *
 * Lists open tabs as `extra` so an unsaved Untitled tab is reachable too.
 *
 * 5.0 C4 — recents and save counts never hear about a rename / delete / move,
 * so on every open the candidates are re-checked against the workspace index
 * and the disk (lib/live-paths.ts); the dead ones are hidden at once and
 * dropped from both stores. While typing, every indexed note in the vault is
 * a candidate too, so a renamed file is found under its new name.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useRecentEditsStore } from '../stores/recentEdits';
import { useTabsStore } from '../stores/tabs';
import { useFiles } from '../composables/useFiles';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { findMissing } from '../lib/live-paths';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import Icons from './Icons.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const workspace = useWorkspaceStore();
const recentEdits = useRecentEditsStore();
const tabs = useTabsStore();
const files = useFiles();
const wsIndex = useWorkspaceIndexStore();
const { t } = useI18n();

const query = ref('');
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLUListElement | null>(null);
const TOP_N = 50;

const openTabPaths = computed(() => tabs.tabs.map((tab) => tab.filePath).filter((p): p is string => !!p));

/** Paths found to be gone the last time the switcher opened. */
const missing = ref<Set<string>>(new Set());

const indexedPaths = computed(() => wsIndex.entries.map((e) => e.path));

const results = computed<string[]>(() => {
  const typing = query.value.trim() !== '';
  const extra = typing ? [...openTabPaths.value, ...indexedPaths.value] : openTabPaths.value;
  const gone = missing.value;
  const open = new Set(openTabPaths.value);
  return recentEdits
    .topN(TOP_N + gone.size, query.value, workspace.recentFiles, extra)
    .filter((p) => open.has(p) || !gone.has(p))
    .slice(0, TOP_N);
});

const LIST_DIR_CAP = 10_000; // list_dir truncates at this many entries
const NOT_FOUND = /os error (2|3)\b|not found|cannot find/i;

async function listDir(dir: string): Promise<string[] | null> {
  try {
    const entries = await invoke<Array<{ path: string }>>('list_dir', { path: dir, showHidden: true });
    return entries.length >= LIST_DIR_CAP ? null : entries.map((e) => e.path);
  } catch (e) {
    return NOT_FOUND.test(String(e)) ? [] : null;
  }
}

async function pruneMissing() {
  if (!('__TAURI_INTERNALS__' in window)) return;
  const open = new Set(openTabPaths.value);
  const candidates = [...workspace.recentFiles, ...Object.keys(recentEdits.counts)].filter((p) => !open.has(p));
  const gone = await findMissing(candidates, wsIndex.ready ? indexedPaths.value : [], listDir);
  if (gone.size === 0) return;
  missing.value = gone;
  for (const p of gone) {
    workspace.removeRecent(p);
    recentEdits.forget(p);
  }
}

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
      void pruneMissing();
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
  // CJK/IME guard — see CommandPalette.vue for rationale.
  if (e.isComposing || e.keyCode === 229) return;
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
  <Teleport to="body">
  <div v-if="open" class="quick-switcher__backdrop" @click.self="emit('close')">
    <div class="quick-switcher" role="dialog" aria-label="Quick file switcher">
      <div class="quick-switcher__field">
        <Icons class="quick-switcher__field-icon" name="search" :size="16" aria-hidden="true" />
        <input
          ref="inputRef"
          v-model="query"
          @keydown="onKey"
          class="quick-switcher__input"
          :placeholder="t('quickSwitcher.placeholder')"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
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
  </Teleport>
</template>

<style scoped>
/* 5.0 (spec §6): 640px, radius 12, --sh-modal on --bg-pop; a 44px input row
   with a search icon and 15px text; 34px rows (radius 7), the selected one
   --fill-2; chords / paths right in --text-3; opens like a dialog (180ms fade
   + scale, keyframes in styles/menus.css). */
.quick-switcher__backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 14vh;
  z-index: var(--z-modal);
  animation: sm-fade-in var(--dur) var(--ease-out);
}
.quick-switcher {
  width: min(640px, calc(100vw - 32px));
  background: var(--bg-pop);
  color: var(--text);
  border: var(--bd-hair);
  border-radius: 12px;
  box-shadow: var(--sh-modal);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: min(480px, 64vh);
  transform-origin: top center;
  animation: sm-dialog-in var(--dur) var(--ease-out);
}
.quick-switcher__field {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 44px;
  padding: 0 16px;
  border-bottom: var(--bd-hair);
  color: var(--text-3);
}
.quick-switcher__field-icon {
  flex: none;
}
.quick-switcher__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  font: 15px var(--font-ui);
  color: var(--text);
}
.quick-switcher__input::placeholder {
  color: var(--text-3);
}
.quick-switcher__list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
}
.quick-switcher__item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 34px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--text);
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
}
.quick-switcher__item--active {
  background: var(--fill-2);
}
.quick-switcher__empty {
  padding: 20px 16px;
  color: var(--text-3);
  text-align: center;
  font-size: 13px;
}
.quick-switcher__name {
  color: var(--text);
  flex: 0 1 auto;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.quick-switcher__path {
  margin-left: auto;
  color: var(--text-3);
  font-size: 12px;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: right;
}
@media (prefers-reduced-motion: reduce) {
  .quick-switcher__backdrop,
  .quick-switcher {
    animation: none;
  }
}
</style>
